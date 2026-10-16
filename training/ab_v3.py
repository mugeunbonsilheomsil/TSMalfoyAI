"""LoRA v2 vs v3 비교: 같은 서버에 두 LoRA 를 올리고 요청마다 하나만 켠다. 시스템 프롬프트는 prompt_v3 (앱과 동일)."""
import json, os, subprocess, sys, time, urllib.request
sys.stdout.reconfigure(encoding="utf-8")
D = "D:/TSMalfoyAI/_dev/install"; P = "D:/TSMalfoyAI/app/persona"
CH = json.load(open(f"{P}/character.json", encoding="utf-8")); PROMPT = open(f"{P}/prompt_v3.txt", encoding="utf-8").read()
ST = {s["name"]: s for s in CH["stages"]}
srv = subprocess.Popen([f"{D}/runtime/cuda/llama-server.exe", "-m", f"{D}/models/gemma-4-E4B_q4_0-it.gguf", "--port", "7872", "-c", "8192", "-np", "1", "--jinja", "--no-webui", "-ngl", "99", "-fa", "on",
                        "--lora", "D:/TSMalfoyAI/persona/lora/v2/malfoy-lora-v2.gguf", "--lora", "D:/TSMalfoyAI/persona/lora/v3/malfoy-lora-v3.gguf"],
                       cwd=f"{D}/runtime/cuda", stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=0x08000000)
for _ in range(240):
    try:
        if urllib.request.urlopen("http://127.0.0.1:7872/health", timeout=2).status == 200: break
    except Exception: time.sleep(1)
TESTS = [("라이벌", "아 씨, 계단에서 또 발 헛디뎠네."), ("앙숙", "나 변신술 과제 또 실패했어. 찻잔이 반만 쥐가 됐어."),
         ("특별함", "다치지 마. 진심이야."), ("휴전", "방학 동안 좀 보고 싶었어."), ("특별함", "너랑 있으면 편해."),
         ("휴전", "판지가 오늘 내 흉터 가지고 놀렸어."), ("라이벌", "크레이브가 복도에서 나 밀쳤어."),
         ("라이벌", "헤르미온느랑 도서관 가기로 했어."), ("들킴", "너 어제 경기 때 그리핀도르 쪽에서 소리 지르던데?"),
         ("앙숙", "말포이, 오늘 머리 좀 이상하다."), ("라이벌", "고마워, 어제 도와줘서."), ("특별함", "어제 우리 무슨 얘기 했는지 기억나?")]


def ask(stage, text, lora_id, seed):
    sysm = PROMPT.replace("{stage}", stage).replace("{hint}", ST[stage]["hint"])
    body = {"messages": [{"role": "system", "content": sysm}, {"role": "user", "content": text}], "max_tokens": 220, "temperature": 0.85, "top_p": 0.95, "top_k": 64, "min_p": 0.05,
            "repeat_penalty": 1.08, "seed": seed, "chat_template_kwargs": {"enable_thinking": False}, "lora": [{"id": 0, "scale": 1.0 if lora_id == 0 else 0.0}, {"id": 1, "scale": 1.0 if lora_id == 1 else 0.0}]}
    r = urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:7872/v1/chat/completions", json.dumps(body).encode(), {"Content-Type": "application/json"}), timeout=300)
    return json.loads(r.read())["choices"][0]["message"]["content"].strip().replace("\n", " ")


out = []
try:
    for i, (stage, text) in enumerate(TESTS):
        row = {"stage": stage, "potter": text, "v2": ask(stage, text, 0, 100 + i), "v3": ask(stage, text, 1, 100 + i)}
        out.append(row); print(f"[{stage}] 포터: {text}\n  v2: {row['v2']}\n  v3: {row['v3']}\n", flush=True)
finally:
    srv.kill()
json.dump(out, open("D:/TSMalfoyAI/training/data_v3/ab_v2_v3.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
