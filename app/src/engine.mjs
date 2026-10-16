// 로컬 엔진: llama-server 를 127.0.0.1 에만 띄운다.
//  · 슬롯 0 = 지금 대화 (KV 캐시 유지), 슬롯 1 = 보조 작업(기억 정리·제목·요약) → 대화 캐시를 건드리지 않음
//  · KV 캐시 q8_0 양자화 + kv-unified 로 긴 컨텍스트를 적은 메모리에
//  · 대화를 바꿀 때 슬롯 0 의 KV 를 파일로 저장/복원 → 이전 대화로 돌아가도 다시 계산하지 않음
//  · 일정 시간 안 쓰면 스스로 내려 VRAM 반환
import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";

const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Engine {
  /** cfg: { exe, model, mmproj?, lora?, draft?, gpu, ctx, kv?, cacheRamMB?, mmprojGpu?, lazyMedia?, idleMinutes, logFile, slotDir }
   *  lazyMedia: 이미지·음성 인식기(mmproj)를 처음엔 빼고 띄우고, 사진·음성이 처음 올 때 한 번 다시 띄운다 (글 대화만 할 땐 그만큼 VRAM 절약) */
  constructor(cfg) { this.cfg = cfg; this.proc = null; this.port = 0; this.starting = null; this.lastUse = Date.now(); this.listeners = new Set(); this.hold = 0; this.slotOwner = null; }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(state, extra = {}) { this.state = state; for (const fn of this.listeners) fn({ state, ...extra }); }
  hasLora() { return !!(this.cfg.lora && fs.existsSync(this.cfg.lora)); }

  args() {
    const c = this.cfg;
    const a = ["-m", c.model, "--host", "127.0.0.1", "--port", String(this.port), "-c", String(c.ctx), "--jinja", "--no-webui",
      "-np", "2", "--kv-unified", "-ctk", c.kv || "q8_0", "-ctv", c.kv || "q8_0", "--slot-save-path", c.slotDir,
      // 프롬프트 캐시는 기본 8GB 까지 RAM 을 늘려 씀 → 상한. SWA 체크포인트도 슬롯당 4개면 충분
      "--cache-ram", String(c.cacheRamMB ?? 1024), "--ctx-checkpoints", "4"];
    if (c.gpu) a.push("-ngl", "99", "-fa", "on"); else a.push("-ngl", "0");
    if (c.mmproj && fs.existsSync(c.mmproj) && (!c.lazyMedia || this.media)) a.push("--mmproj", c.mmproj, ...(c.gpu && c.mmprojGpu === false ? ["--no-mmproj-offload"] : []));
    if (this.hasLora()) a.push("--lora", c.lora);                                       // --lora-scaled 은 D:/ 경로에서 ':' 때문에 깨짐
    if (c.draft && fs.existsSync(c.draft)) a.push("-md", c.draft, "--spec-type", "draft-mtp", ...(c.gpu ? ["-ngld", "99"] : []));
    return a;
  }

  async ensure({ media = false } = {}) {
    this.lastUse = Date.now();
    if (media && this.cfg.lazyMedia && !this.media) {
      if (this.starting) await this.starting.catch(() => {});
      this.media = true;
      if (this.proc) { while (this.busy) await sleep(100); await this.stop(); this.media = true; }   // stop() 이 대화 KV 를 저장한다
    }
    if (this.proc && this.state === "ready") return;
    if (this.starting) return this.starting;
    this.starting = this._start().finally(() => (this.starting = null));
    return this.starting;
  }
  async _start() {
    this.emit("starting");
    fs.mkdirSync(this.cfg.slotDir, { recursive: true });
    this.port = await freePort(); this.slotOwner = null;
    const log = fs.createWriteStream(this.cfg.logFile, { flags: "w" });
    const p = spawn(this.cfg.exe, this.args(), { cwd: path.dirname(this.cfg.exe), windowsHide: true });
    this.proc = p; p.stdout.pipe(log); p.stderr.pipe(log);
    p.on("exit", (code) => { if (this.proc === p) { this.proc = null; this.slotOwner = null; this.emit("stopped", { code }); } });
    const t0 = Date.now();
    while (Date.now() - t0 < 240000) {
      if (!this.proc) throw new Error("엔진이 시작하지 못했습니다");
      try { const r = await fetch(`http://127.0.0.1:${this.port}/health`); if (r.ok) { this.emit("ready", { ms: Date.now() - t0 }); this._armIdle(); return; } } catch {}
      await sleep(300);
    }
    this.stop(); throw new Error("엔진 시작 시간 초과");
  }
  _armIdle() {
    clearInterval(this.idleTimer);
    this.idleTimer = setInterval(() => {
      const mins = this.cfg.idleMinutes ?? 10;
      if (mins && this.proc && !this.busy && !this.hold && Date.now() - this.lastUse > mins * 60000) this.stop();
    }, 20000);
  }
  async stop() {
    clearInterval(this.idleTimer); this.media = false;                                 // 다음 시작은 다시 글 전용으로
    if (!this.proc) return;
    if (this.slotOwner) await this.saveSlot(this.slotOwner).catch(() => {});
    const p = this.proc; this.proc = null; try { p.kill(); } catch {} this.emit("stopped");
  }

  async _post(pathname, body, signal) {
    const r = await fetch(`http://127.0.0.1:${this.port}${pathname}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
    if (!r.ok) throw new Error(`엔진 오류 ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r;
  }

  // ── 대화별 KV 캐시 ──
  slotFile(convId) { return `conv-${convId}.bin`; }
  async saveSlot(convId) { if (!this.proc) return; await this._post("/slots/0?action=save", { filename: this.slotFile(convId) }); this.pruneSlots(); }
  /** 슬롯 0 을 이 대화로 바꾼다. 저장된 캐시가 있으면 복원(없으면 다음 요청 때 계산) */
  async useConversation(convId) {
    await this.ensure();
    if (this.slotOwner === convId) return;
    if (this.slotOwner) await this.saveSlot(this.slotOwner).catch(() => {});
    const f = path.join(this.cfg.slotDir, this.slotFile(convId));
    if (fs.existsSync(f)) { try { await this._post("/slots/0?action=restore", { filename: this.slotFile(convId) }); fs.utimesSync(f, new Date(), new Date()); } catch {} }
    else { try { await this._post("/slots/0?action=erase", {}); } catch {} }
    this.slotOwner = convId;
  }
  dropSlot(convId) { fs.rmSync(path.join(this.cfg.slotDir, this.slotFile(convId)), { force: true }); if (this.slotOwner === convId) this.slotOwner = null; }
  /** 디스크 캐시 자동 정리: 최근 4개, 합계 3 GB 까지 */
  pruneSlots(keep = 4, maxBytes = 3e9) {
    try {
      const files = fs.readdirSync(this.cfg.slotDir).filter((f) => f.startsWith("conv-")).map((f) => { const p = path.join(this.cfg.slotDir, f); const s = fs.statSync(p); return { p, t: s.mtimeMs, n: s.size }; }).sort((a, b) => b.t - a.t);
      let total = 0;
      files.forEach((f, i) => { total += f.n; if (i >= keep || total > maxBytes) fs.rmSync(f.p, { force: true }); });
    } catch {}
  }

  /** 채팅 완성. slot 0 = 대화, 1 = 보조. onToken(delta, full) 이 있으면 스트리밍. 반환 { text, promptTokens } */
  async chat(messages, { onToken, signal, slot = 0, maxTokens = 400, temperature = 0.8, loraScale, json } = {}) {
    const media = messages.some((m) => Array.isArray(m.content) && m.content.some((c) => c.type === "image_url" || c.type === "input_audio"));
    await this.ensure({ media }); this.busy = true; this.lastUse = Date.now();
    try {
      const body = { messages, stream: !!onToken, max_tokens: maxTokens, temperature, top_p: 0.95, top_k: 64, min_p: 0.05, repeat_penalty: 1.08,
        id_slot: slot, cache_prompt: true, chat_template_kwargs: { enable_thinking: false } };   // 생각 모드를 끄지 않으면 E4B가 생각 과정을 본문에 쏟아냄(실측)
      if (onToken) body.stream_options = { include_usage: true };
      if (loraScale !== undefined && this.hasLora()) body.lora = [{ id: 0, scale: loraScale }];
      if (json) body.response_format = { type: "json_schema", json_schema: { schema: json } };
      const res = await this._post("/v1/chat/completions", body, signal);
      if (!onToken) { const j = await res.json(); return { text: j.choices[0].message.content || "", promptTokens: j.usage?.prompt_tokens || 0 }; }
      let full = "", buf = "", promptTokens = 0; const dec = new TextDecoder();
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true }); let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line.startsWith("data:")) continue; const data = line.slice(5).trim(); if (data === "[DONE]") continue;
          try { const j = JSON.parse(data); const d = j.choices?.[0]?.delta?.content; if (d) { full += d; onToken(d, full); } if (j.usage) promptTokens = j.usage.prompt_tokens; } catch {}
        }
      }
      return { text: full, promptTokens };
    } finally { this.busy = false; this.lastUse = Date.now(); }
  }
}
