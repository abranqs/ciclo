/* Sincronizacao com o computador (treino-ia) e importacao de arquivos.
 *
 * O celular nao fala com o relogio nem com o app dele. O computador do Andre
 * (treino-ia) publica treinos e rotas num repositorio PRIVADO do GitHub, e o
 * app le de la com um token que fica apenas neste aparelho.
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
    if (typeof salvarTrechos === "function" && Array.isArray(idx.trechos)) salvarTrechos(idx.trechos);
    const info = { t: agora(), gerado: idx.gerado_em, treinos: (idx.treinos || []).length, rotas: (idx.rotas || []).length,
                   trechos: (idx.trechos || []).length };
    try { localStorage.setItem("ciclo_sync", JSON.stringify(info)); } catch {}
    if (!silencioso) toast("Sincronizado: " + info.treinos + " treinos de bike, " + info.rotas + " rotas e " + info.trechos + " trechos" + (novas ? " (" + novas + " novas/atualizadas)" : ""), 3500);
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
    '<p class="hint">O seu computador (treino-ia) publica os treinos de bike do seu plano e as suas rotas de bike no repositório <b>privado</b> abaixo, a cada sincronização. O celular lê de lá.</p>' +
    '<div class="row"><label for="sRepo">Repositório</label><input id="sRepo" type="text" style="width:190px" value="' + esc(SYNC.repo) + '"></div>' +
    '<div class="row"><label for="sTok">Token do GitHub<small>' + (SYNC.token ? "configurado neste celular" : "ainda não configurado") + '</small></label><input id="sTok" type="password" autocomplete="off" style="width:190px" placeholder="' + (SYNC.token ? "••••••••" : "github_pat_…") + '"></div>' +
    '<div class="grid2" style="margin-top:10px"><button class="btn main" id="sSalvar">Salvar e buscar</button><button class="btn" id="sApagar">Remover token</button></div>' +
    (info ? '<p class="hint">Última busca: ' + new Date(info.t).toLocaleString("pt-BR") + " · " + info.treinos + " treinos · " + info.rotas + " rotas</p>" : "") +
    '<h3>Como criar o token (uma vez só)</h3><ol class="hint" style="padding-left:18px">' +
    "<li>No celular ou computador, abra <b>github.com/settings/personal-access-tokens/new</b> (Fine-grained token).</li>" +
    "<li>Nome: <b>Ciclo celular</b>. Validade: 1 ano.</li>" +
    "<li>Repository access: <b>Only select repositories</b> → <b>ciclo-dados</b>.</li>" +
    "<li>Permissions → <b>Add permissions</b> → marque <b>Contents</b> e <b>Issues</b>.</li>" +
    "<li>Na tabela que aparece: <b>Contents: Read-only</b> e <b>Issues: Read and write</b>. Nada mais.</li>" +
    "<li>Gere, copie e cole aqui.</li></ol>" +
    '<p class="hint">O token fica só neste aparelho. Ele <b>lê</b> rotas, treinos e trechos desse repositório e cria uma issue para mandar o pedal ao computador. Se perder o celular, apague o token no GitHub.</p>';
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
  sub: () => { try { const i = JSON.parse(localStorage.getItem("ciclo_sync") || "null"); return i ? "última busca · " + new Date(i.t).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : SYNC.token ? "buscar agora" : "configurar"; } catch { return ""; } },
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
/* atividade do relogio pelo horario e preenche a cadencia na analise.        */
/* A issue tem teto de 65 mil caracteres: amostra de 5 s (10 s em pedal > 4 h). */
/* ------------------------------------------------------------------------- */
async function montarPacotePedal(r = R) {
  const am = await lerAmostras(r.id);
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
  return { tipo: "pedal", id: "ciclo-" + r.id, inicio_ms: ini, fim_ms: fim, passo_s: passo,
           dist_m: Math.round(r.dist), cad, fc, v, versao: VERSAO };
}

/* O Resumo e um <dialog> modal: o toast ficava ATRAS dele (camada de topo do
 * navegador) e o botao parecia nao responder. O aviso vai no proprio botao. */
function avisoPedal(msg, ok) {
  const b = document.getElementById("bPc");
  if (b) { b.textContent = msg; b.disabled = !!ok; }
  toast(msg, 4000);
}

/* Fila de envio. O pedal encerrado nasce "pendente" no historico e so sai da
 * fila quando o GitHub aceita (201) — ou quando nao ha o que mandar (sem
 * cadencia). Falhou (sem sinal, GitHub fora, token): continua pendente e a
 * fila tenta de novo ao abrir o app, quando ele volta para a tela, quando a
 * rede volta ("online") e pelo botao "Enviar agora" do Historico.
 *
 * Para nao duplicar: (1) o que ja foi aceito fica marcado "enviado" e nunca
 * mais e postado; (2) um pedal nunca tem dois envios ao mesmo tempo; (3) a
 * tentativa e gravada ANTES do POST, e toda nova tentativa de um pedal que ja
 * tentou comeca perguntando ao GitHub se a issue dele ja esta la — cobre o
 * caso em que o GitHub aceitou mas a resposta nao chegou ao celular. */
const ENVIO = { emCurso: new Map(), fila: null, tFila: 0 };
const cabecalhoGh = () => ({ Authorization: "Bearer " + SYNC.token, Accept: "application/vnd.github+json",
                             "X-GitHub-Api-Version": "2022-11-28" });

async function pedalJaNoComputador(titulo, pac) {
  const r = await fetch("https://api.github.com/repos/" + SYNC.repo + "/issues?state=all&per_page=100&since=" +
    encodeURIComponent(new Date(pac.inicio_ms).toISOString()), { headers: cabecalhoGh(), cache: "no-store" });
  if (!r.ok) throw new Error("GitHub " + r.status + " ao conferir o envio anterior");
  const lista = await r.json();
  return Array.isArray(lista) && lista.some((i) => i && i.title === titulo && (!i.body || i.body.includes('"id":"' + pac.id + '"')));
}

async function enviarUm(id, avisa) {
  const p = await histLer(id);
  if (!p) { avisa("Este pedal não está mais no celular"); return false; }
  const marcar = async (envio, erro) => {
    p.envio = envio; p.erro = erro || "";
    await histGravar(p);
    if (envio === "enviado" && R.id === p.id && !R.enviado) { R.enviado = true; salvarMeta(); }
    histTodos().catch(() => {});
  };
  if (p.envio === "enviado") { avisa("Já enviado ao computador ✓", true); return true; }
  if (DEMO) return false;
  try {
    const pac = await montarPacotePedal(p.r);
    if (!pac) { await marcar("sem"); avisa("Este pedal não está mais no celular"); return false; }
    if (!pac.cad.some((x) => x != null)) { await marcar("sem"); avisa("Pedal sem cadência — nada a enviar"); return false; }
    if (!SYNC.token) { avisa("Configure a sincronização para enviar"); return false; }
    if (!navigator.onLine) { avisa("Sem internet — fica na fila e vai sozinho quando a rede voltar"); return false; }
    const titulo = "ciclo-pedal " + new Date(pac.inicio_ms).toISOString().slice(0, 16).replace("T", " ");
    if (p.tent > 0 && (await pedalJaNoComputador(titulo, pac))) { await marcar("enviado"); avisa("Já estava no computador ✓", true); return true; }
    p.tent = (p.tent || 0) + 1;
    await histGravar(p);
    const r = await fetch("https://api.github.com/repos/" + SYNC.repo + "/issues", {
      method: "POST",
      headers: Object.assign(cabecalhoGh(), { "Content-Type": "application/json" }),
      body: JSON.stringify({ title: titulo, body: JSON.stringify(pac) }),
    });
    if (r.status === 201) { await marcar("enviado"); avisa("Enviado ao computador ✓", true); return true; }
    if (r.status === 403) { await marcar("pendente", "o token não tem a permissão Issues (Read and write)"); avisa("Não enviou: o token não tem a permissão Issues (Read and write)"); }
    else { await marcar("pendente", "GitHub " + r.status); avisa("Não enviou (GitHub " + r.status + ") — fica na fila; toque para tentar de novo"); }
  } catch (e) {
    if (p.envio === "enviado") return true;          // o GitHub aceitou; o que falhou foi depois (a proxima tentativa confere la antes de postar)
    try { await marcar("pendente", e.message); } catch {}
    avisa("Não enviou: " + e.message + " — fica na fila");
  }
  return false;
}

/* um envio por pedal de cada vez: quem pedir durante um envio recebe o mesmo resultado */
function enviarPedalGuardado(id, avisa = () => {}) {
  if (ENVIO.emCurso.has(id)) return ENVIO.emCurso.get(id);
  const pr = enviarUm(id, avisa).catch(() => false).finally(() => ENVIO.emCurso.delete(id));
  ENVIO.emCurso.set(id, pr);
  return pr;
}

/* manda tudo o que esta "a enviar", do mais antigo para o mais novo; devolve quantos foram */
function enviarPendentes() {
  if (ENVIO.fila) return ENVIO.fila;
  if (DEMO || !SYNC.token || !navigator.onLine) return Promise.resolve(0);
  ENVIO.tFila = agora();
  ENVIO.fila = (async () => {
    let ok = 0;
    await histPronto;
    for (const p of (await histTodos()).filter((x) => x.envio === "pendente").reverse()) {
      if (await enviarPedalGuardado(p.id)) ok++;
    }
    return ok;
  })().catch(() => 0).finally(() => { ENVIO.fila = null; });
  return ENVIO.fila;
}

/* botao do Resumo (manual) e fim do pedal (automatico) */
async function enviarPedal(manual, id = R.id) {
  const avisa = (m, ok) => { if (manual) avisoPedal(m, ok); else if (ok) toast(m, 3000); };
  if (DEMO) return false;
  if (manual) avisoPedal("Enviando…");
  return enviarPedalGuardado(id, avisa);
}
EXT.encerrar.push(() => { enviarPedal(false); });

window.addEventListener("online", () => { enviarPendentes(); });
document.addEventListener("visibilitychange", () => {     // o app instalado quase nunca fecha: "abrir" e voltar para a tela
  if (document.visibilityState === "visible" && agora() - ENVIO.tFila > 5 * 60000) enviarPendentes();
});
document.addEventListener("DOMContentLoaded", () => { setTimeout(enviarPendentes, 3000); });
