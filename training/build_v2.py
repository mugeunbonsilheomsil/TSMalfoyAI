"""gen_v2.py 결과(raw.jsonl) → LoRA v2 학습 세트. 심사 점수로 거르고, 말버릇 과다를 줄인다.
말버릇 정리(학습 데이터에만 적용, 영상의 대사엔 손대지 않음):
  "포터어" 는 전체 대답의 35%까지만 남기고 나머지는 "포터"로, 끝에 붙는 "착각하지 마." 는 25%까지만 남긴다.
"""
import json, random, re, os, collections

ROOT = r"D:\TSMalfoyAI"
RAW = os.path.join(ROOT, "persona", "data_v2", "raw.jsonl")
OUT = os.path.join(ROOT, "training", "data_v2")
CH = json.load(open(os.path.join(ROOT, "app", "persona", "character.json"), encoding="utf-8"))
PROMPT = open(os.path.join(ROOT, "app", "persona", "prompt_v2.txt"), encoding="utf-8").read()
HINT = {s["name"]: s["hint"] for s in CH["stages"]}
rnd = random.Random(7)

recs = [json.loads(l) for l in open(RAW, encoding="utf-8") if l.strip()]
stats = collections.Counter()
keep = []
for r in recs:
    sc = r["score"]
    if min(sc.values()) <= 2 or sum(sc.values()) < 11: stats["low_score"] += 1; continue
    keep.append(r)

replies = [m for r in keep for m in r["messages"] if m["role"] == "assistant"]
TAIL = re.compile(r"\s*착각하지 마(?:, 포터어?)?[.!]*\s*$")
P_RATE = sum("포터어" in x["content"] for x in replies) / len(replies)
T_RATE = sum(bool(TAIL.search(x["content"])) for x in replies) / len(replies)
for m in replies:
    t = m["content"]
    if "포터어" in t and rnd.random() > 0.35 / max(0.01, P_RATE):
        t = t.replace("포터어", "포터"); stats["potter_softened"] += 1
    if TAIL.search(t) and rnd.random() > 0.25 / max(0.01, T_RATE):
        t2 = TAIL.sub("", t).rstrip(" ,")
        if len(t2) >= 8: t = t2 + ("" if t2[-1] in ".!?…" else "."); stats["tail_cut"] += 1
    m["content"] = t

def fmt(r):
    sysm = PROMPT.replace("{stage}", r["stage"]).replace("{hint}", HINT[r["stage"]])
    return {"stage": r["stage"], "cat": r["cat"], "messages": [{"role": "system", "content": sysm}] + r["messages"]}

rnd.shuffle(keep)
nval = max(30, len(keep) // 12)
os.makedirs(OUT, exist_ok=True)
for name, part in (("val", keep[:nval]), ("train", keep[nval:])):
    with open(os.path.join(OUT, f"{name}.jsonl"), "w", encoding="utf-8") as f:
        for r in part: f.write(json.dumps(fmt(r), ensure_ascii=False) + "\n")
after = [m["content"] for r in keep for m in r["messages"] if m["role"] == "assistant"]
rep = {"raw": len(recs), "kept": len(keep), "train": len(keep) - nval, "val": nval, **stats,
       "replies": len(after), "포터어_rate": round(sum("포터어" in x for x in after) / len(after), 3),
       "착각_rate": round(sum("착각하지 마" in x for x in after) / len(after), 3),
       "더듬기_rate": round(sum(bool(re.search(r"(\w), \1", x)) for x in after) / len(after), 3),
       "cats": collections.Counter(r["cat"] for r in keep), "stages": collections.Counter(r["stage"] for r in keep)}
json.dump(rep, open(os.path.join(OUT, "report.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(json.dumps(rep, ensure_ascii=False, indent=1))
