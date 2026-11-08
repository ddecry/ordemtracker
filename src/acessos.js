// acessos ao site, anônimos: sem cookie; IP + navegador viram um código que muda todo dia
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DADOS } = require("./config");

// ctx.atual(): leitura atual da live; ctx.titulo(id): título do episódio
module.exports = ctx => {
  const atualVivo = () => { const a = ctx.atual(); return a.episodio && a.total > 0 ? a.episodio : null; };
  const ACESSOS = path.join(DADOS, "acessos.json");
  let ac = { dia: "", sal: "", unicos: [], views: 0, pico: 0, celular: 0, computador: 0, origens: {}, eps: {}, serie: [], historico: [],
    navegadores: {}, sistemas: {}, horas: Array(24).fill(0), paginas: {}, tempos: {}, visitas: {} };
  try { ac = { ...ac, ...JSON.parse(fs.readFileSync(ACESSOS, "utf8")) }; } catch {}
  const online = new Map(); // código -> último acesso
  const unicosHoje = new Set(ac.unicos);
  const unicosEp = {}; for (const [id, e] of Object.entries(ac.eps)) unicosEp[id] = new Set(e.codigos || []);
  const hojeSP = () => new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
  function viraDia() {
    const d = hojeSP();
    if (ac.dia === d) return;
    if (ac.dia) ac.historico = [...ac.historico, { dia: ac.dia, unicos: unicosHoje.size, views: ac.views, pico: ac.pico }].slice(-60);
    Object.assign(ac, { dia: d, sal: crypto.randomBytes(16).toString("hex"), views: 0, pico: 0, celular: 0, computador: 0, origens: {}, serie: [],
      navegadores: {}, sistemas: {}, horas: Array(24).fill(0), paginas: {}, tempos: {}, visitas: {} });
    unicosHoje.clear();
  }
  function registraAcesso(req, url) {
    viraDia();
    const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress || "";
    const ua = req.headers["user-agent"] || "";
    if (/bot|crawl|spider|preview|curl|wget/i.test(ua)) return;
    const cod = crypto.createHash("sha256").update(ac.sal + ip + ua).digest("hex").slice(0, 16);
    online.set(cod, Date.now());
    // pico registrado na hora (antes só a cada minuto, e um pico curto podia passar despercebido)
    const agoraOn = online.size;
    if (agoraOn > ac.pico) ac.pico = onlineAgora();
    if (atualVivo() && agoraOn > (ac.eps[atualVivo()]?.pico || 0)) (ac.eps[atualVivo()] ||= { pico: 0 }).pico = onlineAgora();
    // primeiro e último acesso do dia, pra saber quanto tempo a pessoa ficou
    const agora = Date.now(), t = ac.tempos[cod] ||= [agora, agora]; t[1] = agora;
    if (!unicosHoje.has(cod)) {
      unicosHoje.add(cod); /Mobi|Android|iPhone/i.test(ua) ? ac.celular++ : ac.computador++;
      const nav = /Edg\//.test(ua) ? "Edge" : /OPR\/|Opera/.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Outro";
      const sis = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "Outro";
      ac.navegadores[nav] = (ac.navegadores[nav] || 0) + 1; ac.sistemas[sis] = (ac.sistemas[sis] || 0) + 1;
      ac.horas[+new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo", hour: "numeric", hour12: false }) % 24]++;
    }
    if (url.searchParams.get("nova") === "1") {
      ac.views++;
      ac.visitas[cod] = (ac.visitas[cod] || 0) + 1;
      const pg = url.searchParams.get("ep") ? "Episódio " + String(url.searchParams.get("ep")).slice(0, 40) : "Início";
      ac.paginas[pg] = (ac.paginas[pg] || 0) + 1;
      const o = (url.searchParams.get("de") || "").replace(/^www\./, "").slice(0, 60) || "direto";
      ac.origens[o] = (ac.origens[o] || 0) + 1;
    }
    if (atualVivo()) (unicosEp[atualVivo()] ||= new Set()).add(cod);
  }
  const onlineAgora = () => { const lim = Date.now() - 75_000; let n = 0; for (const [k, t] of online) t > lim ? n++ : online.delete(k); return n; };
  // a cada minuto: guarda quantos estavam online e salva no disco
  setInterval(() => {
    viraDia();
    const n = onlineAgora();
    ac.pico = Math.max(ac.pico, n);
    ac.serie = [...ac.serie, [Date.now(), n]].slice(-1440);
    if (atualVivo()) { const e = ac.eps[atualVivo()] ||= { pico: 0 }; e.pico = Math.max(e.pico, n); }
    ac.unicos = [...unicosHoje];
    for (const [id, s] of Object.entries(unicosEp)) { ac.eps[id] ||= { pico: 0 }; ac.eps[id].codigos = [...s]; ac.eps[id].unicos = s.size; }
    fs.writeFileSync(ACESSOS, JSON.stringify(ac));
  }, 60_000);
  const relatorio = () => ({
    online: onlineAgora(), pico: Math.max(ac.pico, onlineAgora()), unicos: unicosHoje.size, views: ac.views, celular: ac.celular, computador: ac.computador,
    origens: Object.entries(ac.origens).sort((a, b) => b[1] - a[1]).slice(0, 8), serie: ac.serie.slice(-360),
    eps: Object.fromEntries(Object.entries(ac.eps).map(([id, e]) => [id, { titulo: ctx.titulo(id) || id, unicos: unicosEp[id]?.size || e.unicos || 0, pico: e.pico || 0 }])),
    historico: ac.historico.slice(-60), aoVivo: !!(atualVivo()),
    navegadores: Object.entries(ac.navegadores).sort((a, b) => b[1] - a[1]), sistemas: Object.entries(ac.sistemas).sort((a, b) => b[1] - a[1]),
    paginas: Object.entries(ac.paginas).sort((a, b) => b[1] - a[1]).slice(0, 8), horas: ac.horas, ...permanencia(),
  });
  // tempo no site: do primeiro ao último sinal do dia (a página avisa a cada 5 s enquanto está aberta)
  function permanencia() {
    const dur = Object.values(ac.tempos).map(([a, b]) => b - a);
    const ficaram = dur.filter(d => d > 0), voltaram = Object.values(ac.visitas).filter(v => v > 1).length;
    return {
      tempoMedio: ficaram.length ? ficaram.reduce((t, d) => t + d, 0) / ficaram.length : 0,
      mais10: dur.filter(d => d >= 10 * 60e3).length, rapidos: dur.filter(d => d < 30e3).length, voltaram,
    };
  }
  // resumo para a aba Status: agora, hoje e desde o começo (pico = mais pessoas ao mesmo tempo, medido a cada minuto)
  function publico() {
    const dias = [...ac.historico, { dia: ac.dia, unicos: unicosHoje.size, views: ac.views, pico: Math.max(ac.pico, onlineAgora()) }];
    const maior = dias.reduce((m, d) => (d.pico || 0) > (m.pico || 0) ? d : m, dias[0]);
    return { online: onlineAgora(), picoHoje: Math.max(ac.pico, onlineAgora()), picoGeral: maior.pico || 0, picoGeralDia: maior.dia,
      unicosHoje: unicosHoje.size, visitasHoje: ac.views, visitasTotal: dias.reduce((t, d) => t + (d.views || 0), 0),
      mediaDia: Math.round(dias.reduce((t, d) => t + (d.unicos || 0), 0) / dias.length) };
  }
  return { registraAcesso, relatorio, publico };
};
