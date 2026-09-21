/* Ciclo — computador de bordo de ciclismo no navegador.
 *
 * GPS do celular + sensores Bluetooth (FC e cadencia/velocidade, perfis padrao
 * 0x180D e 0x1816). Grava o pedal no IndexedDB a cada 10 s — se o navegador
 * fechar no meio, o pedal volta pausado — e exporta TCX, que o Garmin Connect e
 * o Strava importam com FC, cadencia e trajeto.
 *
 * ?demo=1 simula FC, cadencia e GPS, para testar sem sair de casa.
 */
"use strict";

const VERSAO = "1.2.5";

/* Pontos de extensao: rotas.js, treinos.js, sync.js e estrada.js se penduram aqui. */
const EXT = { tick: [], volta: [], iniciar: [], encerrar: [], paginas: [], menu: [] };
const $ = (s) => document.querySelector(s);
const DEMO = new URLSearchParams(location.search).has("demo");

/* ------------------------------------------------------------------------- */
/* Configuracao                                                               */
/* ------------------------------------------------------------------------- */

const PAGINAS_PADRAO = [
  [{ k: "hr", full: 1 }, { k: "speed" }, { k: "cad" }, { k: "dist" }, { k: "time" }, { k: "avgspeed" }, { k: "lapTime" }],
  [{ k: "hr", full: 1 }, { k: "hrzone" }, { k: "hrpct" }, { k: "avghr" }, { k: "maxhr" }, { k: "zonebar", full: 1 }],
  [{ k: "lapTime", full: 1 }, { k: "lapN" }, { k: "lapDist" }, { k: "lapSpeed" }, { k: "lapHr" }, { k: "lapCad" }, { k: "lapGain" }],
  [{ k: "map", full: 1, tall: 1 }, { k: "speed" }, { k: "dist" }],
  [{ k: "alt" }, { k: "grade" }, { k: "gain" }, { k: "maxspeed" }, { k: "totaltime" }, { k: "clock" }, { k: "avgcad" }, { k: "hrTarget" }],
];

const CFG_PADRAO = {
  fcmax: 185, fcrep: 57,
  ceilOn: false, ceil: 146, floorOn: false, floor: 134,
  autopause: true, apKmh: 3, avisoSubida: true,
  wheelMm: 2105,
  wake: true, vibrate: true, sound: true,
  theme: "dark",
  pages: PAGINAS_PADRAO,
};

function carregarCfg() {
  try {
    const c = JSON.parse(localStorage.getItem("ciclo_cfg") || "{}");
    return Object.assign({}, CFG_PADRAO, c, { pages: c.pages || PAGINAS_PADRAO });
  } catch { return JSON.parse(JSON.stringify(CFG_PADRAO)); }
}
let cfg = carregarCfg();
function salvarCfg() { try { localStorage.setItem("ciclo_cfg", JSON.stringify(cfg)); } catch {} }

/* ------------------------------------------------------------------------- */
/* Estado                                                                     */
/* ------------------------------------------------------------------------- */

const S = {
  hr: { dev: null, conn: false, val: null, t: 0, bat: null, want: false, name: "" },
  cad: { dev: null, conn: false, val: 0, tVal: 0, t: 0, bat: null, want: false, name: "",
         lastRevs: null, lastTime: null, hasCrank: false },
  whl: { has: false, speed: 0, tVal: 0, lastRevs: null, lastTime: null },
  gps: { watch: null, on: false, acc: null, t: 0, lat: null, lon: null, alt: null, speed: 0, last: null, err: "" },
  page: 0,
};

function rideNova() {
  return {
    id: Date.now(), state: "idle", startT: null, lastTick: Date.now(),
    movingMs: 0, totalMs: 0, dist: 0, gain: 0, maxSpeed: 0, maxHr: 0,
    hrSum: 0, hrN: 0, cadSum: 0, cadN: 0, zoneMs: [0, 0, 0, 0, 0, 0],
    laps: [], slowS: 0, altF: null, altRef: null, altHist: [], track: [],
    chunkI: 0, nSamples: 0, endT: null,
  };
}
let R = rideNova();
let buf = [];

/* ------------------------------------------------------------------------- */
/* Utilidades                                                                 */
/* ------------------------------------------------------------------------- */

const agora = () => Date.now();
function hav(a, b) {
  const R0 = 6371000, t = Math.PI / 180;
  const dLa = (b.lat - a.lat) * t, dLo = (b.lon - a.lon) * t;
  const s = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.sin(dLo / 2) ** 2;
  return 2 * R0 * Math.asin(Math.sqrt(s));
}
function fmtT(ms) {
  if (!ms || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? h + ":" + String(m).padStart(2, "0") + ":" + String(x).padStart(2, "0")
           : String(m).padStart(2, "0") + ":" + String(x).padStart(2, "0");
}
const fmtKm = (m) => (m / 1000 < 10 ? (m / 1000).toFixed(2) : (m / 1000).toFixed(1));
const fmtKmh = (ms) => (ms * 3.6).toFixed(1);
function toast(msg, ms = 2200) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("on");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("on"), ms);
}

/* zonas de Karvonen */
function cortes() {
  const r = cfg.fcmax - cfg.fcrep;
  return [0.5, 0.6, 0.7, 0.8, 0.9].map((p) => Math.round(cfg.fcrep + p * r));
}
function zonaDe(hr) {
  if (!hr) return 0;
  const c = cortes();
  for (let i = 4; i >= 0; i--) if (hr >= c[i]) return i + 1;
  return 0;
}
const COR_ZONA = ["var(--z0)", "var(--z1)", "var(--z2)", "var(--z3)", "var(--z4)", "var(--z5)"];

/* valores atuais, ja com validade */
const hrAtual = () => (S.hr.val && agora() - S.hr.t < 5000 ? S.hr.val : null);
const cadAtual = () => (S.cad.conn || DEMO) && agora() - S.cad.tVal < 3000 ? S.cad.val : (S.cad.hasCrank ? 0 : null);
function fonteVel() {
  if (S.whl.has && agora() - S.whl.tVal < 4000) return "roda";
  if (S.gps.on && agora() - S.gps.t < 6000 && S.gps.acc != null && S.gps.acc <= 35) return "gps";
  if (S.whl.has) return "roda";
  return "nenhuma";
}
function velAtual() {
  const f = fonteVel();
  if (f === "roda") return agora() - S.whl.tVal < 4000 ? S.whl.speed : 0;
  if (f === "gps") return S.gps.speed;
  return null;
}
const movendo = () => R.state === "running";
const lapAtual = () => R.laps[R.laps.length - 1];

/* ------------------------------------------------------------------------- */
/* Som, vibracao, tela ligada                                                 */
/* ------------------------------------------------------------------------- */

let actx = null;
function beep(freq = 880, ms = 160, vezes = 1) {
  if (cfg.sound) {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      for (let k = 0; k < vezes; k++) {
        const o = actx.createOscillator(), g = actx.createGain();
        o.type = "square"; o.frequency.value = freq; g.gain.value = 0.12;
        o.connect(g); g.connect(actx.destination);
        const t0 = actx.currentTime + k * (ms / 1000 + 0.09);
        o.start(t0); o.stop(t0 + ms / 1000);
      }
    } catch {}
  }
  if (cfg.vibrate && navigator.vibrate) navigator.vibrate(vezes > 1 ? [220, 110, 220, 110, 220] : 200);
}
function flash() { const f = $("#flash"); f.classList.add("on"); setTimeout(() => f.classList.remove("on"), 900); }

let wl = null;
async function manterTela() {
  if (!cfg.wake || !("wakeLock" in navigator) || wl) return;
  try { wl = await navigator.wakeLock.request("screen"); wl.addEventListener("release", () => { wl = null; }); } catch {}
}
/* O Forerunner aceita UMA conexao Bluetooth com o celular. Se o Chrome segurar
 * a conexao de FC com o app fechado, o Garmin Connect para de sincronizar o
 * relogio. Entao, sem pedal em andamento, sair do app solta os sensores — e
 * encerrar o pedal tambem. Com pedal gravando, a conexao fica. */
function soltarSensores(motivo) {
  let soltou = false;
  ["hr", "cad"].forEach((k) => { if (S[k].dev || S[k].want) { esquecer(k); soltou = true; } });
  if (soltou && motivo) toast(motivo);
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") { manterTela(); tick(); return; }
  if (R.state === "idle" || R.state === "done") soltarSensores();
});

/* ------------------------------------------------------------------------- */
/* Bluetooth                                                                  */
/* ------------------------------------------------------------------------- */

const BLE = {
  hr: { svc: "heart_rate", ch: "heart_rate_measurement", nome: "FC" },
  cad: { svc: "cycling_speed_and_cadence", ch: "csc_measurement", nome: "cadência" },
};

async function conectar(tipo) {
  if (!navigator.bluetooth) {
    alert("Bluetooth no navegador não disponível. Use o Chrome no Android, com Bluetooth e localização ligados.");
    return;
  }
  try {
    const dev = await navigator.bluetooth.requestDevice({
      filters: [{ services: [BLE[tipo].svc] }], optionalServices: ["battery_service"],
    });
    const s = S[tipo];
    s.dev = dev; s.want = true; s.name = dev.name || "sensor";
    dev.addEventListener("gattserverdisconnected", () => desconectou(tipo));
    await abrirGatt(tipo);
  } catch (e) {
    if (e && e.name !== "NotFoundError") toast("Não conectou: " + (e.message || e));
  }
  render();
}

async function abrirGatt(tipo) {
  const s = S[tipo];
  const srv = await s.dev.gatt.connect();
  const svc = await srv.getPrimaryService(BLE[tipo].svc);
  const ch = await svc.getCharacteristic(BLE[tipo].ch);
  await ch.startNotifications();
  ch.addEventListener("characteristicvaluechanged", tipo === "hr" ? aoFc : aoCsc);
  s.conn = true;
  toast(BLE[tipo].nome + " conectada: " + s.name);
  try {
    const b = await srv.getPrimaryService("battery_service");
    const bc = await b.getCharacteristic("battery_level");
    s.bat = (await bc.readValue()).getUint8(0);
  } catch {}
  render();
}

function desconectou(tipo) {
  const s = S[tipo];
  s.conn = false;
  render();
  if (!s.want) return;
  beep(440, 250, 1);
  toast(BLE[tipo].nome + " desconectada — tentando reconectar");
  let espera = 2000;
  const tentar = async () => {
    if (!s.want || s.conn) return;
    try { await abrirGatt(tipo); } catch { espera = Math.min(espera * 1.5, 15000); setTimeout(tentar, espera); }
  };
  setTimeout(tentar, espera);
}

function esquecer(tipo) {
  const s = S[tipo];
  s.want = false;
  try { s.dev && s.dev.gatt.connected && s.dev.gatt.disconnect(); } catch {}
  s.dev = null; s.conn = false; s.bat = null; s.name = "";
  render();
}

function aoFc(e) {
  const v = e.target.value, f = v.getUint8(0);
  const hr = f & 1 ? v.getUint16(1, true) : v.getUint8(1);
  if (hr > 25 && hr < 240) { S.hr.val = hr; S.hr.t = agora(); }
}

function aoCsc(e) {
  const v = e.target.value, f = v.getUint8(0), t = agora();
  let i = 1;
  if (f & 1) { roda(v.getUint32(i, true), v.getUint16(i + 4, true), t); i += 6; }
  if (f & 2) { pedivela(v.getUint16(i, true), v.getUint16(i + 2, true), t); }
  S.cad.t = t;
}

function pedivela(revs, tempo, t) {
  const c = S.cad;
  c.hasCrank = true;
  if (c.lastRevs != null) {
    const dr = (revs - c.lastRevs + 65536) % 65536;
    const dt = (tempo - c.lastTime + 65536) % 65536;
    if (dr > 0 && dt > 0) {
      const rpm = (dr / (dt / 1024)) * 60;
      if (rpm < 250) { c.val = Math.round(rpm); c.tVal = t; }
    }
  } else c.tVal = t;
  c.lastRevs = revs; c.lastTime = tempo;
}

function roda(revs, tempo, t) {
  const w = S.whl;
  w.has = true;
  if (w.lastRevs != null) {
    let dr = revs - w.lastRevs; if (dr < 0) dr += 4294967296;
    const dt = (tempo - w.lastTime + 65536) % 65536;
    const circ = cfg.wheelMm / 1000;
    if (dr > 0 && dt > 0) {
      const ms = (dr * circ) / (dt / 1024);
      if (ms < 30) { w.speed = ms; w.tVal = t; }
    }
    if (dr > 0 && dr < 60 && movendo()) R.dist += dr * circ;
  } else w.tVal = t;
  w.lastRevs = revs; w.lastTime = tempo;
}

/* ------------------------------------------------------------------------- */
/* GPS                                                                        */
/* ------------------------------------------------------------------------- */

function ligarGps() {
  if (S.gps.on || !navigator.geolocation) return;
  S.gps.on = true;
  S.gps.watch = navigator.geolocation.watchPosition(aoPos, (err) => {
    S.gps.err = err.message || "erro";
    if (err.code === 1) { S.gps.on = false; toast("Permita a localização para o GPS funcionar."); }
    render();
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
  render();
}

function aoPos(p) {
  const c = p.coords, t = agora();
  S.gps.acc = c.accuracy; S.gps.t = t; S.gps.err = "";
  if (c.accuracy > 35) return;                       // fixo ruim: nao entra em distancia nem trajeto
  const pt = { lat: c.latitude, lon: c.longitude, t };
  S.gps.lat = pt.lat; S.gps.lon = pt.lon;

  let v = c.speed != null && !isNaN(c.speed) ? c.speed : null;
  if (S.gps.last) {
    const d = hav(S.gps.last, pt), dt = (t - S.gps.last.t) / 1000;
    if (dt > 0 && d / dt > 25) return;               // salto > 90 km/h: descarta o ponto
    if (v == null && dt >= 1) v = d / dt;
    const andando = v != null ? v >= 0.8 : d > c.accuracy;
    if (andando && movendo() && fonteVel() !== "roda") R.dist += d;
    if (movendo() && (!R.track.length || hav(R.track[R.track.length - 1], pt) > 12)) {
      R.track.push({ lat: pt.lat, lon: pt.lon });
      if (R.track.length > 3000) R.track = R.track.filter((_, i) => i % 2 === 0);
    }
  }
  if (v != null) S.gps.speed = S.gps.speed ? S.gps.speed + 0.5 * (v - S.gps.speed) : v;
  if (v != null && v < 0.5) S.gps.speed = 0;
  S.gps.last = pt;

  // Altitude do GPS: ruidosa (±10-20 m). Filtro + histerese de 3 m, para o
  // ganho nao virar soma de ruido. O valor final confiavel vem da correcao
  // por relevo do Garmin Connect / Strava na importacao.
  if (c.altitude != null && !isNaN(c.altitude)) {
    R.altF = R.altF == null ? c.altitude : R.altF + 0.15 * (c.altitude - R.altF);
    S.gps.alt = R.altF;
    if (R.altRef == null) R.altRef = R.altF;
    if (R.altF - R.altRef >= 3) { if (movendo()) R.gain += R.altF - R.altRef; R.altRef = R.altF; }
    else if (R.altF < R.altRef - 3) R.altRef = R.altF;
  }
}

/* ------------------------------------------------------------------------- */
/* Gravacao (IndexedDB)                                                       */
/* ------------------------------------------------------------------------- */

let dbp = null;
function idb() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open("ciclo", 2);
    r.onupgradeneeded = () => {
      const d = r.result, tem = (n) => d.objectStoreNames.contains(n);
      if (!tem("chunks")) d.createObjectStore("chunks", { keyPath: ["ride", "i"] });
      if (!tem("rotas")) d.createObjectStore("rotas", { keyPath: "id" });
      if (!tem("treinos")) d.createObjectStore("treinos", { keyPath: "id" });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function gravarChunk() {
  if (!buf.length) return;
  const lote = buf; buf = [];
  const i = R.chunkI++;
  R.nSamples += lote.length;
  try {
    const db = await idb();
    await new Promise((res, rej) => {
      const tx = db.transaction("chunks", "readwrite");
      tx.objectStore("chunks").put({ ride: R.id, i, s: lote });
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  } catch (e) { buf = lote.concat(buf); R.chunkI--; R.nSamples -= lote.length; }
  salvarMeta();
}
async function lerAmostras(rideId) {
  const db = await idb();
  const rows = await new Promise((res, rej) => {
    const tx = db.transaction("chunks", "readonly");
    const q = tx.objectStore("chunks").getAll(IDBKeyRange.bound([rideId, 0], [rideId, Infinity]));
    q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
  });
  rows.sort((a, b) => a.i - b.i);
  return rows.flatMap((r) => r.s).concat(rideId === R.id ? buf : []);
}
async function apagarPedal(rideId) {
  try {
    const db = await idb();
    const tx = db.transaction("chunks", "readwrite");
    tx.objectStore("chunks").delete(IDBKeyRange.bound([rideId, 0], [rideId, Infinity]));
  } catch {}
}
function salvarMeta() {
  try { localStorage.setItem("ciclo_ride", JSON.stringify(R)); } catch {}
}

/* ------------------------------------------------------------------------- */
/* Controle do pedal                                                          */
/* ------------------------------------------------------------------------- */

function novaVolta(t) {
  const ant = lapAtual();
  if (ant) { ant.endT = t; ant.dist1 = R.dist; ant.gain1 = R.gain; }
  R.laps.push({ n: R.laps.length + 1, startT: t, endT: null, movingMs: 0, dist0: R.dist, dist1: null,
                gain0: R.gain, gain1: null, hrSum: 0, hrN: 0, cadSum: 0, cadN: 0, maxHr: 0, maxSpeed: 0 });
}

function iniciar() {
  if (actx) actx.resume();
  ligarGps(); manterTela();
  if (R.state === "done") { apagarPedal(R.id); R = rideNova(); buf = []; }
  if (R.state === "idle") { R.startT = agora(); novaVolta(R.startT); }
  R.state = "running"; R.lastTick = agora(); R.slowS = 0;
  beep(988, 120, 1);
  EXT.iniciar.forEach((f) => f());
  salvarMeta(); render();
}
function pausar() { R.state = "paused"; beep(660, 160, 1); gravarChunk(); salvarMeta(); render(); }
function volta() {
  if (R.state !== "running" && R.state !== "autopaused") return;
  for (const f of EXT.volta) if (f()) return;       // com treino ativo, Volta avanca o passo
  novaVolta(agora());
  beep(1175, 110, 2);
  toast("Volta " + lapAtual().n);
  salvarMeta(); render();
}
async function encerrar() {
  const t = agora();
  const l = lapAtual(); if (l) { l.endT = t; l.dist1 = R.dist; l.gain1 = R.gain; }
  R.state = "done"; R.endT = t;
  await gravarChunk();
  salvarMeta();
  beep(784, 200, 2);
  EXT.encerrar.forEach((f) => f());
  soltarSensores("Sensores desconectados — o relógio volta a sincronizar com o Garmin Connect");
  render(); abrirResumo();
}

/* ------------------------------------------------------------------------- */
/* Relogio de 1 s                                                             */
/* ------------------------------------------------------------------------- */

const alerta = { acima: 0, abaixo: 0 };

function tick() {
  const t = agora();
  if (R.state === "running" || R.state === "autopaused") {
    const dt = Math.max(0, t - R.lastTick);
    R.totalMs += dt;
    const v = velAtual();

    if (cfg.autopause && v != null) {
      const kmh = v * 3.6;
      if (R.state === "running") {
        if (kmh < cfg.apKmh) { if (++R.slowS >= 3) { R.state = "autopaused"; beep(600, 120, 1); } }
        else R.slowS = 0;
      } else if (kmh >= cfg.apKmh + 1) { R.state = "running"; R.slowS = 0; beep(900, 120, 1); }
    }

    if (R.state === "running") {
      R.movingMs += dt;
      const lap = lapAtual(); lap.movingMs += dt;
      const hr = hrAtual(), cad = cadAtual();
      if (hr) {
        R.hrSum += hr; R.hrN++; lap.hrSum += hr; lap.hrN++;
        R.maxHr = Math.max(R.maxHr, hr); lap.maxHr = Math.max(lap.maxHr, hr);
        R.zoneMs[zonaDe(hr)] += dt;
      }
      if (cad != null && cad > 0) { R.cadSum += cad; R.cadN++; lap.cadSum += cad; lap.cadN++; }
      if (v != null) { R.maxSpeed = Math.max(R.maxSpeed, v); lap.maxSpeed = Math.max(lap.maxSpeed, v); }
      const gpsOk = S.gps.lat != null && t - S.gps.t < 6000;
      buf.push({ t, la: gpsOk ? +S.gps.lat.toFixed(6) : null, lo: gpsOk ? +S.gps.lon.toFixed(6) : null,
                 al: R.altF != null ? +R.altF.toFixed(1) : null, hr, cad, v: v != null ? +v.toFixed(2) : null,
                 d: +R.dist.toFixed(1) });
      if (R.altF != null) {
        R.altHist.push([R.dist, R.altF]);
        if (R.altHist.length > 900) R.altHist.shift();
      }
      if (buf.length >= 10) gravarChunk();
    }

    // alertas de FC: 5 s seguidos fora da faixa, repete a cada 30 s
    const hr = hrAtual();
    if (cfg.ceilOn && hr && hr > cfg.ceil && R.state === "running") {
      alerta.acima++;
      if (alerta.acima === 5 || (alerta.acima > 5 && (alerta.acima - 5) % 30 === 0)) {
        beep(1320, 140, 3); flash(); toast("FC " + hr + " acima de " + cfg.ceil);
      }
    } else alerta.acima = 0;
    if (cfg.floorOn && hr && hr < cfg.floor && R.state === "running") {
      alerta.abaixo++;
      if (alerta.abaixo === 20 || (alerta.abaixo > 20 && (alerta.abaixo - 20) % 60 === 0)) {
        beep(520, 200, 2); toast("FC " + hr + " abaixo de " + cfg.floor);
      }
    } else alerta.abaixo = 0;

    if (t % 5000 < 1000) salvarMeta();
  }
  EXT.tick.forEach((f) => { try { f(t); } catch (e) { console.error(e); } });
  R.lastTick = t;
  render();
}

/* ------------------------------------------------------------------------- */
/* Campos                                                                     */
/* ------------------------------------------------------------------------- */

function inclinacao() {
  const h = R.altHist;
  if (h.length < 5) return null;
  const [dN, aN] = h[h.length - 1];
  for (let i = h.length - 2; i >= 0; i--) {
    if (dN - h[i][0] >= 80) return ((aN - h[i][1]) / (dN - h[i][0])) * 100;
  }
  return null;
}
const media = (s, n) => (n ? Math.round(s / n) : null);

const CAMPOS = {
  hr:        { lb: "FC", u: "bpm", v: () => hrAtual() ?? "--", zona: () => zonaDe(hrAtual()), stale: () => !hrAtual() },
  hrzone:    { lb: "Zona", u: "Karvonen", v: () => (hrAtual() ? "Z" + zonaDe(hrAtual()) : "--"), zona: () => zonaDe(hrAtual()) },
  hrpct:     { lb: "% FC reserva", u: "%", v: () => { const h = hrAtual(); return h ? Math.round(((h - cfg.fcrep) / (cfg.fcmax - cfg.fcrep)) * 100) : "--"; } },
  avghr:     { lb: "FC média", u: "bpm", v: () => media(R.hrSum, R.hrN) ?? "--" },
  maxhr:     { lb: "FC máx", u: "bpm", v: () => R.maxHr || "--" },
  hrTarget:  { lb: "Alerta FC", u: "bpm", v: () => (cfg.ceilOn ? "≤" + cfg.ceil : cfg.floorOn ? "≥" + cfg.floor : "off") },
  cad:       { lb: "Cadência", u: "rpm", v: () => cadAtual() ?? "--", stale: () => cadAtual() == null },
  avgcad:    { lb: "Cad. média", u: "rpm", v: () => media(R.cadSum, R.cadN) ?? "--" },
  speed:     { lb: "Velocidade", u: () => "km/h · " + fonteVel(), v: () => { const v = velAtual(); return v == null ? "--" : fmtKmh(v); }, stale: () => velAtual() == null },
  avgspeed:  { lb: "Vel. média", u: "km/h", v: () => (R.movingMs > 5000 ? fmtKmh(R.dist / (R.movingMs / 1000)) : "--") },
  maxspeed:  { lb: "Vel. máx", u: "km/h", v: () => (R.maxSpeed ? fmtKmh(R.maxSpeed) : "--") },
  dist:      { lb: "Distância", u: "km", v: () => fmtKm(R.dist) },
  time:      { lb: "Tempo", u: "em movimento", v: () => fmtT(R.movingMs) },
  totaltime: { lb: "Tempo total", u: "com paradas", v: () => fmtT(R.totalMs) },
  clock:     { lb: "Hora", u: "", v: () => new Date().toTimeString().slice(0, 5) },
  alt:       { lb: "Altitude", u: "m · GPS", v: () => (S.gps.alt != null ? Math.round(S.gps.alt) : "--") },
  gain:      { lb: "Subida", u: "m · GPS, estimada", v: () => Math.round(R.gain) },
  grade:     { lb: "Inclinação", u: "% · últimos 100 m", v: () => { const g = inclinacao(); return g == null ? "--" : g.toFixed(1); } },
  lapN:      { lb: "Volta", u: "", v: () => (lapAtual() ? lapAtual().n : "--") },
  lapTime:   { lb: "Tempo da volta", u: "", v: () => (lapAtual() ? fmtT(lapAtual().movingMs) : "--:--") },
  lapDist:   { lb: "Dist. volta", u: "km", v: () => (lapAtual() ? fmtKm(R.dist - lapAtual().dist0) : "--") },
  lapSpeed:  { lb: "Vel. volta", u: "km/h", v: () => { const l = lapAtual(); return l && l.movingMs > 5000 ? fmtKmh((R.dist - l.dist0) / (l.movingMs / 1000)) : "--"; } },
  lapHr:     { lb: "FC volta", u: "bpm", v: () => (lapAtual() ? media(lapAtual().hrSum, lapAtual().hrN) ?? "--" : "--") },
  lapCad:    { lb: "Cad. volta", u: "rpm", v: () => (lapAtual() ? media(lapAtual().cadSum, lapAtual().cadN) ?? "--" : "--") },
  lapGain:   { lb: "Subida volta", u: "m", v: () => (lapAtual() ? Math.round(R.gain - lapAtual().gain0) : "--") },
  zonebar:   { lb: "Tempo nas zonas", especial: "zonas" },
  map:       { lb: "Trajeto", especial: "mapa" },
};

/* ------------------------------------------------------------------------- */
/* Paginas                                                                    */
/* ------------------------------------------------------------------------- */

function paginasExt() { return EXT.paginas.filter((x) => x.ativa()); }
function nPaginas() { return paginasExt().length + cfg.pages.length; }

function montarPaginas() {
  const main = $("#pages"); main.innerHTML = "";
  const dots = $("#dots"); dots.innerHTML = "";
  let pos = 0;
  paginasExt().forEach((x) => {
    const sec = document.createElement("section");
    sec.className = "page ext"; sec.dataset.p = pos++; sec.dataset.ext = x.nome;
    x.montar(sec);
    main.appendChild(sec);
    dots.appendChild(document.createElement("i"));
  });
  cfg.pages.forEach((campos, p) => {
    const sec = document.createElement("section");
    sec.className = "page"; sec.dataset.p = pos++;
    campos.forEach((c, idx) => {
      const def = CAMPOS[c.k] || CAMPOS.dist;
      const el = document.createElement("div");
      el.className = "f" + (c.full ? " full" : "") + (c.tall ? " tall" : "");
      el.dataset.k = c.k; el.dataset.i = idx;
      if (def.especial === "mapa") el.innerHTML = '<canvas></canvas>';
      else if (def.html) el.innerHTML = def.html;
      else if (def.especial === "zonas") el.innerHTML = '<div class="lb">' + def.lb + '</div><div class="zb"><div class="bar"></div><div class="leg num"></div></div>';
      else el.innerHTML = '<div class="lb">' + def.lb + '</div><div class="v num"></div><div class="u"></div>';
      segurar(el, () => abrirTroca(p, idx));
      sec.appendChild(el);
    });
    main.appendChild(sec);
    dots.appendChild(document.createElement("i"));
  });
  S.page = Math.max(0, Math.min(S.page, nPaginas() - 1));
  posicionar();
}

function posicionar() {
  document.querySelectorAll(".page").forEach((s) => {
    s.style.transform = "translateX(" + (Number(s.dataset.p) - S.page) * 100 + "%)";
  });
  document.querySelectorAll("#dots i").forEach((d, i) => d.classList.toggle("on", i === S.page));
  const vis = document.querySelector('.page[data-p="' + S.page + '"]');
  if (vis && vis.dataset.ext) { const x = EXT.paginas.find((e) => e.nome === vis.dataset.ext); if (x && x.visivel) x.visivel(vis); }
  render();
}
function irPara(p) { const n = nPaginas(); S.page = (p + n) % n; posicionar(); }

(function gestos() {
  const m = $("#pages"); let x0 = null, y0 = null;
  m.addEventListener("touchstart", (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
  m.addEventListener("touchend", (e) => {
    if (x0 == null) return;
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) irPara(S.page + (dx < 0 ? 1 : -1));
    x0 = null;
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") irPara(S.page + 1);
    if (e.key === "ArrowLeft") irPara(S.page - 1);
  });
})();

function segurar(el, fn, ms = 650) {
  let tm = null;
  const ini = () => { tm = setTimeout(() => { tm = null; if (navigator.vibrate) navigator.vibrate(30); fn(); }, ms); };
  const fim = () => { if (tm) clearTimeout(tm); tm = null; };
  el.addEventListener("touchstart", ini, { passive: true });
  el.addEventListener("touchend", fim); el.addEventListener("touchmove", fim, { passive: true });
  el.addEventListener("mousedown", ini); el.addEventListener("mouseup", fim); el.addEventListener("mouseleave", fim);
  el.addEventListener("contextmenu", (e) => e.preventDefault());
}

/* ------------------------------------------------------------------------- */
/* Render                                                                     */
/* ------------------------------------------------------------------------- */

function chip(el, estado, texto) {
  el.className = "chip " + estado;
  el.querySelector("span").textContent = texto;
}

function render() {
  const t = agora();
  $("#clock").textContent = new Date().toTimeString().slice(0, 5);

  // status
  const g = S.gps;
  if (!g.on) chip($("#cGps"), "", "GPS off");
  else if (g.acc == null || t - g.t > 10000) chip($("#cGps"), "bad", "GPS …");
  else chip($("#cGps"), g.acc <= 15 ? "ok" : g.acc <= 35 ? "warn" : "bad", "GPS ±" + Math.round(g.acc));
  chip($("#cHr"), hrAtual() ? "ok" : S.hr.conn ? "warn" : S.hr.want ? "bad" : "", hrAtual() ? "FC " + hrAtual() : "FC");
  chip($("#cCad"), S.cad.conn ? "ok" : S.cad.want ? "bad" : "", S.cad.conn ? (S.whl.has && !S.cad.hasCrank ? "VEL" : "CAD") : "CAD");
  const rec = $("#rec");
  rec.className = { running: "run", paused: "pause", autopaused: "auto" }[R.state] || "";
  rec.textContent = { running: "● REC", paused: "PAUSADO", autopaused: "PAUSA AUTO", done: "FIM" }[R.state] || "";

  // campos da pagina visivel (e das vizinhas, para o deslize nao mostrar vazio)
  document.querySelectorAll('.page').forEach((sec) => {
    const p = Number(sec.dataset.p);
    if (Math.abs(p - S.page) > 1) return;
    if (sec.dataset.ext) {
      const x = EXT.paginas.find((e) => e.nome === sec.dataset.ext);
      if (x) { try { x.atualizar(sec, p === S.page); } catch (e) { console.error(e); } }
      return;
    }
    sec.querySelectorAll(".f").forEach((el) => {
      const def = CAMPOS[el.dataset.k] || CAMPOS.dist;
      if (def.especial === "mapa") return desenharMapa(el.querySelector("canvas"));
      if (def.desenhar) return def.desenhar(el);
      if (def.especial === "zonas") return desenharZonas(el);
      el.querySelector(".v").textContent = def.v();
      el.querySelector(".u").textContent = typeof def.u === "function" ? def.u() : def.u;
      el.classList.toggle("stale", !!(def.stale && def.stale()));
      const z = def.zona ? def.zona() : null;
      if (z) { el.style.background = COR_ZONA[z]; el.classList.add("zoned"); }
      else { el.style.background = ""; el.classList.remove("zoned"); }
    });
  });

  renderControles();
  renderSensores();
}

function desenharZonas(el) {
  const tot = R.zoneMs.slice(1).reduce((a, b) => a + b, 0);
  const bar = el.querySelector(".bar"), leg = el.querySelector(".leg");
  bar.innerHTML = R.zoneMs.slice(1).map((ms, i) =>
    '<span style="width:' + (tot ? (ms / tot) * 100 : 0) + '%;background:' + COR_ZONA[i + 1] + '"></span>').join("");
  const c = cortes();
  leg.innerHTML = R.zoneMs.slice(1).map((ms, i) =>
    '<div><span style="color:' + COR_ZONA[i + 1] + ';font-weight:800">Z' + (i + 1) + '</span><b>' + fmtT(ms) +
    '</b><small style="color:var(--mute)">' + c[i] + (i < 4 ? "–" + (c[i + 1] - 1) : "+") + '</small></div>').join("");
}

function desenharMapa(cv) {
  const box = cv.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(box.width * dpr)) { cv.width = Math.round(box.width * dpr); cv.height = Math.round(box.height * dpr); }
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = box.width, H = box.height;
  ctx.clearRect(0, 0, W, H);
  const pts = R.track.slice();
  if (S.gps.lat != null) pts.push({ lat: S.gps.lat, lon: S.gps.lon });
  const css = getComputedStyle(document.documentElement);
  if (!pts.length) {
    ctx.fillStyle = css.getPropertyValue("--mute"); ctx.font = "600 15px Roboto,sans-serif"; ctx.textAlign = "center";
    ctx.fillText(S.gps.on ? "aguardando GPS" : "GPS desligado", W / 2, H / 2);
    return;
  }
  let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
  pts.forEach((p) => { a = Math.min(a, p.lat); b = Math.max(b, p.lat); c = Math.min(c, p.lon); d = Math.max(d, p.lon); });
  const k = Math.cos(((a + b) / 2) * Math.PI / 180);
  const spanX = Math.max((d - c) * k, 0.0005), spanY = Math.max(b - a, 0.0005);
  const esc = Math.min((W - 40) / spanX, (H - 40) / spanY);
  const cx = (c + d) / 2, cy = (a + b) / 2;
  const P = (p) => [W / 2 + (p.lon - cx) * k * esc, H / 2 - (p.lat - cy) * esc];
  ctx.lineWidth = 4; ctx.lineJoin = "round"; ctx.lineCap = "round";
  ctx.strokeStyle = css.getPropertyValue("--acc").trim() || "#eb6834";
  ctx.beginPath();
  pts.forEach((p, i) => { const [x, y] = P(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.stroke();
  const [sx, sy] = P(pts[0]);
  ctx.fillStyle = "#1baf7a"; ctx.beginPath(); ctx.arc(sx, sy, 6, 0, 7); ctx.fill();
  const [ex, ey] = P(pts[pts.length - 1]);
  ctx.fillStyle = css.getPropertyValue("--txt").trim() || "#fff"; ctx.beginPath(); ctx.arc(ex, ey, 7, 0, 7); ctx.fill();
  // escala
  const m100 = 100 * esc / 111320;
  const alvo = m100 * 10 > W / 3 ? 100 : m100 * 100 > W / 3 ? 1000 : 5000;
  const px = (alvo / 111320) * esc;
  ctx.fillStyle = css.getPropertyValue("--mute"); ctx.fillRect(12, H - 16, px, 3);
  ctx.font = "600 12px Roboto,sans-serif"; ctx.textAlign = "left";
  ctx.fillText(alvo >= 1000 ? alvo / 1000 + " km" : alvo + " m", 12, H - 22);
}

/* controles */
let controlesEstado = "";
function renderControles() {
  const st = R.state + "|" + (R.laps.length ? 1 : 0) + "|" + (typeof treinoAtivo === "function" && treinoAtivo() ? 1 : 0);
  if (st === controlesEstado) return;
  controlesEstado = st;
  const f = $("#controls");
  const B = (txt, cls, fn, extra = "") => {
    const b = document.createElement("button"); b.className = "btn " + cls; b.textContent = txt;
    if (fn) b.addEventListener("click", fn); if (extra) b.setAttribute("data-x", extra); return b;
  };
  f.innerHTML = "";
  if (R.state === "idle") {
    f.append(B("Sensores", "", () => abrir("dlgSensors")), B("▶ INICIAR", "main", iniciar), B("Menu", "", abrirMenu));
  } else if (R.state === "running" || R.state === "autopaused") {
    f.append(B(typeof treinoAtivo === "function" && treinoAtivo() ? "Próximo" : "Volta", "", volta), B("❚❚ PAUSAR", "pause", pausar), B("Menu", "", abrirMenu));
  } else if (R.state === "paused") {
    const fim = B("■ Encerrar", "stop hold");
    segurarBotao(fim, encerrar);
    f.append(fim, B("▶ RETOMAR", "main", iniciar), B("Menu", "", abrirMenu));
  } else if (R.state === "done") {
    f.append(B("Resumo", "", abrirResumo), B("NOVO PEDAL", "main", () => {
      if (confirm("Começar um pedal novo? O anterior some do celular — exporte antes se ainda não exportou.")) {
        apagarPedal(R.id); R = rideNova(); buf = []; salvarMeta(); controlesEstado = ""; render();
      }
    }), B("Menu", "", abrirMenu));
  }
}
function segurarBotao(b, fn, ms = 1100) {
  let t0 = null, raf = null;
  const loop = () => {
    const p = Math.min(1, (agora() - t0) / ms);
    b.style.setProperty("--p", p * 100 + "%");
    if (p >= 1) { t0 = null; b.style.setProperty("--p", "0%"); fn(); return; }
    raf = requestAnimationFrame(loop);
  };
  const ini = (e) => { e.preventDefault(); t0 = agora(); loop(); };
  const fim = () => { if (raf) cancelAnimationFrame(raf); if (t0) toast("Segure para encerrar"); t0 = null; b.style.setProperty("--p", "0%"); };
  b.addEventListener("touchstart", ini); b.addEventListener("mousedown", ini);
  b.addEventListener("touchend", fim); b.addEventListener("mouseup", fim); b.addEventListener("mouseleave", () => { if (raf) cancelAnimationFrame(raf); t0 = null; b.style.setProperty("--p", "0%"); });
}

function renderSensores() {
  if (!$("#dlgSensors").open) return;
  const hr = S.hr, cad = S.cad, g = S.gps;
  $("#sHr").textContent = hr.conn ? hr.name + (hrAtual() ? " · " + hrAtual() + " bpm" : " · sem leitura") + (hr.bat != null ? " · bateria " + hr.bat + "%" : "")
                                  : hr.want ? "reconectando " + hr.name + "…" : DEMO ? "simulada" : "desconectado";
  $("#bHr").textContent = hr.dev ? "Desconectar" : "Conectar";
  $("#sCad").textContent = cad.conn ? cad.name + (cad.hasCrank ? " · " + (cadAtual() ?? 0) + " rpm" : "") + (S.whl.has ? " · roda " + fmtKmh(S.whl.speed) + " km/h" : "") + (cad.bat != null ? " · bateria " + cad.bat + "%" : "")
                                    : cad.want ? "reconectando " + cad.name + "…" : DEMO ? "simulada" : "desconectado";
  $("#bCad").textContent = cad.dev ? "Desconectar" : "Conectar";
  $("#sGps").textContent = !g.on ? "desligado" : g.acc == null ? "procurando satélites…" + (g.err ? " (" + g.err + ")" : "")
                           : "precisão ±" + Math.round(g.acc) + " m" + (g.alt != null ? " · altitude " + Math.round(g.alt) + " m" : "");
  $("#bGps").textContent = g.on ? "Ligado" : "Ativar";
  $("#bGps").disabled = g.on;
}

/* ------------------------------------------------------------------------- */
/* Dialogos                                                                   */
/* ------------------------------------------------------------------------- */

function abrir(id) { const d = document.getElementById(id); if (!d.open) d.showModal(); render(); }
document.addEventListener("click", (e) => {
  const c = e.target.closest("[data-close]"); if (c) c.closest("dialog").close();
  const o = e.target.closest("[data-open]"); if (o) abrir("dlg" + o.dataset.open[0].toUpperCase() + o.dataset.open.slice(1));
});
$("#bHr").addEventListener("click", () => (S.hr.dev ? esquecer("hr") : conectar("hr")));
$("#bCad").addEventListener("click", () => (S.cad.dev ? esquecer("cad") : conectar("cad")));
$("#bGps").addEventListener("click", ligarGps);

function abrirMenu() {
  const body = $("#menuBody"); body.innerHTML = "";
  const item = (txt, sub, fn) => {
    const b = document.createElement("button"); b.className = "mItem";
    b.innerHTML = "<b>" + txt + "</b><small>" + sub + "</small>";
    b.addEventListener("click", () => { $("#dlgMenu").close(); fn(); }); body.appendChild(b);
  };
  EXT.menu.forEach((m) => item(m.txt, typeof m.sub === "function" ? m.sub() : m.sub, m.fn));
  item("Sensores", "FC, cadência, GPS", () => abrir("dlgSensors"));
  item("Ajustes", "zonas, alertas, tela · versão " + VERSAO, abrirAjustes);
  if (R.state === "done") item("Resumo do pedal", "e exportar TCX", abrirResumo);
  abrir("dlgMenu");
}

/* Cada página tem 12 espaços (2 colunas x 6 linhas): campo de meia largura
 * ocupa 1, largura inteira 2, altura dupla dobra. */
const ESPACOS = 12;
const espacos = (c) => (c.full ? 2 : 1) * (c.tall ? 2 : 1);
const usados = (pg) => pg.reduce((a, c) => a + espacos(c), 0);

function abrirTroca(p, idx) {
  const pg = cfg.pages[p], campo = pg[idx], atual = campo.k;
  const body = $("#pickBody"); body.innerHTML = "";
  $("#dlgPick h2").textContent = "Página " + (p + 1) + " · campo " + (idx + 1);
  const refazer = (fechar, alvo) => {
    salvarCfg(); montarPaginas();
    if (fechar) $("#dlgPick").close(); else abrirTroca(alvo ? alvo[0] : p, alvo ? alvo[1] : idx);
  };
  const acao = (txt, fn, ok = true) => {
    const b = document.createElement("button");
    b.textContent = txt; b.disabled = !ok; b.className = "acao";
    b.addEventListener("click", fn); body.appendChild(b);
  };
  const livre = ESPACOS - usados(pg);
  const dica = document.createElement("p");
  dica.className = "hint"; dica.style.gridColumn = "span 2"; dica.style.margin = "0 0 4px";
  dica.textContent = pg.length + " campos · " + (ESPACOS - livre) + " de " + ESPACOS + " espaços usados · " + cfg.pages.length + " páginas";
  body.appendChild(dica);

  acao("＋ Campo depois deste", () => {
    const naPagina = new Set(pg.map((c) => c.k));
    const k = ["speed", "dist", "time", "hr", "cad", "avgspeed", "clock", "alt", "grade", "gain"].find((x) => !naPagina.has(x)) || "clock";
    pg.splice(idx + 1, 0, { k });
    refazer(false, [p, idx + 1]);
    toast("Campo novo — escolha abaixo o que ele mostra", 2600);
  }, livre >= 1);
  acao("− Remover este campo", () => { pg.splice(idx, 1); refazer(true); }, pg.length > 1);
  acao(campo.full ? "↔ Meia largura" : "↔ Largura inteira", () => { campo.full = campo.full ? 0 : 1; refazer(false); }, campo.full || livre >= espacos(campo));
  acao(campo.tall ? "↕ Altura simples" : "↕ Altura dupla", () => { campo.tall = campo.tall ? 0 : 1; refazer(false); }, campo.tall || livre >= espacos(campo));
  acao("◀ Mover antes", () => { pg.splice(idx - 1, 0, pg.splice(idx, 1)[0]); refazer(false, [p, idx - 1]); }, idx > 0);
  acao("Mover depois ▶", () => { pg.splice(idx + 1, 0, pg.splice(idx, 1)[0]); refazer(false, [p, idx + 1]); }, idx < pg.length - 1);
  acao("＋ Página nova", () => {
    cfg.pages.splice(p + 1, 0, [{ k: "speed" }, { k: "dist" }, { k: "time" }, { k: "hr" }]);
    S.page = paginasExt().length + p + 1;
    refazer(true);
    toast("Página nova criada — segure um campo para mudar", 3000);
  }, cfg.pages.length < 10);
  acao("Apagar página", () => {
    if (!confirm("Apagar a página " + (p + 1) + " com " + pg.length + " campos?")) return;
    cfg.pages.splice(p, 1);
    S.page = Math.max(0, S.page - 1);
    refazer(true);
  }, cfg.pages.length > 1);

  const h = document.createElement("h3");
  h.textContent = "Mostrar neste campo"; h.style.gridColumn = "span 2";
  body.appendChild(h);
  Object.entries(CAMPOS).forEach(([k, def]) => {
    const b = document.createElement("button");
    b.textContent = def.lb; if (k === atual) b.className = "on";
    b.addEventListener("click", () => {
      campo.k = k;
      if (k === "map") { campo.full = 1; campo.tall = 1; }
      if (k === "zonebar" || CAMPOS[k].full) campo.full = 1;
      if (CAMPOS[k].tall) campo.tall = 1;
      refazer(true);
    });
    body.appendChild(b);
  });
  abrir("dlgPick");
}

function abrirAjustes() {
  const c = cortes();
  const L = (id, rot, dica, input) => '<div class="row"><label for="' + id + '">' + rot + (dica ? "<small>" + dica + "</small>" : "") + "</label>" + input + "</div>";
  const N = (id, v, min, max, step = 1) => '<input type="number" id="' + id + '" value="' + v + '" min="' + min + '" max="' + max + '" step="' + step + '">';
  const C = (id, v) => '<input type="checkbox" id="' + id + '"' + (v ? " checked" : "") + ">";
  $("#settingsBody").innerHTML =
    "<h3>Zonas de FC (Karvonen)</h3>" +
    L("fcmax", "FC máxima", "", N("fcmax", cfg.fcmax, 120, 230)) +
    L("fcrep", "FC de repouso", "", N("fcrep", cfg.fcrep, 30, 100)) +
    '<p class="hint">Z1 ' + c[0] + "–" + (c[1] - 1) + " · Z2 " + c[1] + "–" + (c[2] - 1) + " · Z3 " + c[2] + "–" + (c[3] - 1) +
    " · Z4 " + c[3] + "–" + (c[4] - 1) + " · Z5 " + c[4] + "+</p>" +
    "<h3>Alertas de FC</h3>" +
    L("ceilOn", "Avisar acima de", "3 bipes + vibração depois de 5 s acima", '<span>' + C("ceilOn", cfg.ceilOn) + " " + N("ceil", cfg.ceil, 80, 220) + "</span>") +
    L("floorOn", "Avisar abaixo de", "depois de 20 s abaixo, pedalando", '<span>' + C("floorOn", cfg.floorOn) + " " + N("floor", cfg.floor, 60, 200) + "</span>") +
    "<h3>Pedal</h3>" +
    L("autopause", "Pausa automática", "abaixo da velocidade ao lado (km/h)", '<span>' + C("autopause", cfg.autopause) + " " + N("apKmh", cfg.apKmh, 1, 10) + "</span>") +
    L("avisoSubida", "Avisar subida à frente", "bipe ~400 m antes de subidas de 300 m ou mais, com ou sem rota", C("avisoSubida", cfg.avisoSubida)) +
    L("wheelMm", "Circunferência da roda (mm)", "só com sensor de velocidade · 700x25c 2105 · 700x28c 2136 · 29x2.2 2326", N("wheelMm", cfg.wheelMm, 1000, 2600)) +
    "<h3>Aparelho</h3>" +
    L("wake", "Manter tela ligada", "com a tela apagada o navegador para de gravar", C("wake", cfg.wake)) +
    L("sound", "Bipes", "", C("sound", cfg.sound)) +
    L("vibrate", "Vibrar", "", C("vibrate", cfg.vibrate)) +
    L("theme", "Tema", "claro é melhor sob sol forte", '<select id="theme"><option value="dark"' + (cfg.theme === "dark" ? " selected" : "") + '>Escuro</option><option value="light"' + (cfg.theme === "light" ? " selected" : "") + ">Claro</option></select>") +
    '<p class="hint">Segure qualquer campo da tela para trocá-lo, <b>adicionar ou remover campos</b> (até 12 espaços por página), mudar tamanho e ordem, ou criar e apagar páginas. Deslize para os lados para mudar de página.</p>' +
    '<div class="row"><label>Páginas<small>volta aos campos originais</small></label><button class="x" id="resetPages">Restaurar</button></div>' +
    '<p class="hint">Ciclo ' + VERSAO + (DEMO ? " · modo demonstração" : "") + "</p>";
  const num = (id, def) => { const v = Number($("#" + id).value); return isFinite(v) && v > 0 ? v : def; };
  $("#settingsBody").querySelectorAll("input,select").forEach((el) => el.addEventListener("change", () => {
    cfg.fcmax = num("fcmax", cfg.fcmax); cfg.fcrep = num("fcrep", cfg.fcrep);
    cfg.ceilOn = $("#ceilOn").checked; cfg.ceil = num("ceil", cfg.ceil);
    cfg.floorOn = $("#floorOn").checked; cfg.floor = num("floor", cfg.floor);
    cfg.autopause = $("#autopause").checked; cfg.apKmh = num("apKmh", cfg.apKmh);
    cfg.wheelMm = num("wheelMm", cfg.wheelMm); cfg.avisoSubida = $("#avisoSubida").checked;
    cfg.wake = $("#wake").checked; cfg.sound = $("#sound").checked; cfg.vibrate = $("#vibrate").checked;
    cfg.theme = $("#theme").value;
    document.documentElement.dataset.theme = cfg.theme;
    salvarCfg(); if (cfg.wake) manterTela();
    if (el.id === "fcmax" || el.id === "fcrep") abrirAjustes();
    render();
  }));
  $("#resetPages").addEventListener("click", () => { cfg.pages = JSON.parse(JSON.stringify(PAGINAS_PADRAO)); salvarCfg(); montarPaginas(); toast("Páginas restauradas"); });
  abrir("dlgSettings");
}

/* ------------------------------------------------------------------------- */
/* Resumo e exportacao                                                        */
/* ------------------------------------------------------------------------- */

function abrirResumo() {
  const K = (rot, val) => '<div class="kv"><span>' + rot + '</span><b class="num">' + val + "</b></div>";
  const tot = R.zoneMs.slice(1).reduce((a, b) => a + b, 0);
  const laps = R.laps.map((l) => {
    const d = (l.dist1 ?? R.dist) - l.dist0;
    return "<tr><td>" + l.n + "</td><td class=num>" + fmtT(l.movingMs) + "</td><td class=num>" + fmtKm(d) +
      "</td><td class=num>" + (l.movingMs > 5000 ? fmtKmh(d / (l.movingMs / 1000)) : "--") + "</td><td class=num>" +
      (media(l.hrSum, l.hrN) ?? "--") + "</td><td class=num>" + (media(l.cadSum, l.cadN) ?? "--") + "</td></tr>";
  }).join("");
  $("#summaryBody").innerHTML =
    '<div class="grid2">' +
    K("Distância", fmtKm(R.dist) + " km") + K("Tempo em movimento", fmtT(R.movingMs)) +
    K("Vel. média", R.movingMs > 5000 ? fmtKmh(R.dist / (R.movingMs / 1000)) + " km/h" : "--") + K("Vel. máx", R.maxSpeed ? fmtKmh(R.maxSpeed) + " km/h" : "--") +
    K("FC média / máx", (media(R.hrSum, R.hrN) ?? "--") + " / " + (R.maxHr || "--")) + K("Cadência média", (media(R.cadSum, R.cadN) ?? "--") + " rpm") +
    K("Subida (GPS)", Math.round(R.gain) + " m") + K("Tempo total", fmtT(R.totalMs)) +
    "</div>" +
    '<div class="zb" style="padding:12px 0 0"><div class="bar">' +
    R.zoneMs.slice(1).map((ms, i) => '<span style="width:' + (tot ? (ms / tot) * 100 : 0) + "%;background:" + COR_ZONA[i + 1] + '"></span>').join("") +
    '</div><div class="leg num">' + R.zoneMs.slice(1).map((ms, i) => '<div><span style="color:' + COR_ZONA[i + 1] + ';font-weight:800">Z' + (i + 1) + "</span><b>" + fmtT(ms) + "</b></div>").join("") + "</div></div>" +
    "<table><tr><th>Volta</th><th>Tempo</th><th>km</th><th>km/h</th><th>FC</th><th>Cad</th></tr>" + laps + "</table>" +
    '<div class="grid2" style="margin-top:14px"><button class="btn main" id="bTcx">Baixar TCX</button><button class="btn" id="bShare">Compartilhar</button></div>' +
    '<button class="btn" id="bPc" style="width:100%;margin-top:8px">' + (R.enviado ? "Já enviado ao computador ✓" : "Enviar cadência ao computador") + '</button>' +
    '<p class="hint"><b>Garmin Connect:</b> connect.garmin.com → ícone de nuvem (Importar dados) → escolha o arquivo. ' +
    "<b>Strava:</b> strava.com/upload/select. Os dois corrigem a subida pelo mapa de relevo, que é mais confiável que o GPS do celular.</p>" +
    '<p class="hint">Se usou o Forerunner em Corrida virtual para a FC, descarte essa atividade no relógio para não duplicar o treino.</p>';
  $("#bTcx").addEventListener("click", baixarTcx);
  $("#bShare").addEventListener("click", compartilharTcx);
  $("#bPc").addEventListener("click", () => enviarPedal(true));
  abrir("dlgSummary");
}

function esc(s) { return String(s).replace(/[<&>]/g, (c) => ({ "<": "&lt;", "&": "&amp;", ">": "&gt;" })[c]); }

async function montarTcx() {
  const amostras = await lerAmostras(R.id);
  const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
  const out = ['<?xml version="1.0" encoding="UTF-8"?>',
    '<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2" xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2">',
    '<Activities><Activity Sport="Biking"><Id>' + iso(R.startT) + "</Id>"];
  R.laps.forEach((l, i) => {
    const fim = l.endT ?? R.endT ?? agora();
    const pts = amostras.filter((s) => s.t >= l.startT && (i === R.laps.length - 1 ? true : s.t < fim));
    const dist = (l.dist1 ?? R.dist) - l.dist0;
    out.push('<Lap StartTime="' + iso(l.startT) + '">',
      "<TotalTimeSeconds>" + (l.movingMs / 1000).toFixed(1) + "</TotalTimeSeconds>",
      "<DistanceMeters>" + dist.toFixed(1) + "</DistanceMeters>",
      "<MaximumSpeed>" + (l.maxSpeed || 0).toFixed(2) + "</MaximumSpeed>",
      "<Calories>0</Calories>");
    if (l.hrN) out.push("<AverageHeartRateBpm><Value>" + Math.round(l.hrSum / l.hrN) + "</Value></AverageHeartRateBpm>",
                        "<MaximumHeartRateBpm><Value>" + l.maxHr + "</Value></MaximumHeartRateBpm>");
    out.push("<Intensity>Active</Intensity>");
    if (l.cadN) out.push("<Cadence>" + Math.min(254, Math.round(l.cadSum / l.cadN)) + "</Cadence>");
    out.push("<TriggerMethod>Manual</TriggerMethod><Track>");
    pts.forEach((s) => {
      out.push("<Trackpoint><Time>" + iso(s.t) + "</Time>");
      if (s.la != null) out.push("<Position><LatitudeDegrees>" + s.la + "</LatitudeDegrees><LongitudeDegrees>" + s.lo + "</LongitudeDegrees></Position>");
      if (s.al != null) out.push("<AltitudeMeters>" + s.al + "</AltitudeMeters>");
      out.push("<DistanceMeters>" + s.d + "</DistanceMeters>");
      if (s.hr) out.push("<HeartRateBpm><Value>" + s.hr + "</Value></HeartRateBpm>");
      if (s.cad != null) out.push("<Cadence>" + Math.min(254, s.cad) + "</Cadence>");
      if (s.v != null) out.push("<Extensions><ns3:TPX><ns3:Speed>" + s.v + "</ns3:Speed></ns3:TPX></Extensions>");
      out.push("</Trackpoint>");
    });
    out.push("</Track></Lap>");
  });
  out.push("<Notes>" + esc("Gravado no Ciclo " + VERSAO) + "</Notes></Activity></Activities></TrainingCenterDatabase>");
  const nome = "pedal_" + new Date(R.startT).toISOString().slice(0, 16).replace(/[-:T]/g, "") + ".tcx";
  return { nome, blob: new Blob([out.join("\n")], { type: "application/vnd.garmin.tcx+xml" }), n: amostras.length };
}

async function baixarTcx() {
  const { nome, blob, n } = await montarTcx();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = nome;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast("TCX salvo em Downloads · " + n + " pontos");
}
async function compartilharTcx() {
  const { nome, blob } = await montarTcx();
  const file = new File([blob], nome, { type: "application/octet-stream" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: nome }); } catch {}
  } else baixarTcx();
}

/* ------------------------------------------------------------------------- */
/* Demonstracao                                                               */
/* ------------------------------------------------------------------------- */

function demo() {
  S.hr.conn = true; S.hr.name = "FC simulada"; S.cad.conn = true; S.cad.name = "cadência simulada"; S.cad.hasCrank = true;
  let hr = 118, ang = 0, alt = 540;
  const lat0 = -22.7253, lon0 = -47.6492;
  setInterval(() => {
    const alvo = R.state === "running" ? 142 + 14 * Math.sin(agora() / 90000) : 105;
    hr += (alvo - hr) * 0.08 + (Math.random() - 0.5) * 2;
    S.hr.val = Math.round(hr); S.hr.t = agora();
    S.cad.val = R.state === "running" ? Math.round(86 + Math.random() * 8) : 0; S.cad.tVal = agora();
    if (R.state === "running" || R.state === "idle") {
      const v = R.state === "running" ? 7.8 + Math.random() * 1.2 : 0;
      ang += v / 900;
      alt += Math.sin(ang * 3) * 0.6;
      aoPos({ coords: { latitude: lat0 + Math.sin(ang) * 0.008, longitude: lon0 + Math.cos(ang) * 0.011 - 0.011,
                        accuracy: 6 + Math.random() * 4, speed: v, altitude: alt + (Math.random() - 0.5) * 4 } });
    }
  }, 1000);
  S.gps.on = true;
}

/* ------------------------------------------------------------------------- */
/* Inicio                                                                     */
/* ------------------------------------------------------------------------- */

function restaurar() {
  try {
    const m = JSON.parse(localStorage.getItem("ciclo_ride") || "null");
    if (m && m.startT && m.state !== "idle") {
      R = Object.assign(rideNova(), m);
      if (R.state === "running" || R.state === "autopaused") {
        R.state = "paused";
        const bn = $("#banner");
        bn.textContent = "O pedal em andamento foi recuperado e está pausado. Toque em Retomar.";
        bn.classList.add("on"); setTimeout(() => bn.classList.remove("on"), 9000);
      }
      R.lastTick = agora();
    }
  } catch {}
}

/* Versao nova: o app instalado quase nunca e fechado de verdade, entao ele
 * procura atualizacao sempre que volta para a tela e se recarrega sozinho —
 * menos no meio de um pedal, quando so avisa. */
function vigiarVersao() {
  const tinhaControle = !!navigator.serviceWorker.controller;
  let pendente = false;
  navigator.serviceWorker.register("sw.js").then((reg) => {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      if (pendente && (R.state === "idle" || R.state === "done")) location.reload();
      else reg.update().catch(() => {});
    });
    setInterval(() => reg.update().catch(() => {}), 30 * 60000);
  }).catch(() => {});
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!tinhaControle || pendente) return;
    pendente = true;
    if (R.state === "idle" || R.state === "done") { location.reload(); return; }
    const bn = $("#banner");
    bn.textContent = "Versão nova do Ciclo pronta — atualiza sozinha quando o pedal terminar.";
    bn.classList.add("on"); setTimeout(() => bn.classList.remove("on"), 8000);
  });
}

function iniciarApp() {
  document.documentElement.dataset.theme = cfg.theme;
  restaurar();
  montarPaginas();
  if (DEMO) demo();
  else if (navigator.permissions) {
    navigator.permissions.query({ name: "geolocation" }).then((p) => { if (p.state === "granted") ligarGps(); }).catch(() => {});
  }
  setInterval(tick, 1000);
  window.addEventListener("resize", render);
  window.addEventListener("pagehide", () => { gravarChunk(); salvarMeta(); });
  if ("serviceWorker" in navigator && location.protocol === "https:") vigiarVersao();
  render();
}
document.addEventListener("DOMContentLoaded", iniciarApp);
