// imagens dos emotes que o chat usa: Twitch, 7TV, BTTV e FFZ
const { env } = require("./config");
const { twitchH, twitchId } = require("./plataformas");

// aoAchar(): chamado quando a busca acha um emote novo (pra refazer o que já foi montado com a lista antiga)
module.exports = aoAchar => {
  // emote pessoal do 7TV (quem assina o 7TV usa os próprios emotes em qualquer canal): busca pelo nome exato, uma vez por nome
  // no máximo 30 buscas por hora; o resultado (achou ou não) fica guardado
  const emotesBusca = {}; let buscas = { q: 0, n: 0 };
  function buscaEmote(nome) {
    if (nome in emotesBusca || !/[a-z][A-Z]|[A-Z][a-z]/.test(nome) || nome.length > 25) return;
    if (Date.now() - buscas.q > 3600e3) buscas = { q: Date.now(), n: 0 };
    if (buscas.n >= 30) return;
    buscas.n++; emotesBusca[nome] = null;
    fetch("https://7tv.io/v3/gql", { method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(8000),
      body: JSON.stringify({ query: "query($q:String!){emotes(query:$q,limit:5,filter:{exact_match:true,case_sensitive:true}){items{id name}}}", variables: { q: nome } }) })
      .then(r => r.json()).then(j => {
        const e = j?.data?.emotes?.items?.find(x => x.name === nome); if (!e) return;
        emotesBusca[nome] = emotesCache.mapa[nome] = `https://cdn.7tv.app/emote/${e.id}/2x.webp`;
        aoAchar();
      }).catch(() => { delete emotesBusca[nome]; });
  }
  // imagens dos emotes do canal (nome -> endereço), pela API da Twitch; guarda 1 dia
  let emotesCache = { q: 0, mapa: {} };
  async function emotesCanal() {
    if (Date.now() - emotesCache.q < 86400e3 || !env.TWITCH_CLIENT_ID) return emotesCache.mapa;
    try {
      const h = await twitchH();
      const twId = await twitchId(h);
      const j = await (await fetch(`https://api.twitch.tv/helix/chat/emotes?broadcaster_id=${twId}`, { headers: h })).json();
      // endereço oficial da Twitch; a versão animada quando o emote tem animação (tema escuro, tamanho 2x)
      const tpl = j.template || "https://static-cdn.jtvnw.net/emoticons/v2/{{id}}/{{format}}/{{theme_mode}}/{{scale}}";
      const mapa = Object.fromEntries((j.data || []).map(e => [e.name,
        tpl.replace("{{id}}", e.id).replace("{{format}}", e.format?.includes("animated") ? "animated" : "static").replace("{{theme_mode}}", "dark").replace("{{scale}}", "2.0")]));
      // emotes das extensões que o chat usa (7TV, BTTV, FFZ), do canal e os globais; APIs públicas, sem login. Os da Twitch têm preferência
      const pega = u => fetch(u, { signal: AbortSignal.timeout(10_000) }).then(r => r.ok ? r.json() : null).catch(() => null);
      const [s7, s7g, bt, btg, fz, fzg, tg] = await Promise.all([pega(`https://7tv.io/v3/users/twitch/${twId}`), pega("https://7tv.io/v3/emote-sets/global"),
        pega(`https://api.betterttv.net/3/cached/users/twitch/${twId}`), pega("https://api.betterttv.net/3/cached/emotes/global"), pega(`https://api.betterttv.net/3/cached/frankerfacez/users/twitch/${twId}`),
        pega("https://api.betterttv.net/3/cached/frankerfacez/emotes/global"),
        fetch("https://api.twitch.tv/helix/chat/emotes/global", { headers: h, signal: AbortSignal.timeout(10_000) }).then(r => r.ok ? r.json() : null).catch(() => null)]);
      // 7TV: o conjunto ativo do canal às vezes fica vazio (o canal troca de conjunto); aí valem também os outros conjuntos do Cellbit
      let sets7 = s7?.emote_set?.emotes || [];
      if (!sets7.length && s7?.user?.id) {
        const u = await pega(`https://7tv.io/v3/users/${s7.user.id}`);
        for (const st of (u?.emote_sets || []).slice(0, 6)) sets7 = sets7.concat((await pega(`https://7tv.io/v3/emote-sets/${st.id}`))?.emotes || []);
      }
      for (const e of [...sets7, ...(s7g?.emotes || [])]) if (e.data?.host?.url) mapa[e.name] ??= `https:${e.data.host.url}/2x.webp`;
      for (const e of [...(bt?.channelEmotes || []), ...(bt?.sharedEmotes || []), ...(btg || [])]) mapa[e.code] ??= `https://cdn.betterttv.net/emote/${e.id}/2x`;
      for (const e of [...(fz || []), ...(fzg || [])]) if (e.images) mapa[e.code] ??= e.images["2x"] || e.images["1x"];
      // globais da Twitch (Kappa, LUL, PogChamp...)
      for (const e of tg?.data || []) mapa[e.name] ??= (tg.template || tpl).replace("{{id}}", e.id).replace("{{format}}", e.format?.includes("animated") ? "animated" : "static").replace("{{theme_mode}}", "dark").replace("{{scale}}", "2.0");
      // emotes achados pela busca (pessoais do 7TV) continuam valendo
      for (const [n, u] of Object.entries(emotesBusca)) if (u) mapa[n] ??= u;
      emotesCache = { q: Date.now(), mapa };
    } catch (e) { console.warn("emotes:", e.message); emotesCache.q = Date.now() - 86400e3 + 600e3; }
    return emotesCache.mapa;
  }
  setTimeout(emotesCanal, 5000);
  return { emotesCanal, buscaEmote, mapa: () => emotesCache.mapa };
};
