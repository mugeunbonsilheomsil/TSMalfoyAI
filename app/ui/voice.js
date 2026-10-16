"use strict";
// 라이브 음성 입출력 (렌더러): 마이크 → 발화 구간 감지(VAD) → 16 kHz WAV, 그리고 말포이 음성 재생 큐
// 사용: const io = new VoiceIO({ onUtterance(wavB64), onLevel(0..1), onSpeechStart() }); await io.start(); io.play(b64); io.stop();
class VoiceIO {
  constructor(h) { this.h = h; this.muted = false; this.queue = []; this.playing = null; this.decoding = false; this.playbackVersion = 0; this.stopped = false; }

  async start() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    if (this.stopped) { stream.getTracks().forEach((track) => track.stop()); return; }
    this.stream = stream;
    this.ctx = new AudioContext({ sampleRate: 16000 });
    this.src = this.ctx.createMediaStreamSource(this.stream);
    this.proc = this.ctx.createScriptProcessor(1024, 1, 1);                         // 64 ms 프레임
    this.outGain = this.ctx.createGain(); this.outAnalyser = this.ctx.createAnalyser(); this.outAnalyser.fftSize = 512;
    this.outGain.connect(this.outAnalyser); this.outAnalyser.connect(this.ctx.destination);
    this.src.connect(this.proc); this.proc.connect(this.ctx.destination);
    this.noise = -55; this.speaking = false; this.frames = []; this.pre = []; this.voiced = 0; this.silent = 0;
    this.proc.onaudioprocess = (e) => this._frame(e.inputBuffer.getChannelData(0));
    this._meter();
  }
  stop() {
    this.stopped = true;
    cancelAnimationFrame(this.raf); this.stopPlayback();
    try { this.proc.disconnect(); this.src.disconnect(); } catch {}
    this.stream?.getTracks().forEach((t) => t.stop()); this.ctx?.close();
  }
  setMuted(m) { this.muted = m; if (m) { this.speaking = false; this.frames = []; } }

  _frame(buf) {
    const f = new Float32Array(buf);
    let sum = 0; for (let i = 0; i < f.length; i++) sum += f[i] * f[i];
    const db = 10 * Math.log10(sum / f.length + 1e-10);
    this.micLevel = Math.max(0, Math.min(1, (db - this.noise) / 30));
    if (this.muted) return;
    if (!this.speaking) {
      this.noise = db < this.noise ? db * 0.3 + this.noise * 0.7 : this.noise * 0.995 + db * 0.005;   // 소음 바닥 추적
      this.pre.push(f); if (this.pre.length > 5) this.pre.shift();                                     // 말 시작 직전 0.3 초 보존
      if (db > this.noise + 13 && db > -50) { if (++this.voiced >= 3) { this.speaking = true; this.frames = [...this.pre]; this.silent = 0; this.h.onSpeechStart?.(); } }
      else this.voiced = 0;
    } else {
      this.frames.push(f);
      if (db < this.noise + 8) this.silent++; else this.silent = 0;
      const dur = this.frames.length * 0.064;
      if (this.silent >= 12 || dur > 20) this._finish();                                                // 0.77 초 조용하면 끝
    }
  }
  _finish() {
    this.speaking = false; this.voiced = 0;
    const frames = this.frames; this.frames = [];
    const speech = frames.length - this.silent;
    if (speech * 0.064 < 0.35) return;                                                                  // 너무 짧은 소리는 무시
    this.h.onUtterance?.(this._wav(frames.slice(0, frames.length - Math.max(0, this.silent - 4))));
  }
  _wav(frames) {
    const n = frames.reduce((s, f) => s + f.length, 0), buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVE"); w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, n * 2, true);
    let o = 44; for (const f of frames) for (let i = 0; i < f.length; i++, o += 2) v.setInt16(o, Math.max(-1, Math.min(1, f[i])) * 0x7fff, true);
    let bin = ""; const bytes = new Uint8Array(buf); for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  // ── 재생 ──
  play(b64) { this.queue.push(b64); if (!this.playing && !this.decoding) this._next(); }
  async _next() {
    const b64 = this.queue.shift(); if (!b64) { this.playing = null; this.h.onPlayEnd?.(); return; }
    const version = this.playbackVersion; this.decoding = true;
    try {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const audio = await this.ctx.decodeAudioData(bytes.buffer);
      if (version !== this.playbackVersion) return;
      this.decoding = false;
      const s = this.ctx.createBufferSource(); s.buffer = audio; s.connect(this.outGain);
      this.playing = s; s.onended = () => { if (this.playing === s) { this.playing = null; this.h.onOutputLevel?.(0); this._next(); } };
      this.h.onPlayStart?.(); s.start();
    } catch { if (version === this.playbackVersion) { this.decoding = false; this.playing = null; this.h.onOutputLevel?.(0); this._next(); } }
  }
  stopPlayback() { this.playbackVersion++; this.queue = []; this.decoding = false; const p = this.playing; this.playing = null; try { p?.stop(); } catch {} this.h.onOutputLevel?.(0); this.h.onPlayEnd?.(); }
  get isPlaying() { return !!this.playing || this.decoding || this.queue.length > 0; }

  _meter() {
    const data = new Uint8Array(256);
    const tick = () => {
      let out = 0;
      if (this.playing) { this.outAnalyser.getByteTimeDomainData(data); let s = 0; for (const x of data) s += ((x - 128) / 128) ** 2; out = Math.sqrt(s / data.length); }
      this.h.onOutputLevel?.(out);
      this.h.onLevel?.(Math.max(Math.min(1, out * 4), this.speaking ? this.micLevel || 0 : 0));
      this.raf = requestAnimationFrame(tick);
    };
    tick();
  }
}
window.VoiceIO = VoiceIO;
