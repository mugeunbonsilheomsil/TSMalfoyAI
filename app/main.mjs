// TS Malfoy — Electron 메인 프로세스
import { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, Notification, nativeImage, nativeTheme, protocol } from "electron";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { JsonStore } from "./src/store.mjs";
import { detect, diskFreeGB } from "./src/hardware.mjs";
import { install } from "./src/installer.mjs";
import { Engine } from "./src/engine.mjs";
import { Conversations } from "./src/conversations.mjs";
import { Memory } from "./src/memory.mjs";
import { Brain } from "./src/brain.mjs";
import { Voice, Speaker } from "./src/tts.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const unpacked = (p) => p.replace(/app\.asar([\\/])/, "app.asar.unpacked$1");     // 외부 프로세스는 asar 안을 못 읽음
const MANIFEST = JSON.parse(fs.readFileSync(path.join(HERE, "src", "manifest.json"), "utf8"));
const PERSONA_DIR = path.join(HERE, "persona");
const LOCAL_LORA = unpacked(path.join(PERSONA_DIR, "malfoy-lora.gguf"));        // 소스 실행: app/persona 에 직접 넣은 파일
const SPEAKER = unpacked(path.join(PERSONA_DIR, "voice", "malfoy_ref.wav"));
const TTS_EXE = unpacked(path.join(HERE, "native", "tsm-tts-server.exe"));
// 말포이 전용 모델(성격 LoRA, 미세조정 TTS): app/persona 에 있으면 그것, 없으면 설치 폴더에 받은 것 (manifest 의 GitHub Release)
const releaseUrl = (f) => ({ ...f, url: f.url.replace("{release}", MANIFEST.release) });
const localOr = (local, name) => (fs.existsSync(local) ? local : path.join(cfg.get("installDir"), "models", name));
const loraPath = () => localOr(LOCAL_LORA, MANIFEST.persona.file.name);
const voicePaths = () => MANIFEST.voice.files.map((f) => localOr(unpacked(path.join(PERSONA_DIR, "voice", f.name)), f.name));
const ICON = path.join(HERE, "ui", "icon.png");
// Fixed, read-only asset namespace. Packaged builds may ship avatar-v2 as an
// extra resource; source checkouts use the existing project assets directly.
protocol.registerSchemesAsPrivileged([{ scheme: "tsm-avatar", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
function registerAvatarAssets() {
  const root = [path.join(process.resourcesPath, "avatar-v2"), path.join(HERE, "assets", "animation", "v2"), path.join(HERE, "..", "assets", "animation", "v2")]
    .find((dir) => fs.existsSync(path.join(dir, "animation.json")));
  const allowed = new Set(root ? JSON.parse(fs.readFileSync(path.join(root, "animation.json"), "utf8")).emotions.flatMap((e) => e.frames.map((f) => f.file)) : []);
  protocol.handle("tsm-avatar", async (request) => {
    const url = new URL(request.url), file = url.pathname.slice(1);
    if (request.method !== "GET" || url.hostname !== "assets" || url.search || !allowed.has(file)) return new Response(null, { status: 404 });
    try { return new Response(await fs.promises.readFile(path.join(root, file)), { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" } }); }
    catch { return new Response(null, { status: 404 }); }
  });
}

if (process.argv.includes("--dev") && process.env.TSM_USERDATA) app.setPath("userData", process.env.TSM_USERDATA);   // 개발용 격리 데이터
if (!app.requestSingleInstanceLock()) app.quit();
app.setAppUserModelId("TSMalfoy");
const DATA = app.getPath("userData");

const cfg = new JsonStore(path.join(DATA, "config.json"), {
  installDir: path.join(process.env.LOCALAPPDATA || DATA, "TSMalfoy"),
  installed: false, runtime: null, model: null, draft: false, vramGB: 0,
  perf: { ctx: 0, kv: "auto" },                       // 0 / "auto" = PC 성능에 맞춰 자동
  owlPost: true, quietStart: 23, quietEnd: 8, theme: "system", lastSeen: 0, lastMail: 0, currentConv: null,
});
nativeTheme.themeSource = cfg.get("theme");
const chrome = () => (nativeTheme.shouldUseDarkColors ? { bg: "#0a0c0b", fg: "#a6b0ab" } : { bg: "#f4f6f5", fg: "#4f5a55" });
let win = null, tray = null, engine = null, voice = null, brain = null, convs = null, memory = null, setupAbort = null, chatAbort = null, quitting = false, speaker = null;
const send = (ch, data) => win?.webContents.send(ch, data);
const applyChrome = () => { if (!win) return; const c = chrome(); win.setBackgroundColor(c.bg); try { win.setTitleBarOverlay({ color: c.bg, symbolColor: c.fg, height: 44 }); } catch {} };
nativeTheme.on("updated", applyChrome);

// ── 자원 자동 관리: PC 의 VRAM·RAM 에 맞춘 기본값 + 사용자가 설정에서 바꾼 값 ──
// 실측(RTX 4070 12GB, 2026-10-16): Gemma 컨텍스트 131072→32768 이 VRAM 1.8GB, TTS 버퍼 축소가 1.3GB.
// 대화는 컨텍스트 70% 에서 자동 요약되므로 큰 컨텍스트가 꼭 필요하지 않다.
const CTX_CHOICES = [8192, 16384, 32768, 65536, 131072];
function tune() {
  const cpu = cfg.get("runtime") === "cpu", v = cfg.get("vramGB") || 8, ram = Math.round(os.totalmem() / 2 ** 30), p = cfg.get("perf") || {};
  const auto = cpu ? { ctx: 8192, kv: "q4_0", mmprojGpu: false, ttsGpu: false }
    : v >= 10 ? { ctx: 32768, kv: "q8_0", mmprojGpu: true, ttsGpu: true }
    : v >= 7.5 ? { ctx: 24576, kv: "q8_0", mmprojGpu: true, ttsGpu: true }
    : v >= 5.5 ? { ctx: 16384, kv: "q4_0", mmprojGpu: true, ttsGpu: false }    // 두 엔진(대화 ~4GB + 목소리 2.8GB)이 같이 못 올라감 → 목소리는 CPU(실측 실시간의 1.9배 느림)
    : { ctx: 12288, kv: "q4_0", mmprojGpu: false, ttsGpu: false };
  auto.cacheRamMB = ram >= 32 ? 2048 : ram >= 16 ? 1024 : 512;              // 프롬프트 캐시 RAM 상한 (기본 8GB)
  return { auto, vramGB: cpu ? 0 : v, ramGB: ram,
    ctx: CTX_CHOICES.includes(p.ctx) ? p.ctx : auto.ctx,
    kv: ["q8_0", "q4_0"].includes(p.kv) ? p.kv : auto.kv,
    cacheRamMB: auto.cacheRamMB, mmprojGpu: auto.mmprojGpu, ttsGpu: auto.ttsGpu };
}

function paths() {
  const d = cfg.get("installDir"), m = MANIFEST.models[cfg.get("model")];
  return {
    runtimeDir: path.join(d, "runtime", cfg.get("runtime")),
    exe: path.join(d, "runtime", cfg.get("runtime"), "llama-server.exe"),
    model: path.join(d, "models", m.file.name),
    mmproj: path.join(d, "models", MANIFEST.mmproj.file.name),
    draft: cfg.get("draft") ? path.join(d, "models", MANIFEST.draft.file.name) : null,
    ttsModel: voicePaths()[0], ttsMmproj: voicePaths()[1],
  };
}
const isInstalled = () => { if (!cfg.get("installed") || !cfg.get("runtime") || !cfg.get("model")) return false; const p = paths(); return fs.existsSync(p.exe) && fs.existsSync(p.model) && fs.existsSync(p.mmproj); };

function boot() {
  if (!isInstalled()) return;
  engine?.stop(); voice?.stop();
  const p = paths(), gpu = cfg.get("runtime") !== "cpu";
  const t = tune();
  engine = new Engine({ exe: p.exe, model: p.model, mmproj: p.mmproj, draft: p.draft, lora: loraPath(), gpu, ctx: t.ctx, kv: t.kv, cacheRamMB: t.cacheRamMB, mmprojGpu: t.mmprojGpu, lazyMedia: true, idleMinutes: 10, logFile: path.join(DATA, "engine.log"), slotDir: path.join(DATA, "kv") });
  engine.on((e) => send("engine:state", e));
  voice = new Voice({ runtimeDir: p.runtimeDir, serverExe: TTS_EXE, model: p.ttsModel, mmproj: p.ttsMmproj, speaker: SPEAKER, gpu: gpu && t.ttsGpu, outDir: path.join(DATA, "voice-cache"), logFile: path.join(DATA, "voice.log") });
  convs = new Conversations(DATA); memory = new Memory(DATA);
  brain = new Brain({ personaDir: PERSONA_DIR, dataDir: DATA, engine, convs, memory, ctx: t.ctx });
  brain.onTitle = (id, title) => send("conv:title", { id, title });
  brain.onUpdate = (id, msg) => send("conv:message", { id, msg: view(msg) });
}

function createWindow() {
  const c = chrome();
  win = new BrowserWindow({
    width: 1180, height: 800, minWidth: 880, minHeight: 600, show: false, backgroundColor: c.bg, title: "TS Malfoy", icon: ICON,
    autoHideMenuBar: true, titleBarStyle: "hidden", titleBarOverlay: { color: c.bg, symbolColor: c.fg, height: 44 },
    webPreferences: { preload: path.join(HERE, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.removeMenu();
  win.loadFile(path.join(HERE, "ui", "index.html"));
  win.once("ready-to-show", () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: "deny" }; });
  win.webContents.session.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === "media"));     // 마이크만 허용
  win.on("close", (e) => { if (!quitting && cfg.get("owlPost") && isInstalled()) { e.preventDefault(); win.hide(); engine?.stop(); voice?.stop(); } });
}
function showWindow(v) { if (!win) createWindow(); win.show(); win.focus(); if (v) send("nav", v); }
function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip("TS Malfoy");
  tray.setContextMenu(Menu.buildFromTemplate([{ label: "열기", click: () => showWindow() }, { label: "우편함", click: () => showWindow("mail") }, { type: "separator" }, { label: "종료", click: () => { quitting = true; app.quit(); } }]));
  tray.on("click", () => showWindow());
}

// ── 부엉이 우편 ──
let mailBusy = false;
async function mailTick() {
  if (mailBusy || !brain || !cfg.get("owlPost")) return;
  const due = brain.dueMail({ quietStart: cfg.get("quietStart"), quietEnd: cfg.get("quietEnd"), lastSeen: cfg.get("lastSeen"), lastMail: cfg.get("lastMail") });
  if (!due) return;
  mailBusy = true;
  try {
    const letter = await brain.writeMail(due); cfg.set("lastMail", Date.now()); send("mail:new", letter);
    if (Notification.isSupported()) { const n = new Notification({ title: "부엉이가 편지를 물고 왔습니다", body: letter.text.replace(/\s+/g, " ").slice(0, 90), icon: ICON }); n.on("click", () => showWindow("mail")); n.show(); }
  } catch (e) { console.error("mail", e); } finally { mailBusy = false; }
}

// ── IPC ──
const handle = (ch, fn) => ipcMain.handle(ch, async (_e, ...a) => { try { return { ok: true, data: await fn(...a) }; } catch (e) { return { ok: false, error: e.message || String(e) }; } });
function view(m) {
  return { id: m.id, role: m.role, t: m.t, text: Conversations.text(m), alts: m.alts?.length || 1, alt: m.alt ?? (m.alts ? m.alts.length - 1 : 0), rating: m.rating, voice: m.voice, opening: m.opening,
    images: (m.images || []).filter((f) => fs.existsSync(f)).map((f) => "data:image/" + path.extname(f).slice(1).replace("jpg", "jpeg") + ";base64," + fs.readFileSync(f).toString("base64")) };
}
const meta = (c) => ({ id: c.id, type: c.type, title: c.title, updated: c.updated, created: c.created });
const stream = (convId) => (_d, full) => send("chat:token", { convId, full });
const touch = () => cfg.set("lastSeen", Date.now());
const audioOut = (convId) => (file, piece) => send("voice:audio", { convId, b64: fs.readFileSync(file).toString("base64"), text: piece });

handle("app:state", () => ({ installed: isInstalled(), config: { theme: cfg.get("theme"), owlPost: cfg.get("owlPost"), quietStart: cfg.get("quietStart"), quietEnd: cfg.get("quietEnd"), perf: cfg.get("perf") }, perf: tune(), version: app.getVersion(),
  hasLora: fs.existsSync(loraPath()), engine: engine?.state || "stopped", current: cfg.get("currentConv") }));

handle("setup:detect", async () => {
  const hw = await detect(); const dir = cfg.get("installDir"); fs.mkdirSync(dir, { recursive: true });
  const sz = (list) => list.reduce((s, f) => s + f.size, 0);
  return { hw, dir, freeGB: diskFreeGB(dir), manifest: {
    runtimes: Object.fromEntries(Object.entries(MANIFEST.runtimes).map(([k, v]) => [k, { label: v.label, size: sz(v.files) }])),
    models: Object.fromEntries(Object.entries(MANIFEST.models).map(([k, v]) => [k, { label: v.label, size: v.file.size + MANIFEST.mmproj.file.size + (fs.existsSync(LOCAL_LORA) ? 0 : MANIFEST.persona.file.size), minVramGB: v.minVramGB }])),   // 말포이 성격 LoRA 포함
    draft: { label: MANIFEST.draft.label, size: MANIFEST.draft.file.size } } };
});
handle("setup:chooseDir", async () => {
  const r = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"], defaultPath: cfg.get("installDir") });
  if (r.canceled || !r.filePaths[0]) return null;
  const dir = path.join(r.filePaths[0], path.basename(r.filePaths[0]).toLowerCase() === "tsmalfoy" ? "" : "TSMalfoy");
  fs.mkdirSync(dir, { recursive: true }); cfg.set("installDir", dir); return { dir, freeGB: diskFreeGB(dir) };
});
handle("setup:start", async ({ runtime, model, draft, vramGB }) => {
  const dir = cfg.get("installDir"), rt = MANIFEST.runtimes[runtime], md = MANIFEST.models[model];
  if (!rt || !md) throw new Error("잘못된 선택");
  const plan = [
    { id: "runtime", items: rt.files.map((f) => ({ ...f, dest: path.join(dir, "downloads", path.basename(f.url)), unzipTo: path.join(dir, "runtime", runtime) })) },
    { id: "model", items: [{ ...md.file, dest: path.join(dir, "models", md.file.name) }, { ...MANIFEST.mmproj.file, dest: path.join(dir, "models", MANIFEST.mmproj.file.name) }] },
  ];
  if (draft) plan.push({ id: "draft", items: [{ ...MANIFEST.draft.file, dest: path.join(dir, "models", MANIFEST.draft.file.name) }] });
  if (!fs.existsSync(LOCAL_LORA)) plan[1].items.push({ ...releaseUrl(MANIFEST.persona.file), dest: path.join(dir, "models", MANIFEST.persona.file.name) });
  setupAbort = new AbortController();
  await install(plan, { signal: setupAbort.signal, onStep: (s) => send("setup:step", s), onProgress: (p) => send("setup:progress", p) });
  fs.rmSync(path.join(dir, "downloads"), { recursive: true, force: true });
  cfg.patch({ installed: true, runtime, model, draft: !!draft, vramGB: vramGB || 0 });
  boot();
  send("setup:step", { id: "check", state: "running" }); await engine.ensure(); send("setup:step", { id: "check", state: "done" });
  return true;
});
handle("setup:cancel", () => { setupAbort?.abort(); return true; });

// 대화 목록
handle("conv:list", () => convs.list().map(meta));
handle("conv:open", async (id) => {
  const c = convs.get(id); if (!c) throw new Error("없는 대화");
  const prev = cfg.get("currentConv"); cfg.set("currentConv", id);
  if (prev && prev !== id) brain.leave(prev);                                          // 떠난 대화는 장기 기억에 한 문단으로
  engine.useConversation(id).catch(() => {});                                         // KV 캐시 미리 복원 (기다리지 않음)
  return { ...meta(c), world: c.world, messages: c.messages.map(view), suggestions: brain.suggestions(c) };
});
handle("conv:new", () => meta(convs.create({ type: "chat" })));
handle("conv:delete", (id) => { convs.remove(id); engine?.dropSlot(id); if (cfg.get("currentConv") === id) cfg.set("currentConv", null); return true; });
handle("conv:rename", (id, title) => { convs.rename(id, String(title).slice(0, 40)); return true; });

// 대화
handle("chat:send", async (convId, { text = "", images = [] } = {}) => {
  touch(); chatAbort = new AbortController();
  const r = await brain.send(convId, { text: String(text).slice(0, 4000), images: images.slice(0, 4) }, { signal: chatAbort.signal, onToken: stream(convId) });
  return { user: view(r.user), bot: view(r.bot) };
});
handle("chat:regenerate", async (convId) => { chatAbort = new AbortController(); return view(await brain.regenerate(convId, { signal: chatAbort.signal, onToken: stream(convId) })); });
handle("chat:alt", (convId, msgId, alt) => view(brain.setAlt(convId, msgId, alt)));
handle("chat:rate", (convId, msgId, v) => view(brain.rate(convId, msgId, v)));
handle("chat:stop", () => { chatAbort?.abort(); speaker?.cancel(); return true; });

// 스토리
handle("story:points", () => brain.points.map((p) => ({ id: p.id, title: p.title, year: p.school_year, time: p.time, location: p.location, situation: p.situation })));
handle("story:create", async (opts) => { touch(); return meta(await brain.createStory(opts || {})); });
handle("story:begin", async (convId) => { chatAbort = new AbortController(); return view(await brain.beginStory(convId, { signal: chatAbort.signal, onToken: stream(convId) })); });

// 음성 (라이브 대화) — 듣기는 Gemma 가 직접, 말하기는 상주 TTS
handle("voice:status", () => ({ ready: voice.available(), size: MANIFEST.voice.files.reduce((s, f) => s + f.size, 0) }));
handle("voice:install", async () => {
  const dir = cfg.get("installDir");
  await install([{ id: "voice", items: MANIFEST.voice.files.map((f) => ({ ...releaseUrl(f), dest: path.join(dir, "models", f.name) })) }], { onProgress: (p) => send("voice:progress", p) });
  return voice.available();
});
handle("voice:warm", async () => { engine.hold++; try { await Promise.all([engine.ensure({ media: true }), voice.ensure()]); } finally { engine.hold--; } return true; });
handle("voice:turn", async (convId, wavB64) => {
  touch(); chatAbort = new AbortController(); speaker?.cancel();
  const conv = convs.get(convId);
  const sp = (speaker = new Speaker(voice, audioOut(convId), { story: conv?.type === "story" }));
  const r = await brain.send(convId, { audio: wavB64 }, { signal: chatAbort.signal, onToken: (_d, full) => { send("chat:token", { convId, full }); sp.feed(full); } });
  sp.feed(Conversations.text(r.bot), true);
  sp.done().then(() => send("voice:spoken", { convId }));
  return { user: view(r.user), bot: view(r.bot) };
});
handle("voice:read", async (convId, msgId) => {                                         // 메시지 하나 읽어 주기
  const c = convs.get(convId), m = c?.messages.find((x) => x.id === msgId); if (!m) return false;
  speaker?.cancel(); const sp = (speaker = new Speaker(voice, audioOut(convId), { story: c.type === "story" }));
  sp.feed(Conversations.text(m), true); await sp.done(); send("voice:spoken", { convId }); return true;
});
handle("voice:stop", () => { speaker?.cancel(); return true; });

// 우편 · 설정 · 데이터
handle("mail:list", () => brain.mail());
handle("mail:read", (id) => { brain.markRead(id); return true; });
handle("mail:test", async () => { const l = await brain.writeMail({ kind: "excuse", context: "핑계: " + brain.char.excuses[0] }); send("mail:new", l); return l; });
handle("settings:set", (patch) => {
  const allowed = ["owlPost", "quietStart", "quietEnd", "theme", "perf"];
  if (patch.perf) patch.perf = { ...cfg.get("perf"), ...patch.perf };
  cfg.patch(Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k))));
  if (patch.perf && isInstalled()) boot();                                  // 엔진은 다음 대화 때 새 설정으로 다시 뜬다
  if (patch.theme) { nativeTheme.themeSource = cfg.get("theme"); applyChrome(); }
  return true;
});
handle("data:open", () => shell.openPath(DATA));
handle("data:forget", () => { memory.clear(); return true; });
handle("data:deleteAll", () => { convs.removeAll(); memory.clear(); brain.saveMail([]); fs.rmSync(path.join(DATA, "kv"), { recursive: true, force: true }); cfg.set("currentConv", null); return true; });
handle("data:reinstall", () => { engine?.stop(); voice?.stop(); cfg.patch({ installed: false }); return true; });

// ── 개발용 원격 조작 (--dev 일 때만, 127.0.0.1) ──
if (process.argv.includes("--dev")) {
  const http = await import("node:http");
  http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, "http://x");
      if (u.pathname === "/shot") { const img = await win.webContents.capturePage(); fs.writeFileSync(u.searchParams.get("out"), img.toPNG()); res.end("ok"); }
      else if (u.pathname === "/eval") { let body = ""; for await (const c of req) body += c; const r = await win.webContents.executeJavaScript(body, true); res.end(JSON.stringify(r ?? null)); }
      else { res.statusCode = 404; res.end(); }
    } catch (e) { res.statusCode = 500; res.end(String(e.stack || e)); }
  }).listen(7870, "127.0.0.1");
}

app.on("second-instance", () => showWindow());
app.whenReady().then(() => { registerAvatarAssets(); boot(); createWindow(); createTray(); setInterval(mailTick, 10 * 60000); setTimeout(mailTick, 60000); });
app.on("before-quit", () => { quitting = true; engine?.stop(); voice?.stop(); });
app.on("window-all-closed", () => { if (!cfg.get("owlPost")) app.quit(); });
