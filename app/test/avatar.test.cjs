const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function load(extra = {}) {
  const context = { window: {}, Image: class { decode() { return Promise.resolve(); } }, performance: { now: () => 0 }, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, Uint8Array, atob: s => Buffer.from(s, 'base64').toString('binary') };
  Object.assign(context, extra); vm.createContext(context);
  for (const file of ['avatar.js', 'voice.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../ui', file), 'utf8'), context);
  return context.window;
}
test('raw RMS gates mouth states; silence and invalid samples close it', () => {
  const { mouthForRms } = load().MalfoyAvatarMotion;
  for (const rms of [0, .017, NaN, undefined]) assert.equal(mouthForRms(rms), 'rest');
  assert.equal(mouthForRms(.02), 'small'); assert.equal(mouthForRms(.1), 'open'); assert.equal(mouthForRms(.2), 'wide');
  assert.equal(mouthForRms(.1, 'round'), 'round'); assert.equal(mouthForRms(0, 'round'), 'rest');
});
test('blink start intervals stay within asset contract; seeking is deterministic', () => {
  const { blinkAt } = load().MalfoyAvatarMotion;
  let previous = 'open'; const starts = [];
  for (let ms = 0; ms < 120000; ms++) { const current = blinkAt(ms / 1000); if (previous === 'open' && current === 'half') starts.push(ms); previous = current; }
  assert.ok(starts.length > 20);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 2600 && starts[i] - starts[i - 1] <= 5800);
  const forward = [0, 2.7, 4, 8, 15].map(t => blinkAt(t));
  assert.deepEqual([15, 8, 4, 2.7, 0].map(t => blinkAt(t)).reverse(), forward);
});
test('cancellation immediately resets mouth without resetting blink or emotion', () => {
  const api = load(), image = { dataset: {} }, avatar = new api.MalfoyAvatar(image, { emotion: 'flustered' });
  avatar.setOutputLevel(.2, 200); avatar.render(4);
  assert.equal(image.dataset.mouth, 'wide');
  const eyes = image.dataset.eyes; avatar.elapsed = 4; avatar.stopSpeaking();
  assert.equal(image.dataset.mouth, 'rest'); assert.equal(image.dataset.emotion, 'flustered'); assert.equal(image.dataset.eyes, eyes);
});
test('microphone activity never reaches character output meter', () => {
  const api = load(); let output, combined;
  const io = new api.VoiceIO({ onOutputLevel: x => output = x, onLevel: x => combined = x });
  io.speaking = true; io.micLevel = 1; io._meter();
  assert.equal(combined, 1); assert.equal(output, 0);
});
test('cancel during asynchronous decode prevents stale playback', async () => {
  const api = load(); let resolveDecode, starts = 0, end = 0;
  const io = new api.VoiceIO({ onPlayEnd: () => end++ });
  io.ctx = { decodeAudioData: () => new Promise(r => resolveDecode = r), createBufferSource: () => ({ connect() {}, start() { starts++; } }) };
  io.play('AA=='); assert.equal(io.isPlaying, true); io.stopPlayback(); resolveDecode({});
  await new Promise(setImmediate);
  assert.equal(starts, 0); assert.equal(io.isPlaying, false); assert.equal(end, 1);
});
test('queued chunks cannot overlap while decoding', async () => {
  const api = load(); let decodes = 0, resolveDecode; const sources = [];
  const io = new api.VoiceIO({});
  io.ctx = { decodeAudioData: () => { decodes++; return new Promise(r => resolveDecode = r); }, createBufferSource: () => { const s = { connect() {}, start() {} }; sources.push(s); return s; } };
  io.play('AA=='); io.play('AQ=='); assert.equal(decodes, 1);
  resolveDecode({}); await new Promise(setImmediate); assert.equal(sources.length, 1); assert.equal(decodes, 1);
  sources[0].onended(); assert.equal(decodes, 2);
  io.stopPlayback(); resolveDecode({}); await new Promise(setImmediate); assert.equal(sources.length, 1);
});
test('closing while microphone permission is pending releases the late stream', async () => {
  let resolveStream, stopped = 0;
  const api = load({ navigator: { mediaDevices: { getUserMedia: () => new Promise(r => resolveStream = r) } } });
  const io = new api.VoiceIO({});
  const starting = io.start(); io.stop();
  resolveStream({ getTracks: () => [{ stop: () => stopped++ }] }); await starting;
  assert.equal(stopped, 1); assert.equal(io.stream, undefined);
});
