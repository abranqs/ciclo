/* Trechos ao vivo — os "segmentos" do Strava, no Ciclo (21/09/2026).
 *
 * O computador (treino-ia) descobre as subidas que o Andre repete e os trechos
 * que ele marca, e publica cada um com o perfil do RECORDE: o tempo que ele
 * levou a cada 50 m. Durante o pedal, ao passar a menos de 35 m do inicio de
 * um trecho, abre uma faixa no topo com: quanto falta, tempo no trecho e a
 * diferenca para o recorde naquele mesmo ponto (verde = na frente). No fim,
 * mostra o resultado e a posicao.
 */
"use strict";

const TRECHOS = {
  lista: (() => { try { return JSON.parse(localStorage.getItem("ciclo_trechos") || "[]"); } catch { return []; } })(),
  vivo: null,          // { t, iniMs, iniDist, fimMostrado }
  ultimo: {},          // id -> ms do ultimo disparo (nao repetir o mesmo trecho em 5 min)
  resultado: null,     // { t, tempo, delta, ate }
};

function salvarTrechos(lista) {
  TRECHOS.lista = Array.isArray(lista) ? lista : [];
  try { localStorage.setItem("ciclo_trechos", JSON.stringify(TRECHOS.lista)); } catch {}
}

function tempoRecordeEm(t, d) {
  const p = t.perfil_recorde || [];
  if (!p.length) return null;
  if (d <= p[0][0]) return p[0][1];
  for (let i = 1; i < p.length; i++) {
    if (d <= p[i][0]) {
      const [d0, t0] = p[i - 1], [d1, t1] = p[i];
      return t0 + ((d - d0) / ((d1 - d0) || 1)) * (t1 - t0);
    }
  }
  return p[p.length - 1][1];
}

function fmtDelta(s) {
  const a = Math.abs(Math.round(s)), m = Math.floor(a / 60), ss = String(a % 60).padStart(2, "0");
  return (s < 0 ? "−" : "+") + m + ":" + ss;
}
function fmtMS(s) { const a = Math.round(s); return Math.floor(a / 60) + ":" + String(a % 60).padStart(2, "0"); }

function faixaTrecho() {
  let el = document.getElementById("trechoVivo");
  if (!el) {
    el = document.createElement("div");
    el.id = "trechoVivo";
    el.style.cssText = "position:fixed;left:8px;right:8px;top:8px;z-index:50;background:#111c;color:#fff;" +
      "border-radius:14px;padding:10px 14px;font:600 15px system-ui;display:none;backdrop-filter:blur(4px)";
    document.body.appendChild(el);
  }
  return el;
}

function desenharTrecho() {
  const el = faixaTrecho();
  const v = TRECHOS.vivo, r = TRECHOS.resultado;
  if (v) {
    const dd = R.dist - v.iniDist, dec = (R.movingMs - v.iniMs) / 1000;
    const ref = tempoRecordeEm(v.t, dd);
    const delta = ref == null ? null : dec - ref;
    const falta = Math.max(0, v.t.dist_m - dd);
    el.style.display = "block";
    el.innerHTML = '<div style="font-size:12px;opacity:.8">TRECHO · ' + esc(v.t.nome) + "</div>" +
      '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-top:2px">' +
      '<span class="num" style="font-size:22px">' + fmtMS(dec) + "</span>" +
      '<span class="num" style="font-size:26px;color:' + (delta == null ? "#fff" : delta <= 0 ? "#5fd35f" : "#ff6b5b") + '">' +
      (delta == null ? "--" : fmtDelta(delta)) + "</span>" +
      '<span class="num" style="font-size:16px">falta ' + (falta >= 1000 ? (falta / 1000).toFixed(1) + " km" : Math.round(falta) + " m") + "</span></div>" +
      '<div style="font-size:11px;opacity:.7">recorde ' + fmtMS(v.t.recorde.tempo_s) + " em " + v.t.recorde.data.split("-").reverse().slice(0, 2).join("/") + "</div>";
  } else if (r && agora() < r.ate) {
    el.style.display = "block";
    el.innerHTML = '<div style="font-size:12px;opacity:.8">TRECHO CONCLUÍDO · ' + esc(r.t.nome) + "</div>" +
      '<div class="num" style="font-size:24px;margin-top:2px">' + fmtMS(r.tempo) + " " +
      '<span style="color:' + (r.delta <= 0 ? "#5fd35f" : "#ff6b5b") + '">' + (r.delta <= 0 ? "NOVO RECORDE " : "") + fmtDelta(r.delta) + "</span></div>";
  } else {
    el.style.display = "none";
  }
}

EXT.tick.push((t) => {
  if (R.state !== "running" || !TRECHOS.lista.length || S.gps.lat == null) { if (!TRECHOS.vivo) desenharTrecho(); return; }
  const pos = { lat: S.gps.lat, lon: S.gps.lon };
  const v = TRECHOS.vivo;
  if (!v) {
    for (const tr of TRECHOS.lista) {
      if (TRECHOS.ultimo[tr.id] && t - TRECHOS.ultimo[tr.id] < 5 * 60000) continue;
      if (hav(pos, { lat: tr.ini[0], lon: tr.ini[1] }) < 35) {
        TRECHOS.vivo = { t: tr, iniMs: R.movingMs, iniDist: R.dist };
        TRECHOS.ultimo[tr.id] = t;
        beep(988, 120, 2);
        break;
      }
    }
  } else {
    const dd = R.dist - v.iniDist;
    // passou do fim sem casar, ou foi por outro caminho: abandona sem alarde
    if (dd > v.t.dist_m * 1.25) TRECHOS.vivo = null;
    else if (dd > v.t.dist_m * 0.85 && hav(pos, { lat: v.t.fim[0], lon: v.t.fim[1] }) < 35) {
      const tempo = (R.movingMs - v.iniMs) / 1000;
      const delta = tempo - v.t.recorde.tempo_s;
      TRECHOS.resultado = { t: v.t, tempo, delta, ate: t + 25000 };
      TRECHOS.vivo = null;
      if (delta <= 0) beep(1319, 150, 4); else beep(784, 180, 2);
    }
  }
  desenharTrecho();
});

EXT.encerrar.push(() => { TRECHOS.vivo = null; TRECHOS.resultado = null; desenharTrecho(); });
