"""학습 데이터 음성: v2_s11과 같은 방식(VoiceDesign + _meta.json instructs[1] + 시드 11). 이어서 하기 가능."""
import json, os, sys, io, time, urllib.request
sys.stdout.reconfigure(encoding="utf-8")
D = "D:/TSMalfoyAI/training/voice"; os.makedirs(f"{D}/raw", exist_ok=True)
META = json.load(open("D:/TSMalfoyAI/assets/voice/candidates/_meta.json", encoding="utf-8"))
texts = json.load(open(f"{D}/texts.json", encoding="utf-8")); t0 = time.time(); done = 0
for i, x in enumerate(texts):
    p = f"{D}/raw/{x['id']}.wav"
    if os.path.exists(p): continue
    b = json.dumps({"text": x["text"], "instruct": META["instructs"][1], "language": "ko", "seed": 11}).encode()
    data = None
    for attempt in range(5):
        try:
            data = urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:8887/v1/design", data=b, headers={"content-type": "application/json"}), timeout=600).read(); break
        except Exception as e:
            print("retry", x["id"], e, flush=True); time.sleep(20)
    if data is None: raise SystemExit(f"server unreachable at {x['id']}")
    open(p + ".tmp", "wb").write(data); os.replace(p + ".tmp", p); done += 1
    if done % 20 == 0: print(f"{i + 1}/{len(texts)} ({time.time() - t0:.0f}s)", flush=True)
print("GEN DONE", len(texts), flush=True)
