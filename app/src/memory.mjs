// 장기 기억: 포터(사용자)에 대한 사실 + 지난 일(에피소드). 대화가 바뀌어도 이어진다.
//  facts    : { id, text, kind: user|pref|event|promise, imp: 1~3, t, used }
//  episodes : { id, convId, text, t }        — 대화를 떠날 때/압축할 때 한 문단 요약
//  bond     : 내부 관계 점수 (화면에 표시하지 않음, 말투 단계에만 사용)
import path from "node:path";
import crypto from "node:crypto";
import { JsonStore } from "./store.mjs";

const uid = () => crypto.randomBytes(5).toString("hex");
const grams = (t) => { const s = String(t).replace(/\s+/g, ""); const g = new Set(); for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2)); return g; };
const sim = (a, b) => { const A = grams(a), B = grams(b); if (!A.size || !B.size) return 0; let n = 0; for (const x of A) if (B.has(x)) n++; return n / Math.min(A.size, B.size); };

export class Memory {
  constructor(dir) { this.db = new JsonStore(path.join(dir, "memory.json"), { facts: [], episodes: [], bond: 0 }); }

  addFact({ text, kind = "user", imp = 1 }) {
    text = String(text || "").trim(); if (text.length < 4) return;
    const facts = this.db.get("facts");
    const same = facts.find((f) => sim(f.text, text) >= 0.6);
    if (same) { same.text = text; same.t = Date.now(); same.imp = Math.max(same.imp, imp); same.kind = kind; }     // 같은 내용이면 최신으로 갱신
    else facts.push({ id: uid(), text, kind, imp: Math.min(3, Math.max(1, imp | 0)), t: Date.now(), used: 0 });
    // 상한: 중요도 낮고 오래된 것부터 정리
    if (facts.length > 200) facts.sort((a, b) => (b.imp * 1e13 + b.t) - (a.imp * 1e13 + a.t)).splice(200);
    this.db.save();
  }
  addEpisode(convId, text) {
    text = String(text || "").trim(); if (!text) return;
    const eps = this.db.get("episodes").filter((e) => e.convId !== convId || Date.now() - e.t > 6 * 3600e3);   // 같은 대화의 최근 요약은 교체
    eps.push({ id: uid(), convId, text, t: Date.now() });
    this.db.set("episodes", eps.slice(-120));
  }

  /** 지금 말에 맞는 기억 몇 개 (관련도 + 중요도 + 최근) */
  recall(query, { facts = 8, episodes = 3 } = {}) {
    const now = Date.now(), fs = this.db.get("facts");
    const score = (x, base) => sim(x.text, query) * 4 + base + Math.max(0, 1 - (now - x.t) / (30 * 864e5));
    const f = fs.map((x) => ({ x, s: score(x, x.imp * 0.7) })).sort((a, b) => b.s - a.s).slice(0, facts).map((o) => o.x);
    f.forEach((x) => (x.used = (x.used || 0) + 1));
    const eps = this.db.get("episodes");
    const recent = eps.slice(-2), related = eps.slice(0, -2).map((x) => ({ x, s: sim(x.text, query) })).filter((o) => o.s > 0.25).sort((a, b) => b.s - a.s).slice(0, episodes - 1).map((o) => o.x);
    return { facts: f, episodes: [...related, ...recent] };
  }
  note(query) {
    const { facts, episodes } = this.recall(query);
    const day = (t) => new Date(t).toLocaleDateString("ko-KR", { month: "long", day: "numeric" });
    const parts = [];
    if (facts.length) parts.push("포터에 대해 아는 것: " + facts.map((f) => f.text).join(" / "));
    if (episodes.length) parts.push("지난 일: " + episodes.map((e) => `(${day(e.t)}) ${e.text}`).join(" / "));
    return parts.join("\n");
  }
  bond(delta) { if (delta) this.db.set("bond", Math.max(0, this.db.get("bond") + delta)); return this.db.get("bond"); }
  clear() { this.db.patch({ facts: [], episodes: [], bond: 0 }); }
}
