/* Ciclo — computador de bordo de ciclismo no navegador.
 *
 * GPS do celular + sensores Bluetooth (FC e cadencia/velocidade, perfis padrao
 * 0x180D e 0x1816). Grava o pedal no IndexedDB a cada 10 s — se o navegador
 * fechar no meio, o pedal volta pausado. Pedal encerrado vai para o Historico
 * (os 30 mais recentes) e exporta TCX, que o Strava e o intervals.icu importam
 * com FC, cadencia e trajeto.
 *
 * ?demo=1 simula FC, cadencia e GPS, para testar sem sair de casa.
 */
"use strict";

const VERSAO = "1.5.0";

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

/* Zonas de FC da bike por limiar (LTHR 164, FCmax 186): teto de Z1..Z5.
 * Cor do campo, tempo em zona e o alerta padrao (Z2 = 139–151) saem daqui. */
const TETOS_ZONA = [138, 151, 158, 165, 186];

const CFG_PADRAO = {
  fcmax: TETOS_ZONA[4], fcrep: 57,
  ceilOn: false, ceil: TETOS_ZONA[1], floorOn: false, floor: TETOS_ZONA[0] + 1,
  autopause: true, apKmh: 3, avisoSubida: true,
  wheelMm: 2105,
  wake: true, vibrate: true, sound: true,
  theme: "dark",
  pages: PAGINAS_PADRAO,
};

function carregarCfg() {
  try {
    const c = JSON.parse(localStorage.getItem("ciclo_cfg") || "{}");
    // uma vez: o que ainda estava no padrao antigo de Karvonen (Z2 134–146, FCmax 185) passa ao padrao por limiar
    if (!c.zonasLimiar) {
      if (c.ceil === 146) delete c.ceil;
      if (c.floor === 134) delete c.floor;
      if (c.fcmax === 185) delete c.fcmax;
    }
    return Object.assign({}, CFG_PADRAO, c, { pages: c.pages || PAGINAS_PADRAO, zonasLimiar: true });
  } catch { return JSON.parse(JSON.stringify(CFG_PADRAO)); }
}
let cfg = carregarCfg();
function salvarCfg() { try { localStorage.setItem("ciclo_cfg", JSON.stringify(cfg)); } catch {} }

/* ------------------------------------------------------------------------- */
/* Estado                                                                     */
/* ------------------------------------------------------------------------- */

const S = {
  // rec: reconexao em curso { n, tm }; caiu: desistiu de reconectar (sem pedal); vez: invalida tentativa antiga
  hr: { dev: null, conn: false, val: null, t: 0, bat: null, want: false, name: "", rec: null, caiu: false, vez: 0, mudo: 0 },
  cad: { dev: null, conn: false, val: 0, tVal: 0, t: 0, bat: null, want: false, name: "", rec: null, caiu: false, vez: 0,
         lastRevs: null, lastTime: null, hasCrank: false },
  whl: { has: false, speed: 0, tVal: 0, lastRevs: null, lastTime: null },
  gps: { watch: null, on: false, acc: null, t: 0, lat: null, lon: null, alt: null, speed: 0, last: null, err: "" },
  page: 0, trava: false,
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
const LACUNA_MS = 10000;   // mais que isso sem tick (tela apagada, navegador suspenso) e lacuna, nao pedal
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
/* Um <dialog> modal fica na camada de topo do navegador e cobria o aviso: com
 * dialogo aberto, o aviso entra no que foi aberto por ultimo. */
let ordemDlg = 0;
function dialogoDoTopo() {
  let topo = null;
  document.querySelectorAll("dialog[open]").forEach((d) => { if (!topo || (d._ord || 0) > (topo._ord || 0)) topo = d; });
  return topo;
}
function toast(msg, ms = 2200) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("on");
  const casa = dialogoDoTopo() || document.body;
  if (t.parentNode !== casa) casa.appendChild(t);
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("on"), ms);
}
document.addEventListener("close", (e) => {          // o dialogo fechou com o aviso dentro: o aviso sai junto
  const t = $("#toast");
  if (e.target && e.target.contains && e.target.contains(t)) (dialogoDoTopo() || document.body).appendChild(t);
}, true);
function dataPedal(t) {
  const d = new Date(t), p = (n) => String(n).padStart(2, "0");
  return ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"][d.getDay()] + " " + p(d.getDate()) + "/" + p(d.getMonth() + 1) +
    (d.getFullYear() !== new Date().getFullYear() ? "/" + d.getFullYear() : "") + " · " + p(d.getHours()) + ":" + p(d.getMinutes());
}

/* zonas por limiar: piso de cada zona, tirado dos tetos (Z1 vale para qualquer FC ate o primeiro teto) */
function cortes() {
  return [1].concat(TETOS_ZONA.slice(0, 4).map((x) => x + 1));
}
function zonaDe(hr) {
  if (!hr) return 0;
  const c = cortes();
  for (let i = 4; i >= 0; i--) if (hr >= c[i]) return i + 1;
  return 0;
}
const COR_ZONA = ["var(--z0)", "var(--z1)", "var(--z2)", "var(--z3)", "var(--z4)", "var(--z5)"];
/* texto sobre a cor da zona: escuro nas zonas claras, branco so no vermelho (contraste >= 4,5:1 ao sol) */
const TXT_ZONA = ["", "var(--zt1)", "var(--zt2)", "var(--zt3)", "var(--zt4)", "var(--zt5)"];
const rotuloZona = (i) => '<span class="zl" style="background:' + COR_ZONA[i] + ";color:" + TXT_ZONA[i] + '">Z' + i + "</span>";

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
const emAndamento = () => R.state === "running" || R.state === "autopaused" || R.state === "paused";
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

/* Tela ligada (Wake Lock). O sistema solta a trava sempre que a pagina fica
 * oculta, entao ela e pedida ao iniciar o pedal, de novo a cada volta para a
 * tela (visibilitychange) e, com pedal rodando, de novo pelo tick se tiver
 * caido. Se o aparelho recusar (economia de bateria), avisa uma vez. */
let wl = null, wlPedindo = false, wlAvisou = false, wlT = 0;
async function manterTela() {
  if (!cfg.wake || !("wakeLock" in navigator) || wl || wlPedindo || document.visibilityState !== "visible") return;
  wlPedindo = true; wlT = agora();
  try {
    const w = await navigator.wakeLock.request("screen");
    wl = w; wlAvisou = false;
    w.addEventListener("release", () => { if (wl === w) wl = null; });
  } catch {
    if (!wlAvisou && emAndamento()) {
      wlAvisou = true;
      toast("Não consegui manter a tela ligada (economia de bateria?). Com a tela apagada o pedal para de gravar.", 7000);
    }
  }
  wlPedindo = false;
}
function soltarTela() { const w = wl; wl = null; if (w) w.release().catch(() => {}); }
/* O relogio (Amazfit T-Rex 3 Pro) disputa a conexao
 * Bluetooth com o app do fabricante. Se o Chrome segurar a conexao de FC com o
 * app fechado, o Zepp pode parar de sincronizar o relogio. Entao, sem pedal em andamento, sair do app solta os sensores — e
 * encerrar o pedal tambem. Com pedal gravando, a conexao fica. */
function soltarSensores(motivo) {
  let soltou = false;
  ["hr", "cad"].forEach((k) => { if (S[k].dev || S[k].want) { esquecer(k); soltou = true; } });
  if (soltou && motivo) toast(motivo);
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") { manterTela(); retomarSensores(); tick(); return; }
  if (R.state === "idle" || R.state === "done") soltarSensores();
  else { gravarChunk(); salvarMeta(); }              // saiu da tela com pedal em andamento: garante o que ja foi medido
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
  const s = S[tipo];
  try {
    // O Amazfit T-Rex 3 Pro nem sempre poe o servico de FC
    // no anuncio Bluetooth, so o nome: o filtro por servico nao o lista. Para a
    // FC, aceita tambem pelo nome e pede o servico como opcional.
    const filtros = [{ services: [BLE[tipo].svc] }];
    if (tipo === "hr") ["Amazfit", "T-Rex", "Zepp"].forEach((n) => filtros.push({ namePrefix: n }));
    const dev = await navigator.bluetooth.requestDevice({
      filters: filtros, optionalServices: [BLE[tipo].svc, "battery_service"],
    });
    pararRec(tipo);
    s.dev = dev; s.want = false; s.caiu = false; s.name = dev.name || "sensor";
    dev.addEventListener("gattserverdisconnected", () => { if (s.dev === dev) desconectou(tipo); });
    await abrirGatt(tipo);
    s.want = true;            // so depois de conectar: falha na primeira conexao nao dispara reconexao
    toast(BLE[tipo].nome + " conectada: " + s.name);
  } catch (e) {
    if (s.dev && !s.conn) esquecer(tipo);
    if (e && e.name !== "NotFoundError") toast("Não conectou: " + (e.message || e), 5000);
  }
  render();
}

async function abrirGatt(tipo) {
  const s = S[tipo], dev = s.dev, vez = ++s.vez;
  // tentativa vencida (passou do prazo, ou o sensor foi esquecido no meio) nao pode marcar "conectado"
  const vale = () => { if (s.dev !== dev || s.vez !== vez) throw new Error("tentativa cancelada"); };
  const srv = await dev.gatt.connect(); vale();
  let svc;
  try { svc = await srv.getPrimaryService(BLE[tipo].svc); }
  catch (e) {
    try { srv.disconnect(); } catch {}
    if (tipo === "hr") throw new Error("o relógio não está transmitindo FC. Ligue a transmissão de frequência cardíaca no relógio e tente de novo");
    throw e;
  }
  vale();
  const ch = await svc.getCharacteristic(BLE[tipo].ch);
  await ch.startNotifications(); vale();
  ch.addEventListener("characteristicvaluechanged", tipo === "hr" ? aoFc : aoCsc);
  s.conn = true; s.caiu = false;
  try {
    const b = await srv.getPrimaryService("battery_service");
    const bc = await b.getCharacteristic("battery_level");
    s.bat = (await bc.readValue()).getUint8(0);
  } catch {}
  render();
}

/* Reconexao. O sensor caiu: um aviso so (bipe + vibracao), "reconectando…" no
 * campo, e tentativas espacadas — 2, 5, 10 e 20 s; depois, a cada 30 s enquanto
 * houver pedal em andamento. Sem pedal, para depois da quarta, mostra "sem
 * sinal" e volta a tentar quando o pedal comecar ou o app voltar para a tela.
 * Cada tentativa tem prazo: o connect() do Bluetooth pode ficar pendurado sem
 * responder, e antes isso parava a fila em silencio. Quando volta, outro aviso. */
const ESPERAS_REC = [2000, 5000, 10000, 20000], ESPERA_REC_PEDAL = 30000, PRAZO_GATT = 15000;

function comPrazo(p, ms) {
  let tm;
  return Promise.race([p, new Promise((_, rej) => { tm = setTimeout(() => rej(new Error("sem resposta")), ms); })])
    .finally(() => clearTimeout(tm));
}
function pararRec(tipo) { const s = S[tipo]; if (s.rec) clearTimeout(s.rec.tm); s.rec = null; }

function desconectou(tipo) {
  const s = S[tipo];
  s.conn = false;
  if (!s.want || s.rec) { render(); return; }       // ele mesmo desligou, ou ja esta reconectando: sem segundo aviso
  s.caiu = false;
  s.rec = { n: 0, tm: null };
  beep(392, 220, 2);
  toast(BLE[tipo].nome + " caiu — reconectando", 4000);
  agendarRec(tipo);
  render();
}
function agendarRec(tipo) {
  const s = S[tipo];
  if (!s.rec) return;
  clearTimeout(s.rec.tm);
  s.rec.tm = setTimeout(() => tentarRec(tipo), s.rec.n < ESPERAS_REC.length ? ESPERAS_REC[s.rec.n] : ESPERA_REC_PEDAL);
}
async function tentarRec(tipo) {
  const s = S[tipo], rec = s.rec;
  if (!rec || !s.want || !s.dev) return;
  rec.n++;
  let ok = false;
  try { await comPrazo(abrirGatt(tipo), PRAZO_GATT); ok = true; }
  catch {
    s.vez++;                                          // se a tentativa ainda estiver pendurada, fica sem efeito
    try { s.dev && s.dev.gatt.disconnect(); } catch {}
  }
  if (s.rec !== rec) return;                          // o sensor foi esquecido (ou trocado) no meio da tentativa
  if (ok) {
    s.rec = null;
    beep(1047, 120, 1);
    toast(BLE[tipo].nome + " voltou: " + s.name, 3000);
  } else if (rec.n >= ESPERAS_REC.length && !emAndamento()) {
    s.rec = null; s.caiu = true;
    toast(BLE[tipo].nome + " não reconectou. Toque em " + (tipo === "hr" ? "FC" : "CAD") + " lá em cima para tentar de novo.", 6000);
  } else agendarRec(tipo);
  render();
}
/* sensor que ele quer e que ficou para tras (desistiu sem pedal): recomeca a sequencia */
function retomarSensores() {
  ["hr", "cad"].forEach((k) => {
    const s = S[k];
    if (s.want && s.dev && !s.conn && !s.rec) { s.caiu = false; s.rec = { n: 0, tm: null }; agendarRec(k); }
  });
  render();
}
/* o que o campo mostra no lugar da unidade quando o sensor nao esta entregando */
function estadoSensor(tipo) {
  const s = S[tipo];
  if (s.rec) return "reconectando…";
  if (s.caiu) return "sem sinal · toque em " + (tipo === "hr" ? "FC" : "CAD");
  if (tipo === "hr" && s.conn && !DEMO && !hrAtual()) return "sem leitura";
  return "";
}

function esquecer(tipo) {
  const s = S[tipo];
  s.want = false; pararRec(tipo); s.vez++;
  try { s.dev && s.dev.gatt.disconnect(); } catch {}
  s.dev = null; s.conn = false; s.bat = null; s.name = ""; s.caiu = false;
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
  if (t - R.lastTick > LACUNA_MS) S.gps.last = null;  // voltando de uma lacuna: nao liga os dois pontos em linha reta
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
  // por relevo do Strava na importacao.
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
    const r = indexedDB.open("ciclo", 3);
    r.onupgradeneeded = () => {
      const d = r.result, tem = (n) => d.objectStoreNames.contains(n);
      if (!tem("chunks")) d.createObjectStore("chunks", { keyPath: ["ride", "i"] });
      if (!tem("rotas")) d.createObjectStore("rotas", { keyPath: "id" });
      if (!tem("treinos")) d.createObjectStore("treinos", { keyPath: "id" });
      if (!tem("pedais")) d.createObjectStore("pedais", { keyPath: "id" });
    };
    r.onsuccess = () => {
      r.result.onversionchange = () => { r.result.close(); dbp = null; };   // versao nova do app pede o banco: solta
      res(r.result);
    };
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
  try { await noBanco("chunks", "readwrite", (st) => st.delete(IDBKeyRange.bound([rideId, 0], [rideId, Infinity]))); } catch {}
}
/* Meta do pedal em andamento: contadores e voltas, sem o trajeto nem o
 * historico de altitude — os dois pesam ~150 kB num pedal longo, iam inteiros
 * para o disco a cada 5 s e se refazem das amostras (refazerTrajeto). A meta
 * vai junto de cada bloco de amostras (10 s) e, parado, a cada ~13 s pelo
 * tick: num fechamento brusco perde-se no maximo ~10 s de pedal. */
const semPeso = (k, v) => (k === "track" || k === "altHist" ? undefined : v);
let metaT = 0;
function salvarMeta() {
  metaT = agora();
  try { localStorage.setItem("ciclo_ride", JSON.stringify(R, semPeso)); } catch {}
}
async function refazerTrajeto() {
  const id = R.id, vazio = !R.track.length, semAlt = !R.altHist.length;
  if (!vazio && !semAlt) return;
  try {
    const am = await lerAmostras(id);
    if (R.id !== id) return;
    let tr = [];
    const ah = [];
    for (const s of am) {
      if (s.la != null && (!tr.length || hav(tr[tr.length - 1], { lat: s.la, lon: s.lo }) > 12)) tr.push({ lat: s.la, lon: s.lo });
      if (s.al != null) ah.push([s.d, s.al]);
    }
    while (tr.length > 3000) tr = tr.filter((_, i) => i % 2 === 0);
    if (vazio) R.track = tr.concat(R.track);
    if (semAlt) R.altHist = ah.slice(-900).concat(R.altHist);
    render();
  } catch (e) { console.error(e); }
}

/* ------------------------------------------------------------------------- */
/* Historico (IndexedDB "pedais")                                             */
/* ------------------------------------------------------------------------- */

/* Cada pedal encerrado vira um registro { id, r, envio, tent, erro }. "r" e a
 * meta leve (totais e voltas); as amostras continuam nos blocos de "chunks"
 * com o mesmo id, e e delas que o TCX sai de novo. Ficam os 30 mais recentes;
 * o que passa disso sai junto com as amostras. O pedal em andamento nao entra
 * aqui: segue em localStorage + blocos, como sempre, e entra ao encerrar.
 * envio: "pendente" (a enviar ao computador), "enviado" ou "sem" (nada a enviar). */
const HIST_MAX = 30;
const HIST = { n: 0, pend: 0 };

async function noBanco(nome, modo, fn) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction(nome, modo);
    const q = fn(tx.objectStore(nome));
    tx.oncomplete = () => res(q && "result" in q ? q.result : undefined);
    tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
  });
}
const histLer = (id) => noBanco("pedais", "readonly", (st) => st.get(id));
const histGravar = (p) => noBanco("pedais", "readwrite", (st) => st.put(p));
async function histTodos() {
  const l = (await noBanco("pedais", "readonly", (st) => st.getAll())).sort((a, b) => b.r.startT - a.r.startT);
  HIST.n = l.length; HIST.pend = l.filter((p) => p.envio === "pendente").length;
  return l;
}
async function histApagar(id) {
  await noBanco("pedais", "readwrite", (st) => st.delete(id));
  await apagarPedal(id);
}

async function guardarNoHistorico(r = R) {
  if (!r || !r.startT) return false;
  const meta = JSON.parse(JSON.stringify(r, semPeso));   // copia ja, antes de qualquer espera: R pode virar outro pedal
  meta.guardado = true;
  try {
    const ja = await histLer(meta.id);
    const reg = Object.assign({ envio: DEMO ? "sem" : "pendente", tent: 0, erro: "" }, ja, { id: meta.id, r: meta });
    if (meta.enviado) reg.envio = "enviado";
    await histGravar(reg);
    for (const p of (await histTodos()).slice(HIST_MAX)) if (p.id !== R.id) await histApagar(p.id);
    await histTodos();
    if (R.id === meta.id && !R.guardado) { R.guardado = true; salvarMeta(); }
    return true;
  } catch (e) { console.error(e); return false; }
}

/* Primeira abertura depois da 1.5: o pedal que estava guardado no formato
 * antigo (um so: meta em localStorage + blocos) entra no historico, com as
 * amostras onde ja estavam. Tambem cobre o pedal encerrado cuja gravacao no
 * historico falhou. Pedal em andamento nao e mexido. */
let histPronto = Promise.resolve(false);
async function migrarPedalAntigo() {
  if (R.state !== "done" || !R.startT || R.guardado) return false;
  const id = R.id;
  if (!(await guardarNoHistorico(R))) return false;
  // a versao antiga ja tentou enviar este pedal ao encerrar: conta como tentativa, para o
  // primeiro envio daqui conferir no GitHub antes de postar (nao duplicar o que foi aceito)
  try { const p = await histLer(id); if (p && p.envio === "pendente" && !p.tent) { p.tent = 1; await histGravar(p); } } catch {}
  return true;
}

/* Pede ao navegador para nao apagar o IndexedDB quando faltar espaco. Nao
 * aparece pergunta: o Chrome decide sozinho (app instalado costuma ganhar).
 * Concedido, nao pede mais; negado, tenta de novo so na proxima abertura. */
let persistPedido = false;
async function pedirPersistencia() {
  if (persistPedido || !navigator.storage || !navigator.storage.persist) return;
  persistPedido = true;
  try {
    if (localStorage.getItem("ciclo_persist") === "1") return;
    if ((navigator.storage.persisted && (await navigator.storage.persisted())) || (await navigator.storage.persist())) {
      localStorage.setItem("ciclo_persist", "1");
    }
  } catch {}
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
  if (R.state === "done") { if (!R.guardado) guardarNoHistorico(R); R = rideNova(); buf = []; }
  if (R.state === "idle") { R.startT = agora(); novaVolta(R.startT); }
  R.state = "running"; R.lastTick = agora(); R.slowS = 0;
  beep(988, 120, 1);
  EXT.iniciar.forEach((f) => f());
  salvarMeta(); retomarSensores();
}
function pausar() { R.state = "paused"; beep(660, 160, 1); gravarChunk(); salvarMeta(); render(); }
/* Pedal novo: o anterior ja esta no Historico (so pergunta se a gravacao la falhou). */
async function novoPedal() {
  if (R.state !== "done") return;
  if (!R.guardado && !(await guardarNoHistorico(R))) {
    if (!confirm("Não consegui guardar este pedal no Histórico. Começar um novo mesmo assim? Ele some do celular — baixe o TCX antes.")) return;
    apagarPedal(R.id);
  }
  R = rideNova(); buf = []; salvarMeta(); controlesEstado = ""; render();
}
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
  await guardarNoHistorico(R);                       // antes do envio: a fila "a enviar" mora no historico
  beep(784, 200, 2);
  EXT.encerrar.forEach((f) => f());
  soltarSensores("Sensores desconectados — o relógio volta a sincronizar com o Zepp");
  render(); abrirResumo();
}

/* ------------------------------------------------------------------------- */
/* Relogio de 1 s                                                             */
/* ------------------------------------------------------------------------- */

const alerta = { acima: 0, abaixo: 0 };

function tick() {
  const t = agora();
  if (R.state === "running" || R.state === "autopaused") {
    // Tela apagada ou navegador suspenso: mais de 10 s sem tick e lacuna. Entra so
    // no tempo total; nao conta como tempo pedalando, de volta nem em zona, e o GPS
    // recomeca do ponto novo (sem somar a distancia em linha reta).
    const decorrido = Math.max(0, t - R.lastTick);
    const lacuna = decorrido > LACUNA_MS;
    const dt = lacuna ? 0 : decorrido;
    R.totalMs += decorrido;
    if (lacuna) {
      S.gps.last = null;
      if (R.state === "running") toast("Ficou " + fmtT(decorrido) + " sem gravar (tela apagada?) — esse trecho não entra no tempo nem na distância", 6000);
    }
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

    // FC conectada mas muda (o relogio parou de transmitir sem derrubar a conexao): avisa uma vez, e quando volta
    if (S.hr.conn && !DEMO && R.state === "running" && !lacuna) {
      if (hr) { if (S.hr.mudo >= 15) { beep(1047, 120, 1); toast("FC voltou"); } S.hr.mudo = 0; }
      else if (++S.hr.mudo === 15) { beep(392, 220, 2); toast("FC sem leitura — confira a transmissão no relógio", 5000); }
    } else if (!S.hr.conn) S.hr.mudo = 0;

    if (t - metaT > 12000) salvarMeta();              // rodando, quem grava e o bloco de amostras; isto cobre o tempo parado
    if (!wl && t - wlT > 20000) manterTela();
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
  hr:        { lb: "FC", u: () => estadoSensor("hr") || "bpm", aviso: () => !!estadoSensor("hr"), v: () => hrAtual() ?? "--", zona: () => zonaDe(hrAtual()), stale: () => !hrAtual() },
  hrzone:    { lb: "Zona", u: "limiar", v: () => (hrAtual() ? "Z" + zonaDe(hrAtual()) : "--"), zona: () => zonaDe(hrAtual()) },
  hrpct:     { lb: "% FC reserva", u: "%", v: () => { const h = hrAtual(); return h ? Math.round(((h - cfg.fcrep) / (cfg.fcmax - cfg.fcrep)) * 100) : "--"; } },
  avghr:     { lb: "FC média", u: "bpm", v: () => media(R.hrSum, R.hrN) ?? "--" },
  maxhr:     { lb: "FC máx", u: "bpm", v: () => R.maxHr || "--" },
  hrTarget:  { lb: "Alerta FC", u: "bpm", v: () => (cfg.ceilOn ? "≤" + cfg.ceil : cfg.floorOn ? "≥" + cfg.floor : "off") },
  cad:       { lb: "Cadência", u: () => estadoSensor("cad") || "rpm", aviso: () => !!estadoSensor("cad"), v: () => cadAtual() ?? "--", stale: () => cadAtual() == null },
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
      segurar(el, () => abrirTroca(p, idx), 650, podeEditarCampos);
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

/* Com o pedal rodando, segurar um campo nao abre o editor: suor, chuva e luva
 * seguram a tela sozinhos. Para editar, pause. */
function podeEditarCampos() {
  if (R.state !== "running" && R.state !== "autopaused") return true;
  toast("Pause o pedal para editar os campos", 1800);
  return false;
}
function segurar(el, fn, ms = 650, pode = null) {
  let tm = null;
  const ini = () => { tm = setTimeout(() => { tm = null; if (pode && !pode()) return; if (navigator.vibrate) navigator.vibrate(30); fn(); }, ms); };
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

/* Mapa (bateria): mexer no Leaflet e redesenhar todo segundo custa caro e nao
 * muda nada que se veja. Redesenha no maximo a cada 3 s, e so se a posicao
 * andou o bastante para aparecer (6 m); na hora quando muda o que e desenhado
 * (pedal, rota, camada, tema, tamanho) e, parado, uma vez a cada 30 s. Quem
 * chama so chama para a pagina que esta na tela. */
const MAPA_MS = 3000, MAPA_M = 6, MAPA_PARADO_MS = 30000;
function mapaMudou(el, extra = "") {
  const t = agora(), g = S.gps, a = el._mapa, temRota = typeof ROTA !== "undefined";
  const chave = [R.id, R.state === "done", temRota && ROTA.ativa ? ROTA.ativa.id : "", temRota ? ROTA.camada : "",
                 cfg.theme, el.clientWidth, el.clientHeight, g.lat != null, extra].join("|");
  if (a && a.chave === chave) {
    if (t - a.t < MAPA_MS) return false;
    const andou = g.lat != null && a.lat != null && hav(a, g) >= MAPA_M;
    if (!andou && t - a.t < MAPA_PARADO_MS) return false;
  }
  el._mapa = { chave, t, lat: g.lat, lon: g.lon };
  return true;
}

function render() {
  if (document.hidden) return;                       // pagina oculta: nada na tela para atualizar
  const t = agora();
  $("#clock").textContent = new Date().toTimeString().slice(0, 5);

  // status
  const g = S.gps;
  if (!g.on) chip($("#cGps"), "", "GPS off");
  else if (g.acc == null || t - g.t > 10000) chip($("#cGps"), "bad", "GPS …");
  else chip($("#cGps"), g.acc <= 15 ? "ok" : g.acc <= 35 ? "warn" : "bad", "GPS ±" + Math.round(g.acc));
  chip($("#cHr"), hrAtual() ? "ok" : S.hr.conn ? "warn" : S.hr.want ? "bad" : "", hrAtual() ? "FC " + hrAtual() : S.hr.rec ? "FC …" : S.hr.caiu ? "FC ✕" : "FC");
  chip($("#cCad"), S.cad.conn ? "ok" : S.cad.want ? "bad" : "",
       S.cad.conn ? (S.whl.has && !S.cad.hasCrank ? "VEL" : "CAD") : S.cad.rec ? "CAD …" : S.cad.caiu ? "CAD ✕" : "CAD");
  const rec = $("#rec");
  rec.className = { running: "run", paused: "pause", autopaused: "auto" }[R.state] || "";
  rec.textContent = { running: "● REC", paused: "PAUSADO", autopaused: "PAUSA AUTO", done: "FIM" }[R.state] || "";

  // campos da pagina visivel (e das vizinhas, para o deslize nao mostrar vazio);
  // mapa, perfil e barras, que custam mais, so na pagina que esta na tela
  document.querySelectorAll('.page').forEach((sec) => {
    const p = Number(sec.dataset.p), naTela = p === S.page;
    if (Math.abs(p - S.page) > 1) return;
    if (sec.dataset.ext) {
      const x = EXT.paginas.find((e) => e.nome === sec.dataset.ext);
      if (x) { try { x.atualizar(sec, naTela); } catch (e) { console.error(e); } }
      return;
    }
    sec.querySelectorAll(".f").forEach((el) => {
      const def = CAMPOS[el.dataset.k] || CAMPOS.dist;
      if (def.especial === "mapa") { if (naTela && mapaMudou(el)) desenharMapa(el.querySelector("canvas")); return; }
      if (def.desenhar) { if (naTela) def.desenhar(el); return; }
      if (def.especial === "zonas") { if (naTela) desenharZonas(el); return; }
      el.querySelector(".v").textContent = def.v();
      el.querySelector(".u").textContent = typeof def.u === "function" ? def.u() : def.u;
      el.classList.toggle("stale", !!(def.stale && def.stale()));
      el.classList.toggle("aviso", !!(def.aviso && def.aviso()));
      const z = def.zona ? def.zona() : null;
      if (z) { el.style.background = COR_ZONA[z]; el.style.color = TXT_ZONA[z]; el.classList.add("zoned"); }
      else { el.style.background = ""; el.style.color = ""; el.classList.remove("zoned"); }
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
    "<div>" + rotuloZona(i + 1) + "<b>" + fmtT(ms) +
    '</b><small style="color:var(--mute)">' + (i === 0 ? "≤" + (c[1] - 1) : c[i] + (i < 4 ? "–" + (c[i + 1] - 1) : "+")) + '</small></div>').join("");
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
  if (S.trava && !emAndamento()) travar(false);
  // rodando e em pausa automatica tem os mesmos botoes: nao refaz (trocar o botao debaixo do dedo perdia o toque)
  const andando = R.state === "running" || R.state === "autopaused";
  const st = (andando ? "andando" : R.state) + "|" + (R.laps.length ? 1 : 0) + "|" + (typeof treinoAtivo === "function" && treinoAtivo() ? 1 : 0);
  if (st === controlesEstado) return;
  controlesEstado = st;
  const f = $("#controls");
  // livre: botao que continua valendo com a tela travada
  const B = (txt, cls, fn, livre = false) => {
    const b = document.createElement("button"); b.className = "btn " + cls; b.textContent = txt;
    if (fn) b.addEventListener("click", fn); if (livre) b.setAttribute("data-livre", ""); return b;
  };
  f.innerHTML = "";
  f.classList.toggle("c4", emAndamento());
  if (R.state === "idle") {
    f.append(B("Sensores", "", () => abrir("dlgSensors")), B("▶ INICIAR", "main", iniciar), B("Menu", "", abrirMenu));
  } else if (andando) {
    f.append(B(typeof treinoAtivo === "function" && treinoAtivo() ? "Próximo" : "Volta", "", volta, true), B("❚❚ PAUSAR", "pause", pausar, true), cadeado(), B("Menu", "", abrirMenu));
  } else if (R.state === "paused") {
    const fim = B("■ Encerrar", "stop hold");
    segurarBotao(fim, encerrar);
    f.append(fim, B("▶ RETOMAR", "main", iniciar, true), cadeado(), B("Menu", "", abrirMenu));
  } else if (R.state === "done") {
    f.append(B("Resumo", "", () => abrirResumo()), B("NOVO PEDAL", "main", novoPedal), B("Menu", "", abrirMenu));
  }
}

/* Trava de tela. Suor, chuva e luva tocam na tela sozinhos: travada, ela so
 * obedece a Volta, Pausar/Retomar e ao proprio cadeado. Um toque no cadeado
 * trava; segurar o cadeado 1,5 s destrava. So existe com pedal em andamento e
 * sai sozinha quando ele termina. */
const TRAVA_MS = 1500;
let bTrava = null;
function travar(sim) {
  S.trava = !!sim;
  document.body.classList.toggle("travado", S.trava);
  if (!bTrava) return;
  bTrava.textContent = S.trava ? "🔒" : "🔓";
  bTrava.classList.toggle("on", S.trava);
  bTrava.setAttribute("aria-label", S.trava ? "Tela travada: segure para destravar" : "Travar a tela");
  bTrava.style.setProperty("--p", "0%");
}
function cadeado() {
  if (bTrava) return bTrava;
  const b = bTrava = document.createElement("button");
  b.id = "bTrava"; b.className = "btn hold"; b.textContent = "🔓"; b.setAttribute("aria-label", "Travar a tela");
  let t0 = null, raf = null, engole = false;
  const parar = () => { if (raf) cancelAnimationFrame(raf); raf = null; t0 = null; b.style.setProperty("--p", "0%"); };
  const loop = () => {
    const p = Math.min(1, (agora() - t0) / TRAVA_MS);
    b.style.setProperty("--p", p * 100 + "%");
    if (p >= 1) {
      parar(); engole = true; travar(false);
      if (navigator.vibrate) navigator.vibrate(60);
      toast("Tela destravada");
      return;
    }
    raf = requestAnimationFrame(loop);
  };
  const ini = (e) => { engole = false; if (!S.trava) return; e.preventDefault(); t0 = agora(); loop(); };
  const fim = () => { if (t0 && S.trava) toast("Segure o cadeado 1,5 s para destravar"); parar(); };
  b.addEventListener("touchstart", ini); b.addEventListener("mousedown", ini);
  b.addEventListener("touchend", fim); b.addEventListener("touchcancel", parar);
  b.addEventListener("mouseup", fim); b.addEventListener("mouseleave", parar);
  b.addEventListener("click", () => {
    if (S.trava || engole) { engole = false; return; }   // o clique que sobra do mesmo aperto que destravou (mouse)
    travar(true);
    if (navigator.vibrate) navigator.vibrate(30);
    toast("Tela travada. Segure o cadeado 1,5 s para destravar.", 3500);
  });
  return b;
}
/* Travada: o toque morre aqui, antes de chegar a qualquer campo, mapa, pagina ou botao. */
["touchstart", "pointerdown", "mousedown", "click", "dblclick", "contextmenu"].forEach((ev) =>
  document.addEventListener(ev, (e) => {
    if (!S.trava || (e.target && e.target.closest && e.target.closest("#bTrava,[data-livre]"))) return;
    e.stopPropagation();
    if (e.cancelable) e.preventDefault();
    if (bTrava) { bTrava.classList.add("pisca"); clearTimeout(travar._t); travar._t = setTimeout(() => bTrava.classList.remove("pisca"), 500); }
  }, { capture: true, passive: false }));
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
                                  : hr.rec ? "reconectando " + hr.name + "… (tentativa " + (hr.rec.n + 1) + ")" : hr.caiu ? hr.name + " não reconectou"
                                  : DEMO ? "simulada" : "desconectado";
  $("#bHr").textContent = hr.caiu ? "Tentar de novo" : hr.dev ? "Desconectar" : "Conectar";
  $("#sCad").textContent = cad.conn ? cad.name + (cad.hasCrank ? " · " + (cadAtual() ?? 0) + " rpm" : "") + (S.whl.has ? " · roda " + fmtKmh(S.whl.speed) + " km/h" : "") + (cad.bat != null ? " · bateria " + cad.bat + "%" : "")
                                    : cad.rec ? "reconectando " + cad.name + "… (tentativa " + (cad.rec.n + 1) + ")" : cad.caiu ? cad.name + " não reconectou"
                                    : DEMO ? "simulada" : "desconectado";
  $("#bCad").textContent = cad.caiu ? "Tentar de novo" : cad.dev ? "Desconectar" : "Conectar";
  $("#sGps").textContent = !g.on ? "desligado" : g.acc == null ? "procurando satélites…" + (g.err ? " (" + g.err + ")" : "")
                           : "precisão ±" + Math.round(g.acc) + " m" + (g.alt != null ? " · altitude " + Math.round(g.alt) + " m" : "");
  $("#bGps").textContent = g.on ? "Ligado" : "Ativar";
  $("#bGps").disabled = g.on;
}

/* ------------------------------------------------------------------------- */
/* Dialogos                                                                   */
/* ------------------------------------------------------------------------- */

function abrir(id) { const d = document.getElementById(id); if (!d.open) d.showModal(); d._ord = ++ordemDlg; render(); }
document.addEventListener("click", (e) => {
  const c = e.target.closest("[data-close]"); if (c) c.closest("dialog").close();
  const o = e.target.closest("[data-open]"); if (o) abrir("dlg" + o.dataset.open[0].toUpperCase() + o.dataset.open.slice(1));
});
$("#bHr").addEventListener("click", () => (S.hr.caiu ? retomarSensores() : S.hr.dev ? esquecer("hr") : conectar("hr")));
$("#bCad").addEventListener("click", () => (S.cad.caiu ? retomarSensores() : S.cad.dev ? esquecer("cad") : conectar("cad")));
$("#bGps").addEventListener("click", ligarGps);

function abrirMenu() {
  const body = $("#menuBody"); body.innerHTML = "";
  const item = (txt, sub, fn) => {
    const b = document.createElement("button"); b.className = "mItem";
    b.innerHTML = "<b>" + esc(txt) + "</b><small>" + esc(sub) + "</small>";
    b.addEventListener("click", () => { $("#dlgMenu").close(); fn(); }); body.appendChild(b);
  };
  EXT.menu.forEach((m) => item(m.txt, typeof m.sub === "function" ? m.sub() : m.sub, m.fn));
  item("Sensores", "FC, cadência, GPS", () => abrir("dlgSensors"));
  item("Ajustes", "zonas, alertas, tela · versão " + VERSAO, abrirAjustes);
  if (R.state === "done") item("Resumo do pedal", "e exportar TCX", () => abrirResumo());
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
    "<h3>Zonas de FC (limiar)</h3>" +
    '<p class="hint">Por limiar (LTHR 164): Z1 até ' + (c[1] - 1) + " · Z2 " + c[1] + "–" + (c[2] - 1) + " · Z3 " + c[2] + "–" + (c[3] - 1) +
    " · Z4 " + c[3] + "–" + (c[4] - 1) + " · Z5 " + c[4] + "+</p>" +
    L("fcmax", "FC máxima", "só para o campo % FC reserva", N("fcmax", cfg.fcmax, 120, 230)) +
    L("fcrep", "FC de repouso", "só para o campo % FC reserva", N("fcrep", cfg.fcrep, 30, 100)) +
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
    '<p class="hint">Segure qualquer campo da tela para trocá-lo, <b>adicionar ou remover campos</b> (até 12 espaços por página), mudar tamanho e ordem, ou criar e apagar páginas. Com o pedal rodando isso fica desligado: pause para editar. Deslize para os lados para mudar de página.</p>' +
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
    salvarCfg(); if (cfg.wake) manterTela(); else soltarTela();
    if (el.id === "fcmax" || el.id === "fcrep") abrirAjustes();
    render();
  }));
  $("#resetPages").addEventListener("click", () => { cfg.pages = JSON.parse(JSON.stringify(PAGINAS_PADRAO)); salvarCfg(); montarPaginas(); toast("Páginas restauradas"); });
  abrir("dlgSettings");
}

/* ------------------------------------------------------------------------- */
/* Resumo e exportacao                                                        */
/* ------------------------------------------------------------------------- */

/* Sem argumento, o pedal atual; com um registro do historico, aquele pedal. */
function abrirResumo(p) {
  const reg = p && p.r ? p : null, r = reg ? reg.r : R;
  const envio = reg ? reg.envio : R.enviado ? "enviado" : "pendente";
  const K = (rot, val) => '<div class="kv"><span>' + rot + '</span><b class="num">' + val + "</b></div>";
  const tot = r.zoneMs.slice(1).reduce((a, b) => a + b, 0);
  const laps = r.laps.map((l) => {
    const d = (l.dist1 ?? r.dist) - l.dist0;
    return "<tr><td>" + l.n + "</td><td class=num>" + fmtT(l.movingMs) + "</td><td class=num>" + fmtKm(d) +
      "</td><td class=num>" + (l.movingMs > 5000 ? fmtKmh(d / (l.movingMs / 1000)) : "--") + "</td><td class=num>" +
      (media(l.hrSum, l.hrN) ?? "--") + "</td><td class=num>" + (media(l.cadSum, l.cadN) ?? "--") + "</td></tr>";
  }).join("");
  $("#summaryBody").innerHTML =
    (reg ? '<p class="hint" style="margin:0 0 10px"><b>' + esc(dataPedal(r.startT)) + "</b></p>" : "") +
    '<div class="grid2">' +
    K("Distância", fmtKm(r.dist) + " km") + K("Tempo em movimento", fmtT(r.movingMs)) +
    K("Vel. média", r.movingMs > 5000 ? fmtKmh(r.dist / (r.movingMs / 1000)) + " km/h" : "--") + K("Vel. máx", r.maxSpeed ? fmtKmh(r.maxSpeed) + " km/h" : "--") +
    K("FC média / máx", (media(r.hrSum, r.hrN) ?? "--") + " / " + (r.maxHr || "--")) + K("Cadência média", (media(r.cadSum, r.cadN) ?? "--") + " rpm") +
    K("Subida (GPS)", Math.round(r.gain) + " m") + K("Tempo total", fmtT(r.totalMs)) +
    "</div>" +
    '<div class="zb" style="padding:12px 0 0"><div class="bar">' +
    r.zoneMs.slice(1).map((ms, i) => '<span style="width:' + (tot ? (ms / tot) * 100 : 0) + "%;background:" + COR_ZONA[i + 1] + '"></span>').join("") +
    '</div><div class="leg num">' + r.zoneMs.slice(1).map((ms, i) => "<div>" + rotuloZona(i + 1) + "<b>" + fmtT(ms) + "</b></div>").join("") + "</div></div>" +
    "<table><tr><th>Volta</th><th>Tempo</th><th>km</th><th>km/h</th><th>FC</th><th>Cad</th></tr>" + laps + "</table>" +
    '<div class="grid2" style="margin-top:14px"><button class="btn main" id="bTcx">Baixar TCX</button><button class="btn" id="bShare">Compartilhar</button></div>' +
    '<button class="btn" id="bPc" style="width:100%;margin-top:8px"' + (envio === "pendente" ? "" : " disabled") + ">" +
    (envio === "enviado" ? "Já enviado ao computador ✓" : envio === "sem" ? (DEMO ? "Demonstração: não envia ao computador" : "Sem cadência: nada a enviar ao computador")
      : reg ? "Enviar agora ao computador" : "Enviar cadência ao computador") + "</button>" +
    (reg && reg.envio === "pendente" && reg.erro ? '<p class="hint">Última tentativa de envio: ' + esc(reg.erro) + ". Fica na fila e tenta de novo sozinho.</p>" : "") +
    '<p class="hint">O pedal fica guardado em <b>Menu → Histórico</b>, e o TCX pode ser baixado de novo lá. ' +
    "<b>Strava:</b> strava.com/upload/select. O <b>intervals.icu</b> também aceita o arquivo. " +
    "O Strava corrige a subida pelo mapa de relevo, que é mais confiável que o GPS do celular.</p>" +
    '<p class="hint">Se você abriu um treino no relógio só para transmitir a FC, descarte essa atividade no relógio para não duplicar o pedal.</p>';
  $("#bTcx").addEventListener("click", () => baixarTcx(r));
  $("#bShare").addEventListener("click", () => compartilharTcx(r));
  $("#bPc").addEventListener("click", () => enviarPedal(true, r.id));
  abrir("dlgSummary");
}

function esc(s) { return String(s).replace(/[<&>"']/g, (c) => ({ "<": "&lt;", "&": "&amp;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }

async function montarTcx(r = R) {
  const amostras = await lerAmostras(r.id);
  const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
  const out = ['<?xml version="1.0" encoding="UTF-8"?>',
    '<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2" xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2">',
    '<Activities><Activity Sport="Biking"><Id>' + iso(r.startT) + "</Id>"];
  r.laps.forEach((l, i) => {
    const fim = l.endT ?? r.endT ?? agora();
    const pts = amostras.filter((s) => s.t >= l.startT && (i === r.laps.length - 1 ? true : s.t < fim));
    const dist = (l.dist1 ?? r.dist) - l.dist0;
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
  const nome = "pedal_" + new Date(r.startT).toISOString().slice(0, 16).replace(/[-:T]/g, "") + ".tcx";
  return { nome, blob: new Blob([out.join("\n")], { type: "application/vnd.garmin.tcx+xml" }), n: amostras.length };
}

async function baixarTcx(r = R) {
  const { nome, blob, n } = await montarTcx(r);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = nome;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast("TCX salvo em Downloads · " + n + " pontos");
}
async function compartilharTcx(r = R) {
  const { nome, blob } = await montarTcx(r);
  const file = new File([blob], nome, { type: "application/octet-stream" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: nome }); } catch {}
  } else baixarTcx(r);
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
      refazerTrajeto();
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
  histPronto = migrarPedalAntigo().catch(() => false);
  pedirPersistencia();
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
