/* Service worker do Ciclo.
 *  - abre sem internet (no meio do pedal pode nao ter sinal);
 *  - guarda os blocos de mapa ja vistos, para a rota nao ficar sem fundo
 *    quando o sinal cai;
 *  - guarda estradas (OpenFreeMap) e relevo (Terrarium) da "Estrada a frente";
 *  - recebe arquivos do "Compartilhar" do Android (share target).
 */
const VERSAO = "ciclo-1.2.3";
const MAPAS = "ciclo-mapas-1";
const RECEBIDOS = "ciclo-recebidos";
const TERRENO = "ciclo-terreno-1";
const ARQUIVOS = ["./", "./index.html", "./app.js", "./rotas.js", "./treinos.js", "./sync.js", "./estrada.js", "./manifest.webmanifest",
  "./icons/icon-192.png", "./icons/icon-512.png", "./vendor/leaflet/leaflet.js", "./vendor/leaflet/leaflet.css"];
const HOSTS_MAPA = ["server.arcgisonline.com", "tile.openstreetmap.org", "a.tile.opentopomap.org", "b.tile.opentopomap.org", "c.tile.opentopomap.org"];
const MAX_BLOCOS = 3000, MAX_TERRENO = 1500;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSAO).then((c) => c.addAll(ARQUIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k.startsWith("ciclo-") && ![VERSAO, MAPAS, RECEBIDOS, TERRENO].includes(k)).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function receber(req) {
  const form = await req.formData();
  const c = await caches.open(RECEBIDOS);
  const arquivos = form.getAll("arquivo").filter((f) => f && f.name);
  for (const f of arquivos) {
    await c.put("/recebido/" + Date.now() + "-" + encodeURIComponent(f.name),
      new Response(f, { headers: { "x-nome": encodeURIComponent(f.name), "content-type": f.type || "application/octet-stream" } }));
  }
  return Response.redirect("./?importar=1", 303);
}

async function blocoDeMapa(req) {
  const c = await caches.open(MAPAS);
  const hit = await c.match(req);
  if (hit) return hit;
  try {
    const r = await fetch(req);
    if (r.ok) {
      c.put(req, r.clone());
      c.keys().then((ks) => { if (ks.length > MAX_BLOCOS) ks.slice(0, ks.length - MAX_BLOCOS).forEach((k) => c.delete(k)); });
    }
    return r;
  } catch (err) {
    return hit || Response.error();
  }
}

/* Estradas e relevo mudam pouco: guardados sem prazo. A chave das estradas
 * ignora a versao do mapa no endereco, para o que ja foi baixado continuar
 * valendo quando o OpenFreeMap publica uma versao nova. */
async function blocoDeTerreno(req, chave) {
  const c = await caches.open(TERRENO);
  const hit = await c.match(chave);
  if (hit) return hit;
  const r = await fetch(req);
  if (r.ok) {
    c.put(chave, r.clone());
    c.keys().then((ks) => { if (ks.length > MAX_TERRENO) ks.slice(0, ks.length - MAX_TERRENO).forEach((k) => c.delete(k)); });
  }
  return r;
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === "POST" && url.origin === location.origin && url.pathname.endsWith("/receber")) {
    e.respondWith(receber(e.request));
    return;
  }
  if (e.request.method !== "GET") return;
  if (HOSTS_MAPA.includes(url.hostname)) { e.respondWith(blocoDeMapa(e.request)); return; }
  if (url.hostname === "tiles.openfreemap.org" && url.pathname.endsWith(".pbf")) {
    e.respondWith(blocoDeTerreno(e.request, url.origin + url.pathname.replace(/^\/planet\/[^/]+\//, "/planet/_/")));
    return;
  }
  if (url.hostname === "s3.amazonaws.com" && url.pathname.startsWith("/elevation-tiles-prod/")) {
    e.respondWith(blocoDeTerreno(e.request, url.href));
    return;
  }
  if (url.origin !== location.origin) return;
  // App: rede primeiro (pega versao nova quando ha sinal), cache quando nao ha.
  // "no-cache" revalida no servidor: o GitHub Pages manda guardar 10 min, e sem
  // isso o app aberto logo depois de uma publicacao continuava na versao velha.
  e.respondWith(
    fetch(url.href, { cache: "no-cache", credentials: "same-origin" })
      .then((r) => { const copia = r.clone(); caches.open(VERSAO).then((c) => c.put(e.request, copia)); return r; })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
