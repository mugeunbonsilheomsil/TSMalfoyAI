"""LoRA를 기본 모델에 병합 → 원본 모델 폴더 구조 그대로 새 폴더(merged/)에 저장 (GGUF 변환용).
학습 대상(talker 본체·code predictor 레이어)만 바뀌고 나머지 파일(토크나이저·speech_tokenizer 등)은 복사."""
import os, shutil, json, sys, torch
from safetensors.torch import load_file, save_file
from qwen_tts import Qwen3TTSModel
from peft import PeftModel
D = "D:/TSMalfoyAI/training/voice"; BASE = "D:/ClipForge/engines/qwen3-tts/models/Qwen3-TTS-12Hz-1.7B-Base"; OUT = f"{D}/merged"
tts = Qwen3TTSModel.from_pretrained(BASE, device_map="cpu", dtype=torch.bfloat16)
merged = PeftModel.from_pretrained(tts.model, f"{D}/lora_ep2").merge_and_unload()
new = {k: v.to(torch.bfloat16).contiguous() for k, v in merged.state_dict().items()}
if os.path.exists(OUT): shutil.rmtree(OUT)
shutil.copytree(BASE, OUT, ignore=lambda d, names: [n for n in names if n.startswith("model") and n.endswith(".safetensors") and os.path.samefile(d, BASE)])
changed = 0
for f in sorted(x for x in os.listdir(BASE) if x.startswith("model") and x.endswith(".safetensors")):
    sd = load_file(f"{BASE}/{f}")
    for k in sd:
        if k in new and not torch.equal(sd[k], new[k]): sd[k] = new[k]; changed += 1
        elif k not in new: print("not in merged model:", k); sys.exit(1)
    save_file(sd, f"{OUT}/{f}", metadata={"format": "pt"})
print("changed tensors:", changed)
