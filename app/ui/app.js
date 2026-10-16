// 프로필 = 음성 대화와 같은 말포이 에셋(assets/animation/v2)의 얼굴. 'D' 글자 원을 대신함
const FACE_SRC = "tsm-avatar://assets/frames/neutral/rest_open.png";
function faceAvatar() { const s = h("span"); const i = document.createElement("img"); i.src = FACE_SRC; i.alt = ""; i.decoding = "async"; s.append(i); return s; }
"use strict";
// window.api 는 preload 가 노출 (같은 이름으로 다시 선언하면 스크립트 전체가 죽음)
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const icon = (id, cls = "ic") => { const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); s.setAttribute("class", cls); const u = document.createElementNS("http://www.w3.org/2000/svg", "use"); u.setAttribute("href", "#i-" + id); s.append(u); return s; };
const GB = (b) => (b / 1e9).toFixed(1) + " GB", MB = (b) => Math.round(b / 1e6) + " MB", size = (b) => (b >= 1e9 ? GB(b) : MB(b));
const hm = (t) => new Date(t).toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit" });
const dayKey = (t) => { const d = new Date(new Date(t).toDateString()), n = new Date(new Date().toDateString()); return Math.round((n - d) / 864e5); };
const dayLabel = (t) => { const k = dayKey(t); return k === 0 ? "오늘" : k === 1 ? "어제" : new Date(t).toLocaleDateString("ko-KR", { month: "long", day: "numeric", weekday: "short" }); };


let cur = null, convList = [], busy = false, attachments = [], pending = null, voiceOn = false;

// ───────── 공통 ─────────
function toast(text, { err = false, ms = 2400 } = {}) {
  const t = h("div", "toast" + (err ? " err" : "")); t.append(icon(err ? "info" : "check"), h("span", null, text));
  $("#toasts").append(t); setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 260); }, ms);
}
function ask(title, body, ok = "확인") {
  const d = $("#confirm"); $("#confirm-title").textContent = title; $("#confirm-body").textContent = body; $("#confirm-ok").textContent = ok;
  d.showModal(); return new Promise((res) => d.addEventListener("close", () => res(d.returnValue === "yes"), { once: true }));
}
const scrollEnd = (force) => { const m = $("#messages"); if (force || m.scrollHeight - m.scrollTop - m.clientHeight < 160) m.scrollTop = m.scrollHeight; };

// ───────── 설치 (구성은 이전과 같음) ─────────
let det = null; const choice = { runtime: null, model: null };
const RT_DESC = { cuda: ["NVIDIA CUDA", "NVIDIA 그래픽에서 가장 빠름"], vulkan: ["Vulkan", "AMD · Intel · NVIDIA 공용"], cpu: ["CPU", "그래픽 카드 없이 (느림)"] };
const MD_DESC = { q4: ["표준", "Gemma 4 E4B QAT Q4_0 · 품질 우선 · VRAM 6 GB 이상"], q2: ["경량", "Gemma 4 E4B QAT Q2_K_XL · 저사양 PC · CPU"] };
function stepper(i) { $$("#stepper li").forEach((li, k) => (li.className = k < i ? "done" : k === i ? "on" : "")); }
function optionCards(box, items, key, rec) {
  box.innerHTML = "";
  for (const [k, v] of Object.entries(items)) {
    const [name, desc] = (key === "runtime" ? RT_DESC : MD_DESC)[k] || [v.label, ""];
    const b = h("button", "opt"); b.type = "button"; b.setAttribute("role", "radio"); b.dataset.k = k;
    const n = h("div", "name", name); if (k === rec) n.append(h("span", "tag", "추천"));
    b.append(h("i", "radio"), n, h("div", "desc", desc), h("div", "size", size(v.size)));
    b.onclick = () => { choice[key] = k; $$(".opt", box).forEach((o) => o.setAttribute("aria-checked", o.dataset.k === k)); updateSize(); };
    b.setAttribute("aria-checked", k === rec); box.append(b);
  }
  choice[key] = rec;
}
async function showSetup() {
  $("#main").hidden = true; $("#setup").hidden = false; $("#setup-plan").hidden = false; $("#setup-run").hidden = true; stepper(0);
  det = await window.api.setup.detect();
  const { hw, manifest } = det, g = hw.gpu, tiles = $("#hw-tiles"); tiles.innerHTML = "";
  const tile = (ic, k, v, s) => { const t = h("div", "tile"); const kk = h("div", "k"); kk.append(icon(ic), h("span", null, k)); t.append(kk, h("div", "v", v), h("div", "s", s || "")); tiles.append(t); };
  tile("gpu", "그래픽", g ? g.name.replace(/^NVIDIA |^AMD /, "") : "감지되지 않음", g?.vramGB ? `VRAM ${g.vramGB} GB` : "");
  tile("ram", "메모리", `${hw.ramGB} GB`, "시스템 RAM");
  tile("cpu", "프로세서", hw.cpu.replace(/\(R\)|\(TM\)|CPU|@.*$/g, "").replace(/\s+/g, " ").trim(), "");
  $("#hw-reco").hidden = false; $("span", $("#hw-reco")).textContent = `이 PC에 맞는 구성을 골라 두었습니다 — ${hw.recommend.reason}`;
  optionCards($("#opt-runtime"), manifest.runtimes, "runtime", hw.recommend.runtime);
  optionCards($("#opt-model"), manifest.models, "model", hw.recommend.model);
  $("#chk-draft").checked = hw.recommend.draft; $("#install-dir").textContent = det.dir; stepper(1); updateSize();
}
function updateSize() {
  if (!det) return;
  const m = det.manifest, total = m.runtimes[choice.runtime].size + m.models[choice.model].size + ($("#chk-draft").checked ? m.draft.size : 0);
  $("#sum-size").textContent = GB(total);
  const enough = det.freeGB == null || det.freeGB * 1e9 > total * 1.1, c = $("#sum-free");
  c.className = "chip " + (enough ? "ok" : "bad"); c.textContent = det.freeGB == null ? "남은 공간 확인 불가" : `남은 공간 ${det.freeGB} GB${enough ? "" : " · 부족"}`;
  $("#btn-install").disabled = !enough;
}
$("#chk-draft").addEventListener("change", updateSize);
$("#btn-dir").onclick = async () => { const r = await window.api.setup.chooseDir(); if (r) { det.dir = r.dir; det.freeGB = r.freeGB; $("#install-dir").textContent = r.dir; updateSize(); } };
async function runInstall() {
  $("#setup-plan").hidden = true; $("#setup-run").hidden = false; $("#setup-error").hidden = true; $("#btn-retry").hidden = true; $("#btn-cancel").hidden = false; stepper(2);
  const opts = { ...choice, draft: $("#chk-draft").checked, vramGB: det.hw.gpu?.vramGB || 0 };
  $$("#steps li").forEach((li) => { li.className = li.dataset.step === "draft" && !opts.draft ? "skip" : ""; $("em", li).textContent = ""; });
  try { await window.api.setup.start(opts); stepper(3); toast("설치가 끝났습니다"); await boot(); }
  catch (e) { const er = $("#setup-error"); $("span", er).textContent = e.message; er.hidden = false; $("#btn-retry").hidden = false; $("#btn-cancel").hidden = true; }
}
$("#btn-install").onclick = runInstall; $("#btn-retry").onclick = runInstall; $("#btn-cancel").onclick = () => window.api.setup.cancel();
window.api.on("setup:step", (s) => {
  const li = $(`#steps li[data-step="${s.id}"]`); if (li && !li.classList.contains("skip")) li.className = s.state;
  if (s.state === "running") { $("#bar").style.width = "0"; $("#pct").firstChild.nodeValue = "0"; if (s.id === "check") $("#prog-line").textContent = "엔진을 처음 켜는 중… 모델을 메모리에 올리고 있습니다"; }
  if (s.state === "done" && li) $("em", li).textContent = "완료";
});
window.api.on("setup:progress", (p) => {
  const pct = Math.floor((p.got / p.total) * 100); $("#bar").style.width = pct + "%"; $("#pct").firstChild.nodeValue = String(pct);
  const li = $(`#steps li[data-step="${p.step}"]`); if (li) $("em", li).textContent = `${size(p.got)} / ${size(p.total)}`;
  if (p.verifying) return ($("#prog-line").textContent = "무결성 확인 중 · SHA256");
  if (p.unzipping) return ($("#prog-line").textContent = "압축 푸는 중");
  const eta = p.speed ? Math.round((p.total - p.got) / p.speed) : null;
  $("#prog-line").textContent = (p.speed ? `${(p.speed / 1e6).toFixed(1)} MB/s` : "연결 중") + (eta != null ? ` · 약 ${eta >= 60 ? Math.round(eta / 60) + "분" : eta + "초"} 남음` : "");
});

// ───────── 셸 / 대화 목록 ─────────
function nav(view) {
  $$(".nav").forEach((b) => b.classList.toggle("on", b.dataset.view === view));
  $$(".view").forEach((v) => (v.hidden = v.id !== "view-" + view));
  if (view !== "chat") $$(".conv").forEach((c) => c.classList.remove("on"));
  else renderList();
  ({ mail: loadMail, settings: loadSettings, chat: () => $("#input").focus() })[view]?.();
}
$$(".nav").forEach((b) => (b.onclick = () => nav(b.dataset.view)));
window.api.on("nav", nav);

async function refreshList() { convList = await window.api.conv.list(); renderList(); }
function renderList() {
  const box = $("#conv-list"); box.innerHTML = "";
  if (!convList.length) { box.append(h("div", "conv-empty", "아직 대화가 없습니다. 말을 걸거나 스토리를 시작해 보세요.")); return; }
  const groups = [["오늘", (k) => k === 0], ["어제", (k) => k === 1], ["지난 7일", (k) => k > 1 && k <= 7], ["지난 30일", (k) => k > 7 && k <= 30], ["이전", (k) => k > 30]];
  for (const [label, test] of groups) {
    const items = convList.filter((c) => test(dayKey(c.updated))); if (!items.length) continue;
    box.append(h("div", "conv-group", label));
    for (const c of items) {
      const b = h("button", "conv" + (cur?.id === c.id && !$("#view-chat").hidden ? " on" : "")); b.title = c.title;
      b.append(icon(c.type === "story" ? "book" : "chat"), h("span", null, c.title));
      const del = h("i", "del"); del.title = "삭제"; del.append(icon("trash"));
      del.onclick = async (e) => { e.stopPropagation(); if (await ask("삭제할까요?", `'${c.title}'을(를) 지웁니다. 되돌릴 수 없습니다.`, "삭제")) { await window.api.conv.remove(c.id); if (cur?.id === c.id) { cur = null; renderThread(); } refreshList(); } };
      b.append(del); b.onclick = () => openConv(c.id); box.append(b);
    }
  }
}
window.api.on("conv:title", ({ id, title }) => { const c = convList.find((x) => x.id === id); if (c) { c.title = title; renderList(); } if (cur?.id === id) { cur.title = title; header(); } });
window.api.on("conv:message", ({ id, msg }) => { if (cur?.id !== id) return; const i = cur.messages.findIndex((m) => m.id === msg.id); if (i >= 0) { cur.messages[i] = msg; renderThread(); } });

async function openConv(id) {
  if (busy) return;
  cur = await window.api.conv.open(id); attachments = []; renderAttach();
  nav("chat"); renderThread(); scrollEnd(true);
}
$("#btn-new-chat").onclick = () => { if (busy) return; cur = null; nav("chat"); renderThread(); $("#input").focus(); };

// ───────── 대화 화면 ─────────
function header() {
  const story = cur?.type === "story";
  $("#who-sub").textContent = story ? `${cur.title} · ${cur.world?.school_year ? cur.world.school_year + "학년 · " : ""}${cur.world?.location || ""}` : "슬리데린";
  $("#btn-book").hidden = !story || !cur.messages.length;
  $("#input").placeholder = story ? "포터의 말이나 행동을 쓰세요…" : "말포이에게 말하기…";
  $("#view-chat").classList.toggle("story", story);
}
function fillHer(el, text) {                                   // 괄호 지문은 흐린 기울임으로
  el.replaceChildren();
  const src = text.replace(/^\s*["“]([^"”]*)["”]\s*$/s, "$1").trim(); let last = 0;
  for (const m of src.matchAll(/\(([^()]{1,160})\)/g)) { const b = src.slice(last, m.index).trim(); if (b) el.append(document.createTextNode(b + " ")); el.append(h("span", "act", m[1].trim())); last = m.index + m[0].length; }
  const rest = src.slice(last).trim(); if (rest) el.append(document.createTextNode(rest));
}
function fillProse(el, text) {                                 // 소설 문단 + 대사 강조
  el.replaceChildren();
  for (const para of text.split(/\n+/).map((s) => s.trim()).filter(Boolean)) {
    const p = h("p"); let last = 0;
    for (const m of para.matchAll(/["“][^"”]{1,400}["”]/g)) { if (m.index > last) p.append(document.createTextNode(para.slice(last, m.index))); p.append(h("span", "q", m[0])); last = m.index + m[0].length; }
    if (last < para.length) p.append(document.createTextNode(para.slice(last)));
    el.append(p);
  }
}
function actionBar(m, isLast) {
  const bar = h("div", "actions" + (isLast ? " keep" : ""));
  const btn = (ic, title, fn, cls = "") => { const b = h("button", "abtn " + cls); b.title = title; b.append(icon(ic)); b.onclick = fn; bar.append(b); return b; };
  if (m.role === "assistant" && m.alts > 1) {
    const a = h("span", "alts"); const l = h("button", "abtn"); l.append(icon("chev-l")); const r = h("button", "abtn"); r.append(icon("chev-r"));
    l.disabled = m.alt <= 0; r.disabled = m.alt >= m.alts - 1;
    l.onclick = () => setAlt(m, m.alt - 1); r.onclick = () => setAlt(m, m.alt + 1);
    a.append(l, h("span", null, `${m.alt + 1}/${m.alts}`), r); bar.append(a);
  }
  btn("copy", "복사", async (e) => { await navigator.clipboard.writeText(m.text); const b = e.currentTarget; b.replaceChildren(icon("check")); setTimeout(() => b.replaceChildren(icon("copy")), 1200); });
  if (m.role === "assistant") {
    btn("speaker", "소리로 듣기", () => readAloud(m));
    if (isLast) btn("refresh", "다시 만들기", regenerate);
    btn("up", "좋아요", () => rate(m, 1), m.rating === 1 ? "on" : "");
    btn("down", "별로예요", () => rate(m, -1), m.rating === -1 ? "on neg" : "");
  }
  return bar;
}
function renderThread() {
  header();
  const box = $("#messages"); box.innerHTML = ""; const th = h("div", "thread"); box.append(th);
  $("#suggest-row").hidden = true;
  if (!cur || !cur.messages.length) { if (!cur || cur.type === "chat") emptyChat(th); return; }
  if (cur.type === "story") {
    const hd = h("div", "story-head"); hd.append(h("div", "kicker", cur.world?.source === "canon" ? "원작 따라가기" : "새 이야기"), h("h2", null, cur.title), h("div", "meta", [cur.world?.time, cur.world?.location].filter(Boolean).join(" · ")), h("div", "rule"));
    th.append(hd);
  }
  let lastDay = "", grp = null, role = null, lastT = 0;
  cur.messages.forEach((m, i) => {
    const isLast = i === cur.messages.length - 1;
    if (cur.type === "story") {
      if (m.role === "user") { const y = h("div", "you"); y.append(h("b", null, "포터")); y.append(document.createTextNode(m.text || "…")); th.append(y); }
      else { const p = h("div", "prose" + (m.opening ? " first" : "")); fillProse(p, m.text); th.append(p, actionBar(m, isLast)); }
      return;
    }
    const d = dayLabel(m.t); if (d !== lastDay) { th.append(h("div", "sep", d)); lastDay = d; grp = null; }
    if (!grp || role !== m.role || m.t - lastT > 5 * 60000) {
      grp = h("div", "grp" + (m.role === "user" ? " me" : "")); const st = h("div", "stack");
      if (m.role !== "user") { const a = h("div", "avatar sm"); a.append(faceAvatar()); grp.append(a); }
      grp.append(st); th.append(grp); role = m.role;
    }
    lastT = m.t; const st = $(".stack", grp);
    if (m.images?.length) { const im = h("div", "msg-imgs"); for (const src of m.images) { const img = h("img"); img.src = src; im.append(img); } st.append(im); }
    if (m.text || m.role === "assistant" || m.voice) {
      const b = h("div", "msg " + (m.role === "user" ? "me" : "her")); b.title = hm(m.t);
      if (m.role === "user") { if (m.voice) b.append(h("span", "vtag", "음성")); b.append(document.createTextNode(m.text || "…")); } else fillHer(b, m.text);
      st.append(b);
    }
    st.append(actionBar(m, isLast));
  });
  if (cur.suggestions?.length && cur.messages.length === 1) {
    const r = $("#suggest-row"); r.innerHTML = ""; r.hidden = false;
    cur.suggestions.forEach((s, i) => { const b = h("button", null, s); b.style.animationDelay = i * 60 + "ms"; b.onclick = () => send(s); r.append(b); });
  }
}
function emptyChat(th) {
  const e = h("div", "empty-chat"); const a = h("div", "avatar"); a.append(faceAvatar());
  e.append(a, h("h3", null, "말포이가 당신을 흘끗 봅니다"), h("p", "t2", "먼저 말을 걸 생각은 없어 보입니다. 사진을 보여 주거나, 음성으로 말을 걸어도 됩니다."));
  const s = h("div", "suggest");
  for (const q of ["오늘 마법약 수업 어땠어?", "아까 퀴디치 연습장에 있었지?", "내 목도리 못 봤어?"]) { const b = h("button", null, q); b.onclick = () => send(q); s.append(b); }
  e.append(s); th.append(e);
}

// 스트리밍 표시: 말풍선/문단을 임시로 붙였다가 끝나면 다시 그림
function showPending(userText, images = [], voice = false) {
  const th = $(".thread") || (renderThread(), $(".thread")); $(".empty-chat")?.remove();
  if (cur.type === "story") {
    if (userText != null) { const y = h("div", "you"); y.append(h("b", null, "포터"), document.createTextNode(userText || "…")); th.append(y); }
    const p = h("div", "prose"); const t = h("div", "typing"); t.append(h("i"), h("i"), h("i")); p.append(t); th.append(p);
    pending = { el: p, story: true };
  } else {
    if (userText != null || images.length) {
      const g = h("div", "grp me"); const st = h("div", "stack");
      if (images.length) { const im = h("div", "msg-imgs"); for (const src of images) { const img = h("img"); img.src = src; im.append(img); } st.append(im); }
      if (userText || voice) { const b = h("div", "msg me"); if (voice) b.append(h("span", "vtag", "음성")); b.append(document.createTextNode(userText || "…")); st.append(b); }
      g.append(st); th.append(g);
    }
    const g = h("div", "grp"); const a = h("div", "avatar sm"); a.append(faceAvatar()); const st = h("div", "stack"); const b = h("div", "msg her typing"); b.append(h("i"), h("i"), h("i")); st.append(b); g.append(a, st); th.append(g);
    pending = { el: b, story: false };
  }
  scrollEnd(true);
}
window.api.on("chat:token", ({ convId, full }) => {
  if (!pending || cur?.id !== convId) return;
  pending.el.classList.remove("typing");
  pending.story ? fillProse(pending.el, full) : fillHer(pending.el, full);
  if (voiceOn) $("#voice-caption").textContent = full.replace(/\([^()]*\)/g, "").slice(-160);
  scrollEnd();
});
function setBusy(b) { busy = b; $("#btn-send").hidden = b; $("#btn-stop").hidden = !b; syncSend(); }

async function ensureConv() { if (!cur) { const c = await window.api.conv.create(); cur = { ...c, messages: [], world: null }; convList.unshift(c); renderList(); } return cur; }
async function send(text) {
  if (busy || (!text && !attachments.length)) return;
  await ensureConv(); const imgs = attachments.map((a) => a.data); attachments = []; renderAttach();
  setBusy(true); showPending(text, imgs);
  try { const r = await window.api.chat.send(cur.id, { text, images: imgs }); cur.messages.push(r.user, r.bot); }
  catch (e) { if (!/abort/i.test(e.message)) toast(e.message, { err: true, ms: 5000 }); }
  finally { pending = null; setBusy(false); bump(); renderThread(); scrollEnd(true); $("#input").focus(); }
}
async function regenerate() {
  if (busy || !cur) return; setBusy(true);
  const last = cur.messages.at(-1); const els = cur.type === "story" ? $$(".prose") : $$(".msg.her"); const el = els.at(-1);
  if (el) { el.replaceChildren(); el.classList.add("typing"); if (cur.type !== "story") el.append(h("i"), h("i"), h("i")); pending = { el, story: cur.type === "story" }; }
  try { const m = await window.api.chat.regenerate(cur.id); cur.messages[cur.messages.length - 1] = m; }
  catch (e) { if (!/abort/i.test(e.message)) toast(e.message, { err: true }); }
  finally { pending = null; setBusy(false); renderThread(); }
}
async function setAlt(m, alt) { const v = await window.api.chat.alt(cur.id, m.id, alt); const i = cur.messages.findIndex((x) => x.id === m.id); cur.messages[i] = v; renderThread(); }
async function rate(m, v) { const r = await window.api.chat.rate(cur.id, m.id, v); const i = cur.messages.findIndex((x) => x.id === m.id); cur.messages[i] = r; renderThread(); if (r.rating) toast(r.rating > 0 ? "좋았던 답으로 기록했습니다" : "아쉬운 답으로 기록했습니다 · 다음 학습에 반영됩니다", { ms: 1800 }); }
function bump() { const c = convList.find((x) => x.id === cur?.id); if (c) { c.updated = Date.now(); convList.sort((a, b) => b.updated - a.updated); renderList(); } }

// 입력창
const input = $("#input");
const syncSend = () => ($("#btn-send").disabled = busy || (!input.value.trim() && !attachments.length));
const grow = () => { input.style.height = "auto"; input.style.height = Math.min(180, input.scrollHeight) + "px"; };
input.addEventListener("input", () => { grow(); syncSend(); });
input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("#composer").requestSubmit(); } });
$("#composer").onsubmit = (e) => { e.preventDefault(); const t = input.value.trim(); if ((!t && !attachments.length) || busy) return; input.value = ""; grow(); send(t); };
$("#btn-stop").onclick = () => window.api.chat.stop();

// 사진 첨부: 버튼 / 붙여넣기 / 끌어놓기 — 긴 변 1280px 로 줄여 보냄
async function addFiles(files) {
  for (const f of [...files].filter((f) => f.type.startsWith("image/")).slice(0, 4 - attachments.length)) {
    const url = URL.createObjectURL(f), img = await new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = url; });
    const k = Math.min(1, 1280 / Math.max(img.width, img.height)), c = document.createElement("canvas"); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
    attachments.push({ data: c.toDataURL("image/jpeg", 0.88) });
  }
  renderAttach(); syncSend();
}
function renderAttach() {
  const r = $("#attach-row"); r.innerHTML = ""; r.hidden = !attachments.length;
  attachments.forEach((a, i) => { const t = h("div", "thumb"); const img = h("img"); img.src = a.data; const x = h("button"); x.type = "button"; x.append(icon("x")); x.onclick = () => { attachments.splice(i, 1); renderAttach(); syncSend(); }; t.append(img, x); r.append(t); });
}
$("#btn-attach").onclick = () => $("#file").click();
$("#file").onchange = (e) => { addFiles(e.target.files); e.target.value = ""; };
input.addEventListener("paste", (e) => { const fs = [...e.clipboardData.files]; if (fs.length) { e.preventDefault(); addFiles(fs); } });
const dock = $("#view-chat");
dock.addEventListener("dragover", (e) => { if ([...e.dataTransfer.items].some((i) => i.type.startsWith("image/"))) { e.preventDefault(); dock.classList.add("drop-on"); } });
dock.addEventListener("dragleave", () => dock.classList.remove("drop-on"));
dock.addEventListener("drop", (e) => { e.preventDefault(); dock.classList.remove("drop-on"); addFiles(e.dataTransfer.files); });

// ───────── 스토리 ─────────
let points = null;
$("#btn-new-story").onclick = async () => {
  if (busy) return;
  const d = $("#story-dialog"); d.showModal(); $("#story-seed").value = "";
  points = points || (await window.api.story.points());
  const g = $("#point-grid"); g.innerHTML = "";
  for (const p of points) {
    const b = h("button", "point"); b.append(h("span", "y", `${p.year}학년 · ${p.time || ""}`), h("strong", null, p.title), h("p", null, p.situation), h("span", "loc", p.location));
    b.onclick = () => startStory({ pointId: p.id }); g.append(b);
  }
};
$("#btn-story-close").onclick = () => $("#story-dialog").close();
$("#btn-story-ai").onclick = () => startStory({ seed: $("#story-seed").value.trim() });
$("#story-seed").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) startStory({ seed: e.target.value.trim() }); });
async function startStory(opts) {
  const d = $("#story-dialog"), veil = h("div", "veil"); veil.append(h("div", "spinner"), h("span", null, opts.pointId ? "그 순간으로 들어가는 중…" : "말포이가 상황을 만드는 중…"));
  $(".modal-body", d).append(veil);
  try {
    const c = await window.api.story.create(opts); d.close(); convList.unshift(c); cur = { ...c, messages: [], world: null };
    const full = await window.api.conv.open(c.id); cur = full; nav("chat"); renderList(); renderThread();
    setBusy(true); showPending(null);
    const m = await window.api.story.begin(c.id); cur = await window.api.conv.open(c.id);
  } catch (e) { toast(e.message, { err: true, ms: 5000 }); }
  finally { veil.remove(); pending = null; setBusy(false); renderThread(); scrollEnd(true); }
}
$("#btn-book").onclick = () => {
  const d = $("#book-dialog"), t = $("#book-text"); t.innerHTML = "";
  $("#book-title").textContent = cur.title; $("#book-meta").textContent = [cur.world?.time, cur.world?.location].filter(Boolean).join(" · ");
  for (const m of cur.messages) { if (m.role === "user") { const y = h("div", "you"); y.append(h("b", null, "포터"), document.createTextNode(m.text)); t.append(y); } else { const p = h("div"); fillProse(p, m.text); t.append(p); } }
  d.showModal();
};
$("#btn-book-close").onclick = () => $("#book-dialog").close();
$("#btn-book-save").onclick = () => {
  const text = `${cur.title}\n${[cur.world?.time, cur.world?.location].filter(Boolean).join(" · ")}\n\n` + cur.messages.map((m) => (m.role === "user" ? `— 포터: ${m.text}` : m.text)).join("\n\n");
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" })); a.download = `${cur.title}.txt`; a.click();
};

// ───────── 라이브 음성 대화 ─────────
let io = null, vState = "idle";
const orb = $("#orb");
const voiceAvatar = new MalfoyAvatar($("#voice-avatar"));
function vset(state, label) { vState = state; orb.className = "orb " + state; $("#voice-state").textContent = label; }
async function openVoice() {
  if (busy) return;
  $("#voice").hidden = false; voiceOn = true; $("#voice-caption").textContent = ""; $("#voice-install").hidden = true;
  voiceAvatar.start();
  const st = await window.api.voice.status();
  if (!st.ready) { $("#voice-install").hidden = false; $("#voice-size").textContent = size(st.size); vset("idle", "목소리 준비가 필요합니다"); return; }
  vset("thinking", "준비 중…");
  try {
    await ensureConv();
    io = new VoiceIO({
      onLevel: (l) => orb.style.setProperty("--lvl", l.toFixed(3)),
      onOutputLevel: (rms) => { if (rms === 0 && !io?.isPlaying) voiceAvatar.stopSpeaking(); else voiceAvatar.setOutputLevel(rms); },
      onSpeechStart: () => { if (io.isPlaying || vState === "speaking" || vState === "thinking") { io.stopPlayback(); window.api.voice.stop(); if (busy) window.api.chat.stop(); } vset("listening", "듣고 있어요"); },
      onUtterance: (wav) => voiceTurn(wav),
      onPlayStart: () => vset("speaking", "말포이"),
      onPlayEnd: () => { if (vState === "speaking") vset("listening", "말해 보세요"); },
    });
    await Promise.all([io.start(), window.api.voice.warm()]);
    vset("listening", "말해 보세요");
  } catch (e) { io?.stop(); io = null; voiceAvatar.stopSpeaking(); vset("idle", "마이크를 쓸 수 없습니다"); toast(e.message, { err: true }); }
}
async function voiceTurn(wav) {
  if (busy) return;
  setBusy(true); vset("thinking", "생각 중…"); showPending("", [], true);
  try { const r = await window.api.voice.turn(cur.id, wav); cur.messages.push(r.user, r.bot); }
  catch (e) { if (!/abort/i.test(e.message)) toast(e.message, { err: true }); vset("listening", "말해 보세요"); }
  finally { pending = null; setBusy(false); bump(); renderThread(); }
}
window.api.on("voice:audio", ({ convId, b64 }) => { if (io && voiceOn && cur?.id === convId) io.play(b64); else if (!voiceOn) playOnce(b64); });
window.api.on("voice:spoken", () => {});
function closeVoice() { voiceOn = false; io?.stop(); io = null; voiceAvatar.stop(); window.api.voice.stop(); $("#voice").hidden = true; }
$("#btn-voice").onclick = openVoice; $("#btn-mic").onclick = openVoice; $("#btn-vend").onclick = closeVoice;
$("#btn-vmute").onclick = (e) => { if (!io) return; io.setMuted(!io.muted); e.currentTarget.classList.toggle("off", io.muted); e.currentTarget.replaceChildren(icon(io.muted ? "micoff" : "mic")); vset(io.muted ? "idle" : "listening", io.muted ? "마이크 꺼짐" : "말해 보세요"); };
$("#btn-voice-install").onclick = async (e) => {
  e.currentTarget.disabled = true;
  const off = window.api.on("voice:progress", (p) => ($("#voice-bar").style.width = (p.got / p.total * 100).toFixed(1) + "%"));
  try { await window.api.voice.install(); off(); $("#voice-install").hidden = true; openVoice(); } catch (err) { off(); toast(err.message, { err: true }); e.currentTarget.disabled = false; }
};
// 메시지 하나 읽어 주기 (음성 모드 밖)
let player = null;
async function readAloud(m) {
  const st = await window.api.voice.status(); if (!st.ready) { openVoice(); return; }
  toast("읽는 중…", { ms: 1200 }); window.api.voice.read(cur.id, m.id);
}
function playOnce(b64) {
  if (!player) { player = { ctx: new AudioContext(), q: [], on: false }; }
  player.q.push(b64); if (player.on) return;
  const next = async () => { const x = player.q.shift(); if (!x) { player.on = false; return; } player.on = true; const buf = await player.ctx.decodeAudioData(Uint8Array.from(atob(x), (c) => c.charCodeAt(0)).buffer); const s = player.ctx.createBufferSource(); s.buffer = buf; s.connect(player.ctx.destination); s.onended = next; s.start(); };
  next();
}

// ───────── 우편함 ─────────
const firstLine = (t) => (t.split("\n").map((l) => l.trim()).find((l) => l && !/^포터,?$/.test(l) && !/^D\.?M\.?$/.test(l)) || "편지").replace(/^포터,\s*/, "").slice(0, 40);
async function loadMail() {
  const list = await window.api.mail.list(); const ul = $("#mail-list"); ul.innerHTML = "";
  if (!list.length) ul.append(h("li", "none", "아직 편지가 없습니다"));
  for (const m of list) {
    const li = h("li", m.read ? "read" : ""); const tx = h("div"); tx.append(h("div", "ttl", firstLine(m.text)), h("div", "d", new Date(m.t).toLocaleString("ko-KR", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })));
    li.append(h("div", "seal", "DM"), tx);
    li.onclick = async () => {
      $$("#mail-list li").forEach((x) => x.classList.remove("on")); li.classList.add("on", "read");
      const p = h("article", "paper"); const body = m.text.replace(/\s*[—-]?\s*D\.\s?M\.?\s*$/, "").trim();
      p.append(h("span", "date", new Date(m.t).toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric" })), document.createTextNode(body), h("span", "sign", "D. M."), h("div", "seal", "DM"));
      $("#letter-stage").replaceChildren(p);
      if (!m.read) { m.read = true; await window.api.mail.read(m.id); badge(list); }
    };
    ul.append(li);
  }
  badge(list);
}
function badge(list) { const n = list.filter((m) => !m.read).length; $("#mail-badge").hidden = !n; $("#mail-badge").textContent = n; }
window.api.on("mail:new", () => { window.api.mail.list().then(badge); if (!$("#view-mail").hidden) loadMail(); toast("부엉이가 편지를 물고 왔습니다"); });

// ───────── 설정 ─────────
async function loadSettings() {
  const s = await window.api.state(), c = s.config;
  $("#set-owl").checked = c.owlPost;
  for (const [sel, v] of [["#set-qs", c.quietStart], ["#set-qe", c.quietEnd]]) { const el = $(sel); el.innerHTML = ""; for (let i = 0; i < 24; i++) el.append(new Option(`${String(i).padStart(2, "0")}:00`, i, false, i === v)); }
  $$("#set-theme button").forEach((b) => b.classList.toggle("on", b.dataset.v === (c.theme || "system")));
  const pf = s.perf, k = (n) => `${Math.round(n / 1024)}K`, chosen = c.perf || {};
  const ctxSel = $("#set-ctx"); ctxSel.innerHTML = "";
  ctxSel.append(new Option(`자동 (${k(pf.auto.ctx)})`, 0, false, !chosen.ctx));
  for (const n of [8192, 16384, 32768, 65536, 131072]) ctxSel.append(new Option(k(n), n, false, chosen.ctx === n));
  $$("#set-kv button").forEach((b) => b.classList.toggle("on", b.dataset.v === (chosen.kv || "auto")));
  $("#perf-info").textContent = `이 PC: ${pf.vramGB ? `그래픽카드 ${pf.vramGB}GB · ` : "그래픽카드 없음 · "}RAM ${pf.ramGB}GB → 지금 설정: 기억 ${k(pf.ctx)} · ${pf.kv === "q4_0" ? "절약" : "표준"} · 캐시 ${pf.cacheRamMB / 1024}GB${pf.mmprojGpu ? "" : " · 이미지·음성 인식은 CPU"}${pf.ttsGpu ? "" : " · 목소리는 CPU"}`;
  $("#about").textContent = `TS Malfoy ${s.version} · 비공식 팬 프로젝트, 무료 배포. 모델 Google Gemma 4 E4B (Apache-2.0) · 엔진 llama.cpp (MIT) · 음성 Qwen3-TTS (Apache-2.0) · 글꼴 Pretendard, 고운바탕 (OFL). 해리 포터 관련 권리는 각 권리자에게 있습니다. 메모리·성능은 앱이 알아서 관리합니다.`;
}
const save = (p, msg = "저장했습니다") => window.api.settings.set(p).then(() => toast(msg, { ms: 1300 }));
$("#set-owl").onchange = (e) => save({ owlPost: e.target.checked });
$("#set-ctx").onchange = (e) => save({ perf: { ctx: +e.target.value } }, "다음 대화부터 적용됩니다").then(loadSettings);
$$("#set-kv button").forEach((b) => (b.onclick = () => save({ perf: { kv: b.dataset.v } }, "다음 대화부터 적용됩니다").then(loadSettings)));
$("#set-qs").onchange = (e) => save({ quietStart: +e.target.value });
$("#set-qe").onchange = (e) => save({ quietEnd: +e.target.value });
$$("#set-theme button").forEach((b) => (b.onclick = () => { $$("#set-theme button").forEach((x) => x.classList.toggle("on", x === b)); save({ theme: b.dataset.v }, "테마를 바꿨습니다"); }));
$("#btn-open-data").onclick = () => window.api.data.open();
$("#btn-forget").onclick = async () => { if (await ask("기억 지우기", "말포이가 포터에 대해 기억하는 것을 모두 지웁니다.", "지우기")) { await window.api.data.forget(); toast("기억을 지웠습니다"); } };
$("#btn-delete-all").onclick = async () => { if (await ask("모두 지우기", "모든 대화, 스토리, 기억, 편지를 지웁니다. 되돌릴 수 없습니다.", "모두 지우기")) { await window.api.data.deleteAll(); cur = null; await refreshList(); nav("chat"); renderThread(); toast("처음 상태로 돌아갔습니다"); } };
$("#btn-reinstall").onclick = async () => { if (await ask("구성 다시 선택", "엔진이나 모델을 바꿉니다. 이미 받은 파일은 다시 받지 않습니다.", "계속")) { await window.api.data.reinstall(); showSetup(); } };

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") { e.preventDefault(); $("#btn-new-chat").click(); }
  if (e.key === "Escape" && voiceOn) closeVoice();
});

// ───────── 시작 ─────────
async function boot() {
  const s = await window.api.state();
  if (!s.installed) return showSetup();
  $("#setup").hidden = true; $("#main").hidden = false;
  await refreshList();
  if (s.current && convList.some((c) => c.id === s.current)) await openConv(s.current); else { nav("chat"); renderThread(); }
  window.api.mail.list().then(badge); syncSend();
}
boot();
