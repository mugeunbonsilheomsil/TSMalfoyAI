// 하드웨어 검사 → 런타임(cuda/vulkan/cpu)과 모델(q4/q2) 추천
import { execFile } from "node:child_process";
import os from "node:os";
import fs from "node:fs";

const run = (cmd, args, timeout = 8000) => new Promise((res) => {
  execFile(cmd, args, { timeout, windowsHide: true }, (err, out) => res(err ? "" : String(out)));
});

async function nvidia() {
  const out = await run("nvidia-smi", ["--query-gpu=name,memory.total,driver_version", "--format=csv,noheader,nounits"]);
  const line = out.split(/\r?\n/).find(Boolean);
  if (!line) return null;
  const [name, mem, driver] = line.split(",").map((s) => s.trim());
  return { vendor: "nvidia", name, vramGB: Math.round(Number(mem) / 1024 * 10) / 10, driver };
}

async function otherGpus() {
  // AdapterRAM은 4 GB에서 잘리므로 이름만 신뢰하고, VRAM은 레지스트리 qwMemorySize를 시도
  const ps = `$ErrorActionPreference='SilentlyContinue';` +
    `Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name };` +
    `'---';` +
    `Get-ItemProperty 'HKLM:\\SYSTEM\\ControlSet001\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' | ForEach-Object { '' + $_.DriverDesc + '|' + $_.'HardwareInformation.qwMemorySize' }`;
  const out = await run("powershell.exe", ["-NoProfile", "-Command", ps], 15000);
  const [namesPart, regPart = ""] = out.split("---");
  const names = namesPart.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const mem = Object.fromEntries(regPart.split(/\r?\n/).map((l) => l.trim().split("|")).filter((p) => p[0] && p[1]).map(([n, b]) => [n, Number(b)]));
  return names.filter((n) => !/microsoft basic|remote|virtual/i.test(n)).map((n) => ({
    vendor: /amd|radeon/i.test(n) ? "amd" : /intel/i.test(n) ? "intel" : /nvidia|geforce|rtx|gtx/i.test(n) ? "nvidia" : "other",
    name: n, vramGB: mem[n] ? Math.round(mem[n] / 2 ** 30 * 10) / 10 : null,
  }));
}

export function diskFreeGB(dir) {
  try { const s = fs.statfsSync(dir); return Math.round(s.bavail * s.bsize / 1e9 * 10) / 10; } catch { return null; }
}

export async function detect() {
  const nv = await nvidia();
  const gpus = nv ? [nv] : await otherGpus();
  const gpu = gpus.sort((a, b) => (b.vramGB || 0) - (a.vramGB || 0))[0] || null;
  const ramGB = Math.round(os.totalmem() / 2 ** 30);
  const cpu = os.cpus()[0]?.model?.trim() || "";
  let runtime = "cpu", model = ramGB >= 16 ? "q4" : "q2", reason;
  if (gpu?.vendor === "nvidia" && nv) { runtime = "cuda"; reason = "NVIDIA GPU → CUDA"; }
  else if (gpu && gpu.vendor !== "other") { runtime = "vulkan"; reason = `${gpu.vendor.toUpperCase()} GPU → Vulkan`; }
  else reason = "GPU 없음 → CPU";
  if (runtime !== "cpu") model = (gpu.vramGB ?? 0) >= 6 ? "q4" : "q2";
  return { gpu, gpus, ramGB, cpu, recommend: { runtime, model, draft: runtime === "cuda", reason } };
}
