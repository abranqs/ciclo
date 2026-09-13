/* Service worker do Ciclo.
 *  - abre sem internet (no meio do pedal pode nao ter sinal);
 *  - guarda os blocos de mapa ja vistos, para a rota nao ficar sem fundo
 *    quando o sinal cai;
 *  - recebe arquivos do "Compartilhar" do Android (share target).
 */
const VERSAO = "ciclo-1.1.3";
const MAPAS = "ciclo-mapas-1";
const RECEBIDOS = "ciclo-recebidos";
const ARQUIVOS = ["./", "./index.html", "./app.js", "./rotas.js", "./treinos.js", "./sync.js", "./manifest.webmanifest",
  "./icons/icon-192.png", "./icons/icon-512.png", "./vendor/leaflet/leaflet.js", "./vendor/leaflet/leaflet.css"];
const HOSTS_MAPA = ["server.arcgisonline.com", "tile.openstreetmap.org", "a.tile.opentopomap.org", "b.tile.opentopomap.org", "c.tile.opentopomap.org"];
const MAX_BLOCOS = 3000;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSAO).then((c) => c.addAll(ARQUIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k.startsWith("ciclo-") && ![VERSAO, MAPAS, RECEBIDOS].includes(k)).map((k) => caches.delete(k))))
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

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === "POST" && url.origin === location.origin && url.pathname.endsWith("/receber")) {
    e.respondWith(receber(e.request));
    return;
  }
  if (e.request.method !== "GET") return;
  if (HOSTS_MAPA.includes(url.hostname)) { e.respondWith(blocoDeMapa(e.request)); return; }
  if (url.origin !== location.origin) return;
  // App: rede primeiro (pega versao nova quando ha sinal), cache quando nao ha.
  e.respondWith(
    fetch(e.request)
      .then((r) => { const copia = r.clone(); caches.open(VERSAO).then((c) => c.put(e.request, copia)); return r; })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
