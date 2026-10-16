"""목소리 학습 데이터 정리 (두 단계, 서로 다른 파이썬):
  1) python prep.py asr        — 시스템 파이썬(faster-whisper large-v3): 받아 적어 원문과 비교, 덧붙은 꼬리 자르기 → clean/*.wav, asr.json
  2) <qwen venv> prep.py encode — Qwen3-TTS 12Hz 토크나이저로 코덱 코드 + 텍스트 토큰 → dataset.pt"""
import json, os, re, sys, difflib
import numpy as np, soundfile as sf
sys.stdout.reconfigure(encoding="utf-8")
D = "D:/TSMalfoyAI/training/voice"
BASE = "D:/ClipForge/engines/qwen3-tts/models/Qwen3-TTS-12Hz-1.7B-Base"
texts = {x["id"]: x["text"] for x in json.load(open(f"{D}/texts.json", encoding="utf-8"))}
norm = lambda s: re.sub(r"[^가-힣A-Za-z0-9]", "", s)


_REF = None


def voice_offset(w, sr):
    """원본 v2_s11 대비 (음높이 중앙값 반음, 스펙트럼 중심 %)"""
    import librosa
    global _REF
    def f(w):
        fz, v, _ = librosa.pyin(w, fmin=120, fmax=650, sr=24000, frame_length=2048, hop_length=256); fz = fz[v & ~np.isnan(fz)]
        S = np.abs(librosa.stft(w, n_fft=2048, hop_length=256)); e = S.sum(0)
        return float(np.median(fz)) if len(fz) else 1.0, float(np.median(librosa.feature.spectral_centroid(S=S, sr=24000)[0][e > e.max() * .1]))
    if _REF is None: _REF = f(sf.read("D:/TSMalfoyAI/assets/voice/candidates/v2_s11.wav", dtype="float32")[0])
    p, c = f(w); return 12 * np.log2(p / _REF[0]), 100 * (c / _REF[1] - 1)


def asr():
    from faster_whisper import WhisperModel
    import librosa
    m = WhisperModel("large-v3", device="cuda", compute_type="float16"); os.makedirs(f"{D}/clean", exist_ok=True)
    out, keep = {}, 0
    for k, text in texts.items():
        p = f"{D}/raw/{k}.wav"
        if not os.path.exists(p): continue
        w, sr = sf.read(p, dtype="float32"); w = w if w.ndim == 1 else w.mean(1)
        if sr != 24000: w = librosa.resample(w, orig_sr=sr, target_sr=24000); sr = 24000
        segs, _ = m.transcribe(w, language="ko", beam_size=5, word_timestamps=True, condition_on_previous_text=False)
        words = [x for s in segs for x in s.words]; heard = "".join(x.word for x in words).strip()
        ratio = difflib.SequenceMatcher(None, norm(text), norm(heard)).ratio()
        ok = bool(words) and ratio >= 0.9
        row = {"text": text, "heard": heard, "match": round(ratio, 3), "ok": ok}
        if ok:
            end = min(len(w), int((words[-1].end + 0.25) * sr)); start = max(0, int((words[0].start - 0.15) * sr))
            seg = w[start:end].copy(); n = int(0.03 * sr); seg[-n:] *= np.linspace(1, 0, n)
            dur = len(seg) / sr; rate = len(norm(text)) / dur
            row.update(dur=round(dur, 2), rate=round(rate, 2), trimmed=round(len(w) / sr - dur, 2))
            st, bright = voice_offset(seg, sr)
            row.update(pitch_st=round(st, 2), bright_pct=round(bright, 1))
            # 같은 목소리만: VoiceDesign은 문장마다 연기가 과해지며 목소리가 바뀜(측정: 영상 대사 -8.3~+3.0 반음) → 원본 v2_s11 근처만 학습
            if not (2.0 <= rate <= 9.5 and 0.6 <= dur <= 15): row["ok"] = False; row["why"] = "rate/dur"
            elif abs(st) > 2.5 or abs(bright) > 25: row["ok"] = False; row["why"] = "voice drift"
            else: sf.write(f"{D}/clean/{k}.wav", seg, sr, subtype="PCM_16"); keep += 1
        out[k] = row
        if len(out) % 40 == 0: print(len(out), "checked,", keep, "kept", flush=True)
    json.dump(out, open(f"{D}/asr.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    bad = [(k, r.get("why", "asr"), r["match"], r.get("pitch_st"), r.get("bright_pct"), r["text"][:20]) for k, r in out.items() if not r["ok"]]
    from collections import Counter; print(Counter(b[1] for b in bad))
    print(f"kept {keep}/{len(out)}; rejected {len(bad)}"); [print("  ", *b) for b in bad[:25]]


def encode():
    import torch
    from qwen_tts import Qwen3TTSModel
    tts = Qwen3TTSModel.from_pretrained(BASE, device_map="cuda:0", dtype=torch.bfloat16, attn_implementation="sdpa")
    rows = json.load(open(f"{D}/asr.json", encoding="utf-8")); data = []
    for k, r in rows.items():
        if not r["ok"]: continue
        w, sr = sf.read(f"{D}/clean/{k}.wav", dtype="float32")
        codes = tts.model.speech_tokenizer.encode(w, sr=sr).audio_codes[0].cpu()          # (T, 16)
        ids = tts._tokenize_texts([tts._build_assistant_text(r["text"])])[0].cpu()        # (1, N)
        data.append({"id": k, "text": r["text"], "codes": codes.to(torch.int16), "ids": ids})
    ref, rsr = sf.read("D:/TSMalfoyAI/app/persona/voice/malfoy_ref.wav", dtype="float32")
    spk = tts.model.extract_speaker_embedding(ref, rsr).float().cpu()                     # the same x-vector the app sends
    torch.save({"items": data, "spk": spk}, f"{D}/dataset.pt")
    T = [d["codes"].shape[0] for d in data]
    print(f"{len(data)} items, frames mean {np.mean(T):.0f} max {max(T)}, {sum(T) / 12 / 60:.1f} min of audio, spk {tuple(spk.shape)}")


if __name__ == "__main__":
    {"asr": asr, "encode": encode}[sys.argv[1]]()
