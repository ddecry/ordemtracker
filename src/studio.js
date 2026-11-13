// CSVs do YouTube Studio mandados pela equipe do canal + limpeza dos dados da API do YouTube
// Regras da API do YouTube (Developer Policies III.E.4): números lidos pela API pública (espectadores, likes, chat)
// só podem ficar guardados por 30 dias. Os CSVs do Studio não vêm da API (o próprio canal entrega), então ficam.
// - a equipe abre /envio/<código> (link só dela, trocável no painel), escolhe o episódio e manda o CSV
// - o envio cai na fila do painel (aba Studio), com o antes e depois; só vai pro site quando aprovado
// - todo dia: episódio com mais de 30 dias perde o que veio da API (YouTube sem CSV, likes e mensagens do chat do YouTube)
const fs = require("fs"), path = require("path"), crypto = require("crypto");

module.exports = ({ DADOS, HIST, DB, R, E, env, aoVivo, limpaCache }) => {
  const ARQ = path.join(DADOS, "studio.json"), CHATLOG = path.join(DADOS, "chat");
  const DIAS = 30, LIMITE = 2e6;
  const le = () => { try { return JSON.parse(fs.readFileSync(ARQ, "utf8")); } catch { return { token: null, fila: [] }; } };
  const grava = s => fs.writeFileSync(ARQ, JSON.stringify(s, null, 2));
  const salvaR = () => fs.writeFileSync(DB, JSON.stringify(R(), null, 2));
  // a parte do YouTube veio de CSV do canal (Studio): não é dado da API
  const doStudio = r => !!r.ytStudio || /YouTube: (CSV do canal|YouTube Studio)/.test(r.fontes || "");

  // ---- link da equipe ----
  function token() { const s = le(); if (!s.token) { s.token = crypto.randomBytes(18).toString("base64url"); grava(s); } return s.token; }
  function novoToken() { const s = le(); s.token = crypto.randomBytes(18).toString("base64url"); grava(s); return s.token; }
  const tokenOk = t => { const s = le(); if (!s.token || typeof t !== "string" || t.length !== s.token.length) return false; return crypto.timingSafeEqual(Buffer.from(t), Buffer.from(s.token)); };

  // ---- CSV ----
  // aceita o export do Studio: uma coluna de tempo (minuto, mm:ss, hh:mm:ss) e uma de espectadores; cabeçalho opcional
  function leCsv(texto) {
    const linhas = String(texto).replace(/^﻿/, "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!linhas.length) throw new Error("O arquivo está vazio.");
    const sep = (linhas[0].match(/[;\t,]/) || [","])[0];
    const min = t => { t = t.replace(/"/g, "").trim(); if (/^\d+(\.\d+)?$/.test(t)) return +t; const p = t.split(":").map(Number); if (p.some(isNaN) || p.length < 2) return NaN; return p.length === 3 ? p[0] * 60 + p[1] + p[2] / 60 : p[0] + p[1] / 60; };
    const pts = [];
    for (const l of linhas) {
      const c = l.split(sep); if (c.length < 2) continue;
      const m = min(c[0]), v = +String(c[c.length - 1]).replace(/["\s.]/g, "").replace(",", ".");
      if (isNaN(m) || isNaN(v)) continue; // cabeçalho
      pts.push([m, Math.round(v)]);
    }
    if (pts.length < 10) throw new Error("Não achei os minutos e os espectadores no arquivo. O esperado é o CSV de espectadores simultâneos do YouTube Studio, com uma linha por minuto.");
    pts.sort((a, b) => a[0] - b[0]);
    const minutos = []; for (const [m, v] of pts) minutos[Math.round(m)] = v;
    for (let i = 0; i < minutos.length; i++) if (minutos[i] == null) minutos[i] = minutos[i - 1] ?? 0;
    return minutos;
  }

  // ---- aplicar: troca a coluna do YouTube do histórico pelo CSV e refaz pico e média ----
  const linhasEp = id => fs.readFileSync(HIST, "utf8").split("\n").map(l => l.split(",")).filter(c => c[1] === id);
  const somaLinha = c => (+c[2] || 0) + (+c[3] || 0) + (+c[4] || 0) + (+c[8] || 0);
  function calcula(id, minutos) {
    const r = R()[id], ini = Date.parse(r.inicioLive || r.inicio);
    const yt = t => { const x = (t - ini) / 60e3; if (x < 0 || x > minutos.length - 1) return null; const i = Math.floor(x), f = x - i; return Math.round(minutos[i] + ((minutos[Math.min(i + 1, minutos.length - 1)]) - minutos[i]) * f); };
    let soma = 0, n = 0, melhor = null;
    const novas = linhasEp(id).map(c => { c = [...c]; while (c.length < 9) c.push(""); const v = yt(Date.parse(c[0])); if (v != null) c[4] = v; c[5] = somaLinha(c) || ""; if (c[5]) { soma += c[5]; n++; if (!melhor || c[5] > melhor[5]) melhor = c; } return c; });
    return { novas, soma, n, melhor, picoYT: Math.max(...minutos), cobre: minutos.length };
  }
  function previa(item) {
    const r = R()[item.ep]; if (!r) return null;
    const { soma, n, melhor, picoYT, cobre } = calcula(item.ep, item.minutos);
    const durMin = r.fimLive && r.inicioLive ? Math.round((Date.parse(r.fimLive) - Date.parse(r.inicioLive)) / 60e3) : null;
    return { antes: { pico: r.recorde, media: r.media, youtube: r.picos?.youtube || null }, depois: { pico: melhor?.[5] || null, media: n ? Math.round(soma / n) : null, youtube: picoYT }, minutosCsv: cobre, minutosLive: durMin };
  }
  function aplica(item) {
    const recs = R(), r = recs[item.ep]; if (!r) throw new Error("Episódio não encontrado.");
    if (aoVivo() === item.ep) throw new Error("O episódio está ao vivo; aplique depois que acabar.");
    const { novas, soma, n, melhor, picoYT } = calcula(item.ep, item.minutos);
    if (!n) throw new Error("O CSV não cobre o horário da live.");
    const porHora = new Map(novas.map(c => [c[0], c.join(",")]));
    const txt = fs.readFileSync(HIST, "utf8").split("\n").map(l => { const c = l.split(","); return c[1] === item.ep ? porHora.get(c[0]) ?? l : l; }).join("\n");
    fs.writeFileSync(HIST, txt);
    Object.assign(r, { recorde: melhor[5], quando: new Date(melhor[0]).toISOString(), twitch: +melhor[2] || 0, kick: +melhor[3] || 0, youtube: +melhor[4] || 0, tiktok: +melhor[8] || 0, soma, amostras: n, media: Math.round(soma / n), ytStudio: true });
    r.picos = { ...(r.picos || {}), youtube: picoYT };
    r.fontes = ["YouTube: YouTube Studio (enviado pela equipe do canal), minuto a minuto", ...String(r.fontes || "").split(/;\s*/).filter(f => f && !/^YouTube:/.test(f))].join("; ");
    salvaR(); limpaCache(item.ep);
  }

  // ---- fila ----
  function recebe({ ep, nome, csv }) {
    if (typeof csv !== "string" || csv.length > LIMITE) throw new Error("Arquivo grande demais (máximo 2 MB).");
    const r = R()[ep]; if (!r || !/^[\w-]{11}$/.test(ep)) throw new Error("Escolha um episódio da lista.");
    const minutos = leCsv(csv), s = le();
    const item = { id: crypto.randomBytes(6).toString("hex"), ep, nome: String(nome || "").slice(0, 120), quando: new Date().toISOString(), minutos };
    s.fila = [...(s.fila || []).filter(x => x.ep !== ep), item]; grava(s); // um envio novo do mesmo episódio substitui o anterior
    const p = previa(item), aviso = p.minutosLive && p.minutosCsv < p.minutosLive * .9 ? `O arquivo tem ${p.minutosCsv} minutos e a live teve ${p.minutosLive}. Confira se é o arquivo da live inteira.` : null;
    return { ok: true, minutos: minutos.length, aviso };
  }
  const fila = () => (le().fila || []).map(x => ({ id: x.id, ep: x.ep, titulo: E().lista.find(e => e.id === x.ep)?.titulo || R()[x.ep]?.titulo || x.ep, nome: x.nome, quando: x.quando, ...previa(x) }));
  function decide(id, aprova) {
    const s = le(), item = (s.fila || []).find(x => x.id === id); if (!item) throw new Error("Esse envio não está mais na fila.");
    if (aprova) aplica(item);
    s.fila = s.fila.filter(x => x.id !== id); grava(s);
  }
  // episódios que a equipe pode escolher: os com vídeo no YouTube que já acabaram, do mais novo pro mais velho
  const episodiosEnvio = () => Object.entries(R()).filter(([id, r]) => /^[\w-]{11}$/.test(id) && r.fimLive && id !== aoVivo())
    .map(([id, r]) => ({ id, titulo: E().lista.find(e => e.id === id)?.titulo || r.titulo, data: r.inicioLive, temStudio: doStudio(r) }))
    .sort((a, b) => (b.data || "").localeCompare(a.data || ""));

  // ---- limpeza diária (30 dias) ----
  function limpeza() {
    const recs = R(), limite = Date.now() - DIAS * 864e5, ids = [];
    for (const [id, r] of Object.entries(recs)) {
      const fim = Date.parse(r.fimLive || r.ultimaLeitura || 0);
      if (!fim || fim > limite || r.ytLimpo || id === aoVivo()) continue;
      const temApi = r.likes != null || (!doStudio(r) && (r.picos?.youtube || r.youtube));
      if (!temApi) { r.ytLimpo = true; continue; }
      ids.push(id);
    }
    if (ids.length) {
      const sel = new Set(ids), por = new Map();
      const txt = fs.readFileSync(HIST, "utf8").split("\n").map(l => {
        const c = l.split(","); if (!sel.has(c[1])) return l;
        while (c.length < 9) c.push("");
        if (!doStudio(recs[c[1]])) c[4] = "";
        c[6] = ""; // likes
        c[5] = somaLinha(c) || "";
        if (c[5]) { const p = por.get(c[1]) || { soma: 0, n: 0, melhor: null }; p.soma += c[5]; p.n++; if (!p.melhor || c[5] > p.melhor[5]) p.melhor = c; por.set(c[1], p); }
        return c.join(",");
      }).join("\n");
      fs.writeFileSync(HIST, txt);
      for (const id of ids) {
        const r = recs[id], p = por.get(id);
        delete r.likes; delete r.ytLikes;
        if (!doStudio(r)) {
          delete r.youtube; if (r.picos) delete r.picos.youtube;
          if (p) Object.assign(r, { recorde: p.melhor[5], quando: new Date(p.melhor[0]).toISOString(), twitch: +p.melhor[2] || 0, kick: +p.melhor[3] || 0, tiktok: +p.melhor[8] || 0, soma: p.soma, amostras: p.n, media: Math.round(p.soma / p.n) });
        }
        r.ytLimpo = true; limpaCache(id);
        console.log("studio: dados da API do YouTube com mais de 30 dias apagados de " + id);
      }
    }
    if (ids.length || Object.values(recs).some(r => r.ytLimpo)) salvaR();
    // mensagens do chat do YouTube com mais de 30 dias
    try {
      for (const f of fs.readdirSync(CHATLOG).filter(f => f.endsWith(".jsonl"))) {
        const arq = path.join(CHATLOG, f), id = f.replace(/\.jsonl$/, "");
        if (id === aoVivo() || fs.statSync(arq).mtimeMs > limite) continue;
        const l = fs.readFileSync(arq, "utf8").split("\n"), fica = l.filter(x => !x.includes('"p":"youtube"'));
        if (fica.length !== l.length) { fs.writeFileSync(arq, fica.join("\n")); console.log("studio: chat do YouTube com mais de 30 dias apagado de " + id); }
      }
    } catch {}
  }

  // títulos dos vídeos (dado da API): buscados de novo todo dia, pra nunca ficarem guardados mais de 30 dias sem atualizar
  async function atualizaTitulos() {
    if (!env.YOUTUBE_API_KEY) return;
    const recs = R(), ids = Object.keys(recs).filter(id => /^[\w-]{11}$/.test(id) && id !== aoVivo() && recs[id].titulo);
    let mudou = false;
    for (let i = 0; i < ids.length; i += 50) {
      const j = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${ids.slice(i, i + 50).join(",")}&key=${env.YOUTUBE_API_KEY}`).then(r => r.json()).catch(() => null);
      if (!j?.items) return;
      for (const v of j.items) if (recs[v.id] && v.snippet?.title && recs[v.id].titulo !== v.snippet.title) { recs[v.id].titulo = v.snippet.title; mudou = true; }
    }
    if (mudou) salvaR();
  }
  async function diario() { try { limpeza(); } catch (e) { console.warn("studio: " + e.message); } await atualizaTitulos().catch(e => console.warn("studio: " + e.message)); }

  return { diario, token, novoToken, tokenOk, recebe, fila, decide, episodiosEnvio, limpeza, leCsv };
};
