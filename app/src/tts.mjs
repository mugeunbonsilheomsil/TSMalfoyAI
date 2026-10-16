// 음성 출력: tsm-tts-server(상주, Qwen3-TTS) 관리 + 문장 단위 큐. 안 쓰면 3분 뒤 스스로 내려간다.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

export class Voice {
  /** cfg: { runtimeDir, serverExe(원본), model, mmproj, speaker, gpu, outDir, logFile } */
  constructor(cfg) { this.cfg = { ...cfg, temperature: Number.isFinite(cfg.temperature) ? cfg.temperature : 0.5 }; this.proc = null; this.ready = null; this.pending = new Map(); this.seq = 0; this.lastUse = 0; }
  available() { return [this.cfg.model, this.cfg.mmproj, this.cfg.speaker, this.cfg.serverExe].every((f) => f && fs.existsSync(f)); }

  async ensure() {
    this.lastUse = Date.now();
    if (this.proc) return this.ready;
    // ggml 백엔드 DLL 은 exe 옆에서 찾으므로 런타임 폴더로 복사해서 실행
    const exe = path.join(this.cfg.runtimeDir, "tsm-tts-server.exe");
    const src = fs.statSync(this.cfg.serverExe);   // 크기만 비교하면 같은 크기로 다시 빌드한 exe 가 교체되지 않는다
    if (!fs.existsSync(exe) || fs.statSync(exe).size !== src.size || fs.statSync(exe).mtimeMs < src.mtimeMs) fs.copyFileSync(this.cfg.serverExe, exe);
    fs.mkdirSync(this.cfg.outDir, { recursive: true });
    const args = ["-m", this.cfg.model, "--mmproj", this.cfg.mmproj, "-ngl", this.cfg.gpu ? "99" : "0", "--temp", String(this.cfg.temperature), "--seed", "7",
      "-c", "1024", "-b", "128", "-ub", "128", ...(this.cfg.gpu ? [] : ["--no-mmproj-offload"])];   // 한 문장 = 텍스트 ~150 + 최대 600 프레임. 기본값(학습 컨텍스트·512 배치)은 VRAM 4.1GB → 2.8GB
    const p = spawn(exe, args, { cwd: this.cfg.runtimeDir, windowsHide: true });
    this.proc = p; p.stderr.pipe(fs.createWriteStream(this.cfg.logFile, { flags: "w" }));
    this.ready = new Promise((res, rej) => {
      const rl = readline.createInterface({ input: p.stdout });
      rl.on("line", (line) => {
        let j; try { j = JSON.parse(line); } catch { return; }
        if (j.ready) return res();
        const cb = this.pending.get(j.id); if (cb) { this.pending.delete(j.id); j.ok ? cb.res(j) : cb.rej(new Error(j.error)); }
      });
      p.on("exit", () => { this.proc = null; for (const cb of this.pending.values()) cb.rej(new Error("음성 엔진 종료")); this.pending.clear(); rej(new Error("음성 엔진이 시작하지 못했습니다")); });
    });
    clearInterval(this.idle);
    this.idle = setInterval(() => { if (this.proc && !this.pending.size && Date.now() - this.lastUse > 3 * 60000) this.stop(); }, 15000);
    return this.ready;
  }
  stop() { clearInterval(this.idle); if (this.proc) { try { this.proc.stdin.write('{"cmd":"quit"}\n'); } catch {} const p = this.proc; setTimeout(() => { try { p.kill(); } catch {} }, 1500); this.proc = null; } }

  /** 한 문장 → WAV 파일 경로 */
  async say(text) {
    await this.ensure(); this.lastUse = Date.now();
    const id = String(++this.seq), out = path.join(this.cfg.outDir, `s${id % 50}.wav`);
    const frames = Math.min(600, 40 + text.length * 9);
    const job = new Promise((res, rej) => this.pending.set(id, { res, rej }));
    this.proc.stdin.write(JSON.stringify({ id, text, lang: "ko", speaker: this.cfg.speaker, out, seed: 7, max_frames: frames }) + "\n");
    await job; return out;
  }
}

/** 말할 부분만: 괄호 지문 제거. 스토리는 큰따옴표 안의 대사만 */
export function speakable(text, story = false) {
  if (story) return (text.match(/"([^"]{1,300})"|“([^”]{1,300})”/g) || []).map((s) => s.replace(/^["“]|["”]$/g, "")).join(" ");
  return text.replace(/\([^()]{0,160}\)/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/** 스트리밍 텍스트를 문장 단위로 끊어 순서대로 합성 → onAudio(file) */
export class Speaker {
  constructor(voice, onAudio, { story = false } = {}) { this.voice = voice; this.onAudio = onAudio; this.story = story; this.sent = 0; this.chain = Promise.resolve(); this.cancelled = false; }
  feed(full, final = false) {
    const text = speakable(full, this.story);
    const rest = text.slice(this.sent);
    const re = /[^.!?…~\n]*[.!?…~\n]+["”']?/g; let m, cut = 0;
    while ((m = re.exec(rest))) { if (m[0].trim().length >= 4) cut = m.index + m[0].length; }
    if (final) cut = rest.length;
    if (cut > 0) { const piece = rest.slice(0, cut).trim(); this.sent += cut; if (piece) this.enqueue(piece); }
  }
  enqueue(piece) {
    this.chain = this.chain.then(async () => { if (this.cancelled) return; try { const f = await this.voice.say(piece); if (!this.cancelled) this.onAudio(f, piece); } catch (e) { console.error("tts", e.message); } });
  }
  cancel() { this.cancelled = true; }
  done() { return this.chain; }
}
