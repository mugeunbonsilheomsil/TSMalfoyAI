"""릴리스 준비: app/persona 의 말포이 전용 모델 파일 크기·SHA256 을 app/src/manifest.json 에 채운다.
이 파일들을 GitHub Release(manifest 의 "release" 주소)에 그대로 올리면 앱 설치 화면이 받아 간다.
사용: python release_manifest.py [--release https://github.com/<계정>/<저장소>/releases/download/models-v1]"""
import hashlib, json, os, sys
APP = "D:/TSMalfoyAI/app"
M = f"{APP}/src/manifest.json"
m = json.load(open(M, encoding="utf-8"))
if "--release" in sys.argv: m["release"] = sys.argv[sys.argv.index("--release") + 1].rstrip("/")
LOCAL = {"malfoy-lora.gguf": f"{APP}/persona/malfoy-lora.gguf",
         "malfoy-tts-Q4_K_M.gguf": f"{APP}/persona/voice/malfoy-tts-Q4_K_M.gguf",
         "mmproj-malfoy-tts-Q8_0.gguf": f"{APP}/persona/voice/mmproj-malfoy-tts-Q8_0.gguf"}


def sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 22), b""): h.update(b)
    return h.hexdigest()


for f in [m["persona"]["file"], *m["voice"]["files"]]:
    p = LOCAL[f["name"]]
    f["size"], f["sha256"] = os.path.getsize(p), sha(p)
    print(f"{f['name']:32s} {f['size'] / 2 ** 20:8.1f} MB  {f['sha256'][:16]}…")
json.dump(m, open(M, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print("release:", m["release"])
