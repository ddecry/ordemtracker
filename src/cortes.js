// cortes do vídeo completo: o vídeo postado depois da live não tem a contagem do começo nem os intervalos
// pra achar o que saiu, compara o volume do áudio do vídeo com o do áudio gravado da live, a cada 30 s
// resultado: [[segundo da live a partir do qual vale, segundos a descontar], ...] (o formato que o site já usa)
const { spawn } = require("child_process");

const HZ = 10; // 10 leituras de volume por segundo

// volume do áudio, 10 vezes por segundo (em escala log, que é como o ouvido percebe)
function volumes(arq) {
  return new Promise((ok, falha) => {
    // no servidor, com prioridade baixa pra não atrapalhar o site; no Windows não tem nice
    const args = ["-v", "error", "-i", arq, "-ac", "1", "-ar", "8000", "-f", "s16le", "-"];
    const p = process.platform === "win32" ? spawn("ffmpeg", args) : spawn("nice", ["-n", "15", "ffmpeg", ...args]);
    const vals = [], passo = 8000 / HZ; let soma = 0, n = 0, resto = Buffer.alloc(0);
    p.stdout.on("data", d => {
      const b = resto.length ? Buffer.concat([resto, d]) : d, fim = b.length - (b.length % 2);
      for (let i = 0; i < fim; i += 2) { const s = b.readInt16LE(i); soma += s * s; if (++n === passo) { vals.push(Math.log10(soma / n + 1)); soma = 0; n = 0; } }
      resto = b.subarray(fim);
    });
    p.on("error", falha);
    p.on("close", c => c === 0 ? ok(Float32Array.from(vals)) : falha(new Error("ffmpeg saiu com " + c)));
  });
}

// parecença entre um trecho do vídeo e a live num ponto (correlação de -1 a 1); trecho da live sem gravação = NaN
function parece(v, vi, live, li, tam) {
  if (li < 0 || li + tam > live.length) return NaN;
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let k = 0; k < tam; k++) {
    const a = v[vi + k], b = live[li + k]; if (Number.isNaN(b)) return NaN;
    sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b;
  }
  const cov = sab - sa * sb / tam, va = saa - sa * sa / tam, vb = sbb - sb * sb / tam;
  return va > 1e-6 && vb > 1e-6 ? cov / Math.sqrt(va * vb) : NaN;
}
// melhor ponto da live entre de e ate
function procura(v, vi, live, de, ate, tam) {
  let melhor = -2, onde = -1;
  for (let li = Math.max(0, de); li <= Math.min(ate, live.length - tam); li++) { const c = parece(v, vi, live, li, tam); if (c > melhor) { melhor = c; onde = li; } }
  return [onde, melhor];
}

const JANELA = 30 * HZ, PASSO = 30 * HZ, BOM = 0.85;
// média de cada segundo (pra busca rápida na live inteira); segundo com buraco na gravação = NaN
const porSegundo = a => { const r = new Float32Array(Math.floor(a.length / HZ)); for (let i = 0; i < r.length; i++) { let s = 0; for (let k = 0; k < HZ; k++) s += a[i * HZ + k]; r[i] = s / HZ; } return r; };
// v e live: volumes; live com NaN onde não tem gravação. Devolve os cortes e o resumo
function alinha(v, live) {
  const v1 = porSegundo(v), l1 = porSegundo(live), J1 = JANELA / HZ;
  let pontos = []; // [décimo no vídeo, desconto em décimos, parecença]
  for (let vi = 0; vi + JANELA <= v.length; vi += PASSO) {
    // cada trecho procura na live inteira, segundo a segundo; depois acerta o décimo em volta
    const [o1, c1] = procura(v1, vi / HZ, l1, 0, l1.length, J1);
    if (!(c1 >= BOM - 0.1)) continue;
    const [onde, c] = procura(v, vi, live, o1 * HZ - 2 * HZ, o1 * HZ + 2 * HZ, JANELA);
    if (c >= BOM) pontos.push([vi, onde - vi, c]);
  }
  // trecho que bateu num lugar que nenhum vizinho confirma é coincidência: sai
  pontos = pontos.filter((p, i) => [pontos[i - 1], pontos[i + 1]].some(q => q && Math.abs(q[1] - p[1]) <= 2 * HZ));
  if (!pontos.length) return { cortes: null, achados: 0, total: Math.floor(v.length / PASSO) };
  // junta os pontos em blocos de desconto igual (diferença até 2 s)
  const blocos = [];
  for (const p of pontos) { const u = blocos.at(-1); if (u && Math.abs(p[1] - u.desc) <= 2 * HZ) u.fim = p[0]; else blocos.push({ desc: p[1], ini: p[0], fim: p[0] }); }
  // bloco de um ponto só (30 s) é engano da comparação: some
  const firmes = blocos.filter(b => b.fim > b.ini);
  const lista = firmes.length ? firmes : blocos;
  const cortes = [[0, Math.round(lista[0].desc / HZ)]];
  for (let i = 1; i < lista.length; i++) {
    const a = lista[i - 1], b = lista[i];
    // desconto que diminui não existe (seria trecho repetido); diferença de poucos segundos é só atraso da gravação
    if (b.desc - a.desc < 5 * HZ) { b.desc = a.desc; continue; }
    // acha o segundo exato da emenda no vídeo: entre o fim do bloco de antes e o começo deste, qual desconto bate melhor a cada segundo
    let emenda = b.ini;
    const t = 5 * HZ;
    for (let vi = a.fim; vi <= b.ini + JANELA - t; vi += HZ) {
      const ca = parece(v, vi, live, vi + a.desc, t), cb = parece(v, vi, live, vi + b.desc, t);
      if (cb > ca + 0.1 && cb >= BOM) { emenda = vi; break; }
    }
    cortes.push([Math.round((emenda + b.desc) / HZ), Math.round(b.desc / HZ)]);
  }
  return { cortes, achados: pontos.length, total: Math.floor(v.length / PASSO) };
}

// volume da live inteira, das partes gravadas: partes = [{ arq, inicio (ms) }], ini = início da live (ms)
async function volumesLive(partes, ini) {
  const pedacos = [];
  for (const p of partes) pedacos.push([Math.round((p.inicio - ini) / 1000 * HZ), await volumes(p.arq)]);
  const tam = Math.max(...pedacos.map(([o, v]) => o + v.length));
  const live = new Float32Array(Math.max(0, tam)).fill(NaN);
  for (const [o, v] of pedacos) for (let k = 0; k < v.length; k++) if (o + k >= 0) live[o + k] = v[k];
  return live;
}

module.exports = { volumes, volumesLive, alinha, procura, parece, HZ };

// pelo terminal, dentro do container: node src/cortes.js <id da live> <id do vídeo>
// usa o volume do vídeo que o PC mandou (dados/cortes/<id>.video.bin) e grava dados/cortes/<id>.json, que o site lê sozinho
if (require.main === module) (async () => {
  const fs = require("fs"), path = require("path");
  const [id, video] = process.argv.slice(2), D = process.env.DADOS || "/dados", pasta = path.join(D, "cortes");
  if (!/^[\w-]{11}$/.test(id || "") || !/^[\w-]{11}$/.test(video || "")) throw new Error("uso: node src/cortes.js <id da live> <id do vídeo>");
  const le = f => { const b = fs.readFileSync(f); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)); };
  const ini = new Date(JSON.parse(fs.readFileSync(path.join(D, "records.json")))[id]?.inicioLive).getTime();
  if (!ini) throw new Error("live sem horário de início");
  // volume da live: calcula uma vez (leva uns minutos) e guarda
  const cacheLive = path.join(pasta, id + ".live.bin");
  let live;
  if (fs.existsSync(cacheLive)) live = le(cacheLive);
  else {
    const dir = path.join(D, "gravacao-feitos", id);
    const partes = fs.readdirSync(dir).filter(f => f.endsWith(".ogg")).map(f => {
      const m = f.match(/(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)/); return { arq: path.join(dir, f), inicio: Date.UTC(m[1], m[2] - 1, m[3], m[4], m[5], m[6]) };
    });
    if (!partes.length) throw new Error("a gravação da live já foi apagada");
    live = await volumesLive(partes, ini); fs.writeFileSync(cacheLive, Buffer.from(live.buffer));
  }
  const r = alinha(le(path.join(pasta, id + ".video.bin")), live);
  if (!r.cortes) throw new Error("o áudio do vídeo não bateu com a live");
  fs.writeFileSync(path.join(pasta, id + ".json"), JSON.stringify({ video, cortes: r.cortes, achados: r.achados, total: r.total, quando: new Date().toISOString() }));
  console.log(JSON.stringify(r));
})().catch(e => { console.error(e.message); process.exit(1); });
