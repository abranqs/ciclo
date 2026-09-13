/* Treinos estruturados: os mesmos que estao no calendario do Garmin.
 *
 * O app executa passo a passo como o Edge: tempo (ou distancia) restante do
 * passo, alvo de FC com a faixa desenhada, aviso de 3-2-1 antes de trocar,
 * bipe quando a FC sai do alvo. Cada troca de passo vira uma volta, entao o
 * TCX exportado chega no Garmin Connect com uma volta por passo.
 */
"use strict";

const TREINO = { ativo: null, i: 0, iniMs: 0, iniDist: 0, fora: 0, concluido: false, bipe: -1 };

const todosTreinos = () => loja("treinos", "readonly", (st) => st.getAll());
const lerTreino = (id) => loja("treinos", "readonly", (st) => st.get(id));
async function substituirTreinos(lista) {
  const d = await idb();
  await new Promise((res, rej) => {
    const tx = d.transaction("treinos", "readwrite"), st = tx.objectStore("treinos");
    st.clear(); lista.forEach((t) => st.put(t));
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}

function treinoAtivo() { return !!TREINO.ativo; }
const passoAtual = () => (TREINO.ativo && !TREINO.concluido ? TREINO.ativo.passos[TREINO.i] : null);
const proximoPasso = () => (TREINO.ativo ? TREINO.ativo.passos[TREINO.i + 1] : null);

function rotuloPasso(p) {
  if (!p) return "";
  return p.rotulo + (p.rep ? " " + p.rep[0] + "/" + p.rep[1] : "");
}
function textoAlvo(p) {
  const a = p && p.alvo;
  if (!a) return "sem alvo";
  if (a.tipo === "fc") return "FC " + a.min + "–" + a.max;
  if (a.tipo === "velocidade") return (a.min * 3.6).toFixed(1) + "–" + (a.max * 3.6).toFixed(1) + " km/h";
  if (a.tipo === "cadencia") return a.min + "–" + a.max + " rpm";
  if (a.tipo === "potencia") return a.min + "–" + a.max + " W (sem medidor)";
  return "";
}
function duracaoPasso(p) {
  if (p.fim === "tempo") return fmtT(p.valor * 1000);
  if (p.fim === "distancia") return fmtDist(p.valor);
  return "até apertar Próximo";
}

function salvarEstadoTreino() {
  try {
    if (!TREINO.ativo) localStorage.removeItem("ciclo_treino");
    else localStorage.setItem("ciclo_treino", JSON.stringify({ id: TREINO.ativo.id, i: TREINO.i, iniMs: TREINO.iniMs, iniDist: TREINO.iniDist, concluido: TREINO.concluido }));
  } catch {}
}

function ativarTreino(t) {
  Object.assign(TREINO, { ativo: t, i: 0, iniMs: R.movingMs, iniDist: R.dist, fora: 0, concluido: false, bipe: -1 });
  salvarEstadoTreino();
  S.page = 0; controlesEstado = ""; montarPaginas();
  toast("Treino: " + t.nome + " · " + t.passos.length + " passos", 3000);
}
function pararTreino() {
  Object.assign(TREINO, { ativo: null, concluido: false });
  salvarEstadoTreino(); S.page = 0; controlesEstado = ""; montarPaginas();
}

function avancarPasso(automatico) {
  const t = TREINO.ativo; if (!t || TREINO.concluido) return;
  novaVolta(agora());
  if (TREINO.i >= t.passos.length - 1) {
    TREINO.concluido = true;
    beep(784, 220, 3); toast("Treino concluído! Siga pedalando ou encerre.", 5000);
  } else {
    TREINO.i++; TREINO.iniMs = R.movingMs; TREINO.iniDist = R.dist; TREINO.fora = 0; TREINO.bipe = -1;
    const p = passoAtual();
    beep(automatico ? 1175 : 988, 130, 2);
    toast((TREINO.i + 1) + "/" + t.passos.length + " · " + rotuloPasso(p) + " · " + duracaoPasso(p) + " · " + textoAlvo(p), 3500);
  }
  salvarEstadoTreino(); salvarMeta(); controlesEstado = ""; render();
}

EXT.volta.push(() => {
  if (!TREINO.ativo || TREINO.concluido) return false;
  avancarPasso(false);
  return true;
});

EXT.iniciar.push(() => {
  // pedal novo com treino ja escolhido: o treino comeca do primeiro passo
  if (TREINO.ativo && R.movingMs === 0) { TREINO.i = 0; TREINO.iniMs = 0; TREINO.iniDist = 0; TREINO.concluido = false; salvarEstadoTreino(); }
});

EXT.tick.push(() => {
  const p = passoAtual();
  if (!p || R.state !== "running") return;
  const dec = R.movingMs - TREINO.iniMs, dd = R.dist - TREINO.iniDist;
  if (p.fim === "tempo" && p.valor) {
    const falta = p.valor * 1000 - dec, s = Math.ceil(falta / 1000);
    if (s <= 3 && s >= 1 && s !== TREINO.bipe) { TREINO.bipe = s; beep(880, 90, 1); }
    if (falta <= 0) return avancarPasso(true);
  } else if (p.fim === "distancia" && p.valor && dd >= p.valor) return avancarPasso(true);

  const a = p.alvo; let valor = null;
  if (a && a.tipo === "fc") valor = hrAtual();
  if (a && a.tipo === "cadencia") valor = cadAtual();
  if (a && a.tipo === "velocidade") valor = velAtual();
  if (valor == null || !a || a.tipo === "potencia") { TREINO.fora = 0; return; }
  const acima = valor > a.max, abaixo = valor < a.min;
  if (!acima && !abaixo) { TREINO.fora = 0; return; }
  TREINO.fora++;
  // 8 s de tolerancia: a FC demora a responder no comeco de um tiro
  if (TREINO.fora === 8 || (TREINO.fora > 8 && (TREINO.fora - 8) % 20 === 0)) {
    const txt = a.tipo === "fc" ? "FC " + valor : a.tipo === "cadencia" ? "Cadência " + valor : (valor * 3.6).toFixed(1) + " km/h";
    if (acima) { beep(1320, 110, 3); toast(txt + " acima do alvo (" + textoAlvo(p) + ")"); }
    else { beep(520, 180, 2); toast(txt + " abaixo do alvo (" + textoAlvo(p) + ")"); }
  }
});

/* ------------------------------------------------------------------------- */
/* Pagina do treino                                                           */
/* ------------------------------------------------------------------------- */

EXT.paginas.push({
  nome: "treino",
  ativa: () => !!TREINO.ativo,
  montar(sec) {
    sec.innerHTML =
      '<div class="wPg">' +
      '<div class="wTopo"><span id="wN"></span><b id="wNome"></b><button id="wSair" class="x">Parar</button></div>' +
      '<div class="wBloco wFalta"><span class="lb" id="wFaltaLb">falta no passo</span><b class="num" id="wFalta">--</b></div>' +
      '<div class="wBloco wAlvo" id="wAlvoBox"><span class="lb">FC · alvo <span id="wAlvo"></span></span><b class="num" id="wVal">--</b>' +
      '<div class="gauge"><s id="wFaixa"></s><i id="wMarca"></i></div></div>' +
      '<div class="wLinha"><div class="wBloco"><span class="lb">Cadência</span><b class="num" id="wCad">--</b></div>' +
      '<div class="wBloco"><span class="lb">Velocidade</span><b class="num" id="wVel">--</b></div>' +
      '<div class="wBloco"><span class="lb">Tempo total</span><b class="num" id="wTot">--</b></div></div>' +
      '<div class="wProx"><span class="lb">depois</span><span id="wProx"></span></div>' +
      '<div class="wProg"><i id="wProg"></i></div></div>';
    sec.querySelector("#wSair").addEventListener("click", () => { if (confirm("Parar de seguir o treino? O pedal continua gravando.")) pararTreino(); });
  },
  atualizar(sec) {
    const t = TREINO.ativo; if (!t) return;
    const p = passoAtual();
    sec.querySelector("#wN").textContent = TREINO.concluido ? "fim" : (TREINO.i + 1) + "/" + t.passos.length;
    sec.querySelector("#wNome").textContent = TREINO.concluido ? "Treino concluído" : rotuloPasso(p);
    sec.querySelector("#wTot").textContent = fmtT(R.movingMs);
    const cad = cadAtual(), vel = velAtual();
    sec.querySelector("#wCad").textContent = cad ?? "--";
    sec.querySelector("#wVel").textContent = vel == null ? "--" : fmtKmh(vel);

    const dec = R.movingMs - TREINO.iniMs, dd = R.dist - TREINO.iniDist;
    let falta = "--", lb = "falta no passo", frac = 0;
    if (p && p.fim === "tempo") { falta = fmtT(Math.max(0, p.valor * 1000 - dec)); frac = dec / (p.valor * 1000); }
    else if (p && p.fim === "distancia") { falta = fmtDist(Math.max(0, p.valor - dd)); frac = dd / p.valor; }
    else if (p) { falta = fmtT(dec); lb = "no passo · aperte Próximo"; }
    sec.querySelector("#wFalta").textContent = TREINO.concluido ? "✓" : falta;
    sec.querySelector("#wFaltaLb").textContent = lb;

    const a = p && p.alvo, box = sec.querySelector("#wAlvoBox");
    const val = a && a.tipo === "cadencia" ? cad : a && a.tipo === "velocidade" ? vel : hrAtual();
    sec.querySelector("#wAlvo").textContent = a ? textoAlvo(p) : "livre";
    box.querySelector(".lb").firstChild.textContent = (a && a.tipo === "cadencia" ? "Cadência" : a && a.tipo === "velocidade" ? "Velocidade" : "FC") + " · alvo ";
    sec.querySelector("#wVal").textContent = val == null ? "--" : a && a.tipo === "velocidade" ? fmtKmh(val) : val;
    let estado = "";
    if (a && val != null && a.tipo !== "potencia") estado = val > a.max ? "acima" : val < a.min ? "abaixo" : "dentro";
    box.dataset.estado = estado;
    const faixa = sec.querySelector("#wFaixa"), marca = sec.querySelector("#wMarca");
    if (a && a.tipo !== "potencia") {
      const lo = a.min - (a.max - a.min) * 0.8, hi = a.max + (a.max - a.min) * 0.8, pos = (x) => Math.max(0, Math.min(100, ((x - lo) / (hi - lo)) * 100));
      faixa.style.left = pos(a.min) + "%"; faixa.style.width = pos(a.max) - pos(a.min) + "%"; faixa.style.display = "";
      marca.style.left = val == null ? "-10%" : pos(val) + "%";
    } else { faixa.style.display = "none"; marca.style.left = "-10%"; }

    const px = proximoPasso();
    sec.querySelector("#wProx").textContent = TREINO.concluido ? "—" : px ? rotuloPasso(px) + " · " + duracaoPasso(px) + " · " + textoAlvo(px) : "fim do treino";
    const totalPassos = t.passos.length;
    sec.querySelector("#wProg").style.width = (TREINO.concluido ? 100 : ((TREINO.i + Math.min(1, frac || 0)) / totalPassos) * 100) + "%";
  },
});

/* ------------------------------------------------------------------------- */
/* Lista de treinos                                                           */
/* ------------------------------------------------------------------------- */

const hojeIso = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const dataBr = (iso) => { const [y, m, d] = iso.split("-"); const dt = new Date(+y, +m - 1, +d); return ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"][dt.getDay()] + " " + d + "/" + m; };

async function abrirTreinos() {
  const hoje = hojeIso();
  const lista = (await todosTreinos()).filter((t) => t.data >= hoje).sort((a, b) => a.data.localeCompare(b.data));
  const sync = (() => { try { return JSON.parse(localStorage.getItem("ciclo_sync") || "null"); } catch { return null; } })();
  const body = $("#treinosBody");
  body.innerHTML =
    '<div class="grid2"><button class="btn main" id="bSyncT">Buscar do Garmin</button><label class="btn" style="text-align:center">Importar arquivo<input type="file" id="fTreino" accept=".json,application/json" hidden></label></div>' +
    '<p class="hint">' + (sync ? "Última busca " + new Date(sync.t).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) + " · " : "") +
    "Treinos de bike do seu calendário do Garmin, incluindo os do ciclo.</p>" +
    (TREINO.ativo ? '<div class="sensor"><div class="top"><div><b>Em andamento</b><div class="st">' + TREINO.ativo.nome + " · passo " + Math.min(TREINO.i + 1, TREINO.ativo.passos.length) + "/" + TREINO.ativo.passos.length + '</div></div><button class="btn" id="bPararT" style="background:var(--bad)">Parar</button></div></div>' : "") +
    (lista.length ? "" : '<p class="hint">Nenhum treino de bike nos próximos dias. Configure a sincronização em Menu → Sincronização, ou importe um arquivo.</p>') +
    lista.map((t) =>
      '<div class="sensor tItem' + (t.data === hoje ? " hoje" : "") + '" data-id="' + t.id + '"><div class="top"><div><b>' + (t.data === hoje ? "HOJE · " : dataBr(t.data) + " · ") + t.nome.replace(/</g, "&lt;") +
      '</b><div class="st">' + t.duracao_min + " min · " + t.passos.length + ' passos</div></div><button class="btn" data-a="usar">Usar</button></div>' +
      '<details><summary>ver passos</summary><table>' + t.passos.map((p, i) => "<tr><td>" + (i + 1) + ". " + rotuloPasso(p) + "</td><td class=num>" + duracaoPasso(p) + "</td><td class=num>" + textoAlvo(p) + "</td></tr>").join("") +
      "</table>" + (t.descricao ? '<p class="hint" style="white-space:pre-line">' + t.descricao.replace(/</g, "&lt;").slice(0, 700) + "</p>" : "") + "</details></div>").join("");
  body.querySelector("#bSyncT").addEventListener("click", async () => { await sincronizar(false); abrirTreinos(); });
  body.querySelector("#fTreino").addEventListener("change", async (e) => {
    try { const n = await importarPacote(JSON.parse(await e.target.files[0].text())); toast(n.treinos + " treinos, " + n.rotas + " rotas importados"); }
    catch (err) { toast("Arquivo inválido: " + err.message, 5000); }
    abrirTreinos();
  });
  const bp = body.querySelector("#bPararT"); if (bp) bp.addEventListener("click", () => { pararTreino(); $("#dlgTreinos").close(); });
  body.querySelectorAll(".tItem [data-a=usar]").forEach((b) => b.addEventListener("click", async () => {
    const t = await lerTreino(b.closest(".tItem").dataset.id);
    $("#dlgTreinos").close(); ativarTreino(t);
  }));
  abrir("dlgTreinos");
}

EXT.menu.push({ txt: "Treinos", sub: () => (TREINO.ativo ? "em andamento: " + TREINO.ativo.nome : "do calendário do Garmin"), fn: abrirTreinos });

/* treino do dia: aviso na tela inicial; restaura o treino em andamento */
async function avisarTreinoDoDia() {
  if (TREINO.ativo || R.state !== "idle") return;
  const t = (await todosTreinos()).find((x) => x.data === hojeIso());
  if (!t) return;
  const bn = $("#banner");
  bn.innerHTML = "Treino de hoje: <b>" + t.nome.replace(/</g, "&lt;") + "</b> · " + t.duracao_min + " min — toque para usar";
  bn.classList.add("on");
  bn.onclick = () => { bn.classList.remove("on"); bn.onclick = null; ativarTreino(t); };
}

document.addEventListener("DOMContentLoaded", () => {
  setTimeout(async () => {
    try {
      const e = JSON.parse(localStorage.getItem("ciclo_treino") || "null");
      if (e) { const t = await lerTreino(e.id); if (t) { Object.assign(TREINO, { ativo: t, i: e.i, iniMs: e.iniMs, iniDist: e.iniDist, concluido: e.concluido }); controlesEstado = ""; montarPaginas(); } }
    } catch {}
    avisarTreinoDoDia();
  }, 350);
});
