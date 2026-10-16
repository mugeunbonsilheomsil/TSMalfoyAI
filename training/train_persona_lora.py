"""TS 말포이 페르소나 LoRA — Gemma 4 E4B (QAT q4_0 unquantized 가중치) on RTX 4070 12 GB
   python train_persona_lora.py --version v1 [--precision nf4|bf16] [--probe]
배포 GGUF(Q4_0 QAT)와 같은 가중치로 학습하므로 LoRA가 배포 모델에 그대로 맞는다.

VRAM/속도 절약 (docs/04_E4B_학습_조사.md 참고)
  1. per-layer embedding 표(2.8B = 5.6 GB)는 GPU/RAM에 안 올리고 safetensors에서 배치에 필요한 행만 mmap으로 읽음
  2. 비전/오디오 타워 제거 (텍스트 대화만 학습)
  3. 언어 층은 NF4(이중양자화) → ~2.2 GB. --precision bf16 은 VRAM 여유 있을 때만
  4. 손실은 말포이 대사 토큰에만, lm_head(어휘 262k)도 그 위치에서만 계산 → 로짓 메모리 절반 이하
  5. 길이 버킷 배치 + 64 배수 패딩 (Triton 재컴파일 방지), VRAM 상한 → 공유메모리로 새면 10배 느려지는 것 방지
  6. --probe : 가장 긴 배치로 3스텝만 돌려 최대 VRAM·토큰/초 측정 → bs / grad-ckpt 결정"""
import argparse, json, math, os, random, time, struct
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "garbage_collection_threshold:0.6,max_split_size_mb:128")
import numpy as np, torch
import torch.nn.functional as F
from transformers import AutoTokenizer, AutoModelForCausalLM, AutoConfig, BitsAndBytesConfig
from peft import LoraConfig, get_peft_model

HERE = os.path.dirname(os.path.abspath(__file__))
ap = argparse.ArgumentParser()
ap.add_argument("--version", default="v1")
ap.add_argument("--base", default=r"D:/AIModels/base/gemma-4-e4b-it-qat-lm", help="split_gemma4_lm.py 결과 (언어 층만)")
ap.add_argument("--ple", default=r"D:/AIModels/base/gemma-4-e4b-it-qat-lm/ple.safetensors", help="per-layer embedding 표만 담은 파일 (mmap)")
ap.add_argument("--data", default=os.path.join(HERE, "data")); ap.add_argument("--out-root", default=os.path.join(HERE, "..", "persona", "lora"))
ap.add_argument("--precision", choices=["nf4", "bf16"], default="nf4")
ap.add_argument("--epochs", type=float, default=3); ap.add_argument("--bs", type=int, default=4); ap.add_argument("--accum", type=int, default=4)
ap.add_argument("--lr", type=float, default=1e-4); ap.add_argument("--rank", type=int, default=16); ap.add_argument("--alpha", type=int, default=32); ap.add_argument("--dropout", type=float, default=0.05)
ap.add_argument("--maxlen", type=int, default=1024); ap.add_argument("--seed", type=int, default=42)
ap.add_argument("--vram-frac", type=float, default=0.85); ap.add_argument("--no-grad-ckpt", action="store_true"); ap.add_argument("--probe", action="store_true")
a = ap.parse_args()
random.seed(a.seed); torch.manual_seed(a.seed)
OUT = os.path.abspath(os.path.join(a.out_root, a.version)); RUN = os.path.join(OUT, "run"); os.makedirs(RUN, exist_ok=True)
open(os.path.join(RUN, "metrics.jsonl"), "w").close()
def log(o): open(os.path.join(RUN, "metrics.jsonl"), "a", encoding="utf-8").write(json.dumps(o, ensure_ascii=False) + "\n")
def status(**kw): json.dump({"updated": time.time(), **kw}, open(os.path.join(RUN, "status.json"), "w", encoding="utf-8"), ensure_ascii=False)

torch.cuda.set_per_process_memory_fraction(a.vram_frac); torch.backends.cuda.matmul.allow_tf32 = True
tok = AutoTokenizer.from_pretrained(a.base)
cfg = AutoConfig.from_pretrained(a.base); cfg.audio_config = None; cfg.vision_config = None
cfg.text_config.vocab_size_per_layer_input = 16          # 5.6 GB 표 대신 아래 mmap 조회로 교체
q = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_use_double_quant=True, bnb_4bit_compute_dtype=torch.bfloat16) if a.precision == "nf4" else None
t_load = time.time()
model, info = AutoModelForCausalLM.from_pretrained(a.base, config=cfg, dtype=torch.bfloat16, quantization_config=q, device_map={"": 0}, low_cpu_mem_usage=True, output_loading_info=True)
miss = [k for k in info["missing_keys"] if "embed_tokens_per_layer" not in k]; assert not miss, f"weights missing from checkpoint: {miss[:5]}"
model.config.use_cache = False                            # transformers 5.18: KV 공유 층은 캐시가 아니라 shared_kv_states를 씀 → 학습 시 안전
lm = model.model.language_model; emb = lm.embed_tokens_per_layer

class MmapLookup(torch.nn.Module):
    def __init__(self, path, name, scale, dev):
        super().__init__(); self.dev = dev; self.scale = float(scale)
        with open(path, "rb") as f: n = struct.unpack("<Q", f.read(8))[0]; hdr = json.loads(f.read(n))
        t = hdr[name]; assert t["dtype"] == "BF16", t["dtype"]; self.shape = tuple(t["shape"])
        self.mm = np.memmap(path, dtype=np.uint16, mode="r", offset=8 + n + t["data_offsets"][0], shape=self.shape)
    def forward(self, ids):
        rows = np.ascontiguousarray(self.mm[ids.detach().cpu().numpy().reshape(-1)])
        return torch.from_numpy(rows).view(torch.bfloat16).reshape(*ids.shape, self.shape[1]).to(self.dev) * self.scale
lm.embed_tokens_per_layer = MmapLookup(a.ple, "model.language_model.embed_tokens_per_layer.weight",
                                       getattr(emb, "scalar_embed_scale", 1.0), "cuda:0"); del emb
print(f"load {time.time()-t_load:.0f}s | precision {a.precision} | vram after load {torch.cuda.memory_allocated()/1e9:.2f} GB", flush=True)

if not a.no_grad_ckpt: model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False}); model.enable_input_require_grads()
lcfg = LoraConfig(r=a.rank, lora_alpha=a.alpha, lora_dropout=a.dropout, bias="none", task_type="CAUSAL_LM",
                  target_modules=r".*language_model\.layers\.\d+\.(self_attn\.(q|k|v|o)_proj|mlp\.(gate|up|down)_proj)")
model = get_peft_model(model, lcfg)
for p in model.parameters():
    if p.requires_grad: p.data = p.data.float()
tr = [p for p in model.parameters() if p.requires_grad]; print(f"trainable {sum(p.numel() for p in tr)/1e6:.1f}M", flush=True)

END = "<turn|>\n"
def encode(msgs):
    """멀티턴: 모든 말포이(assistant) 턴이 정답. 템플릿은 문자열 이어붙이기라 접두사가 안정적 → 조각별 토큰화"""
    ids, lab = [], []
    for i, m in enumerate(msgs):
        if m["role"] != "assistant": continue
        prompt = tok.apply_chat_template(msgs[:i], add_generation_prompt=True, tokenize=False)
        p_ids = tok(prompt, add_special_tokens=False)["input_ids"][len(ids):]       # 이전 조각 이후 새로 붙은 프롬프트 부분
        a_ids = tok(m["content"] + END, add_special_tokens=False)["input_ids"]
        ids += p_ids + a_ids; lab += [-100] * len(p_ids) + a_ids
    return {"ids": ids[: a.maxlen], "labels": lab[: a.maxlen]}

rd = lambda f: [json.loads(l)["messages"] for l in open(os.path.join(a.data, f), encoding="utf-8") if l.strip()]
train = [encode(m) for m in rd("train.jsonl")]; val = [encode(m) for m in rd("val.jsonl")]
# 접두사 안정성 검사: 조각 토큰화 결과가 통째 토큰화와 같아야 함
chk = rd("train.jsonl")[0]; whole = tok(tok.apply_chat_template(chk, tokenize=False), add_special_tokens=False)["input_ids"]
assert whole[: len(train[0]["ids"])] == train[0]["ids"], "segment tokenisation differs from whole-string tokenisation"
ntok = sum(len(x["ids"]) for x in train); nlab = sum(sum(1 for t in x["labels"] if t != -100) for x in train)
print(f"train {len(train)} val {len(val)} | tokens {ntok} (answer {nlab}, {nlab/ntok:.0%}) | max len {max(len(x['ids']) for x in train)}", flush=True)

def batches(rows, bs, shuffle):
    idx = list(range(len(rows)))
    if shuffle:
        random.shuffle(idx); ch = [idx[i:i + bs * 8] for i in range(0, len(idx), bs * 8)]
        idx = [j for c in ch for j in sorted(c, key=lambda k: len(rows[k]["ids"]))]
        bl = [idx[i:i + bs] for i in range(0, len(idx), bs)]; random.shuffle(bl)
    else: bl = [idx[i:i + bs] for i in range(0, len(idx), bs)]
    for b in bl:
        L = ((max(len(rows[i]["ids"]) for i in b) + 63) // 64) * 64; pad = tok.pad_token_id or 0
        ids = torch.tensor([rows[i]["ids"] + [pad] * (L - len(rows[i]["ids"])) for i in b])
        lab = torch.tensor([rows[i]["labels"] + [-100] * (L - len(rows[i]["labels"])) for i in b])
        att = torch.tensor([[1] * len(rows[i]["ids"]) + [0] * (L - len(rows[i]["ids"])) for i in b])
        yield ids.cuda(), att.cuda(), lab.cuda()

class ChunkedSoftcapCE(torch.autograd.Function):
    """lm_head(어휘 262k) + softcap + CE 를 512토큰 조각씩 계산하고 hidden 기울기만 저장 → 전체 로짓 텐서를 만들지 않음 (Cut-Cross-Entropy 원리).
    lm_head(=임베딩)는 학습하지 않으므로 W 기울기는 필요 없음."""
    @staticmethod
    def forward(ctx, h, W, tg, cap, chunk=512):
        grad = torch.empty_like(h); loss = torch.zeros((), device=h.device, dtype=torch.float32); hit = torch.zeros((), device=h.device, dtype=torch.long)
        for s in range(0, h.size(0), chunk):
            x = (h[s:s + chunk] @ W.t()).float(); t = tg[s:s + chunk]
            z = torch.tanh(x / cap) * cap if cap else x
            lse = torch.logsumexp(z, -1); loss += (lse - z.gather(1, t[:, None]).squeeze(1)).sum(); hit += (z.argmax(-1) == t).sum()
            g = torch.softmax(z, -1); g[torch.arange(t.numel(), device=t.device), t] -= 1
            if cap: g *= 1 - (z / cap) ** 2
            grad[s:s + chunk] = (g.to(W.dtype) @ W)
        ctx.save_for_backward(grad); ctx.mark_non_differentiable(hit); return loss, hit
    @staticmethod
    def backward(ctx, gl, _gh):
        (grad,) = ctx.saved_tensors; return grad * gl.to(grad.dtype), None, None, None, None

core = model.get_base_model(); W = core.lm_head.weight; CAP = cfg.get_text_config().final_logit_softcapping
def loss_of(ids, att, lab):
    tgt = lab[:, 1:]; m = tgt != -100
    with torch.autocast("cuda", dtype=torch.bfloat16): h = core.model(input_ids=ids, attention_mask=att, use_cache=False).last_hidden_state
    loss, hit = ChunkedSoftcapCE.apply(h[:, :-1][m].to(W.dtype), W, tgt[m], CAP)
    return loss, m.sum(), hit

@torch.no_grad()
def evaluate():
    model.eval(); tot = cnt = hit = 0
    for ids, att, lab in batches(val, 2, False): l, n, h = loss_of(ids, att, lab); tot += l.item(); cnt += n.item(); hit += h.item()
    model.train(); return tot / max(1, cnt), hit / max(1, cnt)

opt = torch.optim.AdamW(tr, lr=a.lr, weight_decay=0.01, betas=(0.9, 0.99), fused=True)
if a.probe:                                                                     # 최악(가장 긴) 배치로 3스텝
    ids, att, lab = next(batches(val[:1], 1, False))                            # 조각 CE == 표준 CE 검증
    with torch.no_grad(), torch.autocast("cuda", dtype=torch.bfloat16):
        ref = F.cross_entropy(model(input_ids=ids, attention_mask=att).logits[:, :-1].float().reshape(-1, W.size(0)), lab[:, 1:].reshape(-1), ignore_index=-100, reduction="sum")
        mine = loss_of(ids, att, lab)[0]
    print(f"CE check: reference {ref.item():.3f} vs chunked {mine.item():.3f}", flush=True)
    longest = sorted(train, key=lambda x: -len(x["ids"]))[: a.bs]; model.train(); torch.cuda.reset_peak_memory_stats()
    for k in range(3):
        t = time.time(); ids, att, lab = next(batches(longest, a.bs, False)); l, n, _ = loss_of(ids, att, lab); (l / n).backward(); opt.step(); opt.zero_grad(set_to_none=True); torch.cuda.synchronize()
        print(f"probe {k}: {ids.numel()/(time.time()-t):.0f} tok/s | peak {torch.cuda.max_memory_allocated()/1e9:.2f} GB | loss {(l/n).item():.3f}", flush=True)
    raise SystemExit

spe = math.ceil(len(train) / (a.bs * a.accum)); total = int(spe * a.epochs); warm = max(3, int(total * 0.05))
sched = lambda s: (s + 1) / warm if s < warm else 0.5 * (1 + math.cos(math.pi * (s - warm) / max(1, total - warm))) * 0.9 + 0.1
meta = {"version": a.version, "base": "google/gemma-4-E4B-it-qat-q4_0-unquantized", "precision": a.precision, "rank": a.rank, "alpha": a.alpha, "lr": a.lr,
        "epochs": a.epochs, "eff_batch": a.bs * a.accum, "steps": total, "train": len(train), "val": len(val), "grad_ckpt": not a.no_grad_ckpt}
json.dump(meta, open(os.path.join(OUT, "train_config.json"), "w"), indent=1)
model.train(); vl, va = evaluate(); log({"step": 0, "val_loss": vl, "val_acc": va}); print(f"step 0 val loss {vl:.3f} acc {va:.3f}", flush=True)
t0 = time.time(); step = 0; best = vl; done = False
while not done:
    micro = 0; rl = 0.0; rt = 0; opt.zero_grad(set_to_none=True)
    for ids, att, lab in batches(train, a.bs, True):
        l, n, _ = loss_of(ids, att, lab); (l / max(1, n.item()) / a.accum).backward(); rl += l.item(); rt += n.item(); micro += 1
        if micro % a.accum: continue
        for g in opt.param_groups: g["lr"] = a.lr * sched(step)
        gn = torch.nn.utils.clip_grad_norm_(tr, 1.0).item(); opt.step(); opt.zero_grad(set_to_none=True); step += 1; el = time.time() - t0
        log({"step": step, "epoch": round(step / spe, 2), "loss": rl / max(1, rt), "lr": opt.param_groups[0]["lr"], "grad_norm": gn, "t": round(el, 1)})
        status(state="training", step=step, total=total, loss=rl / max(1, rt), eta=round(el / step * (total - step)))
        print(f"step {step}/{total} loss {rl/max(1,rt):.4f} gn {gn:.2f} peak {torch.cuda.max_memory_allocated()/1e9:.1f}GB eta {el/step*(total-step)/60:.1f}m", flush=True); rl = 0.0; rt = 0
        if step % spe == 0 or step == total:
            vl, va = evaluate(); log({"step": step, "val_loss": vl, "val_acc": va}); print(f"  val loss {vl:.3f} acc {va:.3f}", flush=True)
            model.save_pretrained(os.path.join(OUT, f"ckpt-step{step}"))
            if vl < best: best = vl; model.save_pretrained(OUT)                      # 최저 val 체크포인트가 최종본 (과적합 방지)
        if step >= total: done = True; break
status(state="done", step=step, minutes=round((time.time() - t0) / 60, 1), best_val=best); print("DONE", OUT, "best val", round(best, 3), flush=True)
