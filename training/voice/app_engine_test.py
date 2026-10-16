"""앱과 똑같이(tsm-tts-server.exe, --temp 0.5 --seed 7, speaker=malfoy_ref.wav) 기존 공식 모델 vs 학습 모델로 같은 문장 생성."""
import json, os, subprocess, sys, time
sys.stdout.reconfigure(encoding="utf-8")
D = "D:/TSMalfoyAI/training/voice"; RT = "D:/TSMalfoyAI/_dev/runtime/cuda"; M = "D:/TSMalfoyAI/_dev/install/models"
EXE = "D:/TSMalfoyAI/app/native/tsm-tts-server.exe"; SPK = "D:/TSMalfoyAI/app/persona/voice/malfoy_ref.wav"
sys.path.insert(0, D); from ab_lines import LINES
SETS = {"A_official": (f"{M}/Qwen3-TTS-12Hz-1.7B-Base-Q4_K_M.gguf", f"{M}/mmproj-Qwen3-TTS-12Hz-1.7B-Base-Q8_0.gguf"),
        "B_trained": (f"{D}/gguf/malfoy-tts-Q4_K_M.gguf", f"{D}/gguf/mmproj-malfoy-tts-Q8_0.gguf")}
os.makedirs(f"{D}/app_test", exist_ok=True)
for tag, (model, mmproj) in SETS.items():
    p = subprocess.Popen([EXE, "-m", model, "--mmproj", mmproj, "-ngl", "99", "--temp", "0.5", "--seed", "7"], cwd=RT, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         stderr=open(f"{D}/app_test/{tag}.err", "w", encoding="utf-8"), creationflags=0x08000000, text=True, encoding="utf-8")
    for i, t in enumerate(LINES):
        out = f"{D}/app_test/{i + 1}_{tag}.wav"; t0 = time.time()
        p.stdin.write(json.dumps({"id": str(i), "text": t, "lang": "ko", "speaker": SPK, "out": out, "seed": 7, "max_frames": 400}, ensure_ascii=False) + "\n"); p.stdin.flush()
        while True:
            line = p.stdout.readline()
            if not line: raise SystemExit(f"{tag}: server exited, see {tag}.err")
            try: r = json.loads(line)
            except ValueError: continue
            if r.get("id") == str(i): break
        print(tag, i + 1, r.get("ok"), f"{time.time() - t0:.1f}s", r.get("error", ""), flush=True)
    p.stdin.close(); p.wait(timeout=60)
