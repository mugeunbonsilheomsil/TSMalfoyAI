"""GPT가 만든 persona/data/dialogues.jsonl → 학습용 train.jsonl / val.jsonl
- 각 대화 앞에 앱이 실제로 쓰는 것과 같은 짧은 system 프롬프트(관계 단계 포함)를 붙인다 → 학습/추론 형식 일치
- 완전 중복·너무 긴 대화 제거, 단계별로 고르게 val 분리
   python prepare_data.py [--src ../persona/data/dialogues.jsonl] [--out data] [--val 0.08]"""
import argparse, json, os, random, hashlib
HERE = os.path.dirname(os.path.abspath(__file__))
ap = argparse.ArgumentParser()
ap.add_argument("--src", default=os.path.join(HERE, "..", "persona", "data", "dialogues.jsonl"))
ap.add_argument("--out", default=os.path.join(HERE, "data")); ap.add_argument("--val", type=float, default=0.08); ap.add_argument("--seed", type=int, default=7)
a = ap.parse_args(); random.seed(a.seed); os.makedirs(a.out, exist_ok=True)

SYS = open(os.path.join(HERE, "system_prompt.txt"), encoding="utf-8").read().strip()
rows, seen, bad = [], set(), 0
for ln in open(a.src, encoding="utf-8"):
    if not ln.strip(): continue
    try: d = json.loads(ln)
    except json.JSONDecodeError: bad += 1; continue
    msgs = [m for m in d.get("messages", []) if m.get("role") in ("user", "assistant") and m.get("content", "").strip()]
    if len(msgs) < 2 or msgs[-1]["role"] != "assistant" or msgs[0]["role"] != "user": bad += 1; continue
    key = hashlib.md5(json.dumps(msgs, ensure_ascii=False).encode()).hexdigest()
    if key in seen: continue
    seen.add(key)
    stage = d.get("stage") or "앙숙"
    sys = SYS.replace("{stage}", stage).replace("{scene}", d.get("scene") or "없음")
    rows.append({"stage": stage, "messages": [{"role": "system", "content": sys}] + [{"role": m["role"], "content": m["content"].strip()} for m in msgs]})

by = {}
for r in rows: by.setdefault(r["stage"], []).append(r)
train, val = [], []
for st, rs in by.items():
    random.shuffle(rs); k = max(1, round(len(rs) * a.val)); val += rs[:k]; train += rs[k:]
random.shuffle(train)
for name, rs in (("train.jsonl", train), ("val.jsonl", val)):
    with open(os.path.join(a.out, name), "w", encoding="utf-8") as f:
        for r in rs: f.write(json.dumps(r, ensure_ascii=False) + "\n")
print(f"train {len(train)} val {len(val)} | skipped {bad} | stages", {k: len(v) for k, v in by.items()})
