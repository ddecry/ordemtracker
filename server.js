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
  const u = `https://www.googleapis.com/youtube/v3/liveChat/messages?liveChatId=${ytChat}&part=snippet&maxResults=2000${ytChatPagina ? "&pageToken=" + ytChatPagina : ""}&key=${env.YOUTUBE_API_KEY}`;
  const r = await fetch(u);
  if (!r.ok) { marca("Chat do YouTube", false, "HTTP " + r.status); if (r.status === 403 || r.status === 404) ytChat = null; return; }
  marca("Chat do YouTube", true, "lendo a cada 20 s");
  const j = await r.json();
  const primeira = !ytChatPagina;
  ytChatPagina = j.nextPageToken;
  if (primeira) return; // a primeira página traz mensagens antigas; começa a contar daqui
  for (const m of j.items || []) if (m.snippet?.type === "textMessageEvent") msg("youtube", m.snippet.authorChannelId, m.snippet.displayMessage);
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
  ws.onopen = () => { marca("Chat da Twitch", true, "conectado"); ws.send("PASS SCHMOOPIIE"); ws.send("NICK justinfan" + Math.floor(Math.random() * 99999)); ws.send("JOIN #" + TWITCH); };
  ws.onmessage = e => {
    for (const l of String(e.data).split("\r\n")) {
      if (l.startsWith("PING")) ws.send("PONG :tmi.twitch.tv");
      else if (l.includes(" PRIVMSG ")) msg("twitch", l.match(/^:([^!]+)!/)?.[1], l.match(/ PRIVMSG #\S+ :(.*)$/)?.[1]);
    }
  };
  ws.onclose = () => { marca("Chat da Twitch", false, "desconectado, reconectando"); setTimeout(conectaTwitch, 5000); };
  ws.onerror = () => ws.close();
}
conectaTwitch();

// ---------- recordes e episódios cadastrados ----------
let records = {};
try { records = JSON.parse(fs.readFileSync(DB, "utf8")); } catch {}
let episodios = { lista: [] };
try { episodios = JSON.parse(fs.readFileSync(EPS, "utf8")); } catch {}
const salvaEps = () => fs.writeFileSync(EPS, JSON.stringify(episodios, null, 2));
// o glossário escrito à mão virou automático (wiki): as linhas "errado => certo" passam para as correções aprendidas
if (episodios.config?.glossario) {
  const pares = [...episodios.config.glossario.matchAll(/^\s*(.+?)\s*(?:=>|→)\s*(.+?)\s*$/gm)].map(m => [m[1], m[2]]);
  episodios.config = { ...episodios.config, apelidos: { ...Object.fromEntries(pares), ...(episodios.config.apelidos || {}) }, glossario: "" };
  salvaEps();
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
const CAMPOS = ["titulo", "temporada", "recorde", "quando", "twitch", "kick", "youtube", "tiktok", "picos", "media", "inicio", "inicioLive", "fimLive", "ultimaLeitura", "likes", "chatMsgs", "chatPessoas", "twitchSegInicio", "twitchSegFim", "kickSegInicio", "kickSegFim", "tiktokSegInicio", "tiktokSegFim", "picoMsgsMin"];
const so = (o, ks) => Object.fromEntries(ks.filter(k => o[k] != null).map(k => [k, o[k]]));
// endereço amigável do episódio: "A VIGÍLIA - EPISÓDIO 1" vira "a-vigilia-1"
const kebab = t => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const slug = (titulo, id) => { const m = (titulo || "").match(/^(.*?)\s*-\s*EPIS[ÓO]DIO\s*(\d+)/i); return (m ? kebab(m[1]) + "-" + m[2] : kebab((titulo || "").replace(/\s*\|.*$/, ""))) || id; };
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
function publicos() {
  const out = {};
  for (const [id, r] of Object.entries(records)) {
    const e = episodios.lista.find(x => x.id === id);
    if (e?.oculto) continue;
    out[id] = { ...so({ ...r, titulo: e?.titulo || r.titulo, temporada: e?.temporada || null, media: mediaSemFim(id, r) }, CAMPOS), slug: slug(r.titulo, id),
      // a faixa de chat no gráfico só aparece quando o chat do episódio foi gravado inteiro (do Ep 2 em diante)
      chatCompleto: fs.existsSync(path.join(CHATLOG, id.replace(/[^\w-]/g, "_") + ".jsonl")) };
  }
  return out;
}
const config = () => ({ telaInicial: "contagem", semProximo: "", ...(episodios.config || {}) });
const proximos = () => episodios.lista
  .filter(e => !e.oculto && !records[e.id] && e.data && new Date(e.data) > Date.now() - 86_400_000)
  .sort((a, b) => a.data.localeCompare(b.data))
  .map(({ id, titulo, temporada, data }) => ({ id, titulo, temporada, data, slug: slug(titulo, id) }));

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
      return { id, titulo: e.titulo || "", tituloYT: r?.titulo || "", temporada: e.temporada || "", data: e.data || r?.inicioLive || "", oculto: !!e.oculto, recorde: r?.recorde ?? null };
    }).sort((a, b) => (b.data || "").localeCompare(a.data || ""));
    if (url.searchParams.get("acessos")) return json(res, 200, relatorio());
    // correções vêm com o texto atual do momento, pra comparar
    if (url.searchParams.get("status")) return json(res, 200, status());
    if (url.searchParams.get("feedbacks")) return json(res, 200, feedbacks.map(f => f.tipo === "correcao" ? { ...f, atual: leMomentos(f.ep).find(m => m.quando === f.momento) || null } : f));
    const mid = url.searchParams.get("momentos");
    if (mid && records[mid]) return json(res, 200, { lista: leMomentos(mid) });
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
      return json(res, 200, { token, url: "/ep/" + slug(records[pv].titulo, pv) + "#previa=" + token });
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
        captura: /^[\w-]+\.jpg$/.test(m.captura || "") ? m.captura : null, audio: /^[\w-]+\.ogg$/.test(m.audio || "") ? m.audio : undefined, aprovado: !!m.aprovado }));
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
      const e = { id, titulo: String(b.titulo || ytTitulo).slice(0, 200), temporada: String(b.temporada || "").slice(0, 100), data: b.data ? new Date(b.data).toISOString() : ytData, oculto: !!b.oculto };
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
const salvaMomentos = (id, lista) => { fs.mkdirSync(path.join(MOMENTOS, id), { recursive: true }); fs.writeFileSync(path.join(MOMENTOS, id, "momentos.json"), JSON.stringify(lista, null, 2)); };
const momentosPublicos = id => leMomentos(id).filter(m => m.aprovado)
  .map(m => ({ quando: m.quando, titulo: m.titulo, contexto: m.contexto, tipo: m.tipo, captura: m.captura ? `/momento/${id}/${m.captura}` : null }));

// ---------- gravação durante a live (público, sem login) ----------
// áudio em partes de 30 min e uma captura a cada 30 s; cada parte pronta vai pro Gemini, que devolve os momentos como rascunho
const { spawn, execFile } = require("child_process");
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
  // pega o endereço da transmissão pública da Twitch, que é a mesma live (o YouTube pede login para servidores de nuvem);
  // o endereço expira em algumas horas: quando cai, a próxima volta do tick recomeça
  execFile("yt-dlp", ["-g", "-f", "best[height<=480]/worst", "https://www.twitch.tv/" + TWITCH], { timeout: 60_000 }, (erro, saida) => {
    const url = String(saida || "").trim().split("\n")[0];
    if (erro || !url.startsWith("http")) { marca("Gravação", false, "não abriu a live da Twitch: " + (erro?.message || "sem endereço")); console.warn("gravação: sem endereço da live", erro?.message || ""); gravando = null; return; }
    const proc = spawn("ffmpeg", ["-v", "error", "-i", url,
      "-map", "0:a", "-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", "24k", "-f", "segment", "-segment_time", String(PARTE_MIN * 60), "-reset_timestamps", "1", "-strftime", "1", path.join(dir, "audio-%Y%m%dT%H%M%S.ogg"),
      "-map", "0:v", "-vf", "fps=1/30,scale=854:-2", "-q:v", "4", "-f", "image2", "-strftime", "1", path.join(dir, "capturas", "%Y%m%dT%H%M%S.jpg")], { stdio: ["ignore", "ignore", "pipe"] });
    proc.stderr.on("data", d => console.warn("ffmpeg:", String(d).trim().slice(0, 200)));
    proc.on("exit", () => { if (gravando?.proc === proc) gravando = null; });
    gravando = { id, proc };
    marca("Gravação", true, "gravando áudio e capturas da Twitch");
    console.log("gravação: começou", id);
  });
  gravando = { id, proc: { kill() {} } }; // reserva enquanto o yt-dlp responde
}

const GEMINI = "https://generativelanguage.googleapis.com";
const PEDIDO_MOMENTOS = `Este é um trecho de áudio de uma live de RPG de mesa da série Ordem Paranormal, narrada pelo Cellbit com jogadores convidados.
Liste os principais acontecimentos deste trecho: momentos da história (revelações, combates, mortes, decisões, cenas marcantes) e momentos da mesa (piadas que todos riram, pausas, intervalo, abertura e encerramento).
Para cada um, informe o segundo deste trecho em que começa, um título curto (até 8 palavras) e uma frase de contexto (até 25 palavras), em português.
Seja factual: use só nomes de personagens e lugares que foram ditos claramente. Não invente. Prefira 1 momento a cada 3 a 8 minutos.`;
const ESQUEMA_MOMENTOS = { type: "ARRAY", items: { type: "OBJECT", properties: {
  segundo: { type: "INTEGER" }, titulo: { type: "STRING" }, contexto: { type: "STRING" }, tipo: { type: "STRING", enum: ["historia", "mesa"] } },
  required: ["segundo", "titulo", "contexto", "tipo"] } };
async function geminiAudio(arq) {
  const k = { "x-goog-api-key": env.GEMINI_API_KEY };
  const tam = fs.statSync(arq).size;
  const ini = await fetch(`${GEMINI}/upload/v1beta/files`, { method: "POST", headers: { ...k, "X-Goog-Upload-Protocol": "resumable", "X-Goog-Upload-Command": "start",
    "X-Goog-Upload-Header-Content-Length": tam, "X-Goog-Upload-Header-Content-Type": "audio/ogg", "Content-Type": "application/json" }, body: JSON.stringify({ file: { display_name: path.basename(arq) } }) });
  const up = await fetch(ini.headers.get("x-goog-upload-url"), { method: "POST", headers: { "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" }, body: fs.readFileSync(arq) });
  let f = (await up.json()).file;
  while (f?.state === "PROCESSING") { await new Promise(r => setTimeout(r, 5000)); f = await (await fetch(`${GEMINI}/v1beta/${f.name}`, { headers: k })).json(); }
  if (f?.state !== "ACTIVE") throw new Error("gemini: arquivo não ficou pronto");
  const corpo = JSON.stringify({ contents: [{ parts: [{ fileData: { fileUri: f.uri, mimeType: f.mimeType } }, { text: PEDIDO_MOMENTOS + (glossario() ? "\nUse exatamente a grafia oficial destes nomes (o áudio pode soar diferente):\n" + glossario() : "") }] }], generationConfig: { responseMimeType: "application/json", responseSchema: ESQUEMA_MOMENTOS } });
  // só o modelo principal; um reserva (GEMINI_RESERVA) entra só se for definido no .env, porque os resumos dele são piores
  let j;
  for (const modelo of [env.GEMINI_MODELO || "gemini-3.8-flash", env.GEMINI_RESERVA].filter(Boolean)) {
    j = await fetch(`${GEMINI}/v1beta/models/${modelo}:generateContent`, { method: "POST", headers: { ...k, "Content-Type": "application/json" }, body: corpo })
      .then(r => r.json()).catch(e => ({ error: { code: 503, message: e.cause?.code || e.message } }));
    if (j.error?.code !== 429) break;
  }
  fetch(`${GEMINI}/v1beta/${f.name}`, { method: "DELETE", headers: k }).catch(() => {});
  if (j.error) throw Object.assign(new Error("gemini: " + j.error.message), { codigo: j.error.code });
  return JSON.parse(j.candidates[0].content.parts[0].text);
}
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
        const lista = await geminiAudio(path.join(dir, p));
        const caps = fs.readdirSync(path.join(dir, "capturas")).filter(f => f.endsWith(".jpg")).map(f => ({ f, t: deHora14(f.slice(0, 15)).getTime() }));
        const novos = lista.map(m => {
          const t = inicio.getTime() + Math.max(0, Math.min(PARTE_MIN * 60, m.segundo)) * 1000;
          const cap = caps.filter(c => c.t >= t).sort((a, b) => a.t - b.t)[0] || caps.at(-1);
          let captura = null;
          if (cap) { captura = cap.f; fs.mkdirSync(path.join(MOMENTOS, id, "capturas"), { recursive: true }); fs.copyFileSync(path.join(dir, "capturas", cap.f), path.join(MOMENTOS, id, "capturas", cap.f)); }
          return { quando: new Date(t).toISOString(), titulo: String(m.titulo).slice(0, 80), contexto: String(m.contexto).slice(0, 240), tipo: m.tipo === "mesa" ? "mesa" : "historia", captura, aprovado: false, seg: (t - inicio.getTime()) / 1000 };
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
        fs.unlinkSync(path.join(dir, p));
        console.log("momentos:", id, p, novos.length);
        marca("Gemini", true, novos.length + " momentos novos em rascunho");
      }
      // live acabou e tudo analisado: apaga o que sobrou da gravação
      if (gravando?.id !== id && !fs.readdirSync(dir).some(f => f.endsWith(".ogg"))) fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch (e) {
    // cota gratuita acabou: as partes ficam guardadas e a análise tenta de novo de hora em hora até a cota renovar
    if (e.codigo === 429) pausaAte = Date.now() + 3600e3;
    marca("Gemini", false, e.codigo === 429 ? "cota gratuita do dia esgotada; tenta de novo de hora em hora" : e.message);
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
  else if (capturas.length) itens["Gravação"] = { ...itens["Gravação"], info: `gravando · ${capturas.length} capturas · última às ${deHora14(capturas.at(-1).slice(0, 15)).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo" })}` };
  if (!itens["Gemini"]) itens["Gemini"] = { ok: env.GEMINI_API_KEY ? null : false, info: env.GEMINI_API_KEY ? "nenhuma análise feita desde que o servidor ligou" : "sem GEMINI_API_KEY", quando: Date.now() };
  if (partes.length) itens["Gemini"] = { ...itens["Gemini"], info: (itens["Gemini"].info ? itens["Gemini"].info + " · " : "") + partes.length + (partes.length > 1 ? " partes" : " parte") + " de áudio esperando análise" + (pausaAte > Date.now() ? " (próxima tentativa às " + new Date(pausaAte).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" }) + ")" : "") };
  if (!itens["Chat do YouTube"]) itens["Chat do YouTube"] = { ok: null, info: "só lê com o episódio no ar", quando: Date.now() };
  for (const [p, nome] of [["twitch", "Chat da Twitch"], ["youtube", "Chat do YouTube"]]) if (itens[nome] && ultimaMsg[p]) itens[nome] = { ...itens[nome], ultimaMsg: ultimaMsg[p] };
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
function og(caminho) {
  const pub = publicos();
  const p = caminho.match(/^\/ep\/([\w-]+)/)?.[1];
  const id = p ? (pub[p] ? p : Object.keys(pub).find(k => pub[k].slug === p)) : null;
  const fut = p && !id ? proximos().find(e => e.slug === p) : null;
  const r = id ? pub[id] : fut && { titulo: fut.titulo, temporada: fut.temporada };
  // "A VIGÍLIA - EPISÓDIO 1 | ..." vira "A Vigília · Episódio 1"
  const nome = t => t.toLowerCase().replace(/(^|\s)\p{L}/gu, c => c.toUpperCase());
  const m = r?.titulo.match(/^(.*?)\s*-\s*EPIS[ÓO]DIO\s*(\d+)/i);
  const titulo = r ? `${r.temporada || nome(m ? m[1] : r.titulo.replace(/\s*\|.*$/, ""))}${m ? " - Episódio " + m[2] : ""} · Ordem Tracker` : "Ordem Tracker";
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
  "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'",
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
    // episódio que ainda vai ao ar: a página fica zerada com a contagem e vira o painel sozinha quando a live começa
    const futuro = p && !pedido ? proximos().find(e => e.slug === p || e.id === p) || null : null;
    const ver = pedido && pub[pedido] ? pedido : (atual.episodio && pub[atual.episodio] ? atual.episodio : ultimoEp);
    const aoVivo = !!atual.episodio && ver === atual.episodio && atual.total > 0;
    const linhas = fs.readFileSync(HIST, "utf8").trim().split("\n").slice(1);
    const hist = linhas.map(l => l.split(",")).filter(c => c[1] === ver).map(c => [c[0], ...c.slice(2, 6).map(v => (v === "" ? null : +v)), c[7] ? +c[7] : null, c[8] ? +c[8] : null]);
    const at = { ...so(atual, ["twitch", "kick", "youtube", "tiktok", "total", "hora", "episodio"]), extras: so(atual.extras || {}, ["inicio", "ytLikes", "msgsMin", "chatMsgs", "chatPessoas", "twitchSeguidores", "tiktokSeguidores"]) };
    if (futuro) return json(res, 200, { atual: at, records: pub, hist: [], ver, aoVivo: false, futuro, proximos: proximos(), config: config(), momentos: [] });
    return json(res, 200, { atual: at, records: pub, hist, ver, aoVivo, proximos: proximos(), config: config(), momentos: ver ? momentosPublicos(ver) : [] });
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
