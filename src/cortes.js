// cortes do vídeo completo: o vídeo postado depois da live (ex.: A Vigília) não tem a contagem do começo nem os intervalos
// tudo no servidor, sem baixar o vídeo (o YouTube barra download feito de servidor):
// 1. depois da live, o Groq transcreve o áudio gravado da live (uma parte de 30 min por vez, acelerada 2x pra gastar metade da cota)
// 2. com o link do vídeo no admin, o Gemini transcreve trechos curtos do vídeo, lendo direto pelo link do YouTube
// 3. a mesma fala nas duas transcrições dá a diferença de tempo; onde a diferença muda, houve um corte
// resultado em dados/cortes/<id>.json: { video, cortes: [[segundo da live a partir do qual vale, segundos a descontar], ...] } (o formato que o site já usa)
const fs = require("fs"), path = require("path"), { execFile } = require("child_process");

const TRECHO = 40, PASSO = 600, POR_PEDIDO = 8; // trechos de 40 s, um a cada 10 min do vídeo, 8 por pedido ao Gemini
const sem = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const palavras = s => sem(s).replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
const le = (f, padrao) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return padrao; } };
const grava = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); };
const iso8601 = d => { const m = String(d || "").match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/); return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0; };

// ---------- 1. transcrição da live (Groq) ----------
// devolve [[segundo desde o início da parte, texto], ...]
function acelera(arq) {
  return new Promise((ok, falha) => {
    const saida = arq.replace(/\.ogg$/, ".2x.ogg");
    execFile("nice", ["-n", "15", "ffmpeg", "-v", "error", "-y", "-i", arq, "-filter:a", "atempo=2", "-ac", "1", "-c:a", "libopus", "-b:a", "24k", saida], e => e ? falha(e) : ok(saida));
  });
}
async function groqTranscreve(env, arq) {
  const rapido = await acelera(arq);
  try {
    const form = new FormData();
    form.append("file", new Blob([fs.readFileSync(rapido)], { type: "audio/ogg" }), path.basename(rapido));
    form.append("model", env.GROQ_TRANSCRICAO || "whisper-large-v3"); form.append("language", "pt"); form.append("response_format", "verbose_json");
    const j = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", { method: "POST", headers: { Authorization: "Bearer " + env.GROQ_API_KEY }, body: form }).then(r => r.json());
    if (j.error) throw Object.assign(new Error("groq: " + (j.error.message || j.error)), { cota: j.error.code === "rate_limit_exceeded" });
    return (j.segments || []).map(s => [Math.round(s.start * 2 * 10) / 10, s.text.trim()]); // de volta ao tempo real (o áudio foi 2x)
  } finally { fs.rmSync(rapido, { force: true }); }
}

// ---------- 2. transcrição de trechos do vídeo (Gemini, pelo link do YouTube) ----------
async function geminiTrechos(env, video, inicios) {
  const parts = inicios.flatMap((s, i) => [
    { text: `Trecho ${i + 1}:` },
    { file_data: { file_uri: "https://www.youtube.com/watch?v=" + video }, video_metadata: { start_offset: s + "s", end_offset: s + TRECHO + "s" } },
  ]);
  parts.push({ text: `Transcreva as falas de cada um dos ${inicios.length} trechos, em português, como foram ditas. Responda só em JSON: {"trechos":[{"n":1,"falas":[{"s":3,"t":"texto da fala"}]}]}, com "s" em segundos contados a partir do começo de cada trecho. Trecho sem fala: "falas": [].` });
  const corpo = { contents: [{ parts }], generationConfig: { mediaResolution: "MEDIA_RESOLUTION_LOW", temperature: 0, responseMimeType: "application/json" } };
  const modelo = env.GEMINI_MODELO || "gemini-3.8-flash";
  const j = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`, { method: "POST", headers: { "x-goog-api-key": env.GEMINI_API_KEY, "content-type": "application/json" }, body: JSON.stringify(corpo) }).then(r => r.json());
  if (j.error) throw Object.assign(new Error("gemini: " + j.error.message), { cota: j.error.code === 429 || j.error.code === 503 || /demand|overload|unavailable/i.test(j.error.message) });
  const t = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("");
  const r = JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));
  const out = {};
  for (const tr of r.trechos || []) { const s = inicios[(tr.n || 0) - 1]; if (s != null) out[s] = (tr.falas || []).map(f => [+f.s || 0, String(f.t || "")]); }
  for (const s of inicios) out[s] ??= [];
  return out;
}

// ---------- 3. comparação ----------
// live: palavras com o segundo (desde o início da live) de cada uma
function palavrasDaLive(live) {
  const lista = [];
  for (const [t, txt] of live) { const p = palavras(txt); p.forEach((w, i) => lista.push([w, t + i * 0.35])); }
  return lista;
}
// onde a fala aparece na live (pelo menos 70% das palavras, na ordem, perto umas das outras): devolve os segundos da live
function achaFala(lw, idx, fala) {
  const p = palavras(fala); if (p.length < 4) return [];
  const achados = [];
  for (const i of idx.get(p[0]) || []) {
    let k = 1, j = i + 1, bate = 1;
    const fim = i + Math.ceil(p.length * 1.6) + 2;
    for (; k < p.length && j < Math.min(fim, lw.length); j++) if (lw[j][0] === p[k]) { bate++; k++; } else if (lw[j][0] === p[k + 1]) { bate++; k += 2; }
    if (bate / p.length >= .7) achados.push(lw[i][1]);
  }
  return achados;
}
// desconto de cada trecho do vídeo: a mediana das falas achadas uma vez só na live, se pelo menos 2 concordarem (5 s)
function descontos(live, trechos) {
  const lw = palavrasDaLive(live), idx = new Map();
  lw.forEach(([w], i) => { if (!idx.has(w)) idx.set(w, []); idx.get(w).push(i); });
  const pontos = [];
  for (const [ini, falas] of Object.entries(trechos)) {
    const ds = [];
    for (const [s, t] of falas) { const a = achaFala(lw, idx, t); if (a.length === 1) ds.push(a[0] - (+ini + s)); }
    if (ds.length < 2) continue;
    ds.sort((a, b) => a - b);
    const med = ds[ds.length >> 1], perto = ds.filter(d => Math.abs(d - med) <= 5);
    if (perto.length >= 2) pontos.push([+ini, perto.reduce((a, b) => a + b) / perto.length]);
  }
  return pontos.sort((a, b) => a[0] - b[0]);
}
// pontos [segundo do vídeo, desconto] -> blocos de desconto igual; ponto sozinho que desmente os vizinhos sai
function blocos(pontos) {
  const bons = pontos.filter((p, i) => [pontos[i - 1], pontos[i + 1]].some(q => q && Math.abs(q[1] - p[1]) <= 8) || pontos.length < 3);
  const bl = [];
  for (const [v, d] of bons) { const u = bl.at(-1); if (u && Math.abs(d - u.d) <= 8) { u.fim = v; u.ds.push(d); } else bl.push({ d, ini: v, fim: v, ds: [d] }); }
  for (const b of bl) { b.ds.sort((a, c) => a - c); b.d = b.ds[b.ds.length >> 1]; }
  // corte só tira trecho: desconto que diminui é engano de comparação
  return bl.filter((b, i) => i === 0 || b.d > bl[i - 1].d - 8);
}

module.exports = ({ DADOS, env, R, E, ocupado }) => {
  // R() e E(): records e episodios atuais do servidor (as variáveis podem ser trocadas inteiras)
  const PASTA = path.join(DADOS, "cortes"), FEITOS = path.join(DADOS, "gravacao-feitos");
  const arqLive = id => path.join(PASTA, id + ".live.json"), arqVideo = id => path.join(PASTA, id + ".video.json"), arqFim = id => path.join(PASTA, id + ".json");
  let rodando = false, pausaAte = 0;
  const partesDe = id => { try { return fs.readdirSync(path.join(FEITOS, id)).filter(f => /^audio-\d{8}T\d{6}\.ogg$/.test(f)).sort(); } catch { return []; } };
  const inicioDe = f => { const m = f.match(/(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)/); return Date.UTC(m[1], m[2] - 1, m[3], m[4], m[5], m[6]); };

  // a live inteira em [[segundo desde o início da live, texto]]
  const liveTexto = id => {
    const c = le(arqLive(id), { partes: {} }), ini = Date.parse(R()[id].inicioLive);
    return Object.entries(c.partes).flatMap(([f, l]) => l.map(([s, t]) => [(inicioDe(f) - ini) / 1000 + s, t])).sort((a, b) => a[0] - b[0]);
  };

  // um passo por vez (chamado a cada 10 min): transcreve uma parte da live, ou pede um lote de trechos do vídeo, ou fecha os cortes
  async function passo() {
    if (rodando || Date.now() < pausaAte || ocupado()) return;
    rodando = true;
    try {
      // 1. lives já acabadas com áudio gravado e ainda sem transcrição completa (só episódios que podem ganhar vídeo editado: os de temporada com vídeo depois)
      for (const id of fs.existsSync(FEITOS) ? fs.readdirSync(FEITOS) : []) {
        const r = R()[id]; if (!r?.fimLive || !env.GROQ_API_KEY || fs.existsSync(arqFim(id))) continue; // já tem cortes: não gasta cota
        const ep = E().lista.find(e => e.id === id); if (/transcend/i.test(ep?.temporada || r.temporada || "")) continue; // o Transcendendo fica com a própria live
        const c = le(arqLive(id), { partes: {} }), falta = partesDe(id).find(f => !c.partes[f]);
        if (!falta) continue;
        c.partes[falta] = await groqTranscreve(env, path.join(FEITOS, id, falta)); grava(arqLive(id), c);
        console.log(`cortes: ${id} live transcrita, ${falta}`);
        return;
      }
      // 2. episódios com vídeo completo e sem cortes
      for (const e of E().lista) {
        if (!e.video || e.cortes || !R()[e.id]?.inicioLive || !env.GEMINI_API_KEY) continue;
        if (le(arqFim(e.id), {}).video === e.video) continue;
        const partes = partesDe(e.id), cl = le(arqLive(e.id), { partes: {} });
        if (!partes.length) { grava(arqFim(e.id), { video: e.video, cortes: null, erro: "a gravação da live já foi apagada" }); continue; }
        if (partes.some(f => !cl.partes[f])) continue; // espera a live terminar de ser transcrita
        let cv = le(arqVideo(e.id), {}); if (cv.video !== e.video) cv = { video: e.video, trechos: {}, refinos: 0 };
        // duração do vídeo pela API do YouTube (1 unidade)
        if (!cv.dur) {
          const v = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${e.video}&key=${env.YOUTUBE_API_KEY}`).then(r => r.json());
          cv.dur = iso8601(v.items?.[0]?.contentDetails?.duration); if (!cv.dur) continue; grava(arqVideo(e.id), cv);
        }
        let pedir = [];
        for (let s = 60; s + TRECHO < cv.dur; s += PASSO) if (!cv.trechos[s]) pedir.push(s);
        // depois da primeira volta: perto de cada corte, mais trechos pra achar o ponto (até 2 vezes)
        if (!pedir.length && cv.refinos < 2) {
          const bl = blocos(descontos(liveTexto(e.id), cv.trechos));
          for (let i = 1; i < bl.length; i++) {
            const a = bl[i - 1].fim, b = bl[i].ini, n = 4;
            if (b - a <= 90) continue;
            for (let k = 1; k <= n; k++) { const s = Math.round(a + (b - a) * k / (n + 1)); if (!cv.trechos[s]) pedir.push(s); }
          }
          if (!pedir.length) cv.refinos = 2; else cv.refinos++;
        }
        if (pedir.length) {
          Object.assign(cv.trechos, await geminiTrechos(env, e.video, pedir.slice(0, POR_PEDIDO))); grava(arqVideo(e.id), cv);
          console.log(`cortes: ${e.id} ${Object.keys(cv.trechos).length} trechos do vídeo transcritos`);
          return;
        }
        // 3. fecha: cada mudança de desconto vira um corte, no meio entre o último trecho de antes e o primeiro de depois
        const pts = descontos(liveTexto(e.id), cv.trechos), bl = blocos(pts);
        if (!bl.length) { grava(arqFim(e.id), { video: e.video, cortes: null, erro: "as falas do vídeo não bateram com a live" }); continue; }
        const cortes = [[0, Math.round(bl[0].d)]];
        for (let i = 1; i < bl.length; i++) { const vb = (bl[i - 1].fim + TRECHO + bl[i].ini) / 2; cortes.push([Math.round(vb + bl[i].d), Math.round(bl[i].d)]); }
        grava(arqFim(e.id), { video: e.video, cortes, trechos: Object.keys(cv.trechos).length, achados: pts.length, quando: new Date().toISOString() });
        console.log(`cortes: ${e.id} prontos`, JSON.stringify(cortes));
        return;
      }
    } catch (err) {
      console.warn("cortes:", err.message);
      if (err.cota) pausaAte = Date.now() + 30 * 60e3; // limite da cota grátis: tenta de novo em meia hora
    } finally { rodando = false; }
  }
  return { passo, descontos, blocos };
};
