/* Sincronizacao com o Garmin (via treino-ia) e importacao de arquivos.
 *
 * O celular nao fala com a Garmin. O computador do Andre (treino-ia) publica
 * treinos e rotas num repositorio PRIVADO do GitHub, e o app le de la com um
 * token so de leitura que fica apenas neste aparelho.
 *
 * Arquivos tambem entram pelo "Compartilhar" do Android (share target no
 * manifest): o service worker guarda o arquivo e abre o app com ?importar=1.
 */
"use strict";

const SYNC = {
  get repo() { try { return localStorage.getItem("ciclo_repo") || "abranqs/ciclo-dados"; } catch { return "abranqs/ciclo-dados"; } },
  get token() { try { return localStorage.getItem("ciclo_token") || ""; } catch { return ""; } },
  rodando: false,
};

async function ghArquivo(caminho) {
  const url = "https://api.github.com/repos/" + SYNC.repo + "/contents/" + caminho.split("/").map(encodeURIComponent).join("/");
  const r = await fetch(url, {
    headers: { Authorization: "Bearer " + SYNC.token, Accept: "application/vnd.github.raw+json", "X-GitHub-Api-Version": "2022-11-28" },
    cache: "no-store",
  });
  if (r.status === 401) throw new Error("token inválido ou expirado");
  if (r.status === 403) throw new Error("token sem permissão de leitura no repositório");
  if (r.status === 404) throw new Error(await diagnosticar404(caminho));
  if (!r.ok) throw new Error("GitHub respondeu " + r.status);
  return r;
}

/* O GitHub responde 404 (e nao 403) quando o token nao enxerga um repositorio
 * privado — "nao achei o arquivo" soa como arquivo faltando, mas quase sempre
 * e o token. Aqui se separa: token invalido, repo fora do token, ou repo
 * visivel sem a permissao Contents. */
async function diagnosticar404(caminho) {
  const h = { Authorization: "Bearer " + SYNC.token, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  try {
    const u = await fetch("https://api.github.com/user", { headers: h, cache: "no-store" });
    const conta = u.ok ? (await u.json()).login : null;
    const repo = await fetch("https://api.github.com/repos/" + SYNC.repo, { headers: h, cache: "no-store" });
    if (repo.status === 404) {
      return "o token" + (conta ? " (conta " + conta + ")" : "") + " não tem acesso ao repositório " + SYNC.repo +
        ". Edite o token no GitHub: Repository access → Only select repositories → marque ciclo-dados";
    }
    if (repo.ok) {
      return "o token vê o repositório, mas não pode ler arquivos. Edite o token: Permissions → Repository permissions → Contents → Read-only";
    }
  } catch {}
  return "não achei " + caminho + " em " + SYNC.repo;
}

async function sincronizar(silencioso) {
  if (SYNC.rodando) return;
  if (!SYNC.token) { if (!silencioso) { toast("Configure a sincronização primeiro"); abrirSync(); } return; }
  if (!navigator.onLine) { if (!silencioso) toast("Sem internet — usando o que já está no celular"); return; }
  SYNC.rodando = true;
  if (!silencioso) toast("Buscando treinos e rotas…", 8000);
  try {
    const idx = await (await ghArquivo("indice.json")).json();
    const locais = await todasRotas();
    const porId = Object.fromEntries(locais.map((r) => [r.id, r]));
    let novas = 0;
    for (const ri of idx.rotas || []) {
      const id = "g" + ri.id;
      if (porId[id] && porId[id].atualizado === ri.atualizado) continue;
      const r = prepararRota(lerGpx(await (await ghArquivo(ri.arquivo)).text()),
        { id, origem: "garmin", nome: ri.nome, tipo: ri.tipo, atualizado: ri.atualizado });
      await salvarRota(r);
      if (ROTA.ativa && ROTA.ativa.id === id) ROTA.ativa = r;
      novas++;
    }
    const doGarmin = new Set((idx.rotas || []).map((r) => "g" + r.id));
    for (const r of locais) if (r.origem === "garmin" && !doGarmin.has(r.id)) await apagarRota(r.id);
    await substituirTreinos(idx.treinos || []);
    const info = { t: agora(), gerado: idx.gerado_em, treinos: (idx.treinos || []).length, rotas: (idx.rotas || []).length };
    try { localStorage.setItem("ciclo_sync", JSON.stringify(info)); } catch {}
    if (!silencioso) toast("Garmin: " + info.treinos + " treinos de bike e " + info.rotas + " rotas" + (novas ? " (" + novas + " novas/atualizadas)" : ""), 3500);
    avisarTreinoDoDia();
  } catch (e) {
    if (!silencioso) toast("Não sincronizou: " + e.message, 6000);
  } finally { SYNC.rodando = false; }
}

/* pacote JSON (mesmo formato do indice.json, com rotas embutidas em "gpx") */
async function importarPacote(j) {
  let rotas = 0;
  for (const ri of j.rotas || []) {
    if (!ri.gpx) continue;
    await salvarRota(prepararRota(lerGpx(ri.gpx), { id: "p" + ri.id, origem: "arquivo", nome: ri.nome, tipo: ri.tipo }));
    rotas++;
  }
  if (Array.isArray(j.treinos)) {
    const atuais = await todosTreinos();
    const porId = Object.fromEntries(atuais.map((t) => [t.id, t]));
    j.treinos.forEach((t) => { porId[t.id] = t; });
    await substituirTreinos(Object.values(porId));
  }
  return { treinos: (j.treinos || []).length, rotas };
}

/* ------------------------------------------------------------------------- */
/* Tela de configuracao                                                       */
/* ------------------------------------------------------------------------- */

function abrirSync() {
  const info = (() => { try { return JSON.parse(localStorage.getItem("ciclo_sync") || "null"); } catch { return null; } })();
  $("#syncBody").innerHTML =
    '<p class="hint">O seu computador (treino-ia) publica os treinos de bike do calendário do Garmin e as suas rotas de bike no repositório <b>privado</b> abaixo, a cada sincronização. O celular lê de lá.</p>' +
    '<div class="row"><label for="sRepo">Repositório</label><input id="sRepo" type="text" style="width:190px" value="' + SYNC.repo + '"></div>' +
    '<div class="row"><label for="sTok">Token do GitHub<small>' + (SYNC.token ? "configurado neste celular" : "ainda não configurado") + '</small></label><input id="sTok" type="password" autocomplete="off" style="width:190px" placeholder="' + (SYNC.token ? "••••••••" : "github_pat_…") + '"></div>' +
    '<div class="grid2" style="margin-top:10px"><button class="btn main" id="sSalvar">Salvar e buscar</button><button class="btn" id="sApagar">Remover token</button></div>' +
    (info ? '<p class="hint">Última busca: ' + new Date(info.t).toLocaleString("pt-BR") + " · " + info.treinos + " treinos · " + info.rotas + " rotas</p>" : "") +
    '<h3>Como criar o token (uma vez só)</h3><ol class="hint" style="padding-left:18px">' +
    "<li>No celular ou computador, abra <b>github.com/settings/personal-access-tokens/new</b> (Fine-grained token).</li>" +
    "<li>Nome: <b>Ciclo celular</b>. Validade: 1 ano.</li>" +
    "<li>Repository access: <b>Only select repositories</b> → <b>ciclo-dados</b>.</li>" +
    "<li>Permissions → Repository → <b>Contents: Read-only</b>. Nada mais.</li>" +
    "<li>Gere, copie e cole aqui.</li></ol>" +
    '<p class="hint">O token fica só neste aparelho e só consegue <b>ler</b> esse repositório. Se perder o celular, apague o token no GitHub.</p>';
  $("#sSalvar").addEventListener("click", async () => {
    const repo = $("#sRepo").value.trim(), tok = $("#sTok").value.trim();
    try { if (repo) localStorage.setItem("ciclo_repo", repo); if (tok) localStorage.setItem("ciclo_token", tok); } catch {}
    $("#dlgSync").close();
    await sincronizar(false);
  });
  $("#sApagar").addEventListener("click", () => { try { localStorage.removeItem("ciclo_token"); } catch {} toast("Token removido deste celular"); abrirSync(); });
  abrir("dlgSync");
}

EXT.menu.push({
  txt: "Sincronização", fn: abrirSync,
  sub: () => { try { const i = JSON.parse(localStorage.getItem("ciclo_sync") || "null"); return i ? "Garmin · " + new Date(i.t).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : SYNC.token ? "buscar agora" : "configurar"; } catch { return ""; } },
});

/* ------------------------------------------------------------------------- */
/* Arquivos recebidos pelo Compartilhar do Android                            */
/* ------------------------------------------------------------------------- */

async function importarRecebidos() {
  if (!("caches" in window)) return;
  const c = await caches.open("ciclo-recebidos");
  const chaves = await c.keys();
  if (!chaves.length) return;
  let ok = 0;
  for (const req of chaves) {
    const resp = await c.match(req);
    const nome = decodeURIComponent(resp.headers.get("x-nome") || "arquivo");
    const blob = await resp.blob();
    const file = new File([blob], nome, { type: blob.type });
    try {
      if (/\.json$/i.test(nome)) await importarPacote(JSON.parse(await file.text()));
      else { const r = await importarRotaDeArquivo(file); toast("Rota importada: " + r.nome + " · " + fmtKm(r.dist) + " km", 3500); }
      ok++;
    } catch (e) { toast("Não importou " + nome + ": " + e.message, 6000); }
    await c.delete(req);
  }
  if (ok) setTimeout(abrirRotas, 600);
}

document.addEventListener("DOMContentLoaded", () => {
  if (new URLSearchParams(location.search).has("importar")) {
    history.replaceState(null, "", location.pathname + (DEMO ? "?demo=1" : ""));
    setTimeout(importarRecebidos, 400);
  }
  // busca sozinha ao abrir, no maximo a cada 30 min
  setTimeout(() => {
    try {
      const i = JSON.parse(localStorage.getItem("ciclo_sync") || "null");
      if (SYNC.token && (!i || agora() - i.t > 30 * 60000)) sincronizar(true);
    } catch {}
  }, 1500);
});

/* ------------------------------------------------------------------------- */
/* Pedal gravado aqui -> computador (21/09/2026)                              */
/*                                                                            */
/* O celular pega o sensor de cadencia pelo Bluetooth; enquanto ele esta      */
/* conectado aqui, o relogio nao consegue le-lo. Entao a cadencia so existe   */
/* neste aparelho. Ao encerrar o pedal, as series (cadencia, FC, velocidade)  */
/* vao numa issue "ciclo-pedal" do ciclo-dados; o treino-ia le, casa com a    */
/* atividade do Garmin pelo horario e preenche a cadencia na analise.         */
/* A issue tem teto de 65 mil caracteres: amostra de 5 s (10 s em pedal > 4 h). */
/* ------------------------------------------------------------------------- */
async function montarPacotePedal() {
  const am = await lerAmostras(R.id);
  if (!am.length) return null;
  const ini = am[0].t, fim = am[am.length - 1].t;
  const passo = (fim - ini) / 1000 > 4 * 3600 ? 10 : 5;
  const cad = [], fc = [], v = [];
  let j = 0;
  for (let t = ini; t <= fim; t += passo * 1000) {
    while (j + 1 < am.length && am[j + 1].t <= t) j++;
    const s = am[j];
    const perto = Math.abs(s.t - t) <= passo * 1000;
    cad.push(perto && s.cad != null ? Math.round(s.cad) : null);
    fc.push(perto && s.hr ? Math.round(s.hr) : null);
    v.push(perto && s.v != null ? Math.round(s.v * 10) / 10 : null);
  }
  return { tipo: "pedal", id: "ciclo-" + R.id, inicio_ms: ini, fim_ms: fim, passo_s: passo,
           dist_m: Math.round(R.dist), cad, fc, v, versao: VERSAO };
}

/* O Resumo e um <dialog> modal: o toast fica ATRAS dele (camada de topo do
 * navegador) e o botao parecia nao responder. O aviso vai no proprio botao. */
function avisoPedal(msg, ok) {
  const b = document.getElementById("bPc");
  if (b) { b.textContent = msg; b.disabled = !!ok; }
  toast(msg, 4000);
}

async function enviarPedal(manual) {
  const avisa = (m, ok) => { if (manual) avisoPedal(m, ok); else if (ok) toast(m, 3000); };
  if (DEMO) return;
  if (!SYNC.token) { avisa("Configure a sincronização para enviar"); return; }
  if (R.enviado) { avisa("Já enviado ao computador ✓", true); return; }
  if (manual) avisoPedal("Enviando…");
  try {
    const p = await montarPacotePedal();
    if (!p) { avisa("Este pedal não está mais no celular"); return; }
    if (!p.cad.some((x) => x != null)) { avisa("Pedal sem cadência — nada a enviar"); return; }
    const titulo = "ciclo-pedal " + new Date(p.inicio_ms).toISOString().slice(0, 16).replace("T", " ");
    const r = await fetch("https://api.github.com/repos/" + SYNC.repo + "/issues", {
      method: "POST",
      headers: { Authorization: "Bearer " + SYNC.token, Accept: "application/vnd.github+json",
                 "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
      body: JSON.stringify({ title: titulo, body: JSON.stringify(p) }),
    });
    if (r.status === 201) { R.enviado = true; salvarMeta(); avisa("Enviado ao computador ✓", true); }
    else avisa("Não enviou (GitHub " + r.status + ") — toque para tentar de novo");
  } catch (e) { avisa("Não enviou: " + e.message); }
}
EXT.encerrar.push(() => { enviarPedal(false); });
