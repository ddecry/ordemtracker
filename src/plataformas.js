// leitura de audiência na Twitch, na Kick e no TikTok
const { env, TWITCH, KICK, TIKTOK } = require("./config");

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

// cabeçalhos da API da Twitch e o id do canal (pedido uma vez só)
const twitchH = async () => ({ "Client-Id": env.TWITCH_CLIENT_ID, Authorization: "Bearer " + await token("twitch", "https://id.twitch.tv/oauth2/token", env.TWITCH_CLIENT_ID, env.TWITCH_CLIENT_SECRET) });
let idTwitch = null;
const twitchId = async h => idTwitch ||= (await (await fetch(`https://api.twitch.tv/helix/users?login=${TWITCH}`, { headers: h || await twitchH() })).json())?.data?.[0]?.id || null;

// Twitch Helix (API oficial): https://dev.twitch.tv/docs/api/reference/#get-streams
async function twitch() {
  if (!env.TWITCH_CLIENT_ID) return null;
  const h = await twitchH();
  const s = (await (await fetch(`https://api.twitch.tv/helix/streams?user_login=${TWITCH}`, { headers: h })).json())?.data?.[0];
  const id = await twitchId(h);
  // com token de app a Twitch devolve só o total de seguidores, que é o que usamos
  const seg = id ? (await (await fetch(`https://api.twitch.tv/helix/channels/followers?broadcaster_id=${id}&first=1`, { headers: h })).json())?.total : null;
  return { n: s?.viewer_count ?? 0, title: s?.title, seguidores: seg, jogo: s?.game_name, jogoId: s?.game_id, inicio: s?.started_at, h };
}
// só a audiência, sem seguidores (leitura rápida a cada 3 s)
async function twitchRapido() {
  if (!env.TWITCH_CLIENT_ID) return null;
  const s = (await (await fetch(`https://api.twitch.tv/helix/streams?user_login=${TWITCH}`, { headers: await twitchH(), signal: AbortSignal.timeout(4000) })).json())?.data?.[0];
  return s ? s.viewer_count : null;
}

// Kick Public API (oficial): https://docs.kick.com
const kickH = async () => ({ Authorization: "Bearer " + await token("kick", "https://id.kick.com/oauth/token", env.KICK_CLIENT_ID, env.KICK_CLIENT_SECRET), Accept: "application/json" });
async function kick() {
  if (!env.KICK_CLIENT_ID) return null;
  const h = await kickH();
  // a API da Kick às vezes derruba a conexão: tenta de novo até 3 vezes antes de dar erro
  let r;
  for (let i = 0; ; i++) {
    try { r = await fetch(`https://api.kick.com/public/v1/channels?slug=${KICK}`, { headers: h, signal: AbortSignal.timeout(6000) }); break; }
    catch (e) { if (i >= 2) throw e; await new Promise(ok => setTimeout(ok, 800)); }
  }
  if (!r.ok) throw new Error(`kick HTTP ${r.status}`);
  const s = (await r.json())?.data?.[0]?.stream;
  return { n: s?.is_live ? s.viewer_count ?? 0 : 0, inicio: s?.is_live ? s.start_time : null };
}

// TikTok não tem API oficial de espectadores ao vivo: lê o mesmo endereço público que a página da live usa
async function tiktok() {
  if (!TIKTOK) return null;
  const r = await fetch(`https://www.tiktok.com/api-live/user/room/?aid=1988&uniqueId=${TIKTOK}&sourceType=54`, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130 Safari/537.36" } });
  const d = (await r.json())?.data;
  const vivo = d?.liveRoom?.status === 2;
  return { n: vivo ? d.liveRoom.liveRoomStats?.userCount ?? 0 : 0, seguidores: d?.stats?.followerCount, entradas: vivo ? d.liveRoom.liveRoomStats?.enterCount : null };
}

module.exports = { token, twitchH, twitchId, twitch, twitchRapido, kickH, kick, tiktok };
