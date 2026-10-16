// 두뇌: 대화/스토리 생성, 재생성·평가, 장기 기억, 컨텍스트 자동 압축, 음성 턴, 부엉이 우편
import fs from "node:fs";
import path from "node:path";
import { Conversations } from "./conversations.mjs";

const FACT_SCHEMA = {
  type: "object", required: ["delta", "facts"],
  properties: {
    delta: { type: "integer", minimum: -2, maximum: 2 },
    facts: { type: "array", maxItems: 3, items: { type: "object", required: ["text", "kind", "imp"],
      properties: { text: { type: "string", maxLength: 90 }, kind: { enum: ["user", "pref", "event", "promise"] }, imp: { type: "integer", minimum: 1, maximum: 3 } } } },
  },
};
const WORLD_SCHEMA = {
  type: "object", required: ["title", "time", "school_year", "location", "situation", "hidden_emotion", "first_line"],
  properties: { title: { type: "string", maxLength: 24 }, time: { type: "string" }, school_year: { type: "integer", minimum: 1, maximum: 7 }, location: { type: "string" },
    situation: { type: "string", maxLength: 300 }, hidden_emotion: { type: "string", maxLength: 120 }, first_line: { type: "string", maxLength: 120 } },
};
const dataUrl = (file) => `data:image/${path.extname(file).slice(1).replace("jpg", "jpeg")};base64,${fs.readFileSync(file).toString("base64")}`;
const T = Conversations.text;

/** 채팅 답 정리: 괄호 속 행동 묘사·이모지 제거. streaming=true 면 아직 안 닫힌 괄호 뒤를 숨김 */
/** 스토리 서술: 독자(포터)는 '너'. 기본 모델이 프롬프트를 어기고 '당신'을 쓰므로 조사에 맞춰 바꾼다 */
const YOU = [["당신이", "네가"], ["당신은", "너는"], ["당신을", "너를"], ["당신의", "너의"], ["당신에게", "너에게"], ["당신한테", "너한테"], ["당신과", "너와"], ["당신도", "너도"], ["당신만", "너만"], ["당신께", "너에게"], ["당신", "너"]];
export function storyTidy(text) { let s = text; for (const [a, b] of YOU) s = s.split(a).join(b); return s; }

export function tidy(text, streaming = false) {
  let s = text.replace(/[(（][^()（）]{0,200}[)）]/g, " ").replace(/\*[^*\n]{1,120}\*/g, " ");
  if (streaming) s = s.replace(/[(（*][^()（）*]*$/, "");
  s = s.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "");
  return s.replace(/[ \t]{2,}/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export class Brain {
  constructor({ personaDir, dataDir, engine, convs, memory, ctx }) {
    Object.assign(this, { engine, convs, memory, ctx, dataDir });
    this.char = JSON.parse(fs.readFileSync(path.join(personaDir, "character.json"), "utf8"));
    this.prompt = fs.readFileSync(path.join(personaDir, "prompt_v3.txt"), "utf8");
    this.loraScale = this.char.loraScale ?? 0;
    this.points = JSON.parse(fs.readFileSync(path.join(personaDir, "story_points.json"), "utf8")).scenes;
    this.feedbackFile = path.join(dataDir, "feedback.jsonl");
    this.mailFile = path.join(dataDir, "mail.json");
  }

  stage() { const b = this.memory.bond(0); return [...this.char.stages].reverse().find((s) => b >= s.min) || this.char.stages[0]; }

  // ── 프롬프트 ──
  system(conv) {
    const st = this.stage();
    if (conv.type === "story") return this.storySystem(conv);
    let s = this.prompt.replace("{stage}", st.name).replace("{hint}", st.hint);              // v2: 감정선 프롬프트 (LoRA v2 학습 형식과 같음)
    if (conv.summary) s += "\n\n지금까지 이 대화의 요약: " + conv.summary;
    return s;
  }
  storySystem(conv) {
    const w = conv.world || {}, young = (w.school_year || 1) <= 4;
    return [
      "너는 해리 포터 원작 세계를 무대로 한 인터랙티브 소설의 서술자다. 이 세계에서 드레이코 말포이는 처음부터 여자다.",
      "그녀의 외모: 허리까지 오는 곧은 백금발, 회색 눈, 뾰족한 턱, 슬리데린 초록·은색 넥타이. (갈색 머리 아님)",
      "그녀의 결: 대놓고 도발하는 오만한 순혈 영애지만 감정이 얼굴에 다 드러나고, 포터를 먼저 좋아하게 됐지만 절대 인정하지 않는다. 들키면 그럴듯하지 않은 변명을 하고, 큰소리쳐도 결국 포터에게 진다.",
      "독자는 해리 포터다. 서술은 2인칭('너')으로 한다. '당신'이라고 쓰지 않는다. 너(포터)가 무엇을 할지(악수를 받을지 말지 등)는 절대 쓰지 말고, 그 결정 직전에서 멈춘다.",
      "원작 사건이 기준이다: 원작의 사건 순서·인물·장소·학년을 따르되 원작 문장을 그대로 옮기지 않는다.",
      "규칙: 한 번에 2~5문단. 장면 묘사와 인물의 대사(큰따옴표)를 섞는다. 너(포터)의 대사·결정은 대신 쓰지 않는다 — 그건 독자가 정한다. 마지막 문단은 너가 반응할 여지를 남기고 끝낸다. 성적 묘사는 없다." +
        (young ? " 지금은 저학년이므로 감정 표현은 아이다운 수준(경쟁심, 서운함, 호기심)으로만." : ""),
      `지금: ${w.time || ""} · ${w.school_year || "?"}학년 · ${w.location || ""}`,
      `상황: ${w.situation || ""}`,
      w.canon_anchor ? `원작 기준: ${w.canon_anchor}` : "",
      w.hidden_emotion ? `그녀의 속마음(서술에 직접 쓰지 말고 행동으로만 드러낼 것): ${w.hidden_emotion}` : "",
      conv.summary ? `\n지금까지의 이야기: ${conv.summary}` : "",
    ].filter(Boolean).join("\n");
  }

  /** 모델에 보낼 메시지. 이미지는 최근 6개 메시지 안의 것만, 기억 메모는 마지막 사용자 턴 앞에 */
  build(conv, { upto = conv.messages.length, audio = null } = {}) {
    const msgs = conv.messages.slice(conv.summarizedUpTo, upto);
    const out = [{ role: "system", content: this.system(conv) }];
    const recent = upto - 6;
    msgs.forEach((m, k) => {
      const i = conv.summarizedUpTo + k, text = T(m) || "";
      if (m.role === "assistant") return out.push({ role: "assistant", content: text });
      const parts = [];
      if (m.images?.length) for (const f of m.images) { if (i >= recent && fs.existsSync(f)) parts.push({ type: "image_url", image_url: { url: dataUrl(f) } }); else parts.push({ type: "text", text: "[사진]" }); }
      if (i === upto - 1 && audio) parts.push({ type: "input_audio", input_audio: { data: audio, format: "wav" } });
      let body = text;
      if (i === upto - 1) {                                                     // 마지막 턴에만 붙이는 메모 (캐시 앞부분은 그대로)
        const notes = [this.memory.note(text || conv.title)];
        const hour = new Date().getHours(); if (hour >= 1 && hour < 5) notes.push("지금은 새벽이다.");
        const prev = conv.messages[i - 1]; if (prev && Date.now() - prev.t > 2 * 864e5) notes.push(`포터는 ${Math.floor((Date.now() - prev.t) / 864e5)}일 만에 왔다.`);
        const note = notes.filter(Boolean).join("\n");
        if (note) body = `[네 머릿속에 떠오른 기억 — 포터가 보여 준 게 아니다. 메모·쪽지라고 말하지 말고, 원래 기억하던 것처럼 말한다]\n${note}\n[기억 끝]\n\n${body}`;   // <메모> 로 붙였더니 "그딴 메모는 왜 들고 있어" (촬영 중 실측)
      }
      if (body) parts.push({ type: "text", text: body });
      out.push({ role: "user", content: parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts });
    });
    return out;
  }

  // ── 대화 ──
  async send(convId, { text = "", images = [], audio = null }, { onToken, signal } = {}) {
    const conv = this.convs.get(convId); if (!conv) throw new Error("대화를 찾을 수 없습니다");
    await this.engine.useConversation(convId);
    const files = images.map((d, n) => { const m = /^data:image\/(\w+);base64,(.*)$/s.exec(d); if (!m) return null; const f = path.join(this.convs.assetDir(convId), `img_${Date.now()}_${n}.${m[1] === "jpeg" ? "jpg" : m[1]}`); fs.writeFileSync(f, Buffer.from(m[2], "base64")); return f; }).filter(Boolean);
    const user = this.convs.addMessage(conv, { role: "user", content: text, ...(files.length ? { images: files } : {}), ...(audio ? { voice: true } : {}) });
    const reply = await this.generate(conv, { onToken, signal, audio });
    const bot = this.convs.addMessage(conv, { role: "assistant", content: reply });
    this.after(conv, user, bot, audio).catch((e) => console.error("after", e));
    return { user, bot };
  }
  async generate(conv, { onToken, signal, audio, upto } = {}) {
    const story = conv.type === "story";
    const tok = onToken && (story ? (d, full) => onToken(d, storyTidy(full)) : (d, full) => onToken(d, tidy(full, true)));          // 채팅은 지문·이모지를 걸러서 보여 줌
    const msgs = this.build(conv, { audio, upto });
    // 사진이 있는 차례는 LoRA 를 절반으로: 학습 대화에 사진이 없어서 1.0 이면 사진 내용을 안 짚음(실측: 0.5 에서 색까지 짚고 말투 유지)
    const photo = Array.isArray(msgs.at(-1)?.content) && msgs.at(-1).content.some((c) => c.type === "image_url");
    const scale = story ? 0 : photo ? this.loraScale * 0.5 : this.loraScale;
    const r = await this.engine.chat(msgs, { onToken: tok, signal, maxTokens: story ? 700 : 300, temperature: 0.85, loraScale: scale });   // 채팅 = LoRA v3(자기 증류) 1.0, 스토리 서술은 원본
    this.lastPromptTokens = r.promptTokens;
    return story ? storyTidy(r.text.trim()) : tidy(r.text);
  }
  async regenerate(convId, { onToken, signal } = {}) {
    const conv = this.convs.get(convId); const last = conv.messages.at(-1);
    if (!last || last.role !== "assistant") throw new Error("다시 만들 답이 없습니다");
    await this.engine.useConversation(convId);
    const text = await this.generate(conv, { onToken, signal, upto: conv.messages.length - 1 });
    last.alts = [...(last.alts || [last.content]), text]; last.alt = last.alts.length - 1; last.rating = undefined;
    this.convs.save(conv); return last;
  }
  setAlt(convId, msgId, alt) { const c = this.convs.get(convId), m = c.messages.find((x) => x.id === msgId); if (m?.alts) { m.alt = Math.max(0, Math.min(m.alts.length - 1, alt)); this.convs.save(c); } return m; }
  rate(convId, msgId, v) {
    const c = this.convs.get(convId), i = c.messages.findIndex((x) => x.id === msgId), m = c.messages[i]; if (!m) return;
    m.rating = m.rating === v ? undefined : v; this.convs.save(c);
    if (m.rating) {                                                                   // 다음 학습용 기록 (좋아요=정답 예, 싫어요=나쁜 예)
      const ctx = c.messages.slice(Math.max(0, i - 6), i).map((x) => ({ role: x.role, content: T(x) }));
      fs.appendFileSync(this.feedbackFile, JSON.stringify({ t: Date.now(), type: c.type, rating: m.rating, stage: this.stage().name, messages: [...ctx, { role: "assistant", content: T(m) }] }) + "\n");
    }
    return m;
  }

  // ── 턴이 끝난 뒤 (보조 슬롯) : 기억·관계·제목·음성 받아쓰기·압축 ──
  async after(conv, user, bot, audio) {
    if (audio) {
      const r = await this.engine.chat([{ role: "user", content: [{ type: "input_audio", input_audio: { data: audio, format: "wav" } }, { type: "text", text: "이 음성을 한국어로 정확히 받아 적어라. 받아 적은 문장만 출력." }] }], { slot: 1, maxTokens: 120, temperature: 0, loraScale: 0 });
      user.content = r.text.trim(); this.convs.save(conv); this.onUpdate?.(conv.id, user);
    }
    const said = T(user) || "(사진)", st = this.stage();
    const prompt = `포터와 말포이(츤데레, 포터를 몰래 좋아함)의 ${conv.type === "story" ? "이야기" : "대화"} 한 토막이다. 관계 단계: ${st.name}.
포터: ${said}
말포이 쪽: ${T(bot).slice(0, 600)}

1) delta: 포터의 말·행동만 보고(말포이의 퉁명스러운 대답은 원래 성격이니 무시) 그녀의 마음을 얼마나 움직였을지 (-2~2). 다정함·받아치기·챙겨 주기·솔직한 고마움 = +, 무시·모욕·금기(족제비, 흉터, 아버지 체포) = −, 평범하면 0.
2) facts: 오래 기억할 만한 것만 (없으면 빈 배열). user=포터 본인의 현실 정보, pref=취향, promise=약속, event=둘 사이에 일어난 일. imp 1~3.
JSON만.`;
    try {
      const j = JSON.parse((await this.engine.chat([{ role: "user", content: prompt }], { slot: 1, maxTokens: 220, temperature: 0.1, loraScale: 0, json: FACT_SCHEMA })).text);
      this.memory.bond((j.delta | 0) + 0.5); for (const f of j.facts || []) this.memory.addFact(f);   // 만날수록 조금씩 익숙해짐(+0.5). 없으면 늘 앙숙에 머묾 (촬영 중 실측: 20턴 뒤에도 0)
    } catch {}
    if (conv.messages.length <= 3 && conv.type === "chat") await this.autoTitle(conv);
    if (this.lastPromptTokens > this.ctx * 0.7) await this.compress(conv);
  }
  async autoTitle(conv) {
    try {
      const r = await this.engine.chat([{ role: "user", content: `다음 대화의 제목을 12자 이내 한국어 명사구로. 따옴표·마침표 없이 제목만.\n포터: ${T(conv.messages[0])}\n말포이: ${T(conv.messages[1] || {}) || ""}` }], { slot: 1, maxTokens: 24, temperature: 0.3, loraScale: 0 });
      const t = r.text.replace(/["'「」.\n]/g, "").trim().slice(0, 20); if (t) { conv.title = t; this.convs.save(conv); this.onTitle?.(conv.id, t); }
    } catch {}
  }
  /** 오래된 부분을 요약으로 접고 장기 기억(에피소드)에도 남긴다. 최근 12개는 원문 유지 */
  async compress(conv) {
    const end = conv.messages.length - 12; if (end <= conv.summarizedUpTo + 4) return;
    const chunk = conv.messages.slice(conv.summarizedUpTo, end).map((m) => `${m.role === "user" ? "포터" : "말포이"}: ${T(m)}`).join("\n");
    const r = await this.engine.chat([{ role: "user", content: `${conv.summary ? "이전 요약: " + conv.summary + "\n\n" : ""}이어지는 ${conv.type === "story" ? "이야기" : "대화"}:\n${chunk}\n\n이전 요약과 합쳐 사건 순서대로 8문장 이내로 요약하라. 약속·감정 변화·중요한 사실은 빠뜨리지 말 것.` }], { slot: 1, maxTokens: 500, temperature: 0.2, loraScale: 0 });
    conv.summary = r.text.trim(); conv.summarizedUpTo = end; this.convs.save(conv);
    this.memory.addEpisode(conv.id, conv.summary.split(/(?<=[.!?。])\s/).slice(-3).join(" "));
    this.engine.dropSlot(conv.id);                                                    // 프롬프트 앞부분이 바뀌었으니 캐시 무효
  }
  /** 대화를 떠날 때: 새로 쌓인 내용이 있으면 한 문단 에피소드로 */
  async leave(convId) {
    const conv = this.convs.get(convId); if (!conv) return;
    const from = conv.episodeAt || 0; if (conv.messages.length - from < 6) return;
    const chunk = conv.messages.slice(from).slice(-40).map((m) => `${m.role === "user" ? "포터" : "말포이"}: ${T(m)}`).join("\n");
    try {
      const r = await this.engine.chat([{ role: "user", content: `다음 ${conv.type === "story" ? "이야기" : "대화"}에서 있었던 일을 말포이 시점의 기억처럼 2문장으로 요약하라.\n${chunk}` }], { slot: 1, maxTokens: 160, temperature: 0.2, loraScale: 0 });
      this.memory.addEpisode(conv.id, r.text.trim()); conv.episodeAt = conv.messages.length; this.convs.save(conv);
    } catch {}
  }

  // ── 스토리 ──
  async createStory({ pointId = null, seed = "" } = {}) {
    let world;
    if (pointId) { const p = this.points.find((x) => x.id === pointId); world = { ...p, source: "canon" }; }
    else {
      const prompt = `해리 포터 원작 세계(드레이코 말포이가 처음부터 여자인 평행세계)에서 포터와 말포이가 단둘이 엮이는 새로운 상황을 하나 만들어라. 원작의 시간선·사건과 모순되지 않게.${seed ? "\n독자 요청: " + seed : ""}
JSON: title(짧은 제목), time(시기), school_year(1~7), location, situation(2~3문장, 2인칭 '너'=포터), hidden_emotion(그녀의 숨은 감정), first_line(그녀의 첫 대사).`;
      world = { ...JSON.parse((await this.engine.chat([{ role: "user", content: prompt }], { slot: 1, maxTokens: 500, temperature: 1.0, loraScale: 0, json: WORLD_SCHEMA })).text), source: "ai", seed };
    }
    return this.convs.create({ type: "story", title: world.title, world });
  }
  async beginStory(convId, { onToken, signal } = {}) {
    const conv = this.convs.get(convId); await this.engine.useConversation(convId);
    const w = conv.world;
    const msgs = [{ role: "system", content: this.storySystem(conv) }, { role: "user", content: `이야기를 시작하라. 장면을 연 뒤 그녀가 이렇게 말을 꺼낸다: "${w.first_line}" (표현은 자연스럽게 다듬어도 된다)` }];
    const r = await this.engine.chat(msgs, { onToken: onToken && ((d, full) => onToken(d, storyTidy(full))), signal, maxTokens: 700, temperature: 0.85, loraScale: 0.4 });
    const bot = this.convs.addMessage(conv, { role: "assistant", content: storyTidy(r.text.trim()), opening: true });
    return bot;
  }
  suggestions(conv) { return conv.type === "story" && conv.messages.length === 1 ? (conv.world.choices || []).map((c) => c.user_choice) : []; }

  // ── 부엉이 우편 ──
  mail() { try { return JSON.parse(fs.readFileSync(this.mailFile, "utf8")); } catch { return []; } }
  saveMail(list) { fs.writeFileSync(this.mailFile, JSON.stringify(list.slice(0, 100))); }
  dueMail({ quietStart = 23, quietEnd = 8, lastSeen = 0, lastMail = 0 }) {
    const t = Date.now(), hour = new Date().getHours();
    if (!lastSeen || t - lastMail < 20 * 3600e3) return null;
    if (hour >= 1 && hour < 5 && t - lastSeen < 30 * 60000) return { kind: "late", context: "포터가 새벽인데 아직 안 자고 컴퓨터를 하고 있다." };
    const quiet = quietStart > quietEnd ? (hour >= quietStart || hour < quietEnd) : (hour >= quietStart && hour < quietEnd); if (quiet) return null;
    const gap = (t - lastSeen) / 864e5;
    if (gap >= 2) return { kind: "absent", context: `포터가 ${Math.floor(gap)}일째 연락이 없다.` };
    if (Math.random() < 0.35) return { kind: "excuse", context: "핑계: " + this.char.excuses[Math.floor(Math.random() * this.char.excuses.length)] };
    return null;
  }
  async writeMail(due) {
    const note = this.memory.note(due.context);
    const sys = this.char.system.replace("{stage}", this.stage().name).replace("{scene}", "부엉이 편지를 쓰는 중");
    const r = await this.engine.chat([{ role: "system", content: sys }, { role: "user", content: `${note ? "<메모>\n" + note + "\n</메모>\n" : ""}포터에게 보낼 짧은 부엉이 편지를 써라. ${due.context}\n본문만 2~4문장, '포터,'로 시작하고 끝에 서명 'D.M.'. 보고 싶었다는 말은 절대 직접 하지 마라.` }], { slot: 1, maxTokens: 200, temperature: 0.9, loraScale: this.loraScale });
    const letter = { id: Date.now().toString(36), kind: due.kind, text: r.text.trim(), t: Date.now(), read: false };
    this.saveMail([letter, ...this.mail()]); return letter;
  }
  markRead(id) { this.saveMail(this.mail().map((m) => (m.id === id ? { ...m, read: true } : m))); }
}
