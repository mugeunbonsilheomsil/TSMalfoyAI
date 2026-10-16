// 설치 매니저: 이어받기 + SHA256 검증 + zip 해제. 진행 상황은 onProgress 콜백으로.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { Readable } from "node:stream";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function hashFile(file, h = crypto.createHash("sha256")) {
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 4 << 20 })) h.update(chunk);
  return h;
}

/** 한 파일 받기. 이미 검증된 파일이 있으면 건너뜀. .part 가 있으면 이어받음. */
export async function download(item, dest, { signal, onProgress } = {}) {
  const done = dest + ".ok";
  if (fs.existsSync(dest) && fs.existsSync(done) && fs.readFileSync(done, "utf8") === item.sha256) { onProgress?.({ got: item.size, total: item.size, speed: 0 }); return dest; }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = dest + ".part";
  for (let attempt = 1; ; attempt++) {
    let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
    if (have > item.size) { fs.rmSync(part); have = 0; }
    try {
      if (have < item.size) {
        const res = await fetch(item.url, { headers: have ? { Range: `bytes=${have}-` } : {}, signal, redirect: "follow" });
        if (!(res.status === 200 || res.status === 206)) throw new Error(`HTTP ${res.status}`);
        if (res.status === 200 && have) have = 0;                                   // 서버가 Range 무시 → 처음부터
        const out = fs.createWriteStream(part, { flags: have ? "a" : "w" });
        let got = have, last = Date.now(), lastGot = got, speed = 0;
        for await (const chunk of Readable.fromWeb(res.body)) {
          if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
          got += chunk.length;
          const now = Date.now();
          if (now - last > 500) { speed = (got - lastGot) / ((now - last) / 1000); last = now; lastGot = got; onProgress?.({ got, total: item.size, speed }); }
        }
        await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
      }
      onProgress?.({ got: item.size, total: item.size, speed: 0, verifying: true });
      const digest = (await hashFile(part)).digest("hex");
      if (digest !== item.sha256) { fs.rmSync(part); throw new Error("SHA256 불일치 — 파일이 손상되어 다시 받습니다"); }
      fs.renameSync(part, dest); fs.writeFileSync(done, item.sha256);
      return dest;
    } catch (e) {
      if (signal?.aborted) throw new Error("취소됨");
      if (attempt >= 5) throw e;
      await sleep(1500 * attempt);
    }
  }
}

export function unzip(zip, dir) {
  fs.mkdirSync(dir, { recursive: true });
  // Windows 10+ 기본 tar(bsdtar)가 zip 해제 지원
  return new Promise((res, rej) => execFile(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe"), ["-xf", zip, "-C", dir], { windowsHide: true },
    (err, _o, se) => (err ? rej(new Error("압축 해제 실패: " + (se || err.message))) : res())));
}

/** 계획(plan) 전체 설치. steps: [{id,label,items:[{...item, dest, unzipTo?}]}] */
export async function install(plan, { signal, onStep, onProgress }) {
  for (const step of plan) {
    onStep?.({ id: step.id, state: "running" });
    const total = step.items.reduce((s, i) => s + i.size, 0); let base = 0;
    for (const it of step.items) {
      const mark = it.unzipTo && path.join(it.unzipTo, ".ok-" + it.sha256.slice(0, 16));
      if (mark && fs.existsSync(mark)) { base += it.size; onProgress?.({ step: step.id, got: base, total }); continue; }
      await download(it, it.dest, { signal, onProgress: (p) => onProgress?.({ step: step.id, got: base + p.got, total, speed: p.speed, verifying: p.verifying }) });
      if (it.unzipTo) { onProgress?.({ step: step.id, got: base + it.size, total, unzipping: true }); await unzip(it.dest, it.unzipTo); fs.writeFileSync(mark, ""); fs.rmSync(it.dest, { force: true }); fs.rmSync(it.dest + ".ok", { force: true }); }
      base += it.size;
    }
    onStep?.({ id: step.id, state: "done" });
  }
}
