// ---------- laboratório: dados extras em teste, só no computador (NODE_ENV != production) ----------
// pessoas novas no chat, apoio ao vivo, ranking na Twitch, retenção e engajamento
// fica tudo em dados/lab/<episódio>.json; nada disso aparece no site ainda
const fs = require("fs"), path = require("path"), crypto = require("crypto");

module.exports = function lab({ DADOS, HIST, records }) {
  const PASTA = path.join(DADOS, "lab");
  fs.mkdirSync(PASTA, { recursive: true });
  const arq = id => path.join(PASTA, id.replace(/[^\w-]/g, "_") + ".json");
  const VISTOS = path.join(PASTA, "vistos.json");
  // quem já falou em algum episódio acompanhado (só o código, nunca o nome), pra separar quem é novo
  let vistos = { twitch: [], youtube: [] };
  try { vistos = JSON.parse(fs.readFileSync(VISTOS, "utf8")); } catch {}
  const jaVistos = { twitch: new Set(vistos.twitch), youtube: new Set(vistos.youtube) };
  const codigo = (p, u) => crypto.createHash("sha256").update("lab" + p + String(u).toLowerCase()).digest("hex").slice(0, 12);

  let id = null, d = null, vistosEp = null;
  const novo = () => ({
    twitch: { msgs: 0, pessoas: 0, primeiraVez: 0, novosNoHistorico: 0, inscritosFalando: 0, subs: 0, resubs: 0, prime: 0, presentes: 0, bits: 0, raids: [] },
    youtube: { msgs: 0, pessoas: 0, novosNoHistorico: 0, membrosFalando: 0, superChats: {}, superStickers: {}, membrosNovos: 0, membrosPresenteados: 0, marcosMembro: 0 },
    ranking: [], melhor: {},
  });
  function abre(ep) {
    if (id === ep) return;
    salva();
    id = ep;
    try { d = JSON.parse(fs.readFileSync(arq(ep), "utf8")); d._p = { twitch: new Set(d._p?.twitch), youtube: new Set(d._p?.youtube), inscritos: new Set(d._p?.inscritos), membros: new Set(d._p?.membros) }; }
    catch { d = { ...novo(), _p: { twitch: new Set(), youtube: new Set(), inscritos: new Set(), membros: new Set() } }; }
  }
  function salva() {
    if (!id || !d) return;
    const { _p, ...resto } = d;
    fs.writeFileSync(arq(id), JSON.stringify({ ...resto, _p: { twitch: [..._p.twitch], youtube: [..._p.youtube], inscritos: [..._p.inscritos], membros: [..._p.membros] } }));
    for (const p of ["twitch", "youtube"]) vistos[p] = [...new Set([...jaVistos[p], ..._p[p]])];
    fs.writeFileSync(VISTOS, JSON.stringify(vistos));
  }
  // pessoa falou: conta como nova no histórico se nunca apareceu em episódio anterior
  function pessoa(p, u) {
    const c = codigo(p, u);
    if (d._p[p].has(c)) return c;
    d._p[p].add(c); d[p].pessoas++;
    if (!jaVistos[p].has(c)) d[p].novosNoHistorico++;
    return c;
  }
  const tags = s => Object.fromEntries((s || "").split(";").map(x => { const i = x.indexOf("="); return [x.slice(0, i), x.slice(i + 1)]; }));

  return {
    // pede à Twitch as informações extras do chat (marca de primeira mensagem, selos, avisos de inscrição)
    capTwitch: ws => ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands"),
    // linha do IRC da Twitch já com as tags
    twitch(ep, tagStr, resto) {
      if (!ep) return;
      abre(ep);
      const t = tags(tagStr), T = d.twitch;
      if (resto.includes(" PRIVMSG ")) {
        const u = resto.match(/^:([^!]+)!/)?.[1]; if (!u) return;
        T.msgs++;
        const c = pessoa("twitch", u);
        if (t["first-msg"] === "1") T.primeiraVez++;
        if (/(^|,)(subscriber|founder)\//.test(t.badges || "") && !d._p.inscritos.has(c)) { d._p.inscritos.add(c); T.inscritosFalando++; }
        if (+t.bits) T.bits += +t.bits;
      } else if (resto.includes(" USERNOTICE ")) {
        const m = t["msg-id"];
        if (m === "sub") { T.subs++; if (t["msg-param-sub-plan"] === "Prime") T.prime++; }
        else if (m === "resub") { T.resubs++; if (t["msg-param-sub-plan"] === "Prime") T.prime++; }
        else if (m === "subgift") T.presentes++;
        else if (m === "raid") T.raids.push({ de: t["msg-param-displayName"] || t.login, viewers: +t["msg-param-viewerCount"] || 0, q: new Date().toISOString() });
      }
    },
    // mensagem do chat do YouTube (part=snippet,authorDetails)
    youtube(ep, m) {
      if (!ep) return;
      abre(ep);
      const s = m.snippet || {}, a = m.authorDetails || {}, Y = d.youtube;
      if (s.authorChannelId) {
        const c = pessoa("youtube", s.authorChannelId);
        if (a.isChatSponsor && !d._p.membros.has(c)) { d._p.membros.add(c); Y.membrosFalando++; }
      }
      const soma = (o, det) => { const k = det.currency || "?"; o[k] ||= { n: 0, total: 0 }; o[k].n++; o[k].total += (+det.amountMicros || 0) / 1e6; };
      if (s.type === "textMessageEvent") Y.msgs++;
      else if (s.type === "superChatEvent" && s.superChatDetails) { Y.msgs++; soma(Y.superChats, s.superChatDetails); }
      else if (s.type === "superStickerEvent" && s.superStickerDetails) soma(Y.superStickers, s.superStickerDetails);
      else if (s.type === "newSponsorEvent") Y.membrosNovos++;
      else if (s.type === "membershipGiftingEvent") Y.membrosPresenteados += +s.membershipGiftingDetails?.giftMembershipsCount || 0;
      else if (s.type === "memberMilestoneChatEvent") Y.marcosMembro++;
    },
    // posição da live entre as lives em português, na categoria e no geral da Twitch (a cada 2 min)
    async ranking(ep, h, login, jogoId) {
      if (!ep) return;
      abre(ep);
      const pos = async q => {
        const l = (await (await fetch("https://api.twitch.tv/helix/streams?first=100&" + q, { headers: h })).json())?.data || [];
        const i = l.findIndex(s => s.user_login === login);
        return i < 0 ? null : i + 1;
      };
      const r = { q: new Date().toISOString(), pt: await pos("language=pt"), geral: await pos(""), categoria: jogoId ? await pos("game_id=" + jogoId) : null };
      d.ranking.push(r);
      for (const k of ["pt", "geral", "categoria"]) if (r[k] && (!d.melhor[k] || r[k] < d.melhor[k].pos)) d.melhor[k] = { pos: r[k], q: r.q };
      salva();
    },
    salva,
    // relatório do episódio: o que foi juntado + retenção e engajamento tirados do histórico
    relatorio(ep) {
      if (ep === id) salva();
      let x; try { x = JSON.parse(fs.readFileSync(arq(ep), "utf8")); delete x._p; } catch { x = null; }
      const r = records[ep];
      const linhas = fs.readFileSync(HIST, "utf8").trim().split("\n").filter(l => l.split(",")[1] === ep).map(l => l.split(","));
      let ret = null, eng = null;
      if (r && linhas.length) {
        const t0 = new Date(r.inicioLive || linhas[0][0]).getTime(), pico = r.recorde;
        const tot = l => +l[5] || 0;
        // retenção: público no fim de cada hora em relação ao pico
        const horas = [];
        for (let hr = 1; ; hr++) {
          const alvo = t0 + hr * 3600e3, l = linhas.find(l => new Date(l[0]).getTime() >= alvo);
          if (!l) break;
          horas.push({ hora: hr, viewers: tot(l), doPico: Math.round(tot(l) / pico * 1000) / 10 });
        }
        const ultima = linhas.at(-1);
        ret = { pico, minutosAtePico: r.quando ? Math.round((new Date(r.quando) - t0) / 60000) : null, porHora: horas, fimDoPico: Math.round(tot(ultima) / pico * 1000) / 10 };
        // engajamento: por mil viewers
        const media = r.media || 1, durMin = (new Date(r.fimLive || r.ultimaLeitura) - t0) / 60000;
        const msgs = (r.chatMsgs || 0) + (x?.youtube?.msgs || 0);
        eng = {
          msgsPorMinutoPorMilViewers: durMin > 0 ? Math.round(msgs / durMin / media * 1000 * 100) / 100 : null,
          pessoasNoChatPorMilViewers: Math.round(((r.chatPessoas || 0) + (x?.youtube?.pessoas || 0)) / media * 1000 * 10) / 10,
          likesPorMilViewers: r.likes && r.youtube ? Math.round(r.likes / (r.picos?.youtube || r.youtube) * 1000 * 10) / 10 : null,
          seguidoresTwitchPorMilViewers: r.twitchSegFim && r.picos?.twitch ? Math.round((r.twitchSegFim - r.twitchSegInicio) / r.picos.twitch * 1000 * 10) / 10 : null,
        };
      }
      return { episodio: ep, titulo: r?.titulo, extras: x, retencao: ret, engajamento: eng };
    },
  };
};
