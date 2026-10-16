// 작은 JSON 저장소: 원자적 쓰기(임시 파일 → rename), 손상 시 기본값
import fs from "node:fs";
import path from "node:path";

export class JsonStore {
  constructor(file, defaults) {
    this.file = file; this.defaults = defaults;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try { this.data = { ...structuredClone(defaults), ...JSON.parse(fs.readFileSync(file, "utf8")) }; }
    catch { this.data = structuredClone(defaults); }
  }
  get(k) { return this.data[k]; }
  set(k, v) { this.data[k] = v; this.save(); }
  patch(obj) { Object.assign(this.data, obj); this.save(); }
  save() {
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    fs.renameSync(tmp, this.file);
  }
}
