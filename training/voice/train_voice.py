"""Qwen3-TTS 1.7B Base를 v2_s11 말포이 목소리 하나로 미세조정 (LoRA → 병합).
입력 구성은 qwen_tts 추론 코드(Qwen3TTSForConditionalGeneration.generate, x-vector 모드, 스트리밍 텍스트)와 같다:
  [role 3] + [tts_pad×5, tts_bos] + codec[think, think_bos, ko, think_eos, SPK, pad] + [text0 + codec_bos]  = 10 위치
  이어서 프레임 k 마다: 16개 코드 임베딩 합 + (text_{k+1} 또는 tts_eos, 그 뒤는 tts_pad)
본체 손실: 위치 9..9+T 에서 다음 프레임의 첫 코드 / 마지막은 codec_eos.
보조(code predictor) 손실: forward_sub_talker_finetune(프레임 코드, 그 프레임을 예측한 본체 은닉 상태).
SPK 자리에는 앱이 실제로 넘기는 malfoy_ref.wav 의 x-vector 를 고정해서 넣는다 → 앱은 코드 변경 없이 같은 참조로 학습된 목소리를 낸다.
사용: <qwen venv> train_voice.py [--epochs 3] [--lr 1e-4] [--rank 32]"""
import argparse, json, math, os, random, time
import torch, torch.nn.functional as F
from qwen_tts import Qwen3TTSModel
from peft import LoraConfig, get_peft_model

D = "D:/TSMalfoyAI/training/voice"
BASE = "D:/ClipForge/engines/qwen3-tts/models/Qwen3-TTS-12Hz-1.7B-Base"
ap = argparse.ArgumentParser(); ap.add_argument("--epochs", type=int, default=3); ap.add_argument("--lr", type=float, default=1e-4)
ap.add_argument("--rank", type=int, default=32); ap.add_argument("--accum", type=int, default=8); ap.add_argument("--sub_w", type=float, default=0.5)
a = ap.parse_args()
torch.manual_seed(7); random.seed(7)

tts = Qwen3TTSModel.from_pretrained(BASE, device_map="cuda:0", dtype=torch.bfloat16, attn_implementation="sdpa")
model = tts.model; talker = model.talker; cfg = model.config; tc = cfg.talker_config; dev = talker.device
ds = torch.load(f"{D}/dataset.pt"); items = ds["items"]; spk = ds["spk"].to(dev, torch.bfloat16)
random.shuffle(items); n_val = max(8, len(items) // 20); val, train = items[:n_val], items[n_val:]

lcfg = LoraConfig(r=a.rank, lora_alpha=a.rank, lora_dropout=0.05,
                  target_modules=r"talker\.(model|code_predictor\.model)\.layers\.\d+\.(self_attn\.(q|k|v|o)_proj|mlp\.(gate|up|down)_proj)")
pm = get_peft_model(model, lcfg); pm.print_trainable_parameters()
for p in pm.parameters():
    if p.requires_grad: p.data = p.data.float()

E_text = lambda x: talker.text_projection(talker.get_text_embeddings()(x))
E_codec = talker.get_input_embeddings()
T_ = lambda *v: torch.tensor([list(v)], device=dev)


def build(it):
    ids = it["ids"].to(dev); codes = it["codes"].to(dev).long(); T = codes.shape[0]
    tts_bos, tts_eos, tts_pad = E_text(T_(cfg.tts_bos_token_id, cfg.tts_eos_token_id, cfg.tts_pad_token_id)).chunk(3, dim=1)
    c0 = E_codec(T_(tc.codec_think_id, tc.codec_think_bos_id, tc.codec_language_id["korean"], tc.codec_think_eos_id))
    c1 = E_codec(T_(tc.codec_pad_id, tc.codec_bos_id))
    cin = torch.cat([c0, spk.view(1, 1, -1), c1], dim=1)                                    # 7
    pre = torch.cat([tts_pad.expand(-1, cin.shape[1] - 2, -1), tts_bos], dim=1) + cin[:, :-1]
    prefix = torch.cat([E_text(ids[:, :3]), pre, E_text(ids[:, 3:4]) + cin[:, -1:]], dim=1)  # 10
    trailing = torch.cat([E_text(ids[:, 4:-5]), tts_eos], dim=1)                           # text_1.. + eos
    fr = E_codec(codes[:, 0]).clone()
    for g in range(1, tc.num_code_groups): fr = fr + talker.code_predictor.get_input_embeddings()[g - 1](codes[:, g])
    L = trailing.shape[1]; add = torch.cat([trailing[0, :min(L, T)], tts_pad[0].expand(max(0, T - L), -1)], dim=0)
    x = torch.cat([prefix, (fr + add).unsqueeze(0)], dim=1)                                  # (1, 10+T, D)
    target = torch.cat([codes[:, 0], torch.tensor([tc.codec_eos_token_id], device=dev)])    # T+1
    return x, target, codes


def step(it):
    x, target, codes = build(it); n = x.shape[1]
    pos = torch.arange(n, device=dev).view(1, 1, -1).expand(3, 1, -1)
    h = talker.model(inputs_embeds=x, position_ids=pos, use_cache=False).last_hidden_state[0]   # (n, D)
    hp = h[9:9 + codes.shape[0] + 1]                                                        # predicts frames 0..T-1, eos
    lt = F.cross_entropy(talker.codec_head(hp).float(), target)
    # forward_sub_talker_finetune 의 loss 는 HF causal-LM 손실이라 라벨을 한 칸 더 민다(→ 두 칸 뒤 예측을 학습, 생성이 망가짐).
    # 로짓(위치 i 가 i+1 번째 코드를 예측하도록 이미 정렬됨)만 받아서 직접 CE.
    lg, _ = talker.forward_sub_talker_finetune(codes, h[9:9 + codes.shape[0]])
    ls = F.cross_entropy(lg.float().reshape(-1, lg.shape[-1]), codes[:, 1:].reshape(-1))
    return lt, ls


opt = torch.optim.AdamW([p for p in pm.parameters() if p.requires_grad], lr=a.lr, weight_decay=0.0)
total = a.epochs * math.ceil(len(train) / a.accum); sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1, (s + 1) / 20) * max(0.05, 0.5 * (1 + math.cos(math.pi * s / total))))


def evaluate():
    pm.eval(); a_, b_ = 0, 0
    with torch.no_grad():
        for it in val:
            with torch.autocast("cuda", dtype=torch.bfloat16): lt, ls = step(it)
            a_ += lt.item(); b_ += ls.item()
    pm.train(); return a_ / len(val), b_ / len(val)


log = open(f"{D}/train.log", "a", encoding="utf-8"); t0 = time.time()
v0 = evaluate(); print(f"val before: talker {v0[0]:.3f} sub {v0[1]:.3f}", flush=True); log.write(json.dumps({"val0": v0}) + "\n")
pm.train(); s = 0
for ep in range(a.epochs):
    random.shuffle(train); acc = [0, 0]
    for i, it in enumerate(train):
        with torch.autocast("cuda", dtype=torch.bfloat16): lt, ls = step(it)
        ((lt + a.sub_w * ls) / a.accum).backward(); acc[0] += lt.item(); acc[1] += ls.item()
        if (i + 1) % a.accum == 0 or i == len(train) - 1:
            torch.nn.utils.clip_grad_norm_([p for p in pm.parameters() if p.requires_grad], 1.0); opt.step(); sched.step(); opt.zero_grad(); s += 1
            if s % 10 == 0: print(f"ep {ep} step {s}/{total} talker {acc[0] / (i + 1):.3f} sub {acc[1] / (i + 1):.3f} ({time.time() - t0:.0f}s)", flush=True)
    v = evaluate(); print(f"== epoch {ep} val talker {v[0]:.3f} sub {v[1]:.3f}", flush=True); log.write(json.dumps({"epoch": ep, "val": v}) + "\n"); log.flush()
    pm.save_pretrained(f"{D}/lora_ep{ep}")
print("TRAIN DONE", flush=True)
