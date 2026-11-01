// node server.js  ->  http://localhost:3030   (Node 22+)
// Chaves das APIs oficiais ficam no arquivo .env (veja .env.exemplo e LEIA-ME.md)
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

try { process.loadEnvFile(path.join(__dirname, ".env")); } catch {}
const env = process.env;

const TWITCH = env.TWITCH_CANAL || "cellbit";
const KICK = env.KICK_CANAL || "cellbit";
const YT_CANAL = env.YOUTUBE_CANAL_ID || "UCMRaVyexv18FrJu3NiYsbgQ"; // @OrdemParanormal
const TIKTOK = env.TIKTOK_CANAL ?? "ordemparanormal"; // vazio = desliga
const EPISODIO = new RegExp(env.FILTRO_EPISODIO || "EPIS[ÓO]DIO\\s*\\d+.*Ordem Paranormal", "i");
// endereço secreto do painel, definido no .env (sem ele o painel fica desligado)
const ADMIN = /^\/[\w-]{12,}$/.test(env.ADMIN_CAMINHO || "") ? env.ADMIN_CAMINHO : null;
const PORTA = +env.PORT || 3030;
const INTERVALO = 10_000;
const DADOS = env.DATA_DIR || path.join(__dirname, "dados");
const PUBLICO = path.join(__dirname, "public");
const DB = path.join(DADOS, "records.json");
const EPS = path.join(DADOS, "episodios.json");
const HIST = path.join(DADOS, "historico.csv");
const CHATTERS = path.join(DADOS, "chatters");
const RESUMOS = path.join(DADOS, "resumos");
fs.mkdirSync(CHATTERS, { recursive: true });
fs.mkdirSync(RESUMOS, { recursive: true });

// ---------- tokens de app (client credentials), renovados sozinhos ----------
const tokens = {};
async function token(nome, url, id, segredo) {
  const t = tokens[nome];
  if (t && t.expira > Date.now() + 60_000) return t.valor;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: id, client_secret: segredo, grant_type: "client_credentials" }),
  });
  if (!r.ok) throw new Error(`${nome}: token HTTP ${r.status}`);
  const j = await r.json();
  tokens[nome] = { valor: j.access_token, expira: Date.now() + (j.expires_in || 3600) * 1000 };
  return j.access_token;
}

// Twitch Helix (API oficial): https://dev.twitch.tv/docs/api/reference/#get-streams
async function twitch() {
  if (!env.TWITCH_CLIENT_ID) return null;
  const tk = await token("twitch", "https://id.twitch.tv/oauth2/token", env.TWITCH_CLIENT_ID, env.TWITCH_CLIENT_SECRET);
  const h = { "Client-Id": env.TWITCH_CLIENT_ID, Authorization: "Bearer " + tk };
  const s = (await (await fetch(`https://api.twitch.tv/helix/streams?user_login=${TWITCH}`, { headers: h })).json())?.data?.[0];
  if (!twitchId) twitchId = (await (await fetch(`https://api.twitch.tv/helix/users?login=${TWITCH}`, { headers: h })).json())?.data?.[0]?.id;
  // com token de app a Twitch devolve só o total de seguidores, que é o que usamos
  const seg = twitchId ? (await (await fetch(`https://api.twitch.tv/helix/channels/followers?broadcaster_id=${twitchId}&first=1`, { headers: h })).json())?.total : null;
  return { n: s?.viewer_count ?? 0, title: s?.title, seguidores: seg, jogo: s?.game_name, inicio: s?.started_at };
}
let twitchId = null;

// Kick Public API (oficial): https://docs.kick.com
async function kick() {
  if (!env.KICK_CLIENT_ID) return null;
  const tk = await token("kick", "https://id.kick.com/oauth/token", env.KICK_CLIENT_ID, env.KICK_CLIENT_SECRET);
  const r = await fetch(`https://api.kick.com/public/v1/channels?slug=${KICK}`, { headers: { Authorization: "Bearer " + tk, Accept: "application/json" } });
  if (!r.ok) throw new Error(`kick HTTP ${r.status}`);
  const s = (await r.json())?.data?.[0]?.stream;
  return { n: s?.is_live ? s.viewer_count ?? 0 : 0, inicio: s?.is_live ? s.start_time : null };
}

// YouTube Data API v3 (oficial). Cota: videos.list custa 1 unidade; search.list (100) não é usado.
// A live é achada pelo feed RSS público do canal + episódios cadastrados no /admin.
const ytApi = async (ids) => {
  const u = `https://www.googleapis.com/youtube/v3/videos?part=snippet,liveStreamingDetails,statistics&id=${ids.join(",")}&key=${env.YOUTUBE_API_KEY}`;
  const r = await fetch(u);
  if (!r.ok) throw new Error(`youtube HTTP ${r.status}`);
  return (await r.json()).items || [];
};
let ytLive = null, ytUltimaBusca = 0;
async function procuraLive() {
  const rss = await (await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${YT_CANAL}`)).text();
  const ids = [...rss.matchAll(/<yt:videoId>([\w-]{11})</g)].slice(0, 8).map(m => m[1]);
  for (const e of episodios.lista) if (/^[\w-]{11}$/.test(e.id) && !ids.includes(e.id)) ids.push(e.id);
  const cadastrados = new Set(episodios.lista.map(e => e.id));
  // conta só live cadastrada no /admin ou com cara de episódio (ex.: "A VIGÍLIA - EPISÓDIO 2 | Ordem Paranormal RPG")
  const vivo = (await ytApi(ids.slice(0, 50))).find(v => v.snippet?.liveBroadcastContent === "live" && (cadastrados.has(v.id) || EPISODIO.test(v.snippet.title)));
  ytLive = vivo?.id || null;
}
async function youtube() {
  if (!env.YOUTUBE_API_KEY) return null;
  if (!ytLive && Date.now() - ytUltimaBusca > 120_000) { ytUltimaBusca = Date.now(); await procuraLive(); }
  if (!ytLive) return { n: 0 };
  const v = (await ytApi([ytLive]))[0];
  const ls = v?.liveStreamingDetails;
  if (!v || ls?.actualEndTime) {
    // a live acabou: guarda início e fim oficiais do YouTube para a duração
    if (records[ytLive] && ls?.actualEndTime) { records[ytLive].fimLive = ls.actualEndTime; records[ytLive].inicioLive = ls.actualStartTime || records[ytLive].inicioLive; fs.writeFileSync(DB, JSON.stringify(records, null, 2)); }
    ytLive = null; return { n: 0 };
  }
  return { n: +(ls?.concurrentViewers || 0), id: v.id, title: v.snippet.title, likes: +(v.statistics?.likeCount || 0) || null, inicio: ls?.actualStartTime };
}

// TikTok não tem API oficial de espectadores ao vivo: lê o mesmo endereço público que a página da live usa
async function tiktok() {
  if (!TIKTOK) return null;
  const r = await fetch(`https://www.tiktok.com/api-live/user/room/?aid=1988&uniqueId=${TIKTOK}&sourceType=54`, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130 Safari/537.36" } });
  const d = (await r.json())?.data;
  const vivo = d?.liveRoom?.status === 2;
  return { n: vivo ? d.liveRoom.liveRoomStats?.userCount ?? 0 : 0, seguidores: d?.stats?.followerCount, entradas: vivo ? d.liveRoom.liveRoomStats?.enterCount : null };
}

const safe = fn => fn().catch(e => { console.warn(e.message); return null; });

// ---------- chat da Twitch (leitura anônima pelo IRC oficial) ----------
let epAtual = null;
let chat = { msgs: { twitch: 0, kick: 0 }, pessoas: { twitch: new Set(), kick: new Set() } };
let janela = []; // timestamps das msgs do último minuto

function carregaChat(id) {
  const f = path.join(CHATTERS, id.replace(/[^\w-]/g, "_") + ".json");
  try {
    const d = JSON.parse(fs.readFileSync(f, "utf8"));
    chat = { msgs: d.msgs, pessoas: { twitch: new Set(d.twitch), kick: new Set(d.kick) } };
  } catch { chat = { msgs: { twitch: 0, kick: 0 }, pessoas: { twitch: new Set(), kick: new Set() } }; }
}
function salvaChat(id) {
  const f = path.join(CHATTERS, id.replace(/[^\w-]/g, "_") + ".json");
  fs.writeFileSync(f, JSON.stringify({ msgs: chat.msgs, twitch: [...chat.pessoas.twitch], kick: [...chat.pessoas.kick] }));
}
function msg(plataforma, user) {
  if (!epAtual) return;
  chat.msgs[plataforma]++;
  if (user) chat.pessoas[plataforma].add(user.toLowerCase());
  janela.push(Date.now());
}

function conectaTwitch() {
  const ws = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
  ws.onopen = () => { ws.send("PASS SCHMOOPIIE"); ws.send("NICK justinfan" + Math.floor(Math.random() * 99999)); ws.send("JOIN #" + TWITCH); };
  ws.onmessage = e => {
    for (const l of String(e.data).split("\r\n")) {
      if (l.startsWith("PING")) ws.send("PONG :tmi.twitch.tv");
      else if (l.includes(" PRIVMSG ")) msg("twitch", l.match(/^:([^!]+)!/)?.[1]);
    }
  };
  ws.onclose = () => setTimeout(conectaTwitch, 5000);
  ws.onerror = () => ws.close();
}
conectaTwitch();

// ---------- recordes e episódios cadastrados ----------
let records = {};
try { records = JSON.parse(fs.readFileSync(DB, "utf8")); } catch {}
let episodios = { lista: [] };
try { episodios = JSON.parse(fs.readFileSync(EPS, "utf8")); } catch {}
const salvaEps = () => fs.writeFileSync(EPS, JSON.stringify(episodios, null, 2));
if (!fs.existsSync(HIST)) fs.writeFileSync(HIST, "horario,episodio,twitch,kick,youtube,total,yt_likes,msgs_min,tiktok\n");
let atual = { total: 0 };

// só dados de trackers (TwitchTracker / Streams Charts). Contam SÓ a Twitch.
const ANTERIORES = [
  { ep: "Quarentena ep. 1 (23/09/2023)", pico: 215165, plataforma: "twitch", fonte: "TwitchTracker / Streams Charts" },
];
const fmt = n =>(n == null ? "-" : Number(n).toLocaleString("pt-BR"));
function duracao(a, b) {
  if (!a || !b) return "-";
  const m = Math.round((new Date(b) - new Date(a)) / 60000);
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
}
function resumo(e) {
  const p = e.picos || e;
  const hora = e.quando ? new Date(e.quando).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" }) : "-";
  return [
    `📊 ${e.titulo}`,
    ``,
    `🏆 Pico: ${fmt(e.recorde)} pessoas assistindo ao mesmo tempo (às ${hora})`,
    `   YouTube ${fmt(e.youtube)} | Twitch ${fmt(e.twitch)} | Kick ${fmt(e.kick)} | TikTok ${fmt(e.tiktok)}`,
    `📈 Média: ${fmt(e.media)} viewers`,
    `🔝 Picos por plataforma: YouTube ${fmt(p.youtube)} | Twitch ${fmt(p.twitch)} | Kick ${fmt(p.kick)} | TikTok ${fmt(p.tiktok)}`,
    `📌 Recorde da Twitch do canal: ${fmt(ANTERIORES[0].pico)} (${ANTERIORES[0].ep}, ${ANTERIORES[0].fonte})`,
    e.chatMsgs ? `💬 Chat da Twitch: ${fmt(e.chatMsgs)} mensagens de ${fmt(e.chatPessoas)} pessoas diferentes` : null,
    e.picoMsgsMin ? `🔥 Chat mais rápido: ${fmt(e.picoMsgsMin)} mensagens por minuto` : null,
    e.likes ? `👍 Likes no YouTube: ${fmt(e.likes)}` : null,
    `⏱️ Duração: ${duracao(e.inicioLive || e.inicio, e.fimLive || e.ultimaLeitura)}`,
  ].filter(l => l != null).join("\n");
}

async function tick() {
  const [t, k, y, tk] = await Promise.all([safe(twitch), safe(kick), safe(youtube), safe(tiktok)]);
  // episódio = live do canal Ordem Paranormal no YouTube; Twitch e Kick só contam enquanto ela está no ar
  const id = y?.id || null;
  const tw = id ? t?.n ?? null : null, kk = id ? k?.n ?? null : null, tt = id ? tk?.n ?? null : null;
  const total = id ? (tw || 0) + (kk || 0) + (y?.n || 0) + (tt || 0) : 0;
  const hora = new Date().toISOString();
  if (id !== epAtual) { if (epAtual) salvaChat(epAtual); if (id) carregaChat(id); epAtual = id; }
  janela = janela.filter(x => x > Date.now() - 60_000);
  atual = {
    twitch: tw, kick: kk, youtube: y?.n ?? null, tiktok: tt, total, episodio: id, hora,
    extras: {
      twitchSeguidores: t?.seguidores, twitchJogo: t?.jogo, twitchTitulo: t?.title,
      ytLikes: y?.likes, tiktokSeguidores: tk?.seguidores, tiktokEntradas: tk?.entradas,
      inicio: y?.inicio || t?.inicio || k?.inicio,
      msgsMin: janela.length,
      chatMsgs: chat.msgs.twitch + chat.msgs.kick,
      chatPessoas: chat.pessoas.twitch.size + chat.pessoas.kick.size,
      chat: { twitch: { msgs: chat.msgs.twitch, pessoas: chat.pessoas.twitch.size }, kick: { msgs: chat.msgs.kick, pessoas: chat.pessoas.kick.size } },
    },
  };
  if (id) fs.appendFileSync(HIST, `${hora},${id},${tw ?? ""},${kk ?? ""},${atual.youtube ?? ""},${total},${y?.likes ?? ""},${janela.length},${tt ?? ""}\n`);

  if (id && total > 0) {
    const x = atual.extras;
    const ep = records[id] ||= { titulo: y?.title || id, inicio: hora, recorde: 0 };
    ep.picos ||= { twitch: 0, kick: 0, youtube: 0, tiktok: 0 };
    ep.amostras = (ep.amostras || 0) + 1;
    ep.soma = (ep.soma || 0) + total;
    ep.media = Math.round(ep.soma / ep.amostras);
    ep.ultimaLeitura = hora;
    ep.inicioLive ||= x.inicio;
    for (const p of ["twitch", "kick", "youtube", "tiktok"]) if ((atual[p] || 0) > (ep.picos[p] || 0)) ep.picos[p] = atual[p];
    if (tk?.entradas) ep.tiktokEntradas = Math.max(ep.tiktokEntradas || 0, tk.entradas);
    if (y?.likes) ep.likes = Math.max(ep.likes || 0, y.likes);
    ep.chatMsgs = x.chatMsgs;
    ep.chatPessoas = x.chatPessoas;
    ep.chat = x.chat;
    ep.picoMsgsMin = Math.max(ep.picoMsgsMin || 0, x.msgsMin);
    if (tk?.seguidores) { ep.tiktokSegInicio ||= tk.seguidores; ep.tiktokSegFim = tk.seguidores; }
    if (t?.seguidores) { ep.twitchSegInicio ||= t.seguidores; ep.twitchSegFim = t.seguidores; }
    if (total > ep.recorde) Object.assign(ep, { recorde: total, quando: hora, twitch: atual.twitch, kick: atual.kick, youtube: atual.youtube, tiktok: atual.tiktok });
    fs.writeFileSync(DB, JSON.stringify(records, null, 2));
    salvaChat(id);
    fs.writeFileSync(path.join(RESUMOS, id.replace(/[^\w-]/g, "_") + ".txt"), resumo(ep));
  }
  console.log(`[${new Date().toLocaleTimeString("pt-BR")}] ${id || "sem live"} T:${tw} K:${kk} Y:${atual.youtube} TT:${tt} TOTAL:${total} chat/min:${janela.length}`);
}
for (const [v, nome] of [["YOUTUBE_API_KEY", "YouTube"], ["TWITCH_CLIENT_ID", "Twitch"], ["KICK_CLIENT_ID", "Kick"]])
  if (!env[v]) console.warn(`Sem ${v} no .env: ${nome} fica de fora`);
// episódios antigos sem o fim oficial: completa uma vez pela API do YouTube
async function completaFim() {
  const ids = Object.keys(records).filter(id => /^[\w-]{11}$/.test(id) && !records[id].fimLive && id !== ytLive);
  if (!ids.length || !env.YOUTUBE_API_KEY) return;
  for (const v of await ytApi(ids.slice(0, 50))) {
    const ls = v.liveStreamingDetails;
    if (ls?.actualEndTime) Object.assign(records[v.id], { fimLive: ls.actualEndTime, inicioLive: ls.actualStartTime || records[v.id].inicioLive });
  }
  fs.writeFileSync(DB, JSON.stringify(records, null, 2));
}
safe(completaFim);
setTimeout(tick, 1000);
setInterval(tick, INTERVALO);

// ---------- dados públicos: registros + o que foi cadastrado no /admin ----------
const CAMPOS = ["titulo", "temporada", "recorde", "quando", "twitch", "kick", "youtube", "tiktok", "picos", "media", "inicio", "inicioLive", "fimLive", "ultimaLeitura", "likes", "chatMsgs", "chatPessoas", "twitchSegInicio", "twitchSegFim", "kickSegInicio", "kickSegFim", "tiktokSegInicio", "tiktokSegFim", "picoMsgsMin"];
const so = (o, ks) => Object.fromEntries(ks.filter(k => o[k] != null).map(k => [k, o[k]]));
// endereço amigável do episódio: "A VIGÍLIA - EPISÓDIO 1" vira "a-vigilia-1"
const kebab = t => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const slug = (titulo, id) => { const m = (titulo || "").match(/^(.*?)\s*-\s*EPIS[ÓO]DIO\s*(\d+)/i); return (m ? kebab(m[1]) + "-" + m[2] : kebab((titulo || "").replace(/\s*\|.*$/, ""))) || id; };
function publicos() {
  const out = {};
  for (const [id, r] of Object.entries(records)) {
    const e = episodios.lista.find(x => x.id === id);
    if (e?.oculto) continue;
    out[id] = { ...so({ ...r, titulo: e?.titulo || r.titulo, temporada: e?.temporada || null }, CAMPOS), slug: slug(r.titulo, id) };
  }
  return out;
}
const config = () => ({ telaInicial: "contagem", semProximo: "", ...(episodios.config || {}) });
const proximos = () => episodios.lista
  .filter(e => !e.oculto && !records[e.id] && e.data && new Date(e.data) > Date.now() - 86_400_000)
  .sort((a, b) => a.data.localeCompare(b.data))
  .map(({ id, titulo, temporada, data }) => ({ id, titulo, temporada, data }));

// ---------- acessos (anônimo: sem cookie; IP + navegador viram um código que muda todo dia) ----------
const ACESSOS = path.join(DADOS, "acessos.json");
let ac = { dia: "", sal: "", unicos: [], views: 0, pico: 0, celular: 0, computador: 0, origens: {}, eps: {}, serie: [], historico: [] };
try { ac = { ...ac, ...JSON.parse(fs.readFileSync(ACESSOS, "utf8")) }; } catch {}
const online = new Map(); // código -> último acesso
const unicosHoje = new Set(ac.unicos);
const unicosEp = {}; for (const [id, e] of Object.entries(ac.eps)) unicosEp[id] = new Set(e.codigos || []);
const hojeSP = () => new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
function viraDia() {
  const d = hojeSP();
  if (ac.dia === d) return;
  if (ac.dia) ac.historico = [...ac.historico, { dia: ac.dia, unicos: unicosHoje.size, views: ac.views, pico: ac.pico }].slice(-60);
  Object.assign(ac, { dia: d, sal: crypto.randomBytes(16).toString("hex"), views: 0, pico: 0, celular: 0, computador: 0, origens: {}, serie: [] });
  unicosHoje.clear();
}
function registraAcesso(req, url) {
  viraDia();
  const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress || "";
  const ua = req.headers["user-agent"] || "";
  if (/bot|crawl|spider|preview|curl|wget/i.test(ua)) return;
  const cod = crypto.createHash("sha256").update(ac.sal + ip + ua).digest("hex").slice(0, 16);
  online.set(cod, Date.now());
  if (!unicosHoje.has(cod)) { unicosHoje.add(cod); /Mobi|Android|iPhone/i.test(ua) ? ac.celular++ : ac.computador++; }
  if (url.searchParams.get("nova") === "1") {
    ac.views++;
    const o = (url.searchParams.get("de") || "").replace(/^www\./, "").slice(0, 60) || "direto";
    ac.origens[o] = (ac.origens[o] || 0) + 1;
  }
  if (atual.episodio && atual.total > 0) (unicosEp[atual.episodio] ||= new Set()).add(cod);
}
const onlineAgora = () => { const lim = Date.now() - 75_000; let n = 0; for (const [k, t] of online) t > lim ? n++ : online.delete(k); return n; };
// a cada minuto: guarda quantos estavam online e salva no disco
setInterval(() => {
  viraDia();
  const n = onlineAgora();
  ac.pico = Math.max(ac.pico, n);
  ac.serie = [...ac.serie, [Date.now(), n]].slice(-1440);
  if (atual.episodio && atual.total > 0) { const e = ac.eps[atual.episodio] ||= { pico: 0 }; e.pico = Math.max(e.pico, n); }
  ac.unicos = [...unicosHoje];
  for (const [id, s] of Object.entries(unicosEp)) { ac.eps[id] ||= { pico: 0 }; ac.eps[id].codigos = [...s]; ac.eps[id].unicos = s.size; }
  fs.writeFileSync(ACESSOS, JSON.stringify(ac));
}, 60_000);
const relatorio = () => ({
  online: onlineAgora(), pico: Math.max(ac.pico, onlineAgora()), unicos: unicosHoje.size, views: ac.views, celular: ac.celular, computador: ac.computador,
  origens: Object.entries(ac.origens).sort((a, b) => b[1] - a[1]).slice(0, 8), serie: ac.serie.slice(-360),
  eps: Object.fromEntries(Object.entries(ac.eps).map(([id, e]) => [id, { titulo: records[id]?.titulo || id, unicos: unicosEp[id]?.size || e.unicos || 0, pico: e.pico || 0 }])),
  historico: ac.historico.slice(-14), aoVivo: !!(atual.episodio && atual.total > 0),
});

// ---------- admin ----------
const autorizado = req => {
  const senha = env.ADMIN_SENHA, dado = (req.headers.authorization || "").replace(/^Bearer /, "");
  if (!senha || !dado) return false;
  const a = crypto.createHash("sha256").update(senha).digest(), b = crypto.createHash("sha256").update(dado).digest();
  return crypto.timingSafeEqual(a, b);
};
const idDoLink = s => String(s || "").match(/(?:v=|youtu\.be\/|live\/|shorts\/|^)([\w-]{11})(?:[?&#/]|$)/)?.[1];
const corpo = req => new Promise((ok, erro) => {
  let s = ""; req.on("data", c => { s += c; if (s.length > 1e5) req.destroy(); });
  req.on("end", () => { try { ok(JSON.parse(s || "{}")); } catch (e) { erro(e); } });
});
const json = (res, cod, obj) => { res.writeHead(cod, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };

const erros = new Map(); // ip -> [tentativas, desde]
async function admin(req, res) {
  const url = new URL(req.url, "http://x");
  const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress;
  const e = erros.get(ip);
  if (e && e[0] >= 5 && Date.now() - e[1] < 15 * 60_000) return json(res, 429, { erro: "Muitas tentativas. Espere 15 minutos." });
  if (!env.ADMIN_SENHA) return json(res, 503, { erro: "Defina ADMIN_SENHA no .env para usar o painel." });
  if (!autorizado(req)) { const t = e && Date.now() - e[1] < 15 * 60_000 ? e : [0, Date.now()]; t[0]++; erros.set(ip, t); return json(res, 401, { erro: "Senha errada." }); }
  erros.delete(ip);
  if (req.method === "GET") {
    const ids = new Set([...episodios.lista.map(e => e.id), ...Object.keys(records)]);
    const lista = [...ids].map(id => {
      const e = episodios.lista.find(x => x.id === id) || {}, r = records[id];
      return { id, titulo: e.titulo || "", tituloYT: r?.titulo || "", temporada: e.temporada || "", data: e.data || r?.inicioLive || "", oculto: !!e.oculto, recorde: r?.recorde ?? null };
    }).sort((a, b) => (b.data || "").localeCompare(a.data || ""));
    if (url.searchParams.get("acessos")) return json(res, 200, relatorio());
    return json(res, 200, { lista, aoVivo: atual.episodio, config: config() });
  }
  if (req.method === "POST") {
    const b = await corpo(req).catch(() => null);
    if (b?.config) {
      episodios.config = { telaInicial: b.config.telaInicial === "ultimo" ? "ultimo" : "contagem", semProximo: String(b.config.semProximo || "").slice(0, 120) };
      salvaEps();
      return json(res, 200, { ok: true });
    }
    // sem link ainda: episódio só da agenda (data e título), o link entra depois
    const agenda = s => /^ag-[\w-]{6,}$/.test(s || "") ? s : null;
    const id = idDoLink(b?.link) || agenda(b?.id) || (b?.remover ? idDoLink(b?.id) : null)
      || (!b?.link && b?.data ? "ag-" + crypto.randomBytes(5).toString("hex") : null);
    if (!id) return json(res, 400, { erro: b?.link ? "Link do YouTube inválido." : "Cole o link do YouTube ou preencha a data." });
    // ao trocar o cadastro da agenda pelo link real, some o antigo
    if (b.antigo && b.antigo !== id) episodios.lista = episodios.lista.filter(e => e.id !== b.antigo);
    const i = episodios.lista.findIndex(e => e.id === id);
    if (b.remover) { if (i >= 0) episodios.lista.splice(i, 1); }
    else {
      // título e horário vêm do YouTube quando ficam em branco
      const yt = env.YOUTUBE_API_KEY && !agenda(id) ? (await ytApi([id]).catch(() => []))[0] : null;
      if (!yt && !b.data) return json(res, 400, { erro: "Não achei esse vídeo no YouTube. Confira o link ou preencha a data." });
      const ytTitulo = yt?.snippet?.title?.replace(/\s*\|.*$/, "") || "";
      const ytData = yt?.liveStreamingDetails?.scheduledStartTime || yt?.liveStreamingDetails?.actualStartTime || "";
      const e = { id, titulo: String(b.titulo || ytTitulo).slice(0, 200), temporada: String(b.temporada || "").slice(0, 100), data: b.data ? new Date(b.data).toISOString() : ytData, oculto: !!b.oculto };
      if (i >= 0) episodios.lista[i] = e; else episodios.lista.push(e);
      ytUltimaBusca = 0; // procura a live de novo no próximo ciclo
    }
    salvaEps();
    return json(res, 200, { ok: true });
  }
  json(res, 405, {});
}

// páginas servidas sem comentários
const limpa = html => html.replace(/<!--[\s\S]*?-->/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\n\s*\n/g, "\n");
const paginas = {};
const le = nome => limpa(fs.readFileSync(path.join(PUBLICO, nome), "utf8"));
// em produção guarda na memória; no computador relê a cada acesso
const pagina = nome => env.NODE_ENV === "production" ? (paginas[nome] ||= le(nome)) : le(nome);
const html = (res, nome, extra = {}) => { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache", ...extra }); res.end(pagina(nome)); };
const SEGURANCA = {
  "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'",
};

http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SEGURANCA)) res.setHeader(k, v);
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api") {
    registraAcesso(req, url);
    // episódio exibido: o pedido (?ep=), o ao vivo, ou o último que foi ao ar
    const pub = publicos();
    const ultimoEp = Object.entries(pub).sort((p, q) => (q[1].ultimaLeitura || "").localeCompare(p[1].ultimaLeitura || ""))[0]?.[0];
    const p = url.searchParams.get("ep");
    const pedido = p && (pub[p] ? p : Object.keys(pub).find(id => pub[id].slug === p));
    const ver = pedido && pub[pedido] ? pedido : (atual.episodio && pub[atual.episodio] ? atual.episodio : ultimoEp);
    const aoVivo = !!atual.episodio && ver === atual.episodio && atual.total > 0;
    const linhas = fs.readFileSync(HIST, "utf8").trim().split("\n").slice(1);
    const hist = linhas.map(l => l.split(",")).filter(c => c[1] === ver).map(c => [c[0], ...c.slice(2, 6).map(v => (v === "" ? null : +v)), c[7] ? +c[7] : null, c[8] ? +c[8] : null]);
    const at = { ...so(atual, ["twitch", "kick", "youtube", "tiktok", "total", "hora", "episodio"]), extras: so(atual.extras || {}, ["inicio", "ytLikes", "msgsMin", "chatMsgs", "chatPessoas", "twitchSeguidores", "tiktokSeguidores"]) };
    return json(res, 200, { atual: at, records: pub, hist, ver, aoVivo, proximos: proximos(), config: config() });
  }
  if (ADMIN && url.pathname === ADMIN + "/api") return admin(req, res);
  if (url.pathname === "/privacidade") {
    return html(res, "privacidade.html");
  }
  if (ADMIN && url.pathname === ADMIN) {
    return html(res, "admin.html", { "X-Robots-Tag": "noindex" });
  }
  // capa do vídeo servida daqui, pra página poder desenhar ela no PNG de compartilhar
  const capa = req.url.match(/^\/capa\/([\w-]{11})\.jpg$/);
  if (capa) {
    try {
      // depois que a live acaba o YouTube troca a capa "_live" pela normal
      let r = await fetch(`https://i.ytimg.com/vi/${capa[1]}/maxresdefault_live.jpg`);
      if (!r.ok) r = await fetch(`https://i.ytimg.com/vi/${capa[1]}/maxresdefault.jpg`);
      if (!r.ok) r = await fetch(`https://i.ytimg.com/vi/${capa[1]}/hqdefault.jpg`);
      if (!r.ok) throw new Error(r.status);
      res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "max-age=3600" });
      return res.end(Buffer.from(await r.arrayBuffer()));
    } catch { res.writeHead(404); return res.end(); }
  }
  const img = url.pathname.match(/^\/((?:(?:icones|temporadas)\/)?[\w-]+\.(png|jpg))$/);
  if (img && fs.existsSync(path.join(PUBLICO, img[1]))) {
    res.writeHead(200, { "Content-Type": { png: "image/png", jpg: "image/jpeg" }[img[2]], "Cache-Control": "max-age=86400" });
    return res.end(fs.readFileSync(path.join(PUBLICO, img[1])));
  }
  if (url.pathname !== "/" && !/^\/ep\/[\w-]+\/?$/.test(url.pathname)) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("404"); }
  html(res, "index.html");
}).listen(PORTA, () => console.log(`http://localhost:${PORTA}`));
