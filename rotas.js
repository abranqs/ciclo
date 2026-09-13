/* Rotas: importar (GPX, TCX, KML, KMZ), guardar, seguir no mapa.
 *
 * Tudo que a navegacao usa — linha da rota, curvas, desvio, altimetria —
 * vem do arquivo e funciona sem internet. So o fundo do mapa (satelite ou
 * ruas) precisa de sinal; o que ja foi visto fica em cache.
 */
"use strict";

const ROTA = { ativa: null, idx: 0, prog: 0, desvio: null, fora: 0, avisos: {}, chegou: false,
               mapa: null, mapaDiv: null, camadas: {}, camada: "satelite", linhaRota: null, linhaTrack: null,
               marca: null, seguir: true, curvasLayer: null };

/* ------------------------------------------------------------------------- */
/* IndexedDB                                                                  */
/* ------------------------------------------------------------------------- */

async function loja(nome, modo, fn) {
  const d = await idb();
  return new Promise((res, rej) => {
    const tx = d.transaction(nome, modo);
    const req = fn(tx.objectStore(nome));
    tx.oncomplete = () => res(req && "result" in req ? req.result : undefined);
    tx.onerror = () => rej(tx.error);
  });
}
const todasRotas = () => loja("rotas", "readonly", (st) => st.getAll());
const salvarRota = (r) => loja("rotas", "readwrite", (st) => st.put(r));
const apagarRota = (id) => loja("rotas", "readwrite", (st) => st.delete(id));
const lerRota = (id) => loja("rotas", "readonly", (st) => st.get(id));

/* ------------------------------------------------------------------------- */
/* Leitura de arquivos                                                        */
/* ------------------------------------------------------------------------- */

function xml(txt) {
  const d = new DOMParser().parseFromString(txt, "application/xml");
  if (d.getElementsByTagName("parsererror").length) throw new Error("arquivo XML inválido");
  return d;
}
const tags = (el, n) => el.getElementsByTagNameNS("*", n);
const texto = (el, n) => { const x = tags(el, n)[0]; return x ? x.textContent.trim() : ""; };

function lerGpx(txt) {
  const d = xml(txt);
  let pts = [...tags(d, "trkpt")];
  if (!pts.length) pts = [...tags(d, "rtept")];
  return {
    nome: texto(d, "name"),
    pts: pts.map((p) => { const e = tags(p, "ele")[0]; return [+p.getAttribute("lat"), +p.getAttribute("lon"), e ? +e.textContent : null]; }),
  };
}

function lerTcx(txt) {
  const d = xml(txt);
  const pts = [];
  for (const tp of tags(d, "Trackpoint")) {
    const la = texto(tp, "LatitudeDegrees"), lo = texto(tp, "LongitudeDegrees");
    if (!la || !lo) continue;
    const al = texto(tp, "AltitudeMeters");
    pts.push([+la, +lo, al ? +al : null]);
  }
  const cues = [...tags(d, "CoursePoint")].map((cp) => ({
    lat: +texto(cp, "LatitudeDegrees"), lon: +texto(cp, "LongitudeDegrees"), tipo: texto(cp, "PointType"), nome: texto(cp, "Name"),
  })).filter((c) => isFinite(c.lat) && isFinite(c.lon));
  return { nome: texto(d, "Name"), pts, cuesArquivo: cues };
}

function lerKml(txt) {
  const d = xml(txt);
  const linhas = [...tags(d, "LineString")].map((ls) => (texto(ls, "coordinates") || "").split(/\s+/)
    .map((t) => t.split(",").map(Number)).filter((a) => a.length >= 2 && isFinite(a[0]) && isFinite(a[1]))
    .map((a) => [a[1], a[0], a.length > 2 && a[2] ? a[2] : null]));
  const trilhas = [...tags(d, "Track")].map((tk) => [...tags(tk, "coord")]
    .map((c) => c.textContent.trim().split(/\s+/).map(Number)).map((a) => [a[1], a[0], a[2] || null]));
  const todas = linhas.concat(trilhas).filter((l) => l.length > 1);
  if (!todas.length) throw new Error("o KML não tem nenhum caminho. No Google Earth, desenhe um Caminho (linha), não só marcadores.");
  const juntos = todas.length > 1 && todas.every((l, i) => !i || hav(
    { lat: todas[i - 1][todas[i - 1].length - 1][0], lon: todas[i - 1][todas[i - 1].length - 1][1] },
    { lat: l[0][0], lon: l[0][1] }) < 250);
  const pts = todas.length === 1 ? todas[0] : juntos ? todas.flat() : todas.sort((a, b) => b.length - a.length)[0];
  const pm = [...tags(d, "Placemark")].find((p) => tags(p, "LineString").length || tags(p, "Track").length);
  return { nome: (pm && texto(pm, "name")) || texto(d, "name"), pts };
}

async function kmzParaKml(buf) {
  const dv = new DataView(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 66000); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("KMZ inválido");
  const n = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  for (let k = 0; k < n; k++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const metodo = dv.getUint16(off + 10, true), csize = dv.getUint32(off + 20, true);
    const nlen = dv.getUint16(off + 28, true), xlen = dv.getUint16(off + 30, true), clen = dv.getUint16(off + 32, true);
    const lho = dv.getUint32(off + 42, true);
    const nome = new TextDecoder().decode(new Uint8Array(buf, off + 46, nlen));
    if (/\.kml$/i.test(nome)) {
      const ini = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
      const dados = new Uint8Array(buf, ini, csize);
      if (metodo === 0) return new TextDecoder().decode(dados);
      if (metodo === 8) return await new Response(new Blob([dados]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).text();
      throw new Error("compressão do KMZ não suportada");
    }
    off += 46 + nlen + xlen + clen;
  }
  throw new Error("o KMZ não tem um .kml dentro");
}

/* ------------------------------------------------------------------------- */
/* Preparar a rota                                                            */
/* ------------------------------------------------------------------------- */

const P = (a) => ({ lat: a[0], lon: a[1] });

/* Altitude de rota (Garmin, Open-Meteo) ja vem de modelo de relevo, limpa: um
 * filtro forte, como o do GPS do celular, cortaria subida de verdade. Com 1 m
 * de histerese a rota Mandacaru da 740 m contra 756 m do Garmin Connect. */
function desnivel(pts) {
  let ref = null, gain = 0, loss = 0;
  for (const p of pts) {
    if (p[2] == null) continue;
    if (ref == null) ref = p[2];
    if (p[2] - ref >= 1) { gain += p[2] - ref; ref = p[2]; } else if (ref - p[2] >= 1) { loss += ref - p[2]; ref = p[2]; }
  }
  return { gain: Math.round(gain), loss: Math.round(loss) };
}

function pontoEm(r, d) {
  const c = r.cum, n = c.length - 1;
  if (d <= 0) return [r.pts[0][0], r.pts[0][1], r.pts[0][2], 0];
  if (d >= r.dist) return [r.pts[n][0], r.pts[n][1], r.pts[n][2], n - 1];
  let lo = 0, hi = n;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c[m] <= d) lo = m; else hi = m; }
  const t = (d - c[lo]) / (c[hi] - c[lo] || 1), a = r.pts[lo], b = r.pts[hi];
  const ele = a[2] != null && b[2] != null ? a[2] + (b[2] - a[2]) * t : a[2] ?? b[2];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, ele, lo];
}

function rumo(a, b) {
  const t = Math.PI / 180;
  const y = Math.sin((b[1] - a[1]) * t) * Math.cos(b[0] * t);
  const x = Math.cos(a[0] * t) * Math.sin(b[0] * t) - Math.sin(a[0] * t) * Math.cos(b[0] * t) * Math.cos((b[1] - a[1]) * t);
  return (Math.atan2(y, x) / t + 360) % 360;
}

/* Curvas: do arquivo quando ele traz (TCX de curso), senao pela geometria —
 * mudanca de rumo de 50 graus ou mais numa janela de 40 m. E aproximado: numa
 * rotatoria ou num trecho sinuoso pode avisar a mais. */
function detectarCurvas(r, arquivo) {
  if (arquivo && arquivo.length) {
    return arquivo.map((c) => {
      let bi = 0, bd = Infinity;
      r.pts.forEach((p, i) => { const dd = hav(P(p), c); if (dd < bd) { bd = dd; bi = i; } });
      const t = (c.tipo || "").toLowerCase();
      const dir = t.includes("left") ? "esquerda" : t.includes("right") ? "direita" : t.includes("u") && t.includes("turn") ? "retorno"
        : t.includes("straight") ? "siga" : "ponto";
      return { d: r.cum[bi], dir, nome: c.nome };
    }).sort((a, b) => a.d - b.d);
  }
  const W = 40, cand = [];
  for (let d = W; d < r.dist - W; d += 10) {
    const a = pontoEm(r, d - W), b = pontoEm(r, d), c = pontoEm(r, d + W);
    let x = rumo(b, c) - rumo(a, b); x = ((x + 540) % 360) - 180;
    if (Math.abs(x) >= 50) cand.push({ d, ang: x });
  }
  const out = [];
  for (const c of cand) {
    const u = out[out.length - 1];
    if (u && c.d - u.d < 80) { if (Math.abs(c.ang) > Math.abs(u.ang)) { u.d = c.d; u.ang = c.ang; } continue; }
    out.push({ ...c });
  }
  return out.filter((c) => c.d > 60 && c.d < r.dist - 40).map((c) => ({
    d: c.d, ang: Math.round(c.ang), dir: Math.abs(c.ang) >= 150 ? "retorno" : c.ang > 0 ? "direita" : "esquerda", aprox: true,
  }));
}

function prepararRota(bruto, meta) {
  let pts = (bruto.pts || []).filter((p) => isFinite(p[0]) && isFinite(p[1]) && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180);
  if (pts.length < 2) throw new Error("a rota não tem pontos suficientes");
  const f = [pts[0]];
  for (let i = 1; i < pts.length; i++) if (hav(P(f[f.length - 1]), P(pts[i])) >= 4) f.push(pts[i]);
  pts = f.length > 6000 ? f.filter((_, i) => i % Math.ceil(f.length / 6000) === 0 || i === f.length - 1) : f;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + hav(P(pts[i - 1]), P(pts[i])));
  const dn = desnivel(pts);
  const r = {
    id: meta.id || "r" + Date.now(), nome: meta.nome || bruto.nome || "Rota", origem: meta.origem || "arquivo",
    tipo: meta.tipo || "", pts, cum, dist: cum[cum.length - 1], gain: dn.gain, loss: dn.loss,
    criado: Date.now(), atualizado: meta.atualizado || null,
    altOrigem: pts.some((p) => p[2] != null) ? "arquivo" : null,
  };
  r.curvas = detectarCurvas(r, bruto.cuesArquivo);
  return r;
}

/* Rotas desenhadas no Google Earth vem sem altitude. Completa pelo modelo de
 * relevo Copernicus (90 m) via Open-Meteo: gratis, sem chave, 100 pontos por
 * chamada. So roda com internet, na importacao. */
async function preencherAltitude(r) {
  const comEle = r.pts.filter((p) => p[2] != null).length;
  if (comEle > r.pts.length * 0.5 || !navigator.onLine) return false;
  const passo = Math.max(100, r.dist / 1000);
  const ds = [];
  for (let d = 0; d < r.dist; d += passo) ds.push(d);
  ds.push(r.dist);
  const amostras = ds.map((d) => pontoEm(r, d));
  const eles = [];
  for (let i = 0; i < amostras.length; i += 100) {
    const lote = amostras.slice(i, i + 100);
    const url = "https://api.open-meteo.com/v1/elevation?latitude=" + lote.map((p) => p[0].toFixed(5)).join(",") +
      "&longitude=" + lote.map((p) => p[1].toFixed(5)).join(",");
    const j = await (await fetch(url)).json();
    if (!Array.isArray(j.elevation)) throw new Error("sem altitude");
    eles.push(...j.elevation);
  }
  let k = 0;
  r.pts.forEach((p, i) => {
    const d = r.cum[i];
    while (k < ds.length - 2 && ds[k + 1] < d) k++;
    const t = Math.max(0, Math.min(1, (d - ds[k]) / (ds[k + 1] - ds[k] || 1)));
    p[2] = +(eles[k] + (eles[k + 1] - eles[k]) * t).toFixed(1);
  });
  const dn = desnivel(r.pts);
  r.gain = dn.gain; r.loss = dn.loss; r.altOrigem = "relevo Copernicus (Open-Meteo)";
  return true;
}

async function importarRotaDeArquivo(file) {
  const nomeArq = file.name || "rota";
  const ext = (nomeArq.split(".").pop() || "").toLowerCase();
  let bruto;
  if (ext === "kmz") bruto = lerKml(await kmzParaKml(await file.arrayBuffer()));
  else {
    const txt = await file.text();
    if (ext === "gpx" || txt.includes("<gpx")) bruto = lerGpx(txt);
    else if (ext === "tcx" || txt.includes("TrainingCenterDatabase")) bruto = lerTcx(txt);
    else if (ext === "kml" || txt.includes("<kml")) bruto = lerKml(txt);
    else throw new Error("formato não reconhecido — use GPX, TCX, KML ou KMZ");
  }
  const origem = ext === "kml" || ext === "kmz" ? "google-earth" : "arquivo";
  const r = prepararRota(bruto, { origem, nome: bruto.nome || nomeArq.replace(/\.[^.]+$/, "") });
  try { await preencherAltitude(r); } catch {}
  await salvarRota(r);
  return r;
}

/* ------------------------------------------------------------------------- */
/* Seguir a rota                                                              */
/* ------------------------------------------------------------------------- */

function distSeg(p, a, b) {
  const k = Math.cos(p[0] * Math.PI / 180), M = 111320;
  const ax = (a[1] - p[1]) * k * M, ay = (a[0] - p[0]) * M, bx = (b[1] - p[1]) * k * M, by = (b[0] - p[0]) * M;
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0;
  return { d: Math.hypot(ax + t * dx, ay + t * dy), t };
}

function localizar(r, lat, lon) {
  const p = [lat, lon];
  const busca = (i0, i1) => {
    let b = { d: Infinity, i: 0, t: 0 };
    for (let i = Math.max(0, i0); i < Math.min(r.pts.length - 1, i1); i++) {
      const s = distSeg(p, r.pts[i], r.pts[i + 1]);
      if (s.d < b.d) b = { d: s.d, i, t: s.t };
    }
    return b;
  };
  // Procura perto de onde estava primeiro: numa rota de ida e volta, o ponto
  // mais proximo "global" pode ser o da volta.
  let b = busca(ROTA.idx - 40, ROTA.idx + 400);
  if (b.d > 80) { const g = busca(0, r.pts.length); if (g.d < b.d - 20) b = g; }
  ROTA.idx = b.i;
  return { desvio: b.d, prog: r.cum[b.i] + b.t * (r.cum[b.i + 1] - r.cum[b.i]) };
}

const SETA = { esquerda: "↰", direita: "↱", retorno: "⤺", siga: "↑", ponto: "•" };
function textoCurva(c) {
  if (!c) return "";
  if (c.nome && c.dir === "ponto") return c.nome;
  return { esquerda: "Vire à esquerda", direita: "Vire à direita", retorno: "Retorno", siga: "Siga em frente", ponto: "Ponto" }[c.dir];
}
const fmtDist = (m) => (m >= 1000 ? (m / 1000).toFixed(m >= 10000 ? 0 : 1) + " km" : Math.round(m / 10) * 10 + " m");

async function ativarRota(id) {
  const r = await lerRota(id);
  if (!r) return;
  ROTA.ativa = r; ROTA.idx = 0; ROTA.prog = 0; ROTA.fora = 0; ROTA.avisos = {}; ROTA.chegou = false;
  try { localStorage.setItem("ciclo_rota", id); } catch {}
  ligarGps();
  S.page = paginasExt().findIndex((x) => x.nome === "rota");
  montarPaginas();
  if (S.page < 0) S.page = 0;
  desenharRotaNoMapa(true);
  toast("Seguindo: " + r.nome + " · " + fmtKm(r.dist) + " km");
}
function desativarRota() {
  ROTA.ativa = null;
  try { localStorage.removeItem("ciclo_rota"); } catch {}
  S.page = 0; montarPaginas();
}

EXT.tick.push((t) => {
  const r = ROTA.ativa;
  if (!r || S.gps.lat == null || t - S.gps.t > 6000) return;
  const loc = localizar(r, S.gps.lat, S.gps.lon);
  ROTA.desvio = loc.desvio; ROTA.prog = loc.prog;
  if (R.state !== "running") return;

  if (loc.desvio > 50) {
    ROTA.fora++;
    if (ROTA.fora === 8 || (ROTA.fora > 8 && (ROTA.fora - 8) % 45 === 0)) { beep(330, 300, 2); toast("Fora da rota: " + Math.round(loc.desvio) + " m"); }
  } else {
    if (ROTA.fora >= 8) { beep(1046, 120, 1); toast("De volta à rota"); }
    ROTA.fora = 0;
    const prox = r.curvas.find((c) => c.d > loc.prog + 5);
    if (prox) {
      const falta = prox.d - loc.prog, k = Math.round(prox.d);
      if (falta <= 220 && falta > 120 && !ROTA.avisos[k + "a"]) { ROTA.avisos[k + "a"] = 1; beep(988, 90, 1); toast(textoCurva(prox) + " em 200 m"); }
      if (falta <= 50 && !ROTA.avisos[k + "b"]) { ROTA.avisos[k + "b"] = 1; beep(1319, 90, 2); }
    }
  }
  if (!ROTA.chegou && r.dist - loc.prog < 40 && loc.desvio < 50) { ROTA.chegou = true; beep(784, 220, 3); toast("Fim da rota"); }
});

/* ------------------------------------------------------------------------- */
/* Pagina da rota: mapa, proxima curva, altimetria                            */
/* ------------------------------------------------------------------------- */

function camadas() {
  const esri = (s) => L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/" + s + "/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 19, maxNativeZoom: 18, crossOrigin: true });
  return {
    satelite: () => L.layerGroup([
      esri("World_Imagery"),
      esri("Reference/World_Transportation"), esri("Reference/World_Boundaries_and_Places"),
    ]),
    ruas: () => L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, crossOrigin: true }),
    relevo: () => L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", { maxZoom: 17, subdomains: "abc", crossOrigin: true }),
  };
}
const ATRIB = { satelite: "Imagens © Esri, Maxar, Earthstar Geographics", ruas: "© OpenStreetMap", relevo: "© OpenTopoMap (CC-BY-SA)" };
const NOME_CAMADA = { satelite: "Satélite", ruas: "Ruas", relevo: "Relevo" };

function garantirMapa() {
  if (ROTA.mapa || typeof L === "undefined") return;
  ROTA.mapaDiv = document.createElement("div");
  ROTA.mapaDiv.className = "mapaLeaflet";
  ROTA.mapa = L.map(ROTA.mapaDiv, { zoomControl: false, attributionControl: true, preferCanvas: true });
  ROTA.mapa.attributionControl.setPrefix("");
  try { ROTA.camada = localStorage.getItem("ciclo_camada") || "satelite"; } catch {}
  trocarCamada(ROTA.camada);
  ROTA.mapa.setView([-22.72, -47.65], 13);
  ROTA.mapa.on("dragstart", () => { ROTA.seguir = false; atualizarBotoesMapa(); });
}
function trocarCamada(nome) {
  const m = ROTA.mapa; if (!m) return;
  if (ROTA.camadas.atual) m.removeLayer(ROTA.camadas.atual);
  ROTA.camadas.atual = camadas()[nome]().addTo(m);
  m.attributionControl.remove(); m.attributionControl = L.control.attribution({ prefix: "" }).addTo(m);
  m.attributionControl.addAttribution(ATRIB[nome]);
  ROTA.camada = nome;
  try { localStorage.setItem("ciclo_camada", nome); } catch {}
  atualizarBotoesMapa();
}
function atualizarBotoesMapa() {
  const c = document.getElementById("bCamada"); if (c) c.textContent = NOME_CAMADA[ROTA.camada];
  const s = document.getElementById("bSeguir"); if (s) s.classList.toggle("on", ROTA.seguir);
}

function desenharRotaNoMapa(enquadrar) {
  const m = ROTA.mapa, r = ROTA.ativa;
  if (!m) return;
  [ROTA.linhaRota, ROTA.curvasLayer].forEach((l) => l && m.removeLayer(l));
  ROTA.linhaRota = ROTA.curvasLayer = null;
  if (!r) return;
  const css = getComputedStyle(document.documentElement);
  ROTA.linhaRota = L.polyline(r.pts.map((p) => [p[0], p[1]]), { color: "#ff7a3d", weight: 6, opacity: 0.9 }).addTo(m);
  ROTA.curvasLayer = L.layerGroup(r.curvas.map((c) => {
    const p = pontoEm(r, c.d);
    return L.circleMarker([p[0], p[1]], { radius: 4, color: "#fff", weight: 2, fillColor: "#111", fillOpacity: 1 });
  })).addTo(m);
  L.circleMarker([r.pts[0][0], r.pts[0][1]], { radius: 7, color: "#fff", weight: 2, fillColor: css.getPropertyValue("--ok").trim() || "#1baf7a", fillOpacity: 1 }).addTo(ROTA.curvasLayer);
  if (enquadrar) m.fitBounds(ROTA.linhaRota.getBounds(), { padding: [24, 24] });
}

function desenharPerfil(cv, r) {
  const box = cv.getBoundingClientRect(), dpr = devicePixelRatio || 1;
  if (!box.width) return;
  if (cv.width !== Math.round(box.width * dpr)) { cv.width = Math.round(box.width * dpr); cv.height = Math.round(box.height * dpr); }
  const ctx = cv.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = box.width, H = box.height; ctx.clearRect(0, 0, W, H);
  const css = getComputedStyle(document.documentElement);
  if (!r.pts.some((p) => p[2] != null)) {
    ctx.fillStyle = css.getPropertyValue("--mute"); ctx.font = "600 13px Roboto,sans-serif"; ctx.textAlign = "center";
    ctx.fillText("rota sem altitude", W / 2, H / 2 + 4); return;
  }
  const N = Math.min(300, Math.round(W)), es = [];
  for (let i = 0; i <= N; i++) es.push(pontoEm(r, (r.dist * i) / N)[2]);
  const ok = es.filter((e) => e != null), mn = Math.min(...ok), mx = Math.max(...ok), rng = Math.max(20, mx - mn);
  const X = (i) => (i / N) * W, Y = (e) => H - 4 - ((e - mn) / rng) * (H - 18);
  ctx.beginPath(); ctx.moveTo(0, H);
  es.forEach((e, i) => ctx.lineTo(X(i), Y(e ?? mn)));
  ctx.lineTo(W, H); ctx.closePath();
  ctx.fillStyle = "rgba(235,104,52,.28)"; ctx.fill();
  ctx.beginPath(); es.forEach((e, i) => (i ? ctx.lineTo(X(i), Y(e ?? mn)) : ctx.moveTo(X(i), Y(e ?? mn))));
  ctx.strokeStyle = "#eb6834"; ctx.lineWidth = 2; ctx.stroke();
  const px = (ROTA.prog / r.dist) * W;
  ctx.fillStyle = css.getPropertyValue("--txt").trim() || "#fff"; ctx.fillRect(px - 1, 0, 2, H);
  const ep = pontoEm(r, ROTA.prog)[2];
  if (ep != null) { ctx.beginPath(); ctx.arc(px, Y(ep), 5, 0, 7); ctx.fill(); }
  ctx.font = "600 11px Roboto,sans-serif"; ctx.textAlign = "left"; ctx.fillStyle = css.getPropertyValue("--mute");
  ctx.fillText(Math.round(mx) + " m", 4, 12); ctx.fillText(Math.round(mn) + " m", 4, H - 6);
}

function subidaRestante(r) {
  return desnivel(r.pts.slice(Math.max(0, ROTA.idx))).gain;
}
function inclinacaoAFrente(r, metros = 400) {
  const a = pontoEm(r, ROTA.prog), b = pontoEm(r, Math.min(r.dist, ROTA.prog + metros));
  if (a[2] == null || b[2] == null || r.dist - ROTA.prog < 50) return null;
  return ((b[2] - a[2]) / Math.min(metros, r.dist - ROTA.prog)) * 100;
}

EXT.paginas.push({
  nome: "rota",
  ativa: () => !!ROTA.ativa,
  montar(sec) {
    garantirMapa();
    sec.innerHTML =
      '<div class="rPg"><div class="rMapa"></div>' +
      '<div class="rCue"><span class="seta" id="rSeta">↑</span><div class="cTxt"><b class="num" id="rCueD">--</b><span id="rCueT"></span></div>' +
      '<div class="rFalta"><span>faltam</span><b class="num" id="rFalta">--</b><small id="rSub"></small></div></div>' +
      '<div class="rBtns"><button id="bSeguir" class="on">◎</button><button id="bCamada">Satélite</button></div>' +
      '<div class="rDes" id="rDes"></div>' +
      '<canvas class="rPerfil" id="rPerfil"></canvas></div>';
    if (ROTA.mapaDiv) sec.querySelector(".rMapa").appendChild(ROTA.mapaDiv);
    sec.querySelector("#bSeguir").addEventListener("click", () => { ROTA.seguir = true; atualizarBotoesMapa(); render(); });
    sec.querySelector("#bCamada").addEventListener("click", () => {
      const ordem = ["satelite", "ruas", "relevo"]; trocarCamada(ordem[(ordem.indexOf(ROTA.camada) + 1) % 3]);
    });
    // O mapa usa arrastar; o deslize entre paginas fica so na faixa de baixo.
    sec.querySelector(".rMapa").addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });
    sec.querySelector(".rMapa").addEventListener("touchend", (e) => e.stopPropagation());
    setTimeout(() => { if (ROTA.mapa) { ROTA.mapa.invalidateSize(); desenharRotaNoMapa(true); atualizarBotoesMapa(); } }, 50);
  },
  visivel() { setTimeout(() => ROTA.mapa && ROTA.mapa.invalidateSize(), 260); },
  atualizar(sec, visivel) {
    const r = ROTA.ativa; if (!r) return;
    const falta = Math.max(0, r.dist - ROTA.prog);
    sec.querySelector("#rFalta").textContent = fmtKm(falta);
    const v = R.movingMs > 60000 ? R.dist / (R.movingMs / 1000) : null;
    const sub = subidaRestante(r);
    sec.querySelector("#rSub").textContent = (sub ? "↑ " + sub + " m" : "") + (v ? " · chega " + new Date(agora() + (falta / v) * 1000).toTimeString().slice(0, 5) : "");
    const prox = r.curvas.find((c) => c.d > ROTA.prog + 5);
    const fora = ROTA.desvio != null && ROTA.desvio > 50;
    const cue = sec.querySelector(".rCue");
    cue.classList.toggle("fora", fora);
    if (ROTA.desvio == null) { sec.querySelector("#rSeta").textContent = "…"; sec.querySelector("#rCueD").textContent = S.gps.on ? "buscando GPS" : "GPS desligado"; sec.querySelector("#rCueT").textContent = ""; }
    else if (fora) { sec.querySelector("#rSeta").textContent = "⚠"; sec.querySelector("#rCueD").textContent = Math.round(ROTA.desvio) + " m"; sec.querySelector("#rCueT").textContent = "fora da rota"; }
    else if (prox) { sec.querySelector("#rSeta").textContent = SETA[prox.dir]; sec.querySelector("#rCueD").textContent = fmtDist(prox.d - ROTA.prog); sec.querySelector("#rCueT").textContent = textoCurva(prox) + (prox.aprox ? "" : ""); }
    else { sec.querySelector("#rSeta").textContent = "↑"; sec.querySelector("#rCueD").textContent = fmtDist(falta); sec.querySelector("#rCueT").textContent = "até o fim"; }
    const g = inclinacaoAFrente(r);
    sec.querySelector("#rDes").textContent = g == null ? "" : (g >= 0 ? "↗ " : "↘ ") + g.toFixed(1) + "% nos próximos 400 m";
    if (!visivel) return;
    desenharPerfil(sec.querySelector("#rPerfil"), r);
    const m = ROTA.mapa; if (!m) return;
    if (!ROTA.linhaTrack) ROTA.linhaTrack = L.polyline([], { color: "#3aa0ff", weight: 4, opacity: 0.95 }).addTo(m);
    ROTA.linhaTrack.setLatLngs(R.track.map((p) => [p.lat, p.lon]));
    if (S.gps.lat != null) {
      const ll = [S.gps.lat, S.gps.lon];
      if (!ROTA.marca) ROTA.marca = L.circleMarker(ll, { radius: 9, color: "#fff", weight: 3, fillColor: "#3aa0ff", fillOpacity: 1 }).addTo(m);
      else ROTA.marca.setLatLng(ll);
      if (ROTA.seguir) { const z = m.getZoom(); m.setView(ll, z >= 13 && z <= 18 ? z : 16, { animate: false }); }
    }
  },
});

/* ------------------------------------------------------------------------- */
/* Google Earth e Google Maps                                                 */
/* ------------------------------------------------------------------------- */

function kmlDaRota(r) {
  const e = (s) => String(s).replace(/[<&>]/g, (c) => ({ "<": "&lt;", "&": "&amp;", ">": "&gt;" })[c]);
  const coords = r.pts.map((p) => p[1].toFixed(6) + "," + p[0].toFixed(6) + "," + (p[2] != null ? p[2].toFixed(1) : 0)).join(" ");
  return '<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>' + e(r.nome) +
    '</name><Style id="rota"><LineStyle><color>ff3468eb</color><width>5</width></LineStyle></Style>' +
    "<Placemark><name>" + e(r.nome) + "</name><description>" + fmtKm(r.dist) + " km · ↑" + r.gain + " m</description><styleUrl>#rota</styleUrl>" +
    "<LineString><tessellate>1</tessellate><altitudeMode>clampToGround</altitudeMode><coordinates>" + coords + "</coordinates></LineString></Placemark>" +
    "<Placemark><name>Início</name><Point><coordinates>" + r.pts[0][1] + "," + r.pts[0][0] + ",0</coordinates></Point></Placemark>" +
    "</Document></kml>";
}
async function abrirNoGoogleEarth(r) {
  const nome = r.nome.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "_") + ".kml";
  const file = new File([kmlDaRota(r)], nome, { type: "application/vnd.google-earth.kml+xml" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: r.nome }); return; } catch (e) { if (e.name === "AbortError") return; }
  }
  const a = document.createElement("a"); a.href = URL.createObjectURL(file); a.download = nome;
  document.body.appendChild(a); a.click(); a.remove();
  toast("KML salvo em Downloads — abra com o Google Earth");
}
const linkMapsInicio = (r) => "https://www.google.com/maps/dir/?api=1&travelmode=bicycling&destination=" + r.pts[0][0].toFixed(6) + "," + r.pts[0][1].toFixed(6);
const linkEarthInicio = (r) => "https://earth.google.com/web/@" + r.pts[0][0].toFixed(6) + "," + r.pts[0][1].toFixed(6) + ",700a,4000d,35y,0h,50t,0r";

/* ------------------------------------------------------------------------- */
/* Biblioteca de rotas                                                        */
/* ------------------------------------------------------------------------- */

const ORIGEM = { garmin: "Garmin", "google-earth": "Google Earth", arquivo: "arquivo" };

async function abrirRotas() {
  const lista = (await todasRotas()).sort((a, b) => (a.origem === b.origem ? a.nome.localeCompare(b.nome) : a.origem === "garmin" ? -1 : 1));
  const body = $("#rotasBody");
  body.innerHTML =
    '<div class="grid2"><label class="btn main" style="text-align:center">Importar arquivo<input type="file" id="fRota" accept=".gpx,.tcx,.kml,.kmz,application/gpx+xml,application/vnd.google-earth.kml+xml,application/vnd.google-earth.kmz" hidden></label>' +
    '<button class="btn" id="bSyncR">Buscar do Garmin</button></div>' +
    '<p class="hint">GPX/TCX do Garmin Connect ou Strava, KML/KMZ do Google Earth. Também dá para usar o <b>Compartilhar</b> do Android direto para o Ciclo.</p>' +
    (ROTA.ativa ? '<div class="sensor"><div class="top"><div><b>Seguindo agora</b><div class="st">' + ROTA.ativa.nome + '</div></div><button class="btn" id="bParar" style="background:var(--bad)">Parar</button></div></div>' : "") +
    (lista.length ? "" : '<p class="hint">Nenhuma rota ainda.</p>') +
    lista.map((r) =>
      '<div class="sensor rItem" data-id="' + r.id + '"><div class="top"><div><b>' + r.nome.replace(/</g, "&lt;") + "</b><div class=\"st num\">" +
      fmtKm(r.dist) + " km · ↑" + r.gain + " m · " + (ORIGEM[r.origem] || r.origem) + (r.curvas.length ? " · " + r.curvas.length + " curvas" : "") +
      '</div></div><button class="btn" data-a="seguir">Seguir</button></div>' +
      '<div class="acoes"><button data-a="earth">Google Earth</button><a href="' + linkMapsInicio(r) + '" target="_blank" rel="noopener">Ir ao início</a>' +
      '<a href="' + linkEarthInicio(r) + '" target="_blank" rel="noopener">Earth web</a>' + (r.origem !== "garmin" ? '<button data-a="apagar">Apagar</button>' : "") + "</div></div>").join("");
  body.querySelector("#fRota").addEventListener("change", async (e) => {
    for (const f of e.target.files) {
      try { const r = await importarRotaDeArquivo(f); toast("Importada: " + r.nome + " · " + fmtKm(r.dist) + " km"); }
      catch (err) { toast("Não importou " + f.name + ": " + err.message, 5000); }
    }
    abrirRotas();
  });
  body.querySelector("#bSyncR").addEventListener("click", async () => { await sincronizar(false); abrirRotas(); });
  const bp = body.querySelector("#bParar"); if (bp) bp.addEventListener("click", () => { desativarRota(); $("#dlgRotas").close(); });
  body.querySelectorAll(".rItem").forEach((el) => el.addEventListener("click", async (e) => {
    const a = e.target.closest("[data-a]"); if (!a) return;
    const r = await lerRota(el.dataset.id);
    if (a.dataset.a === "seguir") { $("#dlgRotas").close(); ativarRota(r.id); }
    if (a.dataset.a === "earth") abrirNoGoogleEarth(r);
    if (a.dataset.a === "apagar" && confirm("Apagar a rota " + r.nome + "?")) { await apagarRota(r.id); if (ROTA.ativa && ROTA.ativa.id === r.id) desativarRota(); abrirRotas(); }
  }));
  abrir("dlgRotas");
}

EXT.menu.push({ txt: "Rotas", sub: () => (ROTA.ativa ? "seguindo " + ROTA.ativa.nome : "Garmin, Google Earth, GPX"), fn: abrirRotas });

/* restaura a rota ativa depois de recarregar */
document.addEventListener("DOMContentLoaded", () => {
  let id = null; try { id = localStorage.getItem("ciclo_rota"); } catch {}
  if (id) setTimeout(() => lerRota(id).then((r) => { if (r) { ROTA.ativa = r; montarPaginas(); desenharRotaNoMapa(true); } }).catch(() => {}), 300);
});
