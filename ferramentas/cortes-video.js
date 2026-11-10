// roda no PC (o YouTube barra download feito de servidor na nuvem): acha os cortes do vídeo completo de cada episódio
// 1. pergunta ao servidor quais episódios têm "vídeo completo" no admin e ainda não têm cortes
// 2. baixa o áudio do vídeo, mede o volume e manda só essas medidas (alguns MB) pro servidor
// 3. o servidor compara com a gravação da live e grava dados/cortes/<id>.json, que o site já lê
// precisa de yt-dlp, ffmpeg e da chave SSH do servidor; no .env: CORTES_SSH=usuario@servidor e CORTES_CHAVE=caminho da chave
// uso: node ferramentas/cortes-video.js   (o agendador do Windows roda a cada 30 min)
const fs = require("fs"), os = require("os"), path = require("path"), { execFileSync } = require("child_process");
const RAIZ = path.join(__dirname, "..");
const env = Object.fromEntries(fs.readFileSync(path.join(RAIZ, ".env"), "utf8").split(/\r?\n/).map(l => l.match(/^\s*([\w]+)\s*=\s*(.*)$/)).filter(Boolean).map(m => [m[1], m[2].trim()]));
const SSH = env.CORTES_SSH, CHAVE = (env.CORTES_CHAVE || "~/.ssh/ordemtracker").replace(/^~/, os.homedir());
if (!SSH) throw new Error("falta CORTES_SSH no .env");
// no Windows, o ssh do Git (o do sistema recusa chave com permissão herdada da pasta)
const GITS = ["C:/Program Files/Git/usr/bin/", path.join(os.homedir(), "AppData/Local/Programs/Git/usr/bin/")];
const BIN = n => process.platform === "win32" && GITS.map(g => path.join(g, n + ".exe")).find(a => fs.existsSync(a)) || n;
// yt-dlp instalado pelo winget fica numa pasta que só entra no PATH depois de reabrir o Windows
const YTDLP = (() => { const p = path.join(os.homedir(), "AppData/Local/Microsoft/WinGet/Packages"); try { const d = fs.readdirSync(p).find(x => x.startsWith("yt-dlp.yt-dlp")); if (d) return path.join(p, d, "yt-dlp.exe"); } catch {} return "yt-dlp"; })();
const PASTA = "~/ordemtracker", CONTAINER = "ordemtracker-app-1";
const ssh = cmd => execFileSync(BIN("ssh"), ["-i", CHAVE, "-o", "BatchMode=yes", SSH, cmd], { encoding: "utf8", maxBuffer: 1 << 24 });
// quem já falhou só tenta de novo depois de 6 h (vídeo ainda processando no YouTube, gravação apagada...)
const ESTADO = path.join(RAIZ, "dados", "cortes-pc.json");
const estado = (() => { try { return JSON.parse(fs.readFileSync(ESTADO, "utf8")); } catch { return {}; } })();
const log = (...a) => console.log(new Date().toLocaleString("pt-BR"), ...a);

const pendentes = JSON.parse(ssh(`cd ${PASTA} && python3 -c '
import json, os
eps = json.load(open("dados/episodios.json"))
out = []
for e in eps.get("lista", []):
    v = e.get("video")
    if not v or e.get("cortes"): continue
    try: feito = json.load(open("dados/cortes/" + e["id"] + ".json")).get("video") == v
    except Exception: feito = False
    if not feito: out.append([e["id"], v])
print(json.dumps(out))'`));

for (const [id, video] of pendentes) {
  const chave = id + ":" + video;
  if (Date.now() - (estado[chave] || 0) < 6 * 3600e3) continue;
  estado[chave] = Date.now(); fs.mkdirSync(path.dirname(ESTADO), { recursive: true }); fs.writeFileSync(ESTADO, JSON.stringify(estado));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortes-"));
  try {
    log(id, "baixando o áudio do vídeo", video);
    execFileSync(YTDLP, ["--js-runtimes", "node", "-q", "--no-warnings", "-f", "worstaudio", "-o", path.join(tmp, "v.%(ext)s"), "https://www.youtube.com/watch?v=" + video], { stdio: "inherit" });
    const arq = fs.readdirSync(tmp).find(f => f.startsWith("v."));
    // volume é medido aqui, no PC, com a mesma conta do servidor
    const bin = path.join(tmp, id + ".video.bin");
    execFileSync(process.execPath, ["-e", `require(${JSON.stringify(path.join(RAIZ, "src", "cortes.js"))}).volumes(${JSON.stringify(path.join(tmp, arq))}).then(v => require("fs").writeFileSync(${JSON.stringify(bin)}, Buffer.from(v.buffer)))`], { stdio: "inherit" });
    ssh(`mkdir -p ${PASTA}/dados/cortes`);
    execFileSync(BIN("scp"), ["-q", "-i", CHAVE, "-o", "BatchMode=yes", path.basename(bin), `${SSH}:${PASTA}/dados/cortes/`], { cwd: tmp }); // nome sem "C:", que o scp leria como servidor
    log(id, "comparando com a gravação da live");
    log(id, "cortes:", ssh(`sudo docker exec ${CONTAINER} node src/cortes.js ${id} ${video}`).trim());
  } catch (e) { log(id, "não deu:", String(e.stderr || e.message).trim().split("\n").at(-1)); }
  finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
if (!pendentes.length) log("nenhum vídeo novo sem cortes");
