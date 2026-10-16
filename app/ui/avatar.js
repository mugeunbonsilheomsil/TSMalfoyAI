"use strict";
// Shared by the live voice overlay and deterministic video scenes. Levels are
// raw RMS from the character's output audio, never the microphone meter.
(() => {
  const EMOTIONS = ["neutral", "smug", "happy", "flustered", "jealous", "angry", "sad", "worried", "surprised", "suspicious", "playful", "relieved", "shy", "deflated"];
  const MOUTHS = ["rest", "small", "open", "round", "wide", "narrow"];
  const EYES = ["open", "half", "closed"];
  const noise = (n) => { const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); };
  function blinkAt(seconds, seed = 7) {
    let start = 2.6 + noise(seed) * 3.2, index = 1;
    while (start + .155 <= seconds) start += 2.6 + noise(seed + index++) * 3.2;
    const phase = seconds - start;
    return phase < 0 || phase >= .155 ? "open" : phase < .045 || phase >= .110 ? "half" : "closed";
  }
  function mouthForRms(rms, viseme) {
    if (!Number.isFinite(rms) || rms < .018) return "rest";
    if (MOUTHS.includes(viseme)) return viseme;
    return rms < .075 ? "small" : rms < .16 ? "open" : "wide";
  }
  class MalfoyAvatar {
    constructor(image, { assetRoot = "tsm-avatar://assets/", emotion = "neutral", seed = 7 } = {}) {
      this.image = image; this.assetRoot = assetRoot.replace(/\/?$/, "/"); this.seed = seed;
      this.emotion = EMOTIONS.includes(emotion) ? emotion : "neutral";
      this.mouth = "rest"; this.level = 0; this.lastChange = -Infinity; this.lastVoiced = -Infinity;
      this.cache = new Map(); this.preload(this.emotion); this.render(0);
    }
    preload(emotion = this.emotion) {
      const loading = [];
      for (const mouth of MOUTHS) for (const eyes of EYES) {
        const url = `${this.assetRoot}frames/${emotion}/${mouth}_${eyes}.png`;
        if (!this.cache.has(url)) {
          const img = new Image(); img.src = url;
          this.cache.set(url, img.decode().catch(() => {}));
        }
        loading.push(this.cache.get(url));
      }
      return Promise.all(loading);
    }
    setEmotion(emotion) {
      this.emotion = EMOTIONS.includes(emotion) ? emotion : "neutral";
      return this.preload(this.emotion);
    }
    setOutputLevel(rms, now = performance.now()) {
      this.level = Math.max(0, Number(rms) || 0);
      if (this.level >= .018) this.lastVoiced = now;
      let next = mouthForRms(this.level);
      if (next === "rest" && now - this.lastVoiced < 110) next = this.mouth;
      if (next !== this.mouth && now - this.lastChange >= 60) { this.mouth = next; this.lastChange = now; }
    }
    stopSpeaking() { this.level = 0; this.mouth = "rest"; this.lastVoiced = -Infinity; this.lastChange = -Infinity; this.render(this.elapsed || 0); }
    render(seconds, { rms, emotion, viseme } = {}) {
      if (emotion) this.emotion = EMOTIONS.includes(emotion) ? emotion : "neutral";
      const mouth = rms == null ? this.mouth : mouthForRms(rms, viseme);
      const eyes = blinkAt(Math.max(0, seconds), this.seed);
      const src = `${this.assetRoot}frames/${this.emotion}/${mouth}_${eyes}.png`;
      if (src !== this.currentSrc) { this.image.src = src; this.currentSrc = src; }
      this.image.dataset.emotion = this.emotion; this.image.dataset.mouth = mouth; this.image.dataset.eyes = eyes;
    }
    start() {
      if (this.raf != null) return;
      const started = performance.now();
      const tick = (now) => { this.elapsed = (now - started) / 1000; this.setOutputLevel(this.level, now); this.render(this.elapsed); this.raf = requestAnimationFrame(tick); };
      this.raf = requestAnimationFrame(tick);
    }
    stop() { cancelAnimationFrame(this.raf); this.raf = null; this.stopSpeaking(); }
  }
  window.MalfoyAvatar = MalfoyAvatar;
  window.MalfoyAvatarMotion = { blinkAt, mouthForRms, emotions: EMOTIONS, mouths: MOUTHS, eyes: EYES };
})();
