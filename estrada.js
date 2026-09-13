/* Estrada à frente: sem rota marcada, prevê subidas e descidas seguindo a
 * própria estrada — o "ClimbPro" de quem sai sem percurso.
 *
 *  1. Estradas: blocos vetoriais do OpenStreetMap servidos pelo OpenFreeMap
 *     (grátis, sem chave). Um bloco z14 cobre ~2,3 km; ficam guardados no
 *     aparelho pelo service worker.
 *  2. Onde você está: o GPS e o seu rumo casados com o trecho de estrada
 *     mais próximo que aponta para o mesmo lado.
 *  3. Para onde a estrada vai: anda pela malha a partir dali. Em cada
 *     cruzamento segue a mesma via; se ela acaba, a saída mais reta, sem
 *     descer de categoria (rodovia → rua → terra) sem motivo. Num T, ou numa
 *     bifurcação sem saída óbvia, a previsão para no cruzamento.
 *  4. Relevo: SRTM de 30 m (blocos Terrarium da AWS, grátis). Pontes e túneis
 *     são interpolados, porque o modelo mede o vale embaixo da ponte.
 *
 * Com rota ativa e você sobre ela, o perfil vem da própria rota.
 *
 * Limites: o modelo de relevo erra alguns metros em mata fechada e em corte
 * de estrada, então rampas curtas (<100 m) somem na suavização; depois de um
 * cruzamento a previsão é palpite até você entrar na outra via.
 */
"use strict";

const EST = {
  modelo: null,
  blocos: new Map(),     // "x/y" -> "carregando" | "ok" | "erro"
  dem: new Map(),        // "x/y" -> { w, alt } | "carregando" | "erro"
  nos: [],               // [lat, lon]
  hashNos: new Map(),
  adj: [],               // no -> [{ to, li }]
  linhas: [],            // { rank, ponte }
  hashSeg: new Map(),    // celula -> [a, b, li, ...]
  hist: [], rumo: null,
  casado: null, caminho: null, perfil: null, estado: "aguardando GPS",
  tCalc: 0, avisos: [],
};
const Z_VIAS = 14, Z_DEM = 13, CEL_SEG = 0.0005, Q_NO = 0.00002, ALCANCE = 2500, PASSO = 25;
const RANK = { motorway: 6, trunk: 6, primary: 5, secondary: 4, tertiary: 3, minor: 2, service: 1, track: 1, path: 0 };

/* ------------------------------------------------------------------------- */
/* Blocos vetoriais (Mapbox Vector Tile) → linhas de estrada                  */
/* ------------------------------------------------------------------------- */

function lerVias(buf, tx, ty) {
  const b = new Uint8Array(buf);
  let p = 0;
  const varint = () => { let r = 0, m = 1, x; do { x = b[p++]; r += (x & 0x7f) * m; m *= 128; } while (x & 0x80); return r; };
  const pular = (w) => { if (w === 0) varint(); else if (w === 1) p += 8; else if (w === 2) p += varint(); else if (w === 5) p += 4; };
  const dec = new TextDecoder();
  const str = () => { const n = varint(); const s = dec.decode(b.subarray(p, p + n)); p += n; return s; };
  const out = [];
  while (p < b.length) {
    const tag = varint();
    if (tag >> 3 !== 3 || (tag & 7) !== 2) { pular(tag & 7); continue; }
    const fimCamada = varint() + p;
    let nome = "", ext = 4096;
    const keys = [], vals = [], feats = [];
    while (p < fimCamada) {
      const t = varint(), c = t >> 3, w = t & 7;
      if (c === 1) nome = str();
      else if (c === 2) { const n = varint(); feats.push([p, p + n]); p += n; }
      else if (c === 3) keys.push(str());
      else if (c === 4) {
        const fim = varint() + p; let v = null;
        while (p < fim) {
          const t3 = varint(), c3 = t3 >> 3;
          if (c3 === 1) v = str();
          else if (c3 === 4 || c3 === 5) v = varint();
          else if (c3 === 6) { const z = varint(); v = z % 2 ? -(z + 1) / 2 : z / 2; }
          else if (c3 === 7) v = !!varint();
          else if (c3 === 2) { v = new DataView(b.buffer, b.byteOffset + p, 4).getFloat32(0, true); p += 4; }
          else if (c3 === 3) { v = new DataView(b.buffer, b.byteOffset + p, 8).getFloat64(0, true); p += 8; }
          else pular(t3 & 7);
        }
        vals.push(v);
      } else if (c === 5) ext = varint();
      else pular(w);
    }
    if (nome === "transportation") {
      for (const [ini, fim] of feats) {
        p = ini;
        let tags = [], tipo = 0, geo = [];
        while (p < fim) {
          const t = varint(), c = t >> 3, w = t & 7;
          if ((c === 2 || c === 4) && w === 2) { const n = varint() + p, arr = []; while (p < n) arr.push(varint()); if (c === 2) tags = arr; else geo = arr; }
          else if (c === 3) tipo = varint();
          else pular(w);
        }
        if (tipo !== 2) continue;
        const at = {};
        for (let i = 0; i + 1 < tags.length; i += 2) at[keys[tags[i]]] = vals[tags[i + 1]];
        // calçada e escada ficam de fora: correm colados à rua e confundiriam o casamento
        if (!(at.class in RANK) || (at.class === "path" && !["cycleway", "path", "bridleway"].includes(at.subclass))) continue;
        const partes = [];
        let x = 0, y = 0, i = 0, atual = null;
        while (i < geo.length) {
          const cmd = geo[i] & 7, n = geo[i] >> 3; i++;
          if (cmd === 7) continue;
          for (let k = 0; k < n; k++) {
            const dx = geo[i], dy = geo[i + 1]; i += 2;
            x += (dx >> 1) ^ -(dx & 1); y += (dy >> 1) ^ -(dy & 1);
            if (cmd === 1) { atual = []; partes.push(atual); }
            if (atual) atual.push([x, y]);
          }
        }
        const nt = 2 ** Z_VIAS;
        const ll = ([px, py]) => {
          const yy = (ty + py / ext) / nt;
          return [Math.atan(Math.sinh(Math.PI * (1 - 2 * yy))) * 180 / Math.PI, ((tx + px / ext) / nt) * 360 - 180];
        };
        // Recorta no limite exato do bloco: os blocos trazem uma borda que
        // repete o vizinho, e sem o corte a mesma rua entraria duas vezes.
        for (const parte of partes) {
          for (const pedaco of recortar(parte, ext)) {
            out.push({ pts: pedaco.map(ll), rank: RANK[at.class], ponte: at.brunnel === "bridge" || at.brunnel === "tunnel" });
          }
        }
      }
    }
    p = fimCamada;
  }
  return out;
}

function recortar(l, E) {
  const out = [];
  let atual = null;
  for (let i = 1; i < l.length; i++) {
    const [x0, y0] = l[i - 1], [x1, y1] = l[i], dx = x1 - x0, dy = y1 - y0;
    let t0 = 0, t1 = 1, ok = true;
    for (const [pp, q] of [[-dx, x0], [dx, E - x0], [-dy, y0], [dy, E - y0]]) {
      if (pp === 0) { if (q < 0) { ok = false; break; } continue; }
      const r = q / pp;
      if (pp < 0) { if (r > t1) { ok = false; break; } if (r > t0) t0 = r; }
      else { if (r < t0) { ok = false; break; } if (r < t1) t1 = r; }
    }
    if (!ok) { atual = null; continue; }
    if (!atual || t0 > 0) { atual = [[x0 + t0 * dx, y0 + t0 * dy]]; out.push(atual); }
    atual.push([x0 + t1 * dx, y0 + t1 * dy]);
    if (t1 < 1) atual = null;
  }
  return out.filter((x) => x.length > 1);
}

/* ------------------------------------------------------------------------- */
/* Malha: nós unidos por proximidade (2 m), segmentos num índice espacial     */
/* ------------------------------------------------------------------------- */

const LL = (a) => ({ lat: a[0], lon: a[1] });

function noDe(lat, lon) {
  const kx = Math.round(lat / Q_NO), ky = Math.round(lon / Q_NO);
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    const lista = EST.hashNos.get((kx + i) + ":" + (ky + j));
    if (lista) for (const id of lista) if (hav(LL(EST.nos[id]), { lat, lon }) < 2) return id;
  }
  const id = EST.nos.length;
  EST.nos.push([lat, lon]); EST.adj.push([]);
  const k = kx + ":" + ky;
  if (!EST.hashNos.has(k)) EST.hashNos.set(k, []);
  EST.hashNos.get(k).push(id);
  return id;
}

function adicionarLinha(l) {
  const li = EST.linhas.length;
  EST.linhas.push({ rank: l.rank, ponte: l.ponte });
  let ant = null;
  for (const [la, lo] of l.pts) {
    const id = noDe(la, lo);
    if (ant != null && id !== ant) {
      EST.adj[ant].push({ to: id, li }); EST.adj[id].push({ to: ant, li });
      const A = EST.nos[ant], B = EST.nos[id];
      for (let x = Math.floor(Math.min(A[0], B[0]) / CEL_SEG); x <= Math.floor(Math.max(A[0], B[0]) / CEL_SEG); x++) {
        for (let y = Math.floor(Math.min(A[1], B[1]) / CEL_SEG); y <= Math.floor(Math.max(A[1], B[1]) / CEL_SEG); y++) {
          const k = x + ":" + y;
          if (!EST.hashSeg.has(k)) EST.hashSeg.set(k, []);
          EST.hashSeg.get(k).push(ant, id, li);
        }
      }
    }
    ant = id;
  }
}

function blocoXY(lat, lon, z) {
  const n = 2 ** z, s = Math.sin(lat * Math.PI / 180);
  return [((lon + 180) / 360) * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
}

async function modeloVias(renovar) {
  if (EST.modelo && !renovar) return EST.modelo;
  if (!renovar) {
    try { const m = JSON.parse(localStorage.getItem("ciclo_vias") || "null"); if (m && m.url) return (EST.modelo = m.url); } catch {}
  }
  const j = await (await fetch("https://tiles.openfreemap.org/planet", { cache: "no-store" })).json();
  EST.modelo = j.tiles[0];
  try { localStorage.setItem("ciclo_vias", JSON.stringify({ url: EST.modelo, t: agora() })); } catch {}
  return EST.modelo;
}

async function carregarBloco(x, y) {
  const k = x + "/" + y;
  if (EST.blocos.has(k)) return;
  EST.blocos.set(k, "carregando");
  try {
    const url = (m) => m.replace("{z}", Z_VIAS).replace("{x}", x).replace("{y}", y);
    let r = await fetch(url(await modeloVias()));
    // O OpenFreeMap troca a versão do mapa de tempos em tempos e apaga as antigas.
    if (!r.ok && navigator.onLine) r = await fetch(url(await modeloVias(true)));
    if (!r.ok) throw new Error("HTTP " + r.status);
    let buf = await r.arrayBuffer();
    const u8 = new Uint8Array(buf);
    if (u8[0] === 0x1f && u8[1] === 0x8b) buf = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
    for (const l of lerVias(buf, x, y)) adicionarLinha(l);
    EST.blocos.set(k, "ok");
  } catch (e) {
    EST.blocos.set(k, "erro");
    setTimeout(() => EST.blocos.delete(k), 20000);
  }
}

function garantirBlocos(lat, lon) {
  const [fx, fy] = blocoXY(lat, lon, Z_VIAS), x = Math.floor(fx), y = Math.floor(fy);
  const ordem = [[0, 0], [0, -1], [1, 0], [0, 1], [-1, 0], [1, -1], [1, 1], [-1, 1], [-1, -1]];
  for (const [i, j] of ordem) carregarBloco(x + i, y + j);
  return EST.blocos.get(x + "/" + y);
}

/* ------------------------------------------------------------------------- */
/* Relevo: SRTM 30 m em PNG Terrarium (altitude = R*256 + G + B/256 - 32768)   */
/* ------------------------------------------------------------------------- */

async function carregarDem(x, y) {
  const k = x + "/" + y;
  if (EST.dem.has(k)) return;
  EST.dem.set(k, "carregando");
  try {
    const r = await fetch("https://s3.amazonaws.com/elevation-tiles-prod/terrarium/" + Z_DEM + "/" + x + "/" + y + ".png");
    if (!r.ok) throw new Error("HTTP " + r.status);
    // sem conversão de cor: qualquer ajuste de gama no PNG vira erro de altitude
    const bmp = await createImageBitmap(await r.blob(), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
    const w = bmp.width;
    const cv = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, w) : Object.assign(document.createElement("canvas"), { width: w, height: w });
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, w, w).data, alt = new Float32Array(w * w);
    for (let i = 0; i < w * w; i++) alt[i] = d[4 * i] * 256 + d[4 * i + 1] + d[4 * i + 2] / 256 - 32768;
    EST.dem.set(k, { w, alt });
  } catch (e) {
    EST.dem.set(k, "erro");
    setTimeout(() => EST.dem.delete(k), 20000);
  }
}

function altitudeEm(lat, lon) {
  const [fx, fy] = blocoXY(lat, lon, Z_DEM), x = Math.floor(fx), y = Math.floor(fy);
  const t = EST.dem.get(x + "/" + y);
  if (!t) { carregarDem(x, y); return null; }
  if (typeof t === "string") return null;
  const w = t.w, px = Math.max(0, Math.min(w - 1.001, (fx - x) * w - 0.5)), py = Math.max(0, Math.min(w - 1.001, (fy - y) * w - 0.5));
  const i = Math.floor(px), j = Math.floor(py), u = px - i, v = py - j, A = t.alt;
  return (A[j * w + i] * (1 - u) + A[j * w + i + 1] * u) * (1 - v) + (A[(j + 1) * w + i] * (1 - u) + A[(j + 1) * w + i + 1] * u) * v;
}

/* ------------------------------------------------------------------------- */
/* Onde estou e para onde a estrada vai                                       */
/* ------------------------------------------------------------------------- */

const difAng = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

function casar(lat, lon, rumoAtual) {
  const kx = Math.floor(lat / CEL_SEG), ky = Math.floor(lon / CEL_SEG), vistos = new Set();
  let melhor = null;
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    const lista = EST.hashSeg.get((kx + i) + ":" + (ky + j));
    if (!lista) continue;
    for (let s = 0; s < lista.length; s += 3) {
      const a = lista[s], b = lista[s + 1], li = lista[s + 2], chave = a < b ? a + ":" + b : b + ":" + a;
      if (vistos.has(chave)) continue;
      vistos.add(chave);
      const ds = distSeg([lat, lon], EST.nos[a], EST.nos[b]);
      if (ds.d > 30) continue;
      let de = a, para = b, t = ds.t, score = ds.d;
      if (rumoAtual != null) {
        let dif = difAng(rumoAtual, rumo(EST.nos[a], EST.nos[b]));
        if (dif > 90) { de = b; para = a; t = 1 - t; dif = 180 - dif; }
        if (dif > 50) continue;
        score += dif * 0.4;
      }
      if (EST.casado && EST.casado.li === li) score -= 6;
      if (EST.linhas[li].rank === 0) score += 6;
      if (!melhor || score < melhor.score) melhor = { de, para, t, li, d: ds.d, score };
    }
  }
  return melhor;
}

/* ponto 'metros' à frente saindo de 'no' pela aresta e, sem mudar de via */
function pontoPelaAresta(no, e, metros) {
  let prev = no, atual = e.to, dist = hav(LL(EST.nos[prev]), LL(EST.nos[atual]));
  while (dist < metros) {
    const seg = EST.adj[atual].find((x) => x.to !== prev && x.li === e.li);
    if (!seg) break;
    prev = atual; atual = seg.to; dist += hav(LL(EST.nos[prev]), LL(EST.nos[atual]));
  }
  return EST.nos[atual];
}

/* Ponta solta: bloco vizinho ainda não baixado, ou um vão nos dados do OSM
 * (duas pontas a poucos metros sem ligação). Devolve o nó do outro lado, ou
 * "carregando", ou null se a via acaba mesmo. */
function alemDaPonta(no, rIn, noCaminho) {
  const [la, lo] = EST.nos[no], [fx, fy] = blocoXY(la, lo, Z_VIAS);
  let falta = false;
  for (const dx of [-0.01, 0, 0.01]) for (const dy of [-0.01, 0, 0.01]) {
    const k = Math.floor(fx + dx) + "/" + Math.floor(fy + dy);
    if (EST.blocos.get(k) !== "ok") { falta = true; carregarBloco(Math.floor(fx + dx), Math.floor(fy + dy)); }
  }
  if (falta) return "carregando";
  const kx = Math.round(la / Q_NO), ky = Math.round(lo / Q_NO), R0 = 10;
  let melhor = null, md = Infinity;
  for (let i = -R0; i <= R0; i++) for (let j = -R0; j <= R0; j++) {
    const lista = EST.hashNos.get((kx + i) + ":" + (ky + j));
    if (!lista) continue;
    for (const id of lista) {
      if (id === no || noCaminho.has(id) || !EST.adj[id].length) continue;
      const d = hav(LL(EST.nos[no]), LL(EST.nos[id]));
      if (d > 20 || d >= md) continue;
      if (d > 5 && difAng(rumo(EST.nos[no], EST.nos[id]), rIn) > 60) continue;
      melhor = id; md = d;
    }
  }
  return melhor;
}

function seguirEstrada(c) {
  const A = EST.nos[c.de], B = EST.nos[c.para];
  const p0 = [A[0] + (B[0] - A[0]) * c.t, A[1] + (B[1] - A[1]) * c.t];
  const pts = [p0, B], cum = [0, hav(LL(p0), LL(B))], pontes = [EST.linhas[c.li].ponte];
  let prev = c.de, no = c.para, li = c.li, fim = null;
  const visto = new Set(), noCaminho = new Set([c.de, c.para]);
  while (cum[cum.length - 1] < ALCANCE) {
    const dAtual = cum[cum.length - 1];
    const tras = dAtual > 20 ? pontoEm({ pts, cum, dist: dAtual }, dAtual - 20) : pts[0];
    const rIn = rumo(tras, EST.nos[no]);
    const opcoes = EST.adj[no].filter((e) => e.to !== prev);
    if (!opcoes.length) {
      const alem = alemDaPonta(no, rIn, noCaminho);
      if (alem === "carregando") { fim = "carregando"; break; }
      if (alem == null) { fim = "fim da via"; break; }
      prev = no; no = alem;
      noCaminho.add(no); pts.push(EST.nos[no]); cum.push(dAtual + hav(LL(EST.nos[prev]), LL(EST.nos[no]))); pontes.push(false);
      li = (EST.adj[no][0] || {}).li ?? li;
      // o nó do outro lado não tem aresta de volta para 'prev'; sai por qualquer uma
      prev = -1;
      continue;
    }
    let escolha = opcoes[0];
    if (opcoes.length > 1) {
      const cls = opcoes.map((e) => {
        const giro = difAng(rumo(EST.nos[no], pontoPelaAresta(no, e, 25)), rIn);
        const mesma = e.li === li, de = EST.linhas[li].rank, para = EST.linhas[e.li].rank;
        // de rua para trilha só se não houver outra saída
        const desce = Math.max(0, de - para) * 12 + (para === 0 && de > 0 ? 100 : 0);
        return { e, giro, mesma, s: giro + (mesma ? -30 : 0) + desce };
      }).sort((a, b) => a.s - b.s);
      const [m, seg] = cls;
      // T: nenhuma saída segue reto. Bifurcação: duas saídas quase iguais.
      if ((!m.mesma && m.giro > 60) || (seg && seg.s - m.s < 18 && seg.giro < 75)) { fim = "cruzamento"; break; }
      escolha = m.e;
    }
    const chave = no + ">" + escolha.to;
    if (visto.has(chave)) break;
    visto.add(chave);
    prev = no; no = escolha.to; li = escolha.li;
    noCaminho.add(no); pts.push(EST.nos[no]); cum.push(cum[cum.length - 1] + hav(LL(EST.nos[prev]), LL(EST.nos[no]))); pontes.push(EST.linhas[li].ponte);
  }
  return { pts, cum, pontes, dist: cum[cum.length - 1], fim };
}

/* ------------------------------------------------------------------------- */
/* Perfil e trechos                                                           */
/* ------------------------------------------------------------------------- */

/* amostra de 25 em 25 m; 'altDe(d)' devolve a altitude ou null */
function amostrar(dist, altDe, ponteEm) {
  const n = Math.floor(Math.min(dist, ALCANCE) / PASSO);
  if (n < 6) return null;
  const d = [], e = [], pt = [];
  for (let i = 0; i <= n; i++) {
    const x = i * PASSO, a = altDe(x);
    if (a == null) return { falta: true };
    d.push(x); e.push(a); pt.push(ponteEm ? ponteEm(x) : false);
  }
  for (let i = 0; i < pt.length; i++) {
    if (!pt[i]) continue;
    let j = i; while (j < pt.length && pt[j]) j++;
    const a = e[Math.max(0, i - 1)], b = e[Math.min(e.length - 1, j)], L = j - i + 1;
    for (let k = i; k < j; k++) e[k] = a + ((b - a) * (k - i + 1)) / L;
    i = j;
  }
  return { d, e };
}

function suavizar(e, raio) {
  return e.map((_, i) => {
    let s = 0, w = 0;
    for (let k = -raio; k <= raio; k++) {
      const j = i + k; if (j < 0 || j >= e.length) continue;
      const p = raio + 1 - Math.abs(k); s += e[j] * p; w += p;
    }
    return s / w;
  });
}

/* inclinação média em 100 m centrados em cada amostra */
function grade100(d, e) {
  const n = d.length, w = Math.max(1, Math.round(50 / PASSO));
  return d.map((_, i) => { const a = Math.max(0, i - w), b = Math.min(n - 1, i + w); return ((e[b] - e[a]) / (d[b] - d[a])) * 100; });
}

function trechos(d, e) {
  const n = d.length, g = grade100(d, e);
  let runs = [];
  for (let i = 0; i < n - 1; i++) {
    const c = g[i] >= 2.5 ? 1 : g[i] <= -2.5 ? -1 : 0, u = runs[runs.length - 1];
    if (u && u.c === c) u.i1 = i + 1; else runs.push({ c, i0: i, i1: i + 1 });
  }
  const len = (r) => d[r.i1] - d[r.i0];
  const juntar = () => { runs = runs.reduce((acc, r) => { const u = acc[acc.length - 1]; if (u && u.c === r.c) u.i1 = r.i1; else acc.push(r); return acc; }, []); };
  for (;;) {
    let k = -1, m = Infinity;
    runs.forEach((r, i) => { const lim = i === 0 ? 75 : 150; if (runs.length > 1 && len(r) < lim && len(r) < m) { m = len(r); k = i; } });
    if (k < 0) break;
    const viz = k === 0 ? 1 : k === runs.length - 1 ? k - 1 : len(runs[k - 1]) >= len(runs[k + 1]) ? k - 1 : k + 1;
    runs[k].c = runs[viz].c;
    juntar();
  }
  return runs.map((r) => {
    const L = len(r), ganho = e[r.i1] - e[r.i0];
    let gmax = 0; for (let i = r.i0; i < r.i1; i++) if (Math.abs(g[i]) > Math.abs(gmax)) gmax = g[i];
    return { ini: d[r.i0], fim: d[r.i1], len: L, tipo: r.c, ganho, grade: (ganho / L) * 100, gmax };
  });
}

function calcularPerfil(dist, altDe, ponteEm, pontoDe, fonte, fim) {
  const a = amostrar(dist, altDe, ponteEm);
  if (!a) return { vazio: "estrada curta demais" };
  if (a.falta) return { vazio: "baixando relevo…" };
  const e = suavizar(a.e, 2);
  return { d: a.d, e, g: grade100(a.d, e), trechos: trechos(a.d, e), fonte, fim, dist: Math.min(dist, ALCANCE), pontoDe };
}

/* ------------------------------------------------------------------------- */
/* Laço: a cada 3 s                                                           */
/* ------------------------------------------------------------------------- */

function atualizarEstrada(t) {
  const g = S.gps;
  if (g.lat == null || t - g.t > 8000) { EST.estado = g.on ? "aguardando GPS" : "GPS desligado"; EST.perfil = null; return; }
  const aqui = { lat: g.lat, lon: g.lon };
  const u = EST.hist[EST.hist.length - 1];
  if (!u || hav(u, aqui) >= 5) { EST.hist.push(aqui); if (EST.hist.length > 20) EST.hist.shift(); }
  for (let i = EST.hist.length - 2; i >= 0; i--) {
    if (hav(EST.hist[i], aqui) >= 20) { EST.rumo = rumo([EST.hist[i].lat, EST.hist[i].lon], [aqui.lat, aqui.lon]); break; }
  }

  const r = ROTA.ativa;
  if (r && ROTA.desvio != null && ROTA.desvio <= 50) {
    const base = ROTA.prog, temAlt = r.pts.some((p) => p[2] != null);
    EST.casado = null;
    EST.perfil = calcularPerfil(r.dist - base,
      (x) => { const p = pontoEm(r, base + x); return temAlt && p[2] != null ? p[2] : altitudeEm(p[0], p[1]); },
      null, (x) => pontoEm(r, base + x), "rota", r.dist - base <= ALCANCE ? "fim da rota" : null);
    return;
  }

  const bloco = garantirBlocos(aqui.lat, aqui.lon);
  if (bloco !== "ok") { EST.estado = bloco === "erro" ? (navigator.onLine ? "mapa de estradas indisponível" : "sem internet para baixar as estradas daqui") : "baixando estradas…"; EST.perfil = null; return; }
  if (EST.rumo == null) { EST.estado = "comece a andar para saber o sentido"; EST.perfil = null; return; }
  const c = casar(aqui.lat, aqui.lon, EST.rumo);
  if (!c) { EST.estado = "fora de estrada mapeada"; EST.casado = null; EST.perfil = null; return; }
  EST.casado = c;
  const cam = seguirEstrada(c);
  EST.caminho = cam;
  const onde = (x) => pontoEm(cam, x);
  let k = 0;
  EST.perfil = calcularPerfil(cam.dist,
    (x) => { const p = onde(x); return altitudeEm(p[0], p[1]); },
    (x) => { while (k < cam.cum.length - 2 && cam.cum[k + 1] < x) k++; return cam.pontes[k]; },
    onde, "estrada", cam.fim);
  if (EST.perfil.vazio) EST.estado = EST.perfil.vazio;
}

function avisarSubida() {
  const p = EST.perfil;
  if (!p || !p.trechos || cfg.avisoSubida === false || R.state !== "running") return;
  const s = p.trechos.find((x) => x.tipo === 1 && x.ini > 0 && x.len >= 300 && x.ganho >= 15);
  if (!s || s.ini > 450) return;
  const pt = p.pontoDe(s.ini), onde = { lat: pt[0], lon: pt[1] };
  if (EST.avisos.some((a) => hav(a, onde) < 300)) return;
  EST.avisos.push(onde);
  if (EST.avisos.length > 50) EST.avisos.shift();
  beep(880, 110, 2);
  if (cfg.vibrate && navigator.vibrate) navigator.vibrate([80, 60, 80]);
  toast("Subida em " + fmtDist(s.ini) + ": " + fmtDist(s.len) + " a " + fmtPct(s.grade) + " (+" + Math.round(s.ganho) + " m)", 5000);
}

EXT.tick.push((t) => {
  if (t - EST.tCalc < 3000) return;
  EST.tCalc = t;
  atualizarEstrada(t);
  avisarSubida();
});

/* ------------------------------------------------------------------------- */
/* Campos                                                                     */
/* ------------------------------------------------------------------------- */

const fmtPct = (g) => (g > 0.05 ? "+" : "") + g.toFixed(1) + "%";
const SETA_T = { 1: "↗", 0: "→", "-1": "↘" };
function corGrade(g) {
  if (g <= -2.5) return "#3aa0ff";
  if (g < 2.5) return "#7d838c";
  if (g < 5) return "#1baf7a";
  if (g < 8) return "#e6c200";
  if (g < 11) return "#eb6834";
  return "#d03b3b";
}
function descreverTrecho(s, primeiro) {
  if (s.tipo === 0) return (primeiro ? "Plano" : "plano") + " por " + fmtDist(s.len);
  return (primeiro ? (s.tipo > 0 ? "Subindo " : "Descendo ") : (s.tipo > 0 ? "subida " : "descida ")) + fmtPct(s.grade) + " por " + fmtDist(s.len);
}

/* texto curto para a tela de rota e para quem mais quiser */
function textoRelevo() {
  const p = EST.perfil;
  if (!p || !p.trechos) return "";
  const [a, b] = p.trechos;
  return SETA_T[a.tipo] + " " + (a.tipo ? fmtPct(a.grade) + " por " : "plano ") + fmtDist(a.len) + (b ? " · depois " + SETA_T[b.tipo] + " " + (b.tipo ? fmtPct(b.grade) : "plano") : "");
}

function desenharEstrada(el) {
  const cv = el.querySelector("canvas"), box = el.getBoundingClientRect(), dpr = devicePixelRatio || 1;
  if (!box.width) return;
  if (cv.width !== Math.round(box.width * dpr) || cv.height !== Math.round(box.height * dpr)) { cv.width = Math.round(box.width * dpr); cv.height = Math.round(box.height * dpr); }
  const ctx = cv.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = box.width, H = box.height, p = EST.perfil;
  ctx.clearRect(0, 0, W, H);
  const b1 = el.querySelector(".eAgora"), b2 = el.querySelector(".eDepois"), b3 = el.querySelector(".eFonte");
  if (!p || !p.trechos) {
    b1.textContent = "À frente"; b2.textContent = (p && p.vazio) || EST.estado; b3.textContent = "";
    return;
  }
  const [a, b] = p.trechos;
  b1.textContent = SETA_T[a.tipo] + " " + descreverTrecho(a, true);
  const prox = p.trechos.find((x, i) => i > 0 && x.tipo === 1 && x.len >= 200);
  b2.textContent = b ? (a.tipo !== 1 && prox ? "subida em " + fmtDist(prox.ini) + ": " + fmtDist(prox.len) + " a " + fmtPct(prox.grade) : "depois " + descreverTrecho(b, false))
    : p.fim === "cruzamento" ? "até o cruzamento" : "";
  b3.textContent = (p.fonte === "rota" ? "rota" : "OSM · SRTM") + (p.fim === "cruzamento" ? " · até o cruzamento" : "");

  const topo = Math.min(58, H * 0.45), base = H - 16, esc = 2000 >= p.dist ? 2000 : p.dist;
  const mn = Math.min(...p.e), mx = Math.max(...p.e), faixa = Math.max(25, mx - mn);
  const X = (d) => 8 + (d / esc) * (W - 16), Y = (e) => base - ((e - mn) / faixa) * (base - topo);
  for (let i = 1; i < p.d.length; i++) {
    ctx.beginPath();
    ctx.moveTo(X(p.d[i - 1]), base); ctx.lineTo(X(p.d[i - 1]), Y(p.e[i - 1])); ctx.lineTo(X(p.d[i]), Y(p.e[i])); ctx.lineTo(X(p.d[i]), base);
    ctx.closePath(); ctx.fillStyle = corGrade((p.g[i - 1] + p.g[i]) / 2); ctx.fill();
  }
  const css = getComputedStyle(document.documentElement), mute = css.getPropertyValue("--mute").trim() || "#8b919a";
  ctx.fillStyle = mute; ctx.font = "600 10px Roboto,sans-serif"; ctx.textAlign = "center";
  for (let d = 500; d < esc; d += 500) { ctx.fillRect(X(d), base, 1, 4); ctx.fillText(d % 1000 ? "" : d / 1000 + " km", X(d), H - 3); }
  if (p.fim === "cruzamento") { ctx.fillStyle = css.getPropertyValue("--txt").trim() || "#fff"; ctx.fillRect(X(p.dist) - 1, topo, 2, base - topo); }
  ctx.fillStyle = "#fff"; ctx.strokeStyle = "#000"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(X(0), Y(p.e[0]), 5, 0, 7); ctx.fill(); ctx.stroke();
}

CAMPOS.estrada = {
  lb: "Estrada à frente", especial: "estrada", full: 1,
  html: '<canvas></canvas><div class="eTxt"><b class="eAgora"></b><span class="eDepois"></span></div><small class="eFonte"></small>',
  desenhar: desenharEstrada,
};
CAMPOS.gradeFrente = {
  lb: "Inclinação à frente", u: "% · próximos 200 m",
  v: () => { const p = EST.perfil; if (!p || !p.e || p.d.length < 9) return "--"; return fmtPct(((p.e[8] - p.e[0]) / 200) * 100).replace("%", ""); },
};

/* No campo Trajeto, a estrada assumida à frente vai tracejada em amarelo:
 * se ela não for por onde você pretende ir, o perfil também não é. */
const desenharMapaSemFrente = desenharMapa;
desenharMapa = function (cv) {
  desenharMapaSemFrente(cv);
  if (typeof L === "undefined" || typeof MAPAS_CAMPO === "undefined") return;
  const m = MAPAS_CAMPO.find((x) => x.el === cv.parentElement);
  if (!m) return;
  if (!m.frente) m.frente = L.polyline([], { color: "#ffd24a", weight: 4, opacity: 0.95, dashArray: "6 8" }).addTo(m.mapa);
  const p = EST.perfil;
  m.frente.setLatLngs(p && p.trechos && p.fonte === "estrada" && EST.caminho ? EST.caminho.pts.slice() : []);
};

/* quem já tinha páginas salvas ganha o campo embaixo do mapa */
(function migrar() {
  if (cfg.vEstrada) return;
  if (!cfg.pages.some((pg) => pg.some((c) => c.k === "estrada"))) {
    const pg = cfg.pages.find((x) => x.some((c) => c.k === "map"));
    if (pg) pg.splice(pg.findIndex((c) => c.k === "map") + 1, 0, { k: "estrada", full: 1 });
  }
  cfg.vEstrada = 1;
  salvarCfg();
})();
