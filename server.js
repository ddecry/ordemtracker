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
// lives que entram sozinhas, sem cadastro: episódios ("A VIGÍLIA - EPISÓDIO 2 | Ordem Paranormal RPG") e o quadro Transcendendo
const EPISODIO = new RegExp(env.FILTRO_EPISODIO || "(EPIS[ÓO]DIO\\s*\\d+|Transcendendo).*Ordem Paranormal", "i");
// temporada pelo título quando a live entrou sozinha, sem cadastro no painel
const temporadaDoTitulo = t => /transcendendo/i.test(t || "") ? "Transcendendo" : null;
// endereço secreto do painel, definido no .env (sem ele o painel fica desligado)
// endereço do painel, ex.: /menu/admin (letras, números, - e /)
const ADMIN = /^(\/[\w-]+)+$/.test(env.ADMIN_CAMINHO || "") && env.ADMIN_CAMINHO.length >= 6 ? env.ADMIN_CAMINHO : null;
// senha do painel: de preferência só o hash (ADMIN_SENHA_HASH=scrypt$sal$hash), assim nem o servidor guarda a senha
const SENHA_CFG = env.ADMIN_SENHA_HASH || env.ADMIN_SENHA || "";
// senha simples só para testar no computador (ADMIN_SENHA_LOCAL no .env); no site publicado ela é ignorada
const SENHA_LOCAL = env.NODE_ENV !== "production" && env.ADMIN_SENHA_LOCAL || null;
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
  return { n: s?.viewer_count ?? 0, title: s?.title, seguidores: seg, jogo: s?.game_name, jogoId: s?.game_id, inicio: s?.started_at, h };
}
let twitchId = null;

// clipes da Twitch criados durante o episódio (do começo da live até 1 h depois do fim), mais vistos primeiro
// https://dev.twitch.tv/docs/api/reference/#get-clips — guarda 5 min pra não pedir de novo a cada visita
const clipesCache = new Map();
const capasCache = new Map();
async function clipes(id) {
  const r = records[id];
  if (!r || !env.TWITCH_CLIENT_ID) return [];
  const c = clipesCache.get(id);
  // episódio encerrado quase não ganha clipe novo: guarda 12 h; ao vivo, 5 min
  if (c && Date.now() - c.q < (r.fimLive && id !== atual.episodio ? 12 * 3600e3 : 300_000)) return c.lista;
  const tk = await token("twitch", "https://id.twitch.tv/oauth2/token", env.TWITCH_CLIENT_ID, env.TWITCH_CLIENT_SECRET);
  const h = { "Client-Id": env.TWITCH_CLIENT_ID, Authorization: "Bearer " + tk };
  if (!twitchId) twitchId = (await (await fetch(`https://api.twitch.tv/helix/users?login=${TWITCH}`, { headers: h })).json())?.data?.[0]?.id;
  if (!twitchId) return [];
  const ini = new Date(new Date(r.inicioLive || r.inicio).getTime() - 10 * 60e3).toISOString();
  const fim = new Date(r.fimLive ? new Date(r.fimLive).getTime() + 3600e3 : Date.now()).toISOString();
  const j = await (await fetch(`https://api.twitch.tv/helix/clips?broadcaster_id=${twitchId}&started_at=${ini}&ended_at=${fim}&first=50`, { headers: h })).json();
  const lista = (j.data || []).sort((a, b) => b.view_count - a.view_count).map(x => ({
    id: x.id, titulo: x.title, views: x.view_count, criador: x.creator_name, duracao: Math.round(x.duration), capa: x.thumbnail_url, quando: x.created_at,
  }));
  clipesCache.set(id, { q: Date.now(), lista });
  return lista;
}

// VOD da Twitch de cada episódio: procura nas transmissões salvas do canal as que começaram durante a live
// (do início até o fim; live que caiu e voltou vira mais de um VOD, em ordem). Roda a cada hora pros episódios sem VOD.
// https://dev.twitch.tv/docs/api/reference/#get-videos
async function achaVods() {
  if (!env.TWITCH_CLIENT_ID) return;
  const falta = Object.entries(records).filter(([id, r]) => !r.vods?.length && r.fimLive && id !== atual.episodio);
  if (!falta.length) return;
  const tk = await token("twitch", "https://id.twitch.tv/oauth2/token", env.TWITCH_CLIENT_ID, env.TWITCH_CLIENT_SECRET);
  const h = { "Client-Id": env.TWITCH_CLIENT_ID, Authorization: "Bearer " + tk };
  if (!twitchId) twitchId = (await (await fetch(`https://api.twitch.tv/helix/users?login=${TWITCH}`, { headers: h })).json())?.data?.[0]?.id;
  if (!twitchId) return;
  // vai voltando nas páginas até passar do episódio mais antigo que falta (no máximo 10 páginas)
  const maisAntigo = Math.min(...falta.map(([, r]) => new Date(r.inicioLive || r.inicio).getTime())) - 3600e3;
  const vids = []; let cur = "";
  for (let p = 0; p < 10; p++) {
    const j = await (await fetch(`https://api.twitch.tv/helix/videos?user_id=${twitchId}&type=archive&first=100${cur ? "&after=" + cur : ""}`, { headers: h })).json();
    vids.push(...(j?.data || [])); cur = j?.pagination?.cursor;
    if (!cur || !j.data?.length || new Date(j.data.at(-1).created_at).getTime() < maisAntigo) break;
  }
  let mudou = false;
  for (const [, r] of falta) {
    const ini = new Date(r.inicioLive || r.inicio).getTime() - 30 * 60e3, fim = new Date(r.fimLive).getTime();
    const v = vids.filter(x => { const t = new Date(x.created_at).getTime(); return t >= ini && t <= fim; }).sort((x, y) => x.created_at.localeCompare(y.created_at));
    if (v.length) { r.vods = v.map(x => x.id); mudou = true; }
  }
  if (mudou) fs.writeFileSync(DB, JSON.stringify(records, null, 2));
}
setTimeout(() => achaVods().catch(() => {}), 15_000);
setInterval(() => achaVods().catch(() => {}), 3600e3);

// Kick Public API (oficial): https://docs.kick.com
async function kick() {
  if (!env.KICK_CLIENT_ID) return null;
  const tk = await token("kick", "https://id.kick.com/oauth/token", env.KICK_CLIENT_ID, env.KICK_CLIENT_SECRET);
  // a API da Kick às vezes derruba a conexão: tenta de novo até 3 vezes antes de dar erro
  let r;
  for (let i = 0; ; i++) {
    try { r = await fetch(`https://api.kick.com/public/v1/channels?slug=${KICK}`, { headers: { Authorization: "Bearer " + tk, Accept: "application/json" }, signal: AbortSignal.timeout(6000) }); break; }
    catch (e) { if (i >= 2) throw e; await new Promise(ok => setTimeout(ok, 800)); }
  }
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
  const videos = await ytApi(ids.slice(0, 50));
  const vivo = videos.find(v => v.snippet?.liveBroadcastContent === "live" && (cadastrados.has(v.id) || EPISODIO.test(v.snippet.title)));
  ytLive = vivo?.id || null;
  // live já agendada no YouTube (umas horas antes): troca o cadastro só da agenda pelo vídeo, pra ter capa e lembrete sem colar o link
  let mudou = false;
  for (const v of videos) {
    if (v.snippet?.liveBroadcastContent !== "upcoming" || !EPISODIO.test(v.snippet.title) || cadastrados.has(v.id)) continue;
    const e = episodios.lista.find(e => e.id.startsWith("ag-") && slug(e.titulo, e.id) === slug(v.snippet.title, v.id));
    if (!e) continue;
    e.id = v.id; e.data = v.liveStreamingDetails?.scheduledStartTime || e.data; mudou = true;
    console.log(`episódio da agenda ligado ao vídeo agendado ${v.id}`);
  }
  if (mudou) salvaEps();
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
  ytChat = ls?.activeLiveChatId || null;
  return { n: +(ls?.concurrentViewers || 0), id: v.id, title: v.snippet.title, likes: +(v.statistics?.likeCount || 0) || null, inicio: ls?.actualStartTime };
}
// chat do YouTube pela API oficial; a cada 20 s pra caber na cota diária junto com a contagem
let ytChat = null, ytChatPagina = null;
async function chatYoutube() {
  if (!ytChat || !epAtual || !env.YOUTUBE_API_KEY) return;
  const u = `https://www.googleapis.com/youtube/v3/liveChat/messages?liveChatId=${ytChat}&part=snippet${LAB ? ",authorDetails" : ""}&maxResults=2000${ytChatPagina ? "&pageToken=" + ytChatPagina : ""}&key=${env.YOUTUBE_API_KEY}`;
  const r = await fetch(u);
  if (!r.ok) { marca("Chat do YouTube", false, "HTTP " + r.status); if (r.status === 403 || r.status === 404) ytChat = null; return; }
  marca("Chat do YouTube", true, "lendo a cada 20 s");
  const j = await r.json();
  const primeira = !ytChatPagina;
  ytChatPagina = j.nextPageToken;
  if (primeira) return; // a primeira página traz mensagens antigas; começa a contar daqui
  for (const m of j.items || []) {
    if (m.snippet?.type === "textMessageEvent") msg("youtube", m.snippet.authorChannelId, m.snippet.displayMessage);
    LAB?.youtube(epAtual, m);
  }
}
setInterval(() => safe(chatYoutube), 20_000);

// TikTok não tem API oficial de espectadores ao vivo: lê o mesmo endereço público que a página da live usa
async function tiktok() {
  if (!TIKTOK) return null;
  const r = await fetch(`https://www.tiktok.com/api-live/user/room/?aid=1988&uniqueId=${TIKTOK}&sourceType=54`, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130 Safari/537.36" } });
  const d = (await r.json())?.data;
  const vivo = d?.liveRoom?.status === 2;
  return { n: vivo ? d.liveRoom.liveRoomStats?.userCount ?? 0 : 0, seguidores: d?.stats?.followerCount, entradas: vivo ? d.liveRoom.liveRoomStats?.enterCount : null };
}

const safe = fn => fn().catch(e => { console.warn(e.message); return null; });
// ---------- status de cada parte, para a aba Status do painel ----------
// ok: true (funcionando), false (com erro) ou null (desligado / sem nada para fazer agora)
const estado = {}, ultimaMsg = {};
function marca(nome, ok, info) {
  const antes = estado[nome] || {};
  estado[nome] = { ok, info: info == null ? null : String(info).slice(0, 200), quando: Date.now(), ultimoOk: ok ? Date.now() : antes.ultimoOk || null };
}
// coleta de uma plataforma: registra se respondeu, falhou ou está sem chave
const coleta = (nome, fn) => fn().then(r => { marca(nome, r == null ? null : true, r == null ? "sem chave ou desligado" : null); return r; })
  .catch(e => { marca(nome, false, e.message); console.warn(e.message); return null; });

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
function msg(plataforma, user, texto) {
  if (!epAtual) return;
  chat.msgs[plataforma] = (chat.msgs[plataforma] || 0) + 1;
  if (user) (chat.pessoas[plataforma] ||= new Set()).add(user.toLowerCase());
  janela.push(Date.now());
  ultimaMsg[plataforma] = Date.now();
  if (texto) guardaMsg(plataforma, user, texto);
}
// mensagens do episódio pra análise depois: quem escreveu vira um código que muda a cada episódio
const CHATLOG = path.join(DADOS, "chat");
fs.mkdirSync(CHATLOG, { recursive: true });
let chatLog = null; // { id, sal, stream }
function guardaMsg(plataforma, user, texto) {
  if (chatLog?.id !== epAtual) {
    chatLog?.stream.end();
    chatLog = { id: epAtual, sal: crypto.createHash("sha256").update(epAtual + SENHA_CFG).digest("hex"), stream: fs.createWriteStream(path.join(CHATLOG, epAtual.replace(/[^\w-]/g, "_") + ".jsonl"), { flags: "a" }) };
  }
  const u = crypto.createHash("sha256").update(chatLog.sal + plataforma + (user || "").toLowerCase()).digest("hex").slice(0, 10);
  chatLog.stream.write(JSON.stringify({ q: new Date().toISOString(), p: plataforma, u, t: String(texto).slice(0, 500) }) + "\n");
}

function conectaTwitch() {
  const ws = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
  ws.onopen = () => { marca("Chat da Twitch", true, "conectado"); LAB?.capTwitch(ws); ws.send("PASS SCHMOOPIIE"); ws.send("NICK justinfan" + Math.floor(Math.random() * 99999)); ws.send("JOIN #" + TWITCH); };
  ws.onmessage = e => {
    for (const linha of String(e.data).split("\r\n")) {
      // com as tags pedidas (laboratório), a linha começa com "@tags "
      const i = linha.startsWith("@") ? linha.indexOf(" ") : -1, l = i < 0 ? linha : linha.slice(i + 1);
      if (l.startsWith("PING")) ws.send("PONG :tmi.twitch.tv");
      else if (l.includes(" PRIVMSG ")) msg("twitch", l.match(/^:([^!]+)!/)?.[1], l.match(/ PRIVMSG #\S+ :(.*)$/)?.[1]);
      if (LAB && i >= 0) LAB.twitch(epAtual, linha.slice(1, i), l);
    }
  };
  ws.onclose = () => { marca("Chat da Twitch", false, "desconectado, reconectando"); setTimeout(conectaTwitch, 5000); };
  ws.onerror = () => ws.close();
}
conectaTwitch();

// ---------- chat da Kick pelo webhook oficial (chat.message.sent) ----------
// a Kick manda cada mensagem para https://<site>/webhook/kick (endereço configurado no app em kick.com/settings/developer)
// a assinatura é conferida com a chave pública da Kick, pra ninguém mandar mensagem falsa
let kickChave = null;
const chaveKick = async () => kickChave ||= (await (await fetch("https://api.kick.com/public/v1/public-key")).json())?.data?.public_key;
async function webhookKick(req, res) {
  let corpo = ""; for await (const p of req) { corpo += p; if (corpo.length > 64e3) break; }
  res.writeHead(200).end();
  try {
    const h = req.headers, ass = h["kick-event-signature"], base = `${h["kick-event-message-id"]}.${h["kick-event-message-timestamp"]}.${corpo}`;
    if (!ass || !crypto.verify("RSA-SHA256", Buffer.from(base), await chaveKick(), Buffer.from(ass, "base64"))) return;
    if (h["kick-event-type"] !== "chat.message.sent") return;
    const m = JSON.parse(corpo);
    // emote da Kick vem como [emote:123:nome]: fica só o nome, igual aos emotes da Twitch
    msg("kick", m.sender?.username, String(m.content || "").replace(/\[emote:\d+:([^\]]+)\]/g, "$1"));
    marca("Chat da Kick", true, "recebendo pelo webhook");
  } catch (e) { console.warn("webhook kick:", e.message); }
}
// pede à Kick o evento de chat do canal (uma vez; se já existir, a Kick só confirma)
async function assinaChatKick() {
  if (!env.KICK_CLIENT_ID) return;
  try {
    const tk = await token("kick", "https://id.kick.com/oauth/token", env.KICK_CLIENT_ID, env.KICK_CLIENT_SECRET), H = { Authorization: "Bearer " + tk, "Content-Type": "application/json", Accept: "application/json" };
    const canal = (await (await fetch(`https://api.kick.com/public/v1/channels?slug=${KICK}`, { headers: H })).json())?.data?.[0];
    const r = await fetch("https://api.kick.com/public/v1/events/subscriptions", { method: "POST", headers: H,
      body: JSON.stringify({ broadcaster_user_id: canal?.broadcaster_user_id, events: [{ name: "chat.message.sent", version: 1 }], method: "webhook" }) });
    const j = await r.json().catch(() => ({}));
    const erro = j?.data?.find?.(x => x.error)?.error;
    marca("Chat da Kick", r.ok && !erro ? null : false, r.ok && !erro ? "assinado; esperando mensagens pelo webhook" : `assinatura HTTP ${r.status} ${erro || j?.message || ""}`);
  } catch (e) { marca("Chat da Kick", false, e.message); }
}
setTimeout(assinaChatKick, 8000);

// ---------- recordes e episódios cadastrados ----------
let records = {};
try { records = JSON.parse(fs.readFileSync(DB, "utf8")); } catch {}
// laboratório (lab.js): dados extras em teste, só no computador; no site publicado fica desligado
const LAB = env.NODE_ENV !== "production" && fs.existsSync(path.join(__dirname, "lab.js")) ? require("./lab")({ DADOS, HIST, records }) : null;
let labRanking = 0;
let episodios = { lista: [] };
try { episodios = JSON.parse(fs.readFileSync(EPS, "utf8")); } catch {}
const salvaEps = () => fs.writeFileSync(EPS, JSON.stringify(episodios, null, 2));
// o glossário escrito à mão virou automático (wiki): as linhas "errado => certo" passam para as correções aprendidas
if (episodios.config?.glossario) {
  const pares = [...episodios.config.glossario.matchAll(/^\s*(.+?)\s*(?:=>|→)\s*(.+?)\s*$/gm)].map(m => [m[1], m[2]]);
  episodios.config = { ...episodios.config, apelidos: { ...Object.fromEntries(pares), ...(episodios.config.apelidos || {}) }, glossario: "" };
  salvaEps();
}
// histórico lido uma vez e guardado por episódio; só lê de novo quando o arquivo muda (a cada leitura da live)
let histCache = { chave: "", por: new Map() };
function histDe(id) {
  const st = fs.statSync(HIST), chave = st.mtimeMs + ":" + st.size;
  if (histCache.chave !== chave) {
    const por = new Map();
    for (const l of fs.readFileSync(HIST, "utf8").split("\n")) {
      const c = l.split(","); if (c.length < 6 || c[0] === "horario") continue;
      let a = por.get(c[1]); if (!a) por.set(c[1], a = []);
      a.push([c[0], ...c.slice(2, 6).map(v => (v === "" ? null : +v)), c[7] ? +c[7] : null, c[8] ? +c[8] : null]);
    }
    histCache = { chave, por };
  }
  return histCache.por.get(id) || [];
}
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
  const [t, k, y, tk] = await Promise.all([coleta("Twitch", twitch), coleta("Kick", kick), coleta("YouTube", youtube), coleta("TikTok", tiktok)]);
  // episódio = live do canal Ordem Paranormal no YouTube; Twitch e Kick só contam enquanto ela está no ar
  const id = y?.id || null;
  const tw = id ? t?.n ?? null : null, kk = id ? k?.n ?? null : null, tt = id ? tk?.n ?? null : null;
  const total = id ? (tw || 0) + (kk || 0) + (y?.n || 0) + (tt || 0) : 0;
  const hora = new Date().toISOString();
  if (LAB && id && t?.n && Date.now() - labRanking > 120_000) { labRanking = Date.now(); safe(() => LAB.ranking(id, t.h, TWITCH, t.jogoId)); }
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
  gravacao();
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
const CAMPOS = ["titulo", "temporada", "recorde", "quando", "twitch", "kick", "youtube", "tiktok", "picos", "media", "inicio", "inicioLive", "fimLive", "ultimaLeitura", "likes", "chatMsgs", "chatPessoas", "twitchSegInicio", "twitchSegFim", "kickSegInicio", "kickSegFim", "tiktokSegInicio", "tiktokSegFim", "picoMsgsMin", "vods", "videosYT"];
const so = (o, ks) => Object.fromEntries(ks.filter(k => o[k] != null).map(k => [k, o[k]]));
// endereço amigável do episódio: "A VIGÍLIA - EPISÓDIO 1" vira "a-vigilia-1"
const kebab = t => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const slug = (titulo, id) => { const m = (titulo || "").match(/^(.*?)\s*-\s*EPIS[ÓO]DIO\s*(\d+)/i); return (m ? kebab(m[1]) + "-" + m[2] : kebab((titulo || "").replace(/\s*\|.*$/, ""))) || id; };
// título sem número de episódio (ex.: Transcendendo): endereço curto pela temporada e a ordem da live nela → /ep/transcendendo-1
const temporadaDe = id => episodios.lista.find(e => e.id === id)?.temporada || temporadaDoTitulo(records[id]?.titulo);
function slugEp(id, titulo, temporada) {
  if (!temporada || /EPIS[ÓO]DIO\s*\d+/i.test(titulo || "")) return slug(titulo, id);
  const da = Object.keys(records).filter(k => temporadaDe(k) === temporada)
    .sort((a, b) => (records[a].inicioLive || records[a].inicio || "").localeCompare(records[b].inicioLive || records[b].inicio || ""));
  return kebab(temporada) + "-" + ((da.indexOf(id) + 1) || da.length + 1);
}
// acha o episódio pelo id, pelo endereço curto ou pelo endereço antigo (título inteiro), pra links já compartilhados não quebrarem
const achaEp = (pub, p) => pub[p] ? p : Object.keys(pub).find(k => pub[k].slug === p || slug(pub[k].titulo, k) === p);
// média sem o fim da live: quando a transmissão acaba todo mundo sai de uma vez e a queda puxaria a média pra baixo.
// corta do fim pra trás as leituras abaixo de 90% da mediana dos 10 minutos anteriores (só aparecem no gráfico)
const medias = new Map(); // id -> { chave, media }
function mediaSemFim(id, r) {
  if (id === atual.episodio) return r.media;
  const m = medias.get(id);
  if (m && m.chave === r.ultimaLeitura) return m.media;
  const tot = fs.readFileSync(HIST, "utf8").split("\n").map(l => l.split(",")).filter(c => c[1] === id && +c[5] > 0).map(c => +c[5]);
  const mediana = arr => { const s = [...arr].sort((a, b) => a - b); return s[s.length >> 1]; };
  let fim = tot.length;
  while (fim > 60 && tot[fim - 1] < .9 * mediana(tot.slice(fim - 61, fim - 1))) fim--;
  const media = fim ? Math.round(tot.slice(0, fim).reduce((s, v) => s + v, 0) / fim) : r.media;
  medias.set(id, { chave: r.ultimaLeitura, media });
  return media;
}
// teste = id de um episódio escondido que o link de teste (com a chave certa) pode ver
function publicos(teste) {
  const out = {};
  for (const [id, r] of Object.entries(records)) {
    const e = episodios.lista.find(x => x.id === id);
    if (e?.oculto && id !== teste) continue;
    out[id] = { ...so({ ...r, titulo: e?.titulo || r.titulo, temporada: e?.temporada || temporadaDoTitulo(r.titulo), media: mediaSemFim(id, r) }, CAMPOS), slug: slugEp(id, e?.titulo || r.titulo, temporadaDe(id)),
      // vídeo completo (sem membros), nome do episódio e trechos cortados da live, pra os momentos abrirem no ponto certo
      video: e?.video || null, nome: e?.nome || null, cortes: e?.video ? e.cortes || null : null,
      // a faixa de chat no gráfico só aparece quando o chat do episódio foi gravado inteiro (do Ep 2 em diante)
      chatCompleto: fs.existsSync(path.join(CHATLOG, id.replace(/[^\w-]/g, "_") + ".jsonl")) };
  }
  return out;
}
const config = () => ({ telaInicial: "contagem", semProximo: "", ...(episodios.config || {}) });
const proximos = () => episodios.lista
  .filter(e => !e.oculto && !records[e.id] && e.data && new Date(e.data) > Date.now() - 86_400_000)
  .sort((a, b) => a.data.localeCompare(b.data))
  .map(({ id, titulo, temporada, data }) => ({ id, titulo, temporada, data, slug: slugEp(id, titulo, temporada) }));

// ---------- acessos (anônimo: sem cookie; IP + navegador viram um código que muda todo dia) ----------
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
  if (atual.episodio && atual.total > 0 && agoraOn > (ac.eps[atual.episodio]?.pico || 0)) (ac.eps[atual.episodio] ||= { pico: 0 }).pico = onlineAgora();
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
  historico: ac.historico.slice(-60), aoVivo: !!(atual.episodio && atual.total > 0),
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

// ---------- feedbacks e bugs enviados pelo site ----------
const FEEDBACKS = path.join(DADOS, "feedbacks.json");
let feedbacks = [];
try { feedbacks = JSON.parse(fs.readFileSync(FEEDBACKS, "utf8")); } catch {}
const salvaFb = () => fs.writeFileSync(FEEDBACKS, JSON.stringify(feedbacks));
const envios = new Map(); // ip -> horários dos últimos envios
async function feedback(req, res) {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress;
  const lista = (envios.get(ip) || []).filter(t => Date.now() - t < 3600e3);
  if (lista.length >= 5) return json(res, 429, { erro: "Muitos envios. Tente de novo mais tarde." });
  const b = await corpo(req).catch(() => null);
  const texto = String(b?.texto || "").trim().slice(0, 1500);
  if (texto.length < 5) return json(res, 400, { erro: "Escreva um pouco mais." });
  // sugestão de correção de um momento: guarda qual episódio e qual momento
  const correcao = b.tipo === "correcao" && records[b.ep] && leMomentos(b.ep).some(m => m.quando === b.momento) ? { ep: b.ep, momento: b.momento } : null;
  if (b.tipo === "correcao" && !correcao) return json(res, 400, { erro: "Momento não encontrado." });
  envios.set(ip, [...lista, Date.now()]);
  const ua = req.headers["user-agent"] || "";
  feedbacks = [{ id: crypto.randomBytes(5).toString("hex"), tipo: correcao ? "correcao" : b.tipo === "bug" ? "bug" : "ideia", texto, contato: String(b.contato || "").trim().slice(0, 120), ...correcao,
    pagina: String(b.pagina || "").slice(0, 80), aparelho: /Mobi|Android|iPhone/i.test(ua) ? "Celular" : "Computador", quando: new Date().toISOString() }, ...feedbacks].slice(0, 500);
  salvaFb();
  json(res, 200, { ok: true });
}

// ---------- admin ----------
const autorizado = req => {
  const dado = (req.headers.authorization || "").replace(/^Bearer /, "");
  if (!dado) return false;
  if (SENHA_LOCAL && dado === SENHA_LOCAL) return true;
  if (!SENHA_CFG) return false;
  const h = env.ADMIN_SENHA_HASH?.match(/^scrypt\$([0-9a-f]+)\$([0-9a-f]{64})$/);
  if (h) return crypto.timingSafeEqual(crypto.scryptSync(dado, Buffer.from(h[1], "hex"), 32), Buffer.from(h[2], "hex"));
  const a = crypto.createHash("sha256").update(env.ADMIN_SENHA || "").digest(), b = crypto.createHash("sha256").update(dado).digest();
  return crypto.timingSafeEqual(a, b);
};
const idDoLink = s => String(s || "").match(/(?:v=|youtu\.be\/|live\/|shorts\/|^)([\w-]{11})(?:[?&#/]|$)/)?.[1];
const corpo = req => new Promise((ok, erro) => {
  let s = ""; req.on("data", c => { s += c; if (s.length > 1e5) req.destroy(); });
  req.on("end", () => { try { ok(JSON.parse(s || "{}")); } catch (e) { erro(e); } });
});
const json = (res, cod, obj) => { res.writeHead(cod, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); };

const erros = new Map(); // ip -> [tentativas, desde]
async function admin(req, res) {
  const url = new URL(req.url, "http://x");
  const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress;
  const e = erros.get(ip);
  // o bloqueio por tentativas vale só no site publicado
  if (env.NODE_ENV === "production" && e && e[0] >= 5 && Date.now() - e[1] < 15 * 60_000) return json(res, 429, { erro: "Muitas tentativas. Espere 15 minutos." });
  if (!SENHA_CFG) return json(res, 503, { erro: "Defina ADMIN_SENHA_HASH no .env para usar o painel." });
  if (!autorizado(req)) { const t = e && Date.now() - e[1] < 15 * 60_000 ? e : [0, Date.now()]; t[0]++; erros.set(ip, t); return json(res, 401, { erro: "Senha errada." }); }
  erros.delete(ip);
  if (req.method === "GET") {
    const ids = new Set([...episodios.lista.map(e => e.id), ...Object.keys(records)]);
    const lista = [...ids].map(id => {
      const e = episodios.lista.find(x => x.id === id) || {}, r = records[id];
      return { id, titulo: e.titulo || "", tituloYT: r?.titulo || "", video: e.video || "", nome: e.nome || "", teste: e.oculto && e.teste ? "/ep/" + id + "?teste=" + e.teste : "", temporada: e.temporada || "", data: e.data || r?.inicioLive || "", oculto: !!e.oculto, recorde: r?.recorde ?? null };
    }).sort((a, b) => (b.data || "").localeCompare(a.data || ""));
    if (url.searchParams.get("acessos")) return json(res, 200, relatorio());
    // correções vêm com o texto atual do momento, pra comparar
    if (url.searchParams.get("status")) return json(res, 200, status());
    if (url.searchParams.get("feedbacks")) return json(res, 200, feedbacks.map(f => f.tipo === "correcao" ? { ...f, atual: leMomentos(f.ep).find(m => m.quando === f.momento) || null } : f));
    const mid = url.searchParams.get("momentos");
    // rascunhos com a reação real do chat (agito e o que mais gente mandou) e as imagens dos emotes, pra conferir o resumo da IA
    if (mid && records[mid]) { const reac = reacoesChat(mid); return json(res, 200, { lista: leMomentos(mid).map(m => ({ ...m, reac: reac?.(m.quando) || null })), emotes: await emotesCanal() }); }
    if (url.searchParams.get("pendentes")) return json(res, 200, { pendentes: Object.keys(records).reduce((t, id) => t + leMomentos(id).filter(m => !m.aprovado).length, 0) });
    // trecho de áudio do momento (só no painel)
    const au = url.searchParams.get("audio")?.match(/^([\w-]+)\/([\w-]+\.ogg)$/);
    if (au && records[au[1]]) {
      const arq = path.join(MOMENTOS, au[1], "audio", au[2]);
      if (!fs.existsSync(arq)) return json(res, 404, {});
      res.writeHead(200, { "Content-Type": "audio/ogg" }); return res.end(fs.readFileSync(arq));
    }
    // captura de rascunho (só no painel)
    const cap = url.searchParams.get("captura")?.match(/^([\w-]+)\/([\w-]+\.jpg)$/);
    if (cap && records[cap[1]]) {
      const arq = path.join(MOMENTOS, cap[1], "capturas", cap[2]);
      if (!fs.existsSync(arq)) return json(res, 404, {});
      res.writeHead(200, { "Content-Type": "image/jpeg" }); return res.end(fs.readFileSync(arq));
    }
    // senha de uso único pra página do episódio mandar a imagem da prévia
    const pv = url.searchParams.get("previa");
    if (pv && records[pv]) {
      const token = crypto.randomBytes(16).toString("hex");
      previaTokens.set(token, { id: pv, ate: Date.now() + 5 * 60e3 });
      return json(res, 200, { token, url: "/ep/" + slugEp(pv, records[pv].titulo, temporadaDe(pv)) + "#previa=" + token });
    }
    return json(res, 200, { lista, aoVivo: atual.episodio, config: config(), wiki: gloWiki });
  }
  if (req.method === "POST") {
    const b = await corpo(req).catch(() => null);
    if (b?.atualizaWiki) { await atualizaWiki(true); return json(res, 200, { wiki: gloWiki }); }
    if (b?.apagaFeedback) {
      feedbacks = feedbacks.filter(f => f.id !== b.apagaFeedback); salvaFb();
      return json(res, 200, { ok: true });
    }
    // aceita a sugestão: troca o texto do momento (o painel pode mandar o texto já ajustado)
    const fc = b?.aplicaCorrecao && feedbacks.find(f => f.id === b.aplicaCorrecao && f.tipo === "correcao");
    if (fc) {
      const lista = leMomentos(fc.ep), m = lista.find(x => x.quando === fc.momento);
      if (m) { const novo = String(b.texto || fc.texto).slice(0, 240); aprende(m.contexto, novo); m.contexto = novo; salvaMomentos(fc.ep, lista); }
      feedbacks = feedbacks.filter(f => f.id !== fc.id); salvaFb();
      return json(res, 200, { ok: true });
    }
    // revisão dos momentos: só guarda os campos conhecidos
    if (b?.momentos && records[b.momentos] && Array.isArray(b.lista)) {
      const lista = b.lista.slice(0, 500).map(m => ({ quando: new Date(m.quando).toISOString(), segundoVideo: Number.isFinite(+m.segundoVideo) && m.segundoVideo !== null && m.segundoVideo !== "" ? +m.segundoVideo : undefined,
        titulo: String(m.titulo || "").slice(0, 80), contexto: String(m.contexto || "").slice(0, 240), tipo: m.tipo === "mesa" ? "mesa" : "historia",
        captura: /^[\w-]+\.jpg$/.test(m.captura || "") ? m.captura : null, audio: /^[\w-]+\.ogg$/.test(m.audio || "") ? m.audio : undefined,
        chatResumo: m.chatResumo ? String(m.chatResumo).slice(0, 160) : undefined, aprovado: !!m.aprovado }));
      // nomes trocados à mão viram correção automática para os próximos momentos
      const antes = Object.fromEntries(leMomentos(b.momentos).map(m => [m.quando, m]));
      for (const m of lista) if (antes[m.quando]) { aprende(antes[m.quando].titulo, m.titulo); aprende(antes[m.quando].contexto, m.contexto); }
      salvaMomentos(b.momentos, lista);
      return json(res, 200, { ok: true });
    }
    if (b?.config) {
      episodios.config = { telaInicial: b.config.telaInicial === "ultimo" ? "ultimo" : "contagem", semProximo: String(b.config.semProximo || "").slice(0, 120), glossario: String(b.config.glossario ?? episodios.config?.glossario ?? "").slice(0, 4000),
        apelidos: b.config.apelidos && typeof b.config.apelidos === "object" ? Object.fromEntries(Object.entries(b.config.apelidos).slice(0, 200).map(([d, p]) => [String(d).slice(0, 40), String(p).slice(0, 40)])) : episodios.config?.apelidos || {} };
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
      // vídeo completo postado depois da live: o nome do episódio vem do título dele ("O Vilarejo")
      const antes = i >= 0 ? episodios.lista[i] : {}, video = idDoLink(b.video) || null;
      const ytVideo = video && video !== antes.video && env.YOUTUBE_API_KEY ? (await ytApi([video]).catch(() => []))[0] : null;
      const nomeYT = (ytVideo?.snippet?.title || yt?.snippet?.title || "").match(/["“]([^"”]+)["”]/)?.[1] || "";
      const e = { id, titulo: String(b.titulo || ytTitulo).slice(0, 200), temporada: String(b.temporada || "").slice(0, 100), data: b.data ? new Date(b.data).toISOString() : ytData, oculto: !!b.oculto, teste: b.oculto ? antes.teste || crypto.randomBytes(9).toString("hex") : undefined,
        video, nome: String(b.nome || nomeYT || "").slice(0, 100) || null, cortes: video && video === antes.video ? antes.cortes || null : null };
      if (i >= 0) episodios.lista[i] = e; else episodios.lista.push(e);
      ytUltimaBusca = 0; // procura a live de novo no próximo ciclo
    }
    salvaEps();
    return json(res, 200, { ok: true });
  }
  json(res, 405, {});
}

// ---------- momentos do episódio (análise da live, revisados no painel) ----------
// dados/momentos/<id>/momentos.json + capturas/<segundo>.jpg
const MOMENTOS = path.join(DADOS, "momentos");
const leMomentos = id => {
  let lista; try { lista = JSON.parse(fs.readFileSync(path.join(MOMENTOS, id, "momentos.json"), "utf8")); } catch { return []; }
  // captura tirada depois (análise de vídeo gravado): capturas/<segundo do vídeo>.jpg
  for (const m of lista) if (!m.captura && m.segundoVideo != null && fs.existsSync(path.join(MOMENTOS, id, "capturas", m.segundoVideo + ".jpg"))) m.captura = m.segundoVideo + ".jpg";
  // trecho de áudio do momento (gravado ao vivo, ou tirado do vídeo: audio/<segundo do vídeo>.ogg)
  for (const m of lista) if (!m.audio && m.segundoVideo != null && fs.existsSync(path.join(MOMENTOS, id, "audio", m.segundoVideo + ".ogg"))) m.audio = m.segundoVideo + ".ogg";
  // rascunho até aprovar no painel; nomes corrigidos pelo glossário
  for (const m of lista) { m.aprovado ??= false; m.titulo = corrigeNomes(m.titulo); m.contexto = corrigeNomes(m.contexto); }
  return lista;
};
// corrige nomes escritos como soam no áudio: apelidos do glossário ("Gwen => Gwayne") e nomes parecidos (até 2 letras de diferença)
const semAcento = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const distancia = (a, b) => {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
};
let gloCache = { texto: null };
// ---------- glossário automático: nomes oficiais da Ordem Paranormal Wiki ----------
// lê a página de cada temporada pela API pública da wiki (elenco, personagens, monstros e locais) e atualiza a cada 12 h
const GLOWIKI = path.join(DADOS, "glossario-wiki.json");
const WIKI = "https://ordemparanormal.fandom.com/api.php", UA = { "User-Agent": "OrdemTracker/1.0 (https://ordemtracker.site)" };
let gloWiki = {}; // temporada -> { pagina, texto, quando, erro }
try { gloWiki = JSON.parse(fs.readFileSync(GLOWIKI, "utf8")); } catch {}
const limpaWiki = t => t.replace(/<!--[\s\S]*?-->/g, "").replace(/\{\{[^}]*\}\}/g, "").replace(/\[\[(?:[^\]|]*\|)?([^\]]+)\]\]/g, "$1").replace(/'''?/g, "").trim();
async function leWiki(temporada) {
  const busca = await (await fetch(`${WIKI}?action=opensearch&search=${encodeURIComponent(temporada)}&limit=1&format=json`, { headers: UA })).json();
  const pagina = busca?.[1]?.[0];
  if (!pagina) throw new Error("não achei a página de " + temporada + " na wiki");
  const w = (await (await fetch(`${WIKI}?action=parse&page=${encodeURIComponent(pagina)}&prop=wikitext&format=json`, { headers: UA })).json())?.parse?.wikitext?.["*"] || "";
  const linhas = [`Campanha: ${pagina} (Ordem Paranormal).`];
  // elenco da caixa de informações: "[[Grifo]] (Gwayne)"
  const elenco = (w.match(/\|\s*elenco\s*=([\s\S]*?)\n\|/) || [])[1] || "";
  const pares = [...elenco.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]\s*\(([^)]+)\)/g)].map(m => [m[1].trim(), m[2].trim()]);
  const mestre = pares.find(p => /mestre/i.test(p[1]));
  if (mestre) linhas.push("Mestre: " + mestre[0] + ".");
  const jog = pares.filter(p => !/mestre/i.test(p[1]));
  if (jog.length) linhas.push("Jogadores e personagens: " + jog.map(([j, p]) => `${j} joga ${p}`).join("; ") + ".");
  // listas das seções de personagens, monstros e locais
  const ini = w.search(/==\s*Personagens/), fim = w.search(/==\s*Créditos/);
  let grupo = null; const grupos = {};
  for (const l of w.slice(ini < 0 ? 0 : ini, fim < 0 ? undefined : fim).split("\n")) {
    const h = l.match(/^=+\s*(.+?)\s*=+\s*$/); if (h) { grupo = limpaWiki(h[1]); continue; }
    const it = l.match(/^\*+\s*(.+)$/); if (it && grupo) (grupos[grupo] ||= []).push(limpaWiki(it[1]));
  }
  for (const [g, nomes] of Object.entries(grupos)) if (nomes.filter(Boolean).length) linhas.push(`${g}: ${nomes.filter(Boolean).join(", ")}.`);
  return { pagina, texto: linhas.join("\n"), quando: Date.now() };
}
// temporadas cadastradas (campo temporada ou o começo do título: "A VIGÍLIA - EPISÓDIO 1")
const temporadas = () => [...new Set([...episodios.lista.map(e => e.temporada || e.titulo), ...Object.values(records).map(r => r.titulo)]
  .map(t => String(t || "").replace(/\s*-\s*EPIS[ÓO]DIO.*$/i, "").replace(/\s*\|.*$/, "").trim()).filter(Boolean).map(t => t.toLowerCase()))];
async function atualizaWiki(forcar) {
  for (const t of temporadas()) {
    // durante a live a wiki ganha personagens novos: relê de hora em hora; fora dela, a cada 12 h
    const validade = atual.episodio && atual.total > 0 ? 55 * 60e3 : 12 * 3600e3;
    if (!forcar && gloWiki[t]?.quando > Date.now() - validade) continue;
    try { gloWiki[t] = await leWiki(t); } catch (e) { gloWiki[t] = { ...gloWiki[t], erro: e.message, quando: Date.now() }; }
  }
  fs.writeFileSync(GLOWIKI, JSON.stringify(gloWiki, null, 2));
  gloCache = { texto: null };
}
setTimeout(() => atualizaWiki().catch(() => {}), 5000);
setInterval(() => atualizaWiki().catch(() => {}), 3600e3);
// glossário usado: o da wiki + as correções aprendidas ("Gwen => Gwayne") + as escritas no painel
const glossario = () => [...Object.values(gloWiki).map(g => g.texto).filter(Boolean),
  ...Object.entries(config().apelidos || {}).map(([de, para]) => `${de} => ${para}`), config().glossario || ""].join("\n").trim();
// aprende correções comparando o texto antes e depois de uma edição: se uma palavra fora da wiki virou um nome da wiki, guarda o par
function aprende(antes, depois) {
  const pa = String(antes || "").split(/\s+/), pd = String(depois || "").split(/\s+/);
  if (!pa.length || pa.length !== pd.length) return;
  corrigeNomes("Inicio"); // garante a lista de nomes carregada
  const novos = {};
  pa.forEach((a, i) => {
    const de = a.replace(/[^\p{L}']/gu, ""), para = pd[i].replace(/[^\p{L}']/gu, "");
    if (de.length >= 3 && para && de !== para && /^\p{Lu}/u.test(de) && !gloCache.chave.has(semAcento(de)) && gloCache.chave.has(semAcento(para))) novos[de] = para;
  });
  if (!Object.keys(novos).length) return;
  episodios.config = { ...config(), apelidos: Object.fromEntries(Object.entries({ ...(config().apelidos || {}), ...novos }).slice(-200)) };
  salvaEps();
  console.log("correções aprendidas:", novos);
}

function corrigeNomes(texto) {
  const g = glossario();
  if (!g || !texto) return texto;
  if (gloCache.texto !== g) {
    const apelidos = [...g.matchAll(/^\s*(.+?)\s*(?:=>|→)\s*(.+?)\s*$/gm)].map(m => [m[1], m[2]]);
    const nomes = [...new Set(g.replace(/^.*(?:=>|→).*$/gm, "").match(/\p{Lu}[\p{L}']{2,}/gu) || [])];
    gloCache = { texto: g, apelidos, nomes, chave: new Set(nomes.map(semAcento)) };
  }
  let t = texto;
  for (const [de, para] of gloCache.apelidos) t = t.replace(new RegExp(`(?<![\\p{L}])${de.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}])`, "gu"), para);
  return t.replace(/\p{Lu}[\p{L}']{4,}/gu, p => {
    const k = semAcento(p); if (gloCache.chave.has(k)) return p;
    // mesma inicial, ou as duas começando com vogal (Aileen ≈ Eileen)
    const inicio = n => semAcento(n)[0] === k[0] || (/[aeiou]/.test(semAcento(n)[0]) && /[aeiou]/.test(k[0]));
    const perto = gloCache.nomes.map(n => [n, distancia(k, semAcento(n))]).filter(([n, d]) => d <= 2 && inicio(n)).sort((a, b) => a[1] - b[1])[0];
    return perto ? perto[0] : p;
  });
}
const salvaMomentos = (id, lista) => { momCache?.delete(id); fs.mkdirSync(path.join(MOMENTOS, id), { recursive: true }); fs.writeFileSync(path.join(MOMENTOS, id, "momentos.json"), JSON.stringify(lista, null, 2)); };
// cada item da reação do chat leva a imagem oficial do emote, quando é um emote do canal (a lista se atualiza sozinha, 1 vez por dia)
const comImagens = r => { if (!r) return null; emotesCanal(); const mapa = emotesCache.mapa; return { ...r, top: r.top.map(x => mapa[x.p] ? { ...x, img: mapa[x.p] } : x) }; };
// momentos com a reação do chat: contar o chat de cada momento pesa; refaz no máximo a cada 30 s por episódio
const momCache = new Map(); // id -> { q, lista }
const momentosPublicos = id => { const c = momCache.get(id); if (c && Date.now() - c.q < 30_000) return c.lista;
  const reac = reacoesChat(id), lista = leMomentos(id).filter(m => m.aprovado)
  .map(m => ({ quando: m.quando, titulo: m.titulo, contexto: m.contexto, tipo: m.tipo, captura: m.captura ? `/momento/${id}/${m.captura}` : null, chat: comImagens(reac?.(m.quando)), chatResumo: m.chatResumo || null }));
  momCache.set(id, { q: Date.now(), lista }); return lista; };

// imagens dos emotes do canal (nome -> endereço), pela API da Twitch; guarda 1 dia
let emotesCache = { q: 0, mapa: {} };
async function emotesCanal() {
  if (Date.now() - emotesCache.q < 86400e3 || !env.TWITCH_CLIENT_ID) return emotesCache.mapa;
  try {
    const tk = await token("twitch", "https://id.twitch.tv/oauth2/token", env.TWITCH_CLIENT_ID, env.TWITCH_CLIENT_SECRET);
    const h = { "Client-Id": env.TWITCH_CLIENT_ID, Authorization: "Bearer " + tk };
    if (!twitchId) twitchId = (await (await fetch(`https://api.twitch.tv/helix/users?login=${TWITCH}`, { headers: h })).json())?.data?.[0]?.id;
    const j = await (await fetch(`https://api.twitch.tv/helix/chat/emotes?broadcaster_id=${twitchId}`, { headers: h })).json();
    // endereço oficial da Twitch; a versão animada quando o emote tem animação (tema escuro, tamanho 2x)
    const tpl = j.template || "https://static-cdn.jtvnw.net/emoticons/v2/{{id}}/{{format}}/{{theme_mode}}/{{scale}}";
    const mapa = Object.fromEntries((j.data || []).map(e => [e.name,
      tpl.replace("{{id}}", e.id).replace("{{format}}", e.format?.includes("animated") ? "animated" : "static").replace("{{theme_mode}}", "dark").replace("{{scale}}", "2.0")]));
    // emotes das extensões que o chat usa (7TV, BTTV, FFZ), do canal e os globais; APIs públicas, sem login. Os da Twitch têm preferência
    const pega = u => fetch(u, { signal: AbortSignal.timeout(10_000) }).then(r => r.ok ? r.json() : null).catch(() => null);
    const [s7, s7g, bt, btg, fz] = await Promise.all([pega(`https://7tv.io/v3/users/twitch/${twitchId}`), pega("https://7tv.io/v3/emote-sets/global"),
      pega(`https://api.betterttv.net/3/cached/users/twitch/${twitchId}`), pega("https://api.betterttv.net/3/cached/emotes/global"), pega(`https://api.betterttv.net/3/cached/frankerfacez/users/twitch/${twitchId}`)]);
    for (const e of [...(s7?.emote_set?.emotes || []), ...(s7g?.emotes || [])]) if (e.data?.host?.url) mapa[e.name] ??= `https:${e.data.host.url}/2x.webp`;
    for (const e of [...(bt?.channelEmotes || []), ...(bt?.sharedEmotes || []), ...(btg || [])]) mapa[e.code] ??= `https://cdn.betterttv.net/emote/${e.id}/2x`;
    for (const e of fz || []) if (e.images) mapa[e.code] ??= e.images["2x"] || e.images["1x"];
    emotesCache = { q: Date.now(), mapa };
  } catch (e) { console.warn("emotes:", e.message); emotesCache.q = Date.now() - 86400e3 + 600e3; }
  return emotesCache.mapa;
}
setTimeout(emotesCanal, 5000);

// ---------- reação do chat em cada momento (episódios com o chat gravado inteiro) ----------
// janela de 2 min a partir de 30 s antes do momento: quanto o chat agitou em relação à média da live
// e as palavras/emotes que mais gente usou (cada pessoa conta uma vez por palavra, pra spam não pesar)
const PARADAS = new Set("a o e é de da do das dos em no na nos nas um uma uns umas que se pra para por com sem ele ela eles elas eu tu vc voce você vcs isso esse essa este esta aqui ai aí la lá ja já nao não sim mas mais muito so só tá ta to tô foi vai era ser ter tem como quando onde qual quem me te lhe meu minha seu sua nosso nossa the and of to is it in".split(" "));
const RISADA = /k{3,}|(?:ha){2,}|(?:rs){2,}|(?:ks){2,}/i;
// nomes dos personagens da temporada do episódio (wiki): "arthur" e "arthur cervero" -> "Arthur Cervero"; jogadores e locais ficam de fora
function personagens(id) {
  const tit = String(records[id]?.titulo || "").replace(/\s*-\s*EPIS[ÓO]DIO.*$/i, "").replace(/\s*\|.*$/, "").trim().toLowerCase();
  // no podcast (Transcendendo) a wiki só lista os convidados: vale o elenco de personagens de todas as temporadas
  const texto = /transcend/.test(tit) ? Object.entries(gloWiki).filter(([k]) => !/transcend/.test(k)).map(([, g]) => g.texto || "").join("\n") : gloWiki[tit]?.texto || "", mapa = new Map();
  for (const l of texto.split("\n")) {
    const [g, resto] = [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1)];
    if (!resto || /^(campanha|mestre|elenco|irlanda|locais|lugares)/i.test(g)) continue;
    const itens = /^jogadores/i.test(g) ? resto.split(";").map(x => x.split(/ joga /)[1] || "").flatMap(x => x.split(/\/|,| e /)) : resto.split(",");
    for (let n of itens) {
      n = n.replace(/\(.*?\)|".*?"|\.$/g, "").trim();
      // só nome próprio curto ("Arthur Cervero", "Ana Delgado dos Santos"); descrições da wiki ficam de fora
      if (n.length < 3 || !/^[A-ZÀ-Ý][\wÀ-ÿ'-]*(?: (?:de|da|do|dos|das|[A-ZÀ-Ý][\wÀ-ÿ'-]*)){0,3}$/.test(n)) continue;
      if (!mapa.has(n.toLowerCase())) mapa.set(n.toLowerCase(), n);
      const pri = n.split(/\s+/)[0].toLowerCase();
      if (pri.length >= 3 && !PARADAS.has(pri) && !mapa.has(pri)) mapa.set(pri, n);
    }
  }
  return mapa;
}
const chatCache = new Map(); // id -> { tam, q, msgs: [[t, u, palavras]], media }
function reacoesChat(id) {
  const arq = path.join(CHATLOG, id.replace(/[^\w-]/g, "_") + ".jsonl");
  let tam; try { tam = fs.statSync(arq).size; } catch { return null; }
  let c = chatCache.get(id);
  // durante a live o arquivo cresce: relê no máximo a cada 30 s
  if (!c || (c.tam !== tam && Date.now() - c.q > 30_000)) {
    const msgs = [];
    for (const l of fs.readFileSync(arq, "utf8").split("\n")) {
      if (!l) continue;
      let m; try { m = JSON.parse(l); } catch { continue; }
      const palavras = new Set();
      for (let w of String(m.t).split(/\s+/)) {
        // emote conhecido (Twitch, 7TV, BTTV, FFZ) entra com o nome exato, mesmo sem maiúscula no meio (ex.: "D:", "catjam")
        if (emotesCache.mapa[w]) { palavras.add(w); continue; }
        w = w.replace(/^:|:$/g, "").replace(/[!?.,;"'()]+/g, "");
        if (!w || w.length < 2 || /^https?:/i.test(w) || /^\d+$/.test(w)) continue;
        if (RISADA.test(w)) { palavras.add("KKKK"); continue; }
        if (PARADAS.has(w.toLowerCase())) continue;
        // emote (tem maiúscula no meio, ex.: cellbitHype) fica como está; palavra comum vira maiúscula
        palavras.add(/[a-z][A-Z]/.test(w) ? w : w.toUpperCase());
      }
      msgs.push([new Date(m.q).getTime(), m.u, [...palavras]]);
    }
    const dur = msgs.length > 1 ? (msgs.at(-1)[0] - msgs[0][0]) / 60000 : 0;
    c = { tam, q: Date.now(), msgs, media: dur > 0 ? msgs.length / dur : 0 };
    chatCache.set(id, c);
  }
  if (c.msgs.length < 100 || !c.media) return null;
  return quando => {
    const t = new Date(quando).getTime(), ini = t - 30_000, fim = t + 90_000;
    const trecho = c.msgs.filter(([q]) => q >= ini && q < fim);
    if (!trecho.length) return null;
    const conta = new Map();
    for (const [, u, ps] of trecho) for (const p of ps) { const s = conta.get(p) || new Set(); s.add(u); conta.set(p, s); }
    const top = [...conta].map(([p, s]) => [p, s.size]).filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([p, n]) => ({ p, n }));
    return { porMin: Math.round(trecho.length / 2), ritmo: Math.round(trecho.length / 2 / c.media * 10) / 10, top };
  };
}

// ---------- gravação durante a live (público, sem login) ----------
// áudio em partes de 30 min e uma captura a cada 30 s; cada parte pronta vai pro Gemini, que devolve os momentos como rascunho
const { spawn, execFile, execFileSync } = require("child_process");
// capturas que não mostram a live: a tela de intervalo comercial da Twitch (quem assiste sem login recebe ela no lugar da live)
// e quadros pretos ou lisos. Compara uma miniatura 16x9 com a tela de referência em ref/twitch-intervalo.jpg
const miniatura = f => { try { return execFileSync("ffmpeg", ["-v", "error", "-i", f, "-vf", "scale=16:9", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"]); } catch { return null; } };
let refIntervalo;
function foraDaLive(f) {
  const b = miniatura(f);
  if (!b) return true;
  if (Math.max(...b) - Math.min(...b) < 16) return true; // preto ou liso
  // a tela de comercial da Twitch é um degradê roxo/azul, às vezes claro, às vezes escuro: conta os pontos com azul bem acima do verde.
  // no Transcendendo: cenas da live de 0% a 14%, telas de comercial de 53% a 100%
  let azul = 0; for (let i = 0; i < b.length; i += 3) if (b[i + 2] > b[i + 1] + 35) azul++;
  if (azul / (b.length / 3) >= .4) return true;
  refIntervalo ??= miniatura(path.join(__dirname, "ref", "twitch-intervalo.jpg"));
  if (!refIntervalo || refIntervalo.length !== b.length) return false;
  let d = 0; for (let i = 0; i < b.length; i++) d += Math.abs(b[i] - refIntervalo[i]);
  return d / b.length < 10;
}
const GRAVACAO = path.join(DADOS, "gravacao");
const PARTE_MIN = 30;
let gravando = null; // { id, proc }
const hora14 = d => d.toISOString().replace(/[-:]/g, "").slice(0, 15); // 20261107T210000
const deHora14 = s => new Date(s.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)$/, "$1-$2-$3T$4:$5:$6Z"));
function gravacao() {
  const id = atual.episodio && atual.total > 0 && /^[\w-]{11}$/.test(atual.episodio) ? atual.episodio : null;
  if (gravando && gravando.id !== id) { gravando.proc.kill("SIGINT"); gravando = null; }
  if (!id || gravando || env.GRAVACAO !== "1") return;
  const dir = path.join(GRAVACAO, id);
  fs.mkdirSync(path.join(dir, "capturas"), { recursive: true });
  // pega o endereço da transmissão pública da mesma live (o YouTube pede login para servidores de nuvem):
  // primeiro a Kick, que não põe comercial no meio pra quem assiste; se ela não abrir, a Twitch (que para quem não tem conta troca a live por comercial)
  // o endereço expira em algumas horas: quando cai, a próxima volta do tick recomeça
  const endereco = (pagina, ok) => execFile("nice", ["-n", "15", "yt-dlp", "-g", "-f", "best[height<=480]/worst", pagina], { timeout: 60_000 }, (erro, saida) => {
    const url = String(saida || "").trim().split("\n")[0]; ok(!erro && url.startsWith("http") ? url : null, erro);
  });
  const grava = (url, fonte) => {
    // decodifica só os quadros-chave (uma captura a cada 30 s não precisa de todos) e roda com prioridade baixa, pra não tirar processador do site
    const proc = spawn("nice", ["-n", "15", "ffmpeg", "-v", "error", "-threads", "1", "-skip_frame:v", "nokey", "-i", url,
      "-map", "0:a", "-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", "24k", "-f", "segment", "-segment_time", String(PARTE_MIN * 60), "-reset_timestamps", "1", "-strftime", "1", path.join(dir, "audio-%Y%m%dT%H%M%S.ogg"),
      "-map", "0:v", "-vf", "fps=1/30,scale=854:-2", "-q:v", "4", "-f", "image2", "-strftime", "1", path.join(dir, "capturas", "%Y%m%dT%H%M%S.jpg")], { stdio: ["ignore", "ignore", "pipe"] });
    proc.stderr.on("data", d => console.warn("ffmpeg:", String(d).trim().slice(0, 200)));
    proc.on("exit", () => { if (gravando?.proc === proc) gravando = null; });
    gravando = { id, proc };
    marca("Gravação", true, "gravando áudio e capturas da " + fonte);
    console.log("gravação: começou", id, "pela", fonte);
  };
  endereco("https://kick.com/" + KICK, urlKick => urlKick ? grava(urlKick, "Kick") : endereco("https://www.twitch.tv/" + TWITCH, (url, erro) => {
    if (!url) { marca("Gravação", false, "não abriu a live nem na Kick nem na Twitch: " + (erro?.message || "sem endereço")); console.warn("gravação: sem endereço da live", erro?.message || ""); gravando = null; return; }
    grava(url, "Twitch");
  }));
  gravando = { id, proc: { kill() {} } }; // reserva enquanto o yt-dlp responde
}

const GEMINI = "https://generativelanguage.googleapis.com";
// o tipo de live muda pela temporada; o título da live diz quem está nela (ex.: "Transcendendo com LJoga: Grifo, Leo Santi e Nayu")
const tipoLive = (ep = {}) => {
  const titulo = String(ep.titulo || "").replace(/\s*\|.*$/, "");
  if (/transcend/i.test(ep.temporada || titulo)) return `um episódio do Transcendendo, o podcast oficial de Ordem Paranormal.
Como é o programa: é uma conversa, não uma sessão de RPG; ninguém está jogando nem narrando. Quem apresenta é o LJoga, que conduz o papo e lê perguntas do chat. Os convidados mudam a cada episódio e geralmente estão no título da live. Eles falam dos bastidores, dos personagens que interpretam, do episódio de RPG que foi ao ar, respondem perguntas e às vezes jogam quizzes ou brincadeiras.
O Cellbit é o criador de Ordem Paranormal e mestre das campanhas de RPG, mas nem sempre está no Transcendendo; só diga que ele falou se a fala for claramente dele.
Título desta live: "${titulo}". Trate os nomes do título como os participantes e os personagens citados como personagens da campanha, não como pessoas presentes`;
  return `uma live de RPG de mesa da série Ordem Paranormal, narrada pelo Cellbit (o mestre) com jogadores convidados que interpretam personagens${titulo ? `. Título desta live: "${titulo}"` : ""}`;
};
const PEDIDO_MOMENTOS = `Este é um trecho de áudio de TIPO_LIVE.
Liste os principais acontecimentos deste trecho: momentos da história ou da conversa (revelações, combates, mortes, decisões, assuntos marcantes, perguntas respondidas) e momentos da mesa (piadas que todos riram, pausas, intervalo, abertura e encerramento).
Para cada um, informe o segundo deste trecho em que começa, um título curto (até 8 palavras, sem ponto final) e uma frase de contexto (até 25 palavras), em português padrão, com acentos, vírgulas e ponto final.
Seja factual: use só nomes de pessoas, personagens e lugares que foram ditos claramente. Não invente.
Quase toda live começa com uma contagem regressiva (timer) de alguns minutos, às vezes mais de uma seguida, só com música e sem ninguém falando; a conversa ou a sessão só começa depois.
Trechos só com música, vinheta, timer ou contagem regressiva viram no máximo um momento ("Contagem para o início", "Abertura" ou "Intervalo"); ignore letras de música e não trate o que toca na música como fala de alguém.
Cada momento resume um BLOCO de 5 a 10 minutos: o assunto principal daquele bloco e o que aconteceu de mais marcante nele, como um capítulo. Não crie um momento para cada fala ou frase; junte as falas do mesmo assunto num só.
O "segundo" é onde o bloco começa. O contexto conta o que rolou no bloco todo, não só a primeira frase. Não repita momentos parecidos.
Num trecho de 30 minutos, gere de 3 a 6 momentos.
Exceção: marcos e anúncios (recorde de espectadores, número de inscritos ou seguidores alcançado, novidade anunciada, convidado surpresa, data do próximo episódio) SEMPRE viram um momento próprio, mesmo curto e no meio de outro assunto.
Use o chat como pista: quando muita gente manda a mesma coisa ao mesmo tempo (ex.: "(30 pessoas)"), algo aconteceu ali; procure na fala o que foi e, se for um marco ou algo marcante, crie o momento.`;
const ESQUEMA_MOMENTOS = { type: "ARRAY", items: { type: "OBJECT", properties: {
  segundo: { type: "INTEGER" }, titulo: { type: "STRING" }, contexto: { type: "STRING" }, tipo: { type: "STRING", enum: ["historia", "mesa"] }, chat: { type: "STRING" } },
  required: ["segundo", "titulo", "contexto", "tipo"] } };
// mensagens do chat no trecho do áudio, pra o Gemini resumir o que o chat falava em cada momento (no mesmo pedido, sem gastar cota a mais)
// "segundo texto" por linha; se passar de 3000 mensagens, pega uma amostra espalhada pelo trecho
function chatDoTrecho(id, inicio, segundos) {
  let linhas; try { linhas = fs.readFileSync(path.join(CHATLOG, id.replace(/[^\w-]/g, "_") + ".jsonl"), "utf8").split("\n"); } catch { return ""; }
  const t0 = inicio.getTime(), t1 = t0 + segundos * 1000, l = [];
  // limpa o chat: emote repetido vira "cellClap x5", "kkkkkkk" vira "kkk", e a mesma mensagem dentro de 10 s entra uma vez só com quantas vezes apareceu
  const vistos = new Map();
  for (const s of linhas) {
    if (!s) continue;
    let m; try { m = JSON.parse(s); } catch { continue; }
    const t = new Date(m.q).getTime();
    if (t < t0 || t >= t1) continue;
    const txt = String(m.t).replace(/\s+/g, " ").replace(/\b([kK]{3})[kK]+\b/g, "$1").replace(/(\S+)( \1)+/g, (a, e) => e + " x" + a.split(" ").length).slice(0, 120).trim();
    if (!txt) continue;
    const seg = Math.round((t - t0) / 1000), chave = Math.floor(seg / 10) + "|" + txt.toLowerCase();
    if (vistos.has(chave)) { vistos.get(chave).n++; continue; }
    const item = { seg, txt, n: 1 }; vistos.set(chave, item); l.push(item);
  }
  const passo = Math.max(1, l.length / 3000);
  return Array.from({ length: Math.min(l.length, 3000) }, (_, i) => l[Math.floor(i * passo)]).map(x => x.seg + " " + x.txt + (x.n > 1 ? ` (${x.n} pessoas)` : "")).join("\n");
}
// o que cada emote do canal mostra (ref/emotes.json, feito olhando as imagens), só dos que aparecem no trecho
let EMOTES; try { EMOTES = JSON.parse(fs.readFileSync(path.join(__dirname, "ref", "emotes.json"), "utf8")); } catch { EMOTES = {}; }
const emotesDoChat = chat => { const usados = Object.keys(EMOTES).filter(e => chat.includes(e)); return usados.length ? "Significado dos emotes (o chat se expressa muito por eles):\n" + usados.map(e => e + " = " + EMOTES[e]).join("\n") + "\n" : ""; };
const PEDIDO_CHAT = `
Abaixo estão mensagens do chat da live neste mesmo trecho (cada linha: segundo do trecho e o texto; "x5" é o emote repetido 5 vezes e "(12 pessoas)" é a mesma mensagem mandada por 12 pessoas).
Para cada momento, preencha "chat" com uma frase de 8 a 18 palavras que COMEÇA com "O chat" e diz como ele reagiu durante aquele bloco: a emoção principal (rindo, aplaudindo, com medo, revoltado, emocionado, surpreso, especulando teorias, fazendo perguntas) MAIS do que estavam falando, tirado das mensagens daquele bloco (um nome, uma piada, uma pergunta que se repetiu).
Escreva com as suas palavras a partir das mensagens reais; não use frases prontas nem invente pedidos ou piadas que não aparecem nas mensagens. Uma palavra solta (como "carinho") não serve.
Use os significados dos emotes para entender a emoção, mas não escreva o nome dos emotes. Não cite quem escreveu. Deixe "chat" vazio só se quase não houver mensagens no bloco.
EMOTES_DO_TRECHO
Mensagens do chat:
`;
async function geminiAudio(arq, chat = "", ep = {}) {
  const k = { "x-goog-api-key": env.GEMINI_API_KEY };
  const tam = fs.statSync(arq).size;
  const ini = await fetch(`${GEMINI}/upload/v1beta/files`, { method: "POST", headers: { ...k, "X-Goog-Upload-Protocol": "resumable", "X-Goog-Upload-Command": "start",
    "X-Goog-Upload-Header-Content-Length": tam, "X-Goog-Upload-Header-Content-Type": "audio/ogg", "Content-Type": "application/json" }, body: JSON.stringify({ file: { display_name: path.basename(arq) } }) });
  const up = await fetch(ini.headers.get("x-goog-upload-url"), { method: "POST", headers: { "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" }, body: fs.readFileSync(arq) });
  let f = (await up.json()).file;
  while (f?.state === "PROCESSING") { await new Promise(r => setTimeout(r, 5000)); f = await (await fetch(`${GEMINI}/v1beta/${f.name}`, { headers: k })).json(); }
  if (f?.state !== "ACTIVE") throw new Error("gemini: arquivo não ficou pronto");
  const corpo = JSON.stringify({ contents: [{ parts: [{ fileData: { fileUri: f.uri, mimeType: f.mimeType } }, { text: PEDIDO_MOMENTOS.replace("TIPO_LIVE", tipoLive(ep)) + (glossario() ? "\nUse exatamente a grafia oficial destes nomes (o áudio pode soar diferente):\n" + glossario() : "") + (chat ? PEDIDO_CHAT.replace("EMOTES_DO_TRECHO", emotesDoChat(chat)) + chat : "") }] }], generationConfig: { responseMimeType: "application/json", responseSchema: ESQUEMA_MOMENTOS } });
  // só o modelo principal; um reserva (GEMINI_RESERVA) entra só se for definido no .env, porque os resumos dele são piores
  let j;
  for (const modelo of [env.GEMINI_MODELO || "gemini-3.8-flash", env.GEMINI_RESERVA].filter(Boolean)) {
    // sobrecarga costuma passar em segundos: tenta de novo com o mesmo arquivo já enviado (30 s, 1 min, 2 min) antes de desistir por 15 min
    for (const espera of [30, 60, 120, 0]) {
      j = await fetch(`${GEMINI}/v1beta/models/${modelo}:generateContent`, { method: "POST", headers: { ...k, "Content-Type": "application/json" }, body: corpo })
        .then(r => r.json()).catch(e => ({ error: { code: 503, message: e.cause?.code || e.message } }));
      const sobrecarga = j.error && (j.error.code === 503 || j.error.code === 500 || /high demand|overloaded|unavailable/i.test(j.error.message));
      if (!sobrecarga || !espera) break;
      await new Promise(r => setTimeout(r, espera * 1000));
    }
    if (j.error?.code !== 429) break;
  }
  fetch(`${GEMINI}/v1beta/${f.name}`, { method: "DELETE", headers: k }).catch(() => {});
  if (j.error) throw Object.assign(new Error("gemini: " + j.error.message), { codigo: j.error.code });
  return JSON.parse(j.candidates[0].content.parts[0].text);
}
// reserva do Gemini pelo Groq (plano grátis): o Whisper transcreve com o segundo de cada fala e o GPT-OSS 120B tira os momentos do texto
// https://console.groq.com/docs — limites do grátis: ~8 h de áudio e ~100 mil tokens por dia, por isso o chat vai numa amostra menor
const GROQ = "https://api.groq.com/openai/v1";
async function groqAudio(arq, chat = "", ep = {}) {
  const h = { Authorization: "Bearer " + env.GROQ_API_KEY };
  // a transcrição fica guardada do lado do áudio: se o resumo falhar, a nova tentativa não gasta de novo o limite de áudio por hora
  const guardada = arq.replace(/\.ogg$/, ".transcricao.json");
  let tr; try { tr = JSON.parse(fs.readFileSync(guardada, "utf8")); } catch {}
  if (!tr) {
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(arq)], { type: "audio/ogg" }), path.basename(arq));
  form.append("model", env.GROQ_TRANSCRICAO || "whisper-large-v3");
  form.append("language", "pt"); form.append("response_format", "verbose_json");
  tr = await fetch(`${GROQ}/audio/transcriptions`, { method: "POST", headers: h, body: form }).then(r => r.json()).catch(e => ({ error: { code: 503, message: e.message } }));
  if (tr.error) throw Object.assign(new Error("groq: " + (tr.error.message || tr.error)), { codigo: tr.error.code === "rate_limit_exceeded" ? 429 : tr.error.code });
  fs.writeFileSync(guardada, JSON.stringify({ segments: (tr.segments || []).map(s => ({ start: s.start, text: s.text })) }));
  }
  const falas = (tr.segments || []).map(s => [Math.round(s.start), s.text.trim()]).filter(f => f[1]);
  if (!falas.length) return [];
  // o grátis aceita ~8 mil tokens por minuto (pedido + resposta): a transcrição vai em pedaços de ~8 mil letras, cada um com o chat do mesmo trecho, e 65 s entre eles
  const chatL = (chat ? chat.split("\n") : []).map(l => [+l.split(" ")[0], l]);
  const pedacos = []; let atual = [], tam = 0;
  for (const f of falas) { if (tam > 8000) { pedacos.push(atual); atual = []; tam = 0; } atual.push(f); tam += f[1].length + 6; }
  if (atual.length) pedacos.push(atual);
  const glos = glossario();
  const todos = [];
  for (const [i, p] of pedacos.entries()) {
    if (i) await new Promise(r => setTimeout(r, 65_000));
    const de = p[0][0], ate = pedacos[i + 1]?.[0][0] ?? Infinity;
    const doTrecho = chatL.filter(([s]) => s >= de && s < ate), passo = Math.max(1, doTrecho.length / 60);
    const amostra = Array.from({ length: Math.min(doTrecho.length, 60) }, (_, k) => doTrecho[Math.floor(k * passo)][1]).join("\n");
    const pedido = PEDIDO_MOMENTOS.replace("TIPO_LIVE", tipoLive(ep)).replace("Este é um trecho de áudio", "Esta é a transcrição de um trecho de áudio (cada linha: segundo do trecho e a fala)")
      + (glos ? "\nUse exatamente a grafia oficial destes nomes (a transcrição pode ter errado):\n" + glos : "")
      + (amostra ? PEDIDO_CHAT.replace("EMOTES_DO_TRECHO", emotesDoChat(amostra)) + amostra : "")
      + `\nEste pedaço da transcrição tem cerca de ${Math.max(1, Math.round(((pedacos[i + 1]?.[0][0] ?? p.at(-1)[0]) - de) / 60))} minutos: gere no máximo ${Math.max(1, Math.round(((pedacos[i + 1]?.[0][0] ?? p.at(-1)[0]) - de) / 60 / 6))} momento(s), cada um resumindo um bloco de 5 a 10 minutos.`
      + `\nResponda só com JSON no formato {"momentos":[{"segundo":0,"titulo":"","contexto":"","tipo":"historia ou mesa","chat":""}]}.\nTranscrição:\n` + p.map(f => f[0] + " " + f[1]).join("\n");
    // se o modelo devolver um JSON quebrado, tenta mais uma vez sem o modo JSON e tira o objeto do texto
    let lista = null;
    for (const modoJson of [true, false]) {
      if (!modoJson) await new Promise(r => setTimeout(r, 65_000));
      const j = await fetch(`${GROQ}/chat/completions`, { method: "POST", headers: { ...h, "Content-Type": "application/json" },
        body: JSON.stringify({ model: env.GROQ_MODELO || "openai/gpt-oss-120b", temperature: .3, reasoning_effort: "low", max_completion_tokens: 2500, ...(modoJson ? { response_format: { type: "json_object" } } : {}), messages: [{ role: "user", content: pedido }] }) })
        .then(r => r.json()).catch(e => ({ error: { code: 503, message: e.message } }));
      if (j.error && !/json/i.test(j.error.message || "")) throw Object.assign(new Error("groq: " + (j.error.message || j.error)), { codigo: j.error.code === "rate_limit_exceeded" ? 429 : j.error.code });
      try { const t = j.choices[0].message.content; lista = JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1)).momentos || []; break; } catch { console.warn("groq: JSON quebrado no pedaço " + (i + 1) + (modoJson ? ", tentando de novo" : ", pulando")); }
    }
    todos.push(...(lista || []));
  }
  return todos;
}
// Gemini primeiro (ouve o áudio direto); se estiver sobrecarregado ou sem cota e houver GROQ_API_KEY, o Groq faz a mesma parte
async function analisaAudio(arq, chat, ep) {
  // ANALISE=groq no .env pula o Gemini (pra comparar a qualidade no computador)
  if (env.ANALISE === "groq" && env.GROQ_API_KEY) return { lista: await groqAudio(arq, chat, ep), ia: "Groq" };
  try { return { lista: await geminiAudio(arq, chat, ep), ia: "Gemini" }; }
  catch (e) {
    const passa = e.codigo === 429 || e.codigo === 503 || e.codigo === 500 || /high demand|overloaded|unavailable/i.test(e.message);
    if (!env.GROQ_API_KEY || !passa) throw e;
    console.warn(e.message, "; usando o Groq");
    return { lista: await groqAudio(arq, chat, ep), ia: "Groq" };
  }
}
// frase de resumo no português padrão: maiúscula no começo e ponto no fim (a IA às vezes esquece)
const ponto = s => { s = String(s || "").trim().replace(/\s+/g, " "); if (!s) return s; s = s[0].toUpperCase() + s.slice(1); return /[.!?…]$/.test(s) ? s : s.replace(/[,;:]$/, "") + "."; };
// a cada 2 min: partes de áudio completas viram momentos (rascunho) com a captura mais próxima
let analisando = false, pausaAte = 0;
async function analisaPartes() {
  if (analisando || Date.now() < pausaAte || !env.GEMINI_API_KEY || !fs.existsSync(GRAVACAO)) return;
  analisando = true;
  try {
    for (const id of fs.readdirSync(GRAVACAO)) {
      const dir = path.join(GRAVACAO, id);
      const partes = fs.readdirSync(dir).filter(f => /^audio-\d{8}T\d{6}\.ogg$/.test(f)).sort();
      // enquanto grava, a última parte ainda está sendo escrita
      const prontas = gravando?.id === id ? partes.slice(0, -1) : partes;
      for (const p of prontas) {
        const inicio = deHora14(p.slice(6, 21));
        const { lista, ia } = await analisaAudio(path.join(dir, p), chatDoTrecho(id, inicio, PARTE_MIN * 60), { temporada: records[id]?.temporada || episodios.lista.find(e => e.id === id)?.temporada, titulo: records[id]?.titulo });
        const caps = fs.readdirSync(path.join(dir, "capturas")).filter(f => f.endsWith(".jpg")).map(f => ({ f, t: deHora14(f.slice(0, 15)).getTime() }));
        const novos = lista.map(m => {
          const t = inicio.getTime() + Math.max(0, Math.min(PARTE_MIN * 60, Number(m.segundo) || 0)) * 1000;
          // a captura de live mais perto do momento (primeiro as de depois, depois as de antes), pulando intervalo comercial e tela preta
          const depois = caps.filter(c => c.t >= t).sort((a, b) => a.t - b.t), antes = caps.filter(c => c.t < t).sort((a, b) => b.t - a.t);
          const cap = [...depois.slice(0, 20), ...antes.slice(0, 20)].find(c => !foraDaLive(path.join(dir, "capturas", c.f)));
          let captura = null;
          if (cap) { captura = cap.f; fs.mkdirSync(path.join(MOMENTOS, id, "capturas"), { recursive: true }); fs.copyFileSync(path.join(dir, "capturas", cap.f), path.join(MOMENTOS, id, "capturas", cap.f)); }
          return { quando: new Date(t).toISOString(), titulo: String(m.titulo).replace(/\.$/, "").slice(0, 80), contexto: ponto(m.contexto).slice(0, 240), tipo: m.tipo === "mesa" ? "mesa" : "historia", captura, chatResumo: m.chat ? ponto(m.chat).slice(0, 160) : undefined, ia, aprovado: false, seg: (t - inicio.getTime()) / 1000 };
        });
        // trecho de 1 min do áudio de cada momento (5 s antes até 55 s depois), pra ouvir no painel e conferir o resumo
        fs.mkdirSync(path.join(MOMENTOS, id, "audio"), { recursive: true });
        for (const m of novos) {
          const nome = hora14(new Date(m.quando)) + ".ogg";
          await new Promise(ok => execFile("ffmpeg", ["-v", "error", "-y", "-ss", String(Math.max(0, m.seg - 5)), "-t", "60", "-i", path.join(dir, p), "-c:a", "copy", path.join(MOMENTOS, id, "audio", nome)], () => ok()));
          if (fs.existsSync(path.join(MOMENTOS, id, "audio", nome))) m.audio = nome;
          delete m.seg;
        }
        salvaMomentos(id, [...leMomentos(id), ...novos].sort((a, b) => a.quando.localeCompare(b.quando)));
        fs.unlinkSync(path.join(dir, p)); fs.rmSync(path.join(dir, p.replace(/\.ogg$/, ".transcricao.json")), { force: true });
        console.log("momentos:", id, p, novos.length);
        marca("Gemini", true, novos.length + " momentos novos em rascunho" + (ia !== "Gemini" ? ", feitos pelo " + ia : ""));
      }
      // live acabou e tudo analisado: apaga o que sobrou da gravação
      if (gravando?.id !== id && !fs.readdirSync(dir).some(f => f.endsWith(".ogg"))) fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch (e) {
    // cota gratuita acabou: as partes ficam guardadas e a análise tenta de novo de hora em hora até a cota renovar
    // Gemini sobrecarregado (503/500): cada tentativa gasta da cota do dia, então espera 15 min em vez de tentar a cada 2 min
    const sobrecarga = e.codigo === 503 || e.codigo === 500 || /high demand|overloaded|unavailable/i.test(e.message);
    // o Groq diz quanto esperar ("try again in 8m3s"); sem isso, espera 1 h como no Gemini
    const espera = String(e.message).match(/try again in (?:(\d+)h)?(?:(\d+)m)?([\d.]+)s/i);
    if (e.codigo === 429) pausaAte = Date.now() + (espera ? ((+espera[1] || 0) * 3600 + (+espera[2] || 0) * 60 + +espera[3] + 20) * 1000 : 3600e3);
    else if (sobrecarga) pausaAte = Date.now() + 15 * 60e3;
    marca("Gemini", false, e.codigo === 429 ? "cota gratuita do dia esgotada; tenta de novo de hora em hora" : sobrecarga ? "Gemini sobrecarregado; tenta de novo em 15 min" : e.message);
    console.warn(e.message);
  }
  analisando = false;
}
setInterval(analisaPartes, 120_000);

// relatório da aba Status
function status() {
  const os = require("os");
  const partes = fs.existsSync(GRAVACAO) ? fs.readdirSync(GRAVACAO).flatMap(id => fs.readdirSync(path.join(GRAVACAO, id)).filter(f => f.endsWith(".ogg")).map(f => id + "/" + f)) : [];
  const capturas = gravando ? (() => { try { return fs.readdirSync(path.join(GRAVACAO, gravando.id, "capturas")).sort(); } catch { return []; } })() : [];
  const itens = { ...estado };
  if (!gravando) itens["Gravação"] = { ok: env.GRAVACAO === "1" ? null : null, info: env.GRAVACAO === "1" ? "ligada; começa sozinha quando um episódio entrar no ar" : "desligada (GRAVACAO=0)", quando: Date.now() };
  else if (capturas.length) itens["Gravação"] = { ...itens["Gravação"], info: `gravando, ${capturas.length} capturas, última às ${deHora14(capturas.at(-1).slice(0, 15)).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo" })}` };
  if (!itens["Gemini"]) itens["Gemini"] = { ok: env.GEMINI_API_KEY ? null : false, info: env.GEMINI_API_KEY ? "nenhuma análise feita desde que o servidor ligou" : "sem GEMINI_API_KEY", quando: Date.now() };
  if (partes.length) itens["Gemini"] = { ...itens["Gemini"], info: (itens["Gemini"].info ? itens["Gemini"].info + ", " : "") + partes.length + (partes.length > 1 ? " partes" : " parte") + " de áudio esperando análise" + (pausaAte > Date.now() ? " (próxima tentativa às " + new Date(pausaAte).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" }) + ")" : "") };
  if (!itens["Chat do YouTube"]) itens["Chat do YouTube"] = { ok: null, info: "só lê com o episódio no ar", quando: Date.now() };
  for (const [p, nome] of [["twitch", "Chat da Twitch"], ["kick", "Chat da Kick"], ["youtube", "Chat do YouTube"]]) if (itens[nome] && ultimaMsg[p]) itens[nome] = { ...itens[nome], ultimaMsg: ultimaMsg[p] };
  let disco = null; try { const d = fs.statfsSync(DADOS); disco = { livre: d.bavail * d.bsize, total: d.blocks * d.bsize }; } catch {}
  return {
    agora: Date.now(), episodio: atual.episodio || null, aoVivo: !!(atual.episodio && atual.total > 0), total: atual.total || 0,
    itens: Object.entries(itens).map(([nome, v]) => ({ nome, ...v })),
    servidor: { ligadoHa: process.uptime() * 1000, memoriaLivre: os.freemem(), memoriaTotal: os.totalmem(), disco },
    // quem usa o site: agora, hoje e desde o começo (pico = mais pessoas ao mesmo tempo, medido a cada minuto)
    publico: (() => {
      const dias = [...ac.historico, { dia: ac.dia, unicos: unicosHoje.size, views: ac.views, pico: Math.max(ac.pico, onlineAgora()) }];
      const maior = dias.reduce((m, d) => (d.pico || 0) > (m.pico || 0) ? d : m, dias[0]);
      return { online: onlineAgora(), picoHoje: Math.max(ac.pico, onlineAgora()), picoGeral: maior.pico || 0, picoGeralDia: maior.dia,
        unicosHoje: unicosHoje.size, visitasHoje: ac.views, visitasTotal: dias.reduce((t, d) => t + (d.views || 0), 0),
        mediaDia: Math.round(dias.reduce((t, d) => t + (d.unicos || 0), 0) / dias.length) };
    })(),
  };
}

// ---------- prévia do link (X, WhatsApp, Discord) ----------
// a imagem é a mesma do "Compartilhar", gerada pela página do episódio a pedido do painel
const SITE = env.SITE_URL || "https://ordemtracker.site";
const PREVIAS = path.join(DADOS, "previas");
fs.mkdirSync(PREVIAS, { recursive: true });
const previaTokens = new Map(); // token -> { id, ate }
async function recebePrevia(req, res, url) {
  const t = previaTokens.get(url.searchParams.get("token") || "");
  if (!t || t.ate < Date.now()) return json(res, 403, { erro: "Link expirado. Gere de novo pelo painel." });
  const partes = []; let tam = 0;
  for await (const c of req) { tam += c.length; if (tam > 4e6) return json(res, 413, { erro: "Imagem grande demais." }); partes.push(c); }
  const png = Buffer.concat(partes);
  if (png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return json(res, 400, { erro: "Não é PNG." });
  previaTokens.delete(url.searchParams.get("token"));
  fs.writeFileSync(path.join(PREVIAS, t.id + ".png"), png);
  json(res, 200, { ok: true });
}
const attr = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// ---------- painel da temporada ----------
// por episódio: números do painel + horas assistidas, curva resumida (até 48 pontos) e divisão por plataforma no pico
const temporadaCache = { chave: "", dados: null };
function resumoEps() {
  const pub = publicos();
  const chave = histCache.chave + ":" + Object.values(pub).map(r => r.ultimaLeitura + r.recorde).join();
  if (temporadaCache.chave === chave && temporadaCache.dados) return temporadaCache.dados;
  const eps = Object.entries(pub).filter(([, r]) => r.temporada && (r.inicioLive || r.inicio)).map(([id, r]) => {
    const h = histDe(id), e = episodios.lista.find(x => x.id === id) || {};
    let soma = 0;
    for (let i = 0; i < h.length - 1; i++) { const dt = Math.min(15 * 60e3, Date.parse(h[i + 1][0]) - Date.parse(h[i][0])); soma += (h[i][4] || 0) * dt; }
    const passo = Math.max(1, Math.ceil(h.length / 48));
    const curva = h.filter((_, i) => i % passo === 0).map(x => x[4] || 0);
    const ini = r.inicioLive || r.inicio, fim = r.fimLive || r.ultimaLeitura;
    const rotulo = (e.titulo || r.titulo || "").replace(/\s*\|.*$/, "").replace(new RegExp("^" + r.temporada.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*-\\s*", "i"), "").replace(/^EPIS[ÓO]DIO/i, "Episódio");
    return { id, slug: r.slug, rotulo: rotulo.replace(/^Episódio\s+(\d+).*$/i, "Episódio $1"), nome: r.nome, temporada: r.temporada, data: ini,
      pico: r.recorde, quando: r.quando, media: r.media, duracaoMin: fim ? Math.round((Date.parse(fim) - Date.parse(ini)) / 60e3) : null,
      horas: soma ? Math.round(soma / 3600e3) : null, picos: r.picos || null,
      noPico: { youtube: r.youtube, twitch: r.twitch, kick: r.kick, tiktok: r.tiktok },
      segTwitch: r.twitchSegInicio && r.twitchSegFim ? r.twitchSegFim - r.twitchSegInicio : null,
      chatMsgs: r.chatMsgs || null, chatPessoas: r.chatPessoas || null, vods: r.vods || null, videosYT: r.videosYT || null, video: r.video || null, curva };
  }).sort((a, b) => a.data.localeCompare(b.data));
  return (temporadaCache.chave = chave, temporadaCache.dados = eps);
}
function temporadaApi(t) {
  const eps = resumoEps(), por = new Map();
  for (const e of eps) { const k = kebab(e.temporada); if (!por.has(k)) por.set(k, []); por.get(k).push(e); }
  const soma = (l, k) => l.reduce((a, e) => a + (e[k] || 0), 0);
  const resumo = (k, l) => ({ slug: k, nome: l[0].temporada, ano: l[0].data.slice(0, 4), fimAno: l.at(-1).data.slice(0, 4), eps: l.length,
    pico: Math.max(...l.map(e => e.pico || 0)), media: Math.round(soma(l, "media") / l.length), horas: soma(l, "horas"),
    capa: l[0].id, plataformas: [...new Set(l.flatMap(e => Object.entries(e.picos || {}).filter(([, v]) => v > 0).map(([p]) => p)))] });
  // o Transcendendo (podcast) não entra na comparação entre temporadas
  const todas = [...por].filter(([k]) => k === t || !/transcend/.test(k)).map(([k, l]) => resumo(k, l)).sort((a, b) => a.ano.localeCompare(b.ano) || a.nome.localeCompare(b.nome));
  const l = por.get(t);
  if (!l) return null;
  return { temporada: resumo(t, l), episodios: l, todas };
}

function og(caminho) {
  const pub = publicos();
  const tp = caminho.match(/^\/temporada\/([\w-]+)/)?.[1];
  if (tp) {
    const d = temporadaApi(tp);
    const tit = d ? `${d.temporada.nome}: painel da temporada | Ordem Tracker` : "Ordem Tracker";
    const ds = d ? `${d.temporada.eps} episódios, pico de ${d.temporada.pico.toLocaleString("pt-BR")} pessoas ao vivo. Audiência de cada episódio de ${d.temporada.nome}.` : "";
    return [["og:type", "website"], ["og:site_name", "Ordem Tracker"], ["og:title", tit], ["og:description", ds], ["og:url", SITE + caminho], ["og:image", d ? `${SITE}/capa/${d.temporada.capa}.jpg` : `${SITE}/rn-branco.png`], ["og:locale", "pt_BR"]]
      .map(([k, v]) => `<meta property="${k}" content="${attr(v)}">`).join("\n") + `\n<meta name="twitter:card" content="summary_large_image">`;
  }
  const p = caminho.match(/^\/ep\/([\w-]+)/)?.[1];
  const id = p ? achaEp(pub, p) : null;
  const fut = p && !id ? proximos().find(e => e.slug === p) : null;
  const r = id ? pub[id] : fut && { titulo: fut.titulo, temporada: fut.temporada };
  // "A VIGÍLIA - EPISÓDIO 1 | ..." vira "A Vigília - Episódio 1"
  const nome = t => t.toLowerCase().replace(/(^|\s)\p{L}/gu, c => c.toUpperCase());
  const m = r?.titulo.match(/^(.*?)\s*-\s*EPIS[ÓO]DIO\s*(\d+)/i);
  const titulo = r ? `${r.temporada || nome(m ? m[1] : r.titulo.replace(/\s*\|.*$/, ""))}${m ? " - Episódio " + m[2] : ""} | Ordem Tracker` : "Ordem Tracker";
  const desc = "Contagem de viewers ao vivo das lives de Ordem Paranormal na Twitch, Kick, YouTube e TikTok. Projeto de fãs do Realitas News.";
  // sem episódio na URL usa o último que foi ao ar
  const ver = id || (fut && !fut.id.startsWith("ag-") ? fut.id : null) || Object.entries(pub).sort((a, b) => (b[1].ultimaLeitura || "").localeCompare(a[1].ultimaLeitura || ""))[0]?.[0];
  const arq = ver && path.join(PREVIAS, ver + ".png");
  const img = arq && fs.existsSync(arq) ? `${SITE}/previa/${ver}.png?v=${Math.round(fs.statSync(arq).mtimeMs / 1000)}` : ver && /^[\w-]{11}$/.test(ver) ? `${SITE}/capa/${ver}.jpg` : `${SITE}/rn-branco.png`;
  return [["og:type", "website"], ["og:site_name", "Ordem Tracker"], ["og:title", titulo], ["og:description", desc], ["og:url", SITE + caminho], ["og:image", img], ["og:locale", "pt_BR"]]
    .map(([k, v]) => `<meta property="${k}" content="${attr(v)}">`).join("\n") + `\n<meta name="twitter:card" content="summary_large_image">`;
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
  // clipes: player oficial da Twitch num quadro e as miniaturas dos clipes
  "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob: https://static-cdn.jtvnw.net https://clips-media-assets2.twitch.tv https://cdn.7tv.app https://cdn.betterttv.net https://cdn.frankerfacez.com; media-src 'self' blob:; connect-src 'self'; frame-src https://clips.twitch.tv; frame-ancestors 'none'",
};

const apiCache = new Map(); // "ep|teste" -> { q, corpo }
http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SEGURANCA)) res.setHeader(k, v);
  const url = new URL(req.url, "http://x");
  if (req.method === "POST" && url.pathname === "/webhook/kick") return webhookKick(req, res);
  // clipes mais vistos da Twitch feitos durante o episódio
  if (url.pathname === "/api/clipes") {
    const p = url.searchParams.get("ep") || "", pub = publicos();
    const doEp = id => clipes(id).catch(e => { console.warn("clipes: " + e.message); return []; });
    // página inicial: clipes de todos os episódios do site juntos, cada um com o nome do episódio
    // ?de=0&n=24&q=palavra&ordem=views|quando: uma página por vez (com muitos clipes a lista inteira travava)
    // ep=todos junta os de todos os episódios; ep=temporada:<slug> os da temporada
    let lista;
    if (p === "todos" || p.startsWith("temporada:")) {
      const t = p.slice(10), ids = Object.keys(pub).filter(id => p === "todos" || kebab(pub[id].temporada || "") === t);
      const listas = []; // de 6 em 6 episódios, pra não abrir dezenas de pedidos de uma vez
      for (let i = 0; i < ids.length; i += 6) listas.push(...await Promise.all(ids.slice(i, i + 6).map(async id => (await doEp(id)).map(c => ({ ...c, ep: id })))));
      lista = listas.flat();
    } else { const id = achaEp(pub, p); lista = id ? await doEp(id) : []; }
    const sem = x => String(x).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const q = sem(url.searchParams.get("q") || ""), ordem = url.searchParams.get("ordem") === "quando" ? "quando" : "views";
    if (q) lista = lista.filter(c => sem(c.titulo + " " + c.criador).includes(q));
    lista = [...lista].sort((a, b) => ordem === "quando" ? b.quando.localeCompare(a.quando) : b.views - a.views);
    const de = Math.max(0, +url.searchParams.get("de") || 0), n = Math.min(60, Math.max(1, +url.searchParams.get("n") || 24));
    return json(res, 200, { lista: lista.slice(de, de + n), total: lista.length });
  }
  // relatório do laboratório (só no computador): /api/lab?ep=<id>
  if (LAB && url.pathname === "/api/lab") return json(res, 200, LAB.relatorio(url.searchParams.get("ep") || epAtual || ""));
  if (LAB && url.pathname === "/lab") return html(res, "lab.html");
  if (url.pathname === "/api") {
    registraAcesso(req, url);
    // a mesma resposta serve todo mundo que pede o mesmo episódio no mesmo instante: monta uma vez a cada 2 s
    const chave = (url.searchParams.get("ep") || "") + "|" + (url.searchParams.get("teste") || "");
    const pronto = apiCache.get(chave);
    if (pronto && Date.now() - pronto.q < 2000) { res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }); return res.end(pronto.corpo); }
    const json = (res, cod, obj) => { const corpo = JSON.stringify(obj); if (apiCache.size > 200) apiCache.clear(); apiCache.set(chave, { q: Date.now(), corpo }); res.writeHead(cod, { "Content-Type": "application/json; charset=utf-8" }); res.end(corpo); };
    // episódio exibido: o pedido (?ep=), o ao vivo, ou o último que foi ao ar
    // link de teste de episódio escondido: /ep/<id>?teste=<chave>; sem a chave ele não aparece pra ninguém
    const ch = url.searchParams.get("teste");
    const teste = ch && episodios.lista.find(e => e.oculto && e.teste && e.teste === ch)?.id;
    const pub = publicos(teste);
    const ultimoEp = Object.entries(pub).sort((p, q) => (q[1].ultimaLeitura || "").localeCompare(p[1].ultimaLeitura || ""))[0]?.[0];
    const p = url.searchParams.get("ep");
    const pedido = p && achaEp(pub, p);
    // episódio que ainda vai ao ar: a página fica zerada com a contagem e vira o painel sozinha quando a live começa
    const futuro = p && !pedido ? proximos().find(e => e.slug === p || e.id === p) || null : null;
    const ver = pedido && pub[pedido] ? pedido : (atual.episodio && pub[atual.episodio] ? atual.episodio : ultimoEp);
    const aoVivo = !!atual.episodio && ver === atual.episodio && atual.total > 0;
    const hist = histDe(ver);
    // live de episódio escondido: o público não recebe nem os números de agora
    const at = atual.episodio && !pub[atual.episodio] ? { total: 0, hora: atual.hora, episodio: null, extras: {} }
      : { ...so(atual, ["twitch", "kick", "youtube", "tiktok", "total", "hora", "episodio"]), extras: so(atual.extras || {}, ["inicio", "ytLikes", "msgsMin", "chatMsgs", "chatPessoas", "twitchSeguidores", "tiktokSeguidores"]) };
    if (futuro) return json(res, 200, { atual: at, records: pub, hist: [], ver, aoVivo: false, futuro, proximos: proximos(), config: config(), momentos: [] });
    return json(res, 200, { atual: at, records: pub, hist, ver, aoVivo, proximos: proximos(), config: config(), momentos: ver ? momentosPublicos(ver) : [] });
  }
  if (url.pathname === "/api/temporada") {
    const d = temporadaApi(url.searchParams.get("t") || "");
    return d ? json(res, 200, d) : json(res, 404, { erro: "Temporada não encontrada" });
  }
  const tp = url.pathname.match(/^\/temporada\/([\w-]+)\/?$/);
  if (tp) {
    const tags = og("/temporada/" + tp[1]);
    const titulo = tags.match(/og:title" content="([^"]*)"/)[1];
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    return res.end(pagina("temporada.html").replace("<title>Ordem Tracker</title>", `<title>${titulo}</title>\n${tags}`));
  }
  if (url.pathname === "/feedback" && req.method === "POST") return feedback(req, res);
  if (ADMIN && url.pathname === ADMIN + "/api") return admin(req, res);
  if (url.pathname === "/privacidade") {
    return html(res, "privacidade.html");
  }
  if (ADMIN && url.pathname === ADMIN) {
    return html(res, "admin.html", { "X-Robots-Tag": "noindex" });
  }
  // capa do vídeo servida daqui, pra página poder desenhar ela no PNG de compartilhar
  // /capa/<id>-p.jpg: versão dos cartões e listas (640 px, leve); /capa/<id>.jpg: a grande, pro destaque e o PNG de compartilhar
  // guardadas na memória por 6 h, pra não pedir ao YouTube a cada visita
  const capa = url.pathname.match(/^\/capa\/([\w-]{11})(-p)?\.jpg$/);
  if (capa) {
    const chave = capa[1] + (capa[2] || ""), c = capasCache.get(chave);
    if (c && Date.now() - c.q < 6 * 3600e3) { res.writeHead(200, { "Content-Type": c.tipo, "Cache-Control": "max-age=21600" }); return res.end(c.buf); }
    try {
      // depois que a live acaba o YouTube troca a capa "_live" pela normal
      // pequena: WebP de 640 px do YouTube (as faixas pretas de cima e de baixo somem no corte 16:9 dos cartões), 3 a 5 vezes mais leve
      const urls = capa[2] ? ["vi_webp/ID/sddefault_live.webp", "vi_webp/ID/sddefault.webp", "vi/ID/maxresdefault.jpg"] : ["vi/ID/maxresdefault_live.jpg", "vi/ID/maxresdefault.jpg", "vi/ID/hqdefault.jpg"];
      let r, u; for (u of urls) { r = await fetch("https://i.ytimg.com/" + u.replace("ID", capa[1])); if (r.ok) break; }
      const tipo = u.endsWith(".webp") ? "image/webp" : "image/jpeg";
      if (!r.ok) throw new Error(r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      capasCache.set(chave, { q: Date.now(), buf, tipo });
      res.writeHead(200, { "Content-Type": tipo, "Cache-Control": "max-age=21600" });
      return res.end(buf);
    } catch { res.writeHead(404); return res.end(); }
  }
  const img = url.pathname.match(/^\/((?:(?:icones|temporadas)\/)?[\w-]+\.(png|jpg))$/);
  if (img && fs.existsSync(path.join(PUBLICO, img[1]))) {
    res.writeHead(200, { "Content-Type": { png: "image/png", jpg: "image/jpeg" }[img[2]], "Cache-Control": "max-age=86400" });
    return res.end(fs.readFileSync(path.join(PUBLICO, img[1])));
  }
  if (url.pathname === "/previa" && req.method === "POST") return recebePrevia(req, res, url);
  // captura de momento aprovado
  const mc = url.pathname.match(/^\/momento\/([\w-]+)\/([\w-]+\.jpg)$/);
  if (mc && leMomentos(mc[1]).some(m => m.aprovado && m.captura === mc[2]) && fs.existsSync(path.join(MOMENTOS, mc[1], "capturas", mc[2]))) {
    // a captura de um momento não muda: o navegador pode guardar por uma semana
    res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "max-age=604800" });
    return res.end(fs.readFileSync(path.join(MOMENTOS, mc[1], "capturas", mc[2])));
  }
  const pv = url.pathname.match(/^\/previa\/([\w-]+)\.png$/);
  if (pv && fs.existsSync(path.join(PREVIAS, pv[1] + ".png"))) {
    res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "max-age=300" });
    return res.end(fs.readFileSync(path.join(PREVIAS, pv[1] + ".png")));
  }
  if (url.pathname !== "/" && !/^\/ep\/[\w-]+\/?$/.test(url.pathname)) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("404"); }
  const tags = og(url.pathname.replace(/\/$/, "") || "/");
  const titulo = tags.match(/og:title" content="([^"]*)"/)[1];
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
  res.end(pagina("index.html").replace("<title>Ordem Tracker</title>", `<title>${titulo}</title>\n${tags}`));
}).listen(PORTA, () => console.log(`http://localhost:${PORTA}`));
