// quantos pedidos o site faz para cada serviço e quanto da cota diária do YouTube já foi gasto
// conta todo fetch do servidor pelo endereço; a cota do YouTube zera à meia-noite do horário do Pacífico
const fs = require("fs");
const path = require("path");
const { DADOS } = require("./config");

const ARQ = path.join(DADOS, "uso.json");
const COTA_YT = 10_000;
// custo de cada pedido na cota do YouTube (videos.list = 1, liveChatMessages.list = 5)
const tipos = [
  ["ytVideos", /googleapis\.com\/youtube\/v3\/videos/, 1],
  ["ytChat", /googleapis\.com\/youtube\/v3\/liveChat/, 5],
  ["ytPagina", /youtube\.com\/watch/, 0],
  ["ytFeed", /youtube\.com\/feeds/, 0],
  ["twitch", /api\.twitch\.tv|id\.twitch\.tv/, 0],
  ["kick", /api\.kick\.com|id\.kick\.com/, 0],
  ["tiktok", /tiktok\.com/, 0],
  ["gemini", /generativelanguage\.googleapis\.com/, 0],
  ["groq", /api\.groq\.com/, 0],
  ["wiki", /fandom\.com/, 0],
  ["emotes", /7tv\.io|betterttv\.net/, 0],
];
const diaPacifico = () => new Date().toLocaleDateString("sv-SE", { timeZone: "America/Los_Angeles" });
let uso = { dia: diaPacifico(), unidades: 0, pedidos: {}, erros: {}, porHora: {} };
try { const u = JSON.parse(fs.readFileSync(ARQ, "utf8")); if (u.dia === uso.dia) uso = { ...uso, ...u }; } catch {}
const recentes = {}; // tipo -> horários dos pedidos do último minuto

function vira() {
  const d = diaPacifico();
  if (uso.dia !== d) uso = { dia: d, unidades: 0, pedidos: {}, erros: {}, porHora: {} };
}
function conta(url, ok) {
  const t = tipos.find(([, re]) => re.test(url));
  if (!t) return;
  vira();
  const [nome, , custo] = t;
  if (ok === undefined) {
    uso.pedidos[nome] = (uso.pedidos[nome] || 0) + 1;
    uso.unidades += custo;
    const h = new Date().toISOString().slice(0, 13);
    uso.porHora[h] = (uso.porHora[h] || 0) + custo;
    (recentes[nome] ||= []).push(Date.now());
  } else if (!ok) uso.erros[nome] = (uso.erros[nome] || 0) + 1;
}
// troca o fetch global por um que conta; o endereço nunca é guardado (tem a chave da API)
const fetchOriginal = globalThis.fetch;
globalThis.fetch = (url, opcoes) => {
  const u = String(url?.url || url);
  conta(u);
  return fetchOriginal(url, opcoes).then(r => { if (!r.ok) conta(u, false); return r; }, e => { conta(u, false); throw e; });
};
setInterval(() => { try { fs.writeFileSync(ARQ, JSON.stringify(uso)); } catch {} }, 60_000).unref();

// resumo para o painel: gasto de hoje, ritmo da última hora e até quando a cota dá
function resumo() {
  vira();
  const agora = Date.now(), lim = agora - 60_000;
  const porMinuto = {};
  for (const [k, l] of Object.entries(recentes)) { while (l.length && l[0] < lim) l.shift(); porMinuto[k] = l.length; }
  // unidades gastas nos últimos 60 min (soma da hora atual com a parte final da anterior)
  const h = new Date(agora).toISOString().slice(0, 13), hAnt = new Date(agora - 3600e3).toISOString().slice(0, 13);
  const min = new Date(agora).getUTCMinutes();
  const ultimaHora = Math.round((uso.porHora[h] || 0) + (uso.porHora[hAnt] || 0) * (60 - min) / 60);
  // meia-noite do Pacífico: quantas horas faltam
  const pac = new Date(new Date(agora).toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const faltaH = 24 - pac.getHours() - pac.getMinutes() / 60;
  const zera = agora + faltaH * 3600e3;
  const restam = Math.max(0, COTA_YT - uso.unidades);
  const acaba = ultimaHora > 0 && restam / ultimaHora < faltaH ? agora + restam / ultimaHora * 3600e3 : null;
  return { dia: uso.dia, cota: COTA_YT, unidades: uso.unidades, restam, ultimaHora, zera, acaba, pedidos: uso.pedidos, erros: uso.erros, porMinuto };
}

module.exports = { resumo };
