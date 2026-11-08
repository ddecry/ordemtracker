// configuração: chaves do .env, canais e pastas dos dados
const path = require("path");
const fs = require("fs");
const RAIZ = path.join(__dirname, "..");
try { process.loadEnvFile(path.join(RAIZ, ".env")); } catch {}
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
const DADOS = env.DATA_DIR || path.join(RAIZ, "dados");
const PUBLICO = path.join(RAIZ, "public");
const DB = path.join(DADOS, "records.json");
const EPS = path.join(DADOS, "episodios.json");
const HIST = path.join(DADOS, "historico.csv");
const CHATTERS = path.join(DADOS, "chatters");
const RESUMOS = path.join(DADOS, "resumos");
fs.mkdirSync(CHATTERS, { recursive: true });
fs.mkdirSync(RESUMOS, { recursive: true });

module.exports = { RAIZ, env, TWITCH, KICK, YT_CANAL, TIKTOK, EPISODIO, temporadaDoTitulo, ADMIN, SENHA_CFG, SENHA_LOCAL, PORTA, INTERVALO, DADOS, PUBLICO, DB, EPS, HIST, CHATTERS, RESUMOS };
