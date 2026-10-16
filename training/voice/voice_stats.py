"""말포이 클립들이 v2_s11 원본에서 얼마나 벗어나는지: 음높이 중앙값(반음), 음높이 폭(반음), 음색 밝기(스펙트럼 중심, %), 말 속도"""
import json, sys, glob, os, re, numpy as np, soundfile as sf, librosa
sys.stdout.reconfigure(encoding="utf-8")
def feats(p):
    w, sr = sf.read(p, dtype="float32"); w = w if w.ndim == 1 else w.mean(1)
    if sr != 24000: w = librosa.resample(w, orig_sr=sr, target_sr=24000); sr = 24000
    f, v, _ = librosa.pyin(w, fmin=120, fmax=650, sr=sr, frame_length=2048, hop_length=256); f = f[v & ~np.isnan(f)]
    S = np.abs(librosa.stft(w, n_fft=2048, hop_length=256)); e = S.sum(0); c = librosa.feature.spectral_centroid(S=S, sr=sr)[0][e > e.max() * .1]
    return dict(f0=float(np.median(f)), span=float(12 * np.log2(np.percentile(f, 90) / np.percentile(f, 10))), cen=float(np.median(c)), dur=len(w) / sr)
def table(files, texts=None):
    ref = feats("D:/TSMalfoyAI/assets/voice/candidates/v2_s11.wav"); rows = []
    for p in files:
        x = feats(p); k = os.path.basename(p)[:-4]
        rows.append(dict(id=k, st=12 * np.log2(x["f0"] / ref["f0"]), span=x["span"] - ref["span"], cen=100 * (x["cen"] / ref["cen"] - 1)))
    return ref, rows
if __name__ == "__main__":
    files = sorted(glob.glob(sys.argv[1]))
    ref, rows = table(files)
    print(f"REF f0 {ref['f0']:.0f}Hz span {ref['span']:.1f}st cen {ref['cen']:.0f}Hz")
    for r in sorted(rows, key=lambda r: -abs(r['st']) - abs(r['cen']) / 10): print(f"{r['id']:10s} pitch {r['st']:+5.1f}st  span {r['span']:+5.1f}st  bright {r['cen']:+5.0f}%")
