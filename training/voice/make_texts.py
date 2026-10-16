"""목소리 학습용 문장: LoRA v2 학습 데이터의 말포이 대답(모델 실제 출력)을 1~3문장 단위로 잘라 고른다. 고쳐 쓰지 않음."""
import json, re, random, sys
sys.stdout.reconfigure(encoding="utf-8")
random.seed(7)
utts = []
for f in ("D:/TSMalfoyAI/training/data_v2/train.jsonl", "D:/TSMalfoyAI/training/data_v2/val.jsonl"):
    for line in open(f, encoding="utf-8"):
        for m in json.loads(line)["messages"]:
            if m["role"] != "assistant": continue
            t = re.sub(r"\s+", " ", m["content"]).strip()
            if re.search(r"[()（）*A-Za-z]", t): continue
            sents = re.findall(r"[^.!?…]+(?:[.!?…]+|$)", t); sents = [s.strip() for s in sents if s.strip()]
            i = 0
            while i < len(sents):
                k = random.choice((1, 2, 2, 3)); u = " ".join(sents[i:i + k]); i += k
                if 8 <= len(u) <= 80: utts.append(u)
seen, out = set(), []
random.shuffle(utts)
for u in utts:
    key = re.sub(r"[^가-힣]", "", u)
    if key in seen or len(key) < 5: continue
    seen.add(key); out.append(u)
short = [u for u in out if len(u) < 20]; mid = [u for u in out if 20 <= len(u) < 50]; long_ = [u for u in out if len(u) >= 50]
pick = short[:90] + mid[:240] + long_[:150]
random.shuffle(pick)
json.dump([{"id": f"v{i:04d}", "text": t} for i, t in enumerate(pick)], open("D:/TSMalfoyAI/training/voice/texts.json", "w", encoding="utf-8"), ensure_ascii=False, indent=0)
print(len(utts), "candidates →", len(pick), "picked;", len(short), len(mid), len(long_)); print("\n".join(pick[:8]))
