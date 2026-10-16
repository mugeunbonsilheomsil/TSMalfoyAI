// 대화 저장소: index.json(목록) + conv/<id>.json(본문). 이미지 등 첨부는 conv/<id>/ 폴더.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { JsonStore } from "./store.mjs";

const uid = () => crypto.randomBytes(6).toString("hex");

export class Conversations {
  constructor(dir) {
    this.dir = path.join(dir, "conv"); fs.mkdirSync(this.dir, { recursive: true });
    this.index = new JsonStore(path.join(dir, "conversations.json"), { list: [] });
    this.cache = new Map();
  }
  list() { return [...this.index.get("list")].sort((a, b) => b.updated - a.updated); }
  meta(id) { return this.index.get("list").find((c) => c.id === id); }
  file(id) { return path.join(this.dir, id + ".json"); }
  assetDir(id) { const d = path.join(this.dir, id); fs.mkdirSync(d, { recursive: true }); return d; }

  create({ type = "chat", title = type === "story" ? "새 스토리" : "새 대화", world = null } = {}) {
    const c = { id: uid(), type, title, created: Date.now(), updated: Date.now(), world, summary: "", summarizedUpTo: 0, messages: [] };
    this.save(c);
    this.index.set("list", [...this.index.get("list"), { id: c.id, type, title, created: c.created, updated: c.updated }]);
    return c;
  }
  get(id) {
    if (this.cache.has(id)) return this.cache.get(id);
    try { const c = JSON.parse(fs.readFileSync(this.file(id), "utf8")); this.cache.set(id, c); return c; } catch { return null; }
  }
  save(c) {
    c.updated = Date.now(); this.cache.set(c.id, c);
    const tmp = this.file(c.id) + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(c)); fs.renameSync(tmp, this.file(c.id));
    const list = this.index.get("list"); const m = list.find((x) => x.id === c.id);
    if (m) { m.title = c.title; m.updated = c.updated; this.index.save(); }
  }
  rename(id, title) { const c = this.get(id); if (c) { c.title = title; this.save(c); } }
  remove(id) {
    this.cache.delete(id);
    fs.rmSync(this.file(id), { force: true }); fs.rmSync(path.join(this.dir, id), { recursive: true, force: true });
    this.index.set("list", this.index.get("list").filter((c) => c.id !== id));
  }
  removeAll() { for (const c of this.list()) this.remove(c.id); }

  // 메시지: { id, role, content, t, alts?: [string], alt?: n, rating?: 1|-1, images?: [file], voice?: true }
  static text(m) { return m.alts ? m.alts[m.alt ?? m.alts.length - 1] : m.content; }
  addMessage(c, m) { const msg = { id: uid(), t: Date.now(), ...m }; c.messages.push(msg); this.save(c); return msg; }
}
