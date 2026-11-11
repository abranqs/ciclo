/* Historico: a tela dos pedais guardados.
 *
 * Guardar, ler e apagar ficam no app.js (guardarNoHistorico, histTodos,
 * histLer, histApagar); o envio ao computador, no sync.js. Aqui e so a lista:
 * data, tempo em movimento, distancia, FC media e subida de cada pedal, com
 * Resumo, Baixar TCX (de novo, quantas vezes quiser), Enviar agora para os
 * que ficaram "a enviar" e Apagar (com confirmacao).
 */
"use strict";

function linhaPedal(p) {
  const r = p.r;
  return '<div class="sensor hItem" data-id="' + esc(p.id) + '"><div class="top"><div><b>' + esc(dataPedal(r.startT)) + "</b>" +
    '<div class="st num">' + esc(fmtT(r.movingMs)) + " em movimento · " + esc(fmtKm(r.dist || 0)) + " km · FC " +
    esc(media(r.hrSum, r.hrN) ?? "--") + " · ↑" + esc(Math.round(r.gain || 0)) + " m</div></div>" +
    '<button class="btn" data-a="ver">Resumo</button></div>' +
    '<div class="acoes"><button data-a="tcx">Baixar TCX</button>' +
    (p.envio === "pendente" ? '<button data-a="enviar">Enviar agora</button>' : "") +
    '<button data-a="apagar">Apagar</button>' +
    (p.envio === "pendente" ? '<span class="hTag pend">a enviar</span>' : p.envio === "enviado" ? '<span class="hTag">enviado ✓</span>' : "") +
    "</div></div>";
}

async function abrirHistorico() {
  let lista = [];
  try { lista = await histTodos(); } catch (e) { console.error(e); }
  const pend = lista.filter((p) => p.envio === "pendente").length;
  const body = $("#histBody");
  body.innerHTML =
    (emAndamento() ? '<p class="hint" style="margin:0 0 10px">O pedal em andamento entra aqui quando você encerrar.</p>' : "") +
    (pend ? '<button class="btn" id="hEnviar" style="width:100%;margin-bottom:10px">Enviar agora ao computador (' + pend + ")</button>" : "") +
    (lista.length ? lista.map(linhaPedal).join("") : '<p class="hint">Nenhum pedal guardado ainda. Cada pedal encerrado fica aqui.</p>') +
    '<p class="hint">Ficam os ' + HIST_MAX + " pedais mais recentes, cada um com tudo o que é preciso para baixar o TCX de novo. " +
    "Quando entra o " + (HIST_MAX + 1) + "º, o mais antigo sai.</p>";

  const enviar = async (botao, id) => {
    botao.disabled = true; botao.textContent = "Enviando…";
    let msg = "";
    try {
      if (id == null) { const n = await enviarPendentes(); msg = n ? n + (n === 1 ? " pedal enviado ✓" : " pedais enviados ✓") : "Não enviou agora — continua na fila"; }
      else await enviarPedalGuardado(id, (m) => { msg = m; });
    } catch (e) { msg = "Não enviou: " + e.message; }
    await abrirHistorico();
    if (msg) toast(msg, 4000);
  };
  const be = body.querySelector("#hEnviar");
  if (be) be.addEventListener("click", () => enviar(be, null));

  body.querySelectorAll(".hItem").forEach((el) => el.addEventListener("click", async (e) => {
    const a = e.target.closest("[data-a]"); if (!a) return;
    const id = Number(el.dataset.id), p = await histLer(id);
    if (!p) { abrirHistorico(); return; }
    if (a.dataset.a === "ver") {
      abrirResumo(p);
      // o envio pode ter mudado la dentro: a lista se refaz quando o resumo fecha
      $("#dlgSummary").addEventListener("close", () => { if ($("#dlgHist").open) abrirHistorico(); }, { once: true });
    }
    if (a.dataset.a === "tcx") {
      a.disabled = true;
      try { await baixarTcx(p.r); } catch (err) { toast("Não gerou o TCX: " + err.message, 5000); }
      a.disabled = false;
    }
    if (a.dataset.a === "enviar") enviar(a, id);
    if (a.dataset.a === "apagar" && confirm("Apagar o pedal de " + dataPedal(p.r.startT) + " (" + fmtKm(p.r.dist || 0) + " km)? Some do celular e não dá para desfazer.")) {
      await histApagar(id);
      if (R.id === id && R.state === "done") { R = rideNova(); buf = []; salvarMeta(); controlesEstado = ""; }
      abrirHistorico();
    }
  }));
  abrir("dlgHist");
}

EXT.menu.push({
  txt: "Histórico", fn: abrirHistorico,
  sub: () => (HIST.n ? HIST.n + (HIST.n === 1 ? " pedal" : " pedais") + (HIST.pend ? " · " + HIST.pend + " a enviar" : "") : "pedais gravados, TCX de novo"),
});

/* a contagem do menu ja vem certa na abertura (depois da migracao do pedal antigo) */
document.addEventListener("DOMContentLoaded", () => { histPronto.then(() => histTodos()).catch(() => {}); });
