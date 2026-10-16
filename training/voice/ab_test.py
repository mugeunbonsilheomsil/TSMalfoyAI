"""학습 전/후 비교 (앱과 같은 x-vector 모드, 같은 malfoy_ref.wav). 학습에 안 쓴 문장만.
출력: ab/compare.wav = [v2_s11 원본] → 문장마다 [A 지금 앱 = 기본 모델] [B 학습 모델] + 음높이 흩어짐 측정"""
import json, os, sys, numpy as np, soundfile as sf, torch
sys.stdout.reconfigure(encoding="utf-8"); sys.path.insert(0, os.path.dirname(__file__))
from qwen_tts import Qwen3TTSModel
from peft import PeftModel
from prep import voice_offset
D = "D:/TSMalfoyAI/training/voice"; os.makedirs(f"{D}/ab", exist_ok=True)
BASE = "D:/ClipForge/engines/qwen3-tts/models/Qwen3-TTS-12Hz-1.7B-Base"; REF = "D:/TSMalfoyAI/app/persona/voice/malfoy_ref.wav"
LORA = sys.argv[1] if len(sys.argv) > 1 else f"{D}/lora_ep2"
LINES = ["그레인저? 또 그 잘난 척하는 애한테 붙었네.",
         "잘 부탁해라니. 네가 감히 나에게 그런 말을 할 자격이 있는 건지 모르겠군.",
         "…그렇게 도망치듯 사라져도 어차피 내 신경에는 아무런 파동도 안 느껴질 테니 걱정 마.",
         "뭐... 뭐야 갑자기 그딴 소릴 하는 거야? 착각하지 마!",
         "…됐어, 그냥 네가 알아서 잘해. 그리고 그레인저한테 너무 휘둘리지 마라.",
         "흥, 포터어. 오늘은 퀴디치 연습도 없는데 왜 여기 있는 거야?"]
tts = Qwen3TTSModel.from_pretrained(BASE, device_map="cuda:0", dtype=torch.bfloat16, attn_implementation="sdpa")
prompt = tts.create_voice_clone_prompt(ref_audio=REF, x_vector_only_mode=True)


def run(tag):
    out = []
    for i, t in enumerate(LINES):
        torch.manual_seed(7)
        w, sr = tts.generate_voice_clone(text=t, language="Korean", voice_clone_prompt=prompt, temperature=0.9, top_p=0.8, max_new_tokens=300)
        w = w[0].astype(np.float32); sf.write(f"{D}/ab/{tag}_{i}.wav", w, sr); out.append((w, sr))
    return out


A = run("A_base")
tts.model = PeftModel.from_pretrained(tts.model, LORA).merge_and_unload()
B = run("B_trained")
ref, rsr = sf.read("D:/TSMalfoyAI/assets/voice/candidates/v2_s11.wav", dtype="float32")
nrm = lambda w: w / (np.abs(w).max() + 1e-9) * 0.8; gap = lambda s, sr: np.zeros(int(s * sr), np.float32)
parts = [nrm(ref), gap(1.5, rsr)]
for (a, sr), (b, _) in zip(A, B): parts += [nrm(a), gap(0.8, sr), nrm(b), gap(1.5, sr)]
sf.write(f"{D}/ab/compare.wav", np.concatenate(parts), rsr)
for tag, xs in (("A 지금 앱", A), ("B 학습", B)):
    m = [voice_offset(w, sr) for w, sr in xs]; st = [x[0] for x in m]; br = [x[1] for x in m]
    print(f"{tag}: 원본 대비 음높이 {np.mean(st):+.1f}반음 (문장 간 폭 {max(st) - min(st):.1f}) · 밝기 {np.mean(br):+.0f}% (폭 {max(br) - min(br):.0f})", " ".join(f"{s:+.1f}" for s in st))
