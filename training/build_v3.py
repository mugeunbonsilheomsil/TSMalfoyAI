"""LoRA v3 학습 세트 = v2 대화(persona/data_v2/raw.jsonl) + v3 대화(training/data_v3/raw*.jsonl), 모두 prompt_v3 시스템 프롬프트로.
- v3 첫 생성분의 솔직·독점 대화는 장면 지시가 없던 버전이라(진심·독점욕이 안 나옴) 빼고, 추가 생성분(raw_extra)으로 채운다.
- 거르기: 심사 점수, 금지 표현(자해·죽음·성적 뉘앙스·'변태'·진짜 모욕), 기본 모델의 '함' 글리치("뭘 안다고 함을").
- 말버릇 정리는 v2와 같음(포터어 35%, 끝 '착각하지 마' 25%). 사용자 결정(2026-10-16): '역겹다'는 허용.
"""
import json, random, re, os, collections

ROOT = r"D:\TSMalfoyAI"
SRC = [(os.path.join(ROOT, "persona", "data_v2", "raw.jsonl"), "v2"),
       (os.path.join(ROOT, "training", "data_v3", "raw.jsonl"), "v3"),
       (os.path.join(ROOT, "training", "data_v3", "raw_extra.jsonl"), "v3x")]
OUT = os.path.join(ROOT, "training", "data_v3", "set")
CH = json.load(open(os.path.join(ROOT, "app", "persona", "character.json"), encoding="utf-8"))
PROMPT = open(os.path.join(ROOT, "app", "persona", "prompt_v3.txt"), encoding="utf-8").read()
HINT = {s["name"]: s["hint"] for s in CH["stages"]}
BAD = re.compile(r"자해|죽어|죽을래|죽여|죽고|변태|쓰레기 같|섹시|야한|몸매|가슴|뽀뽀해|키스해|안다고 함|함을 따|함은\.|함이 ")
rnd = random.Random(7)

recs, stats = [], collections.Counter()
for path, tag in SRC:
    if not os.path.exists(path): continue
    for l in open(path, encoding="utf-8"):
        if not l.strip(): continue
        r = json.loads(l); r["src"] = tag
        if tag == "v3" and r["cat"] in ("솔직", "독점"): stats["v3_old_scene_dropped"] += 1; continue
        recs.append(r)
keep = []
for r in recs:
    sc = r["score"]
    if min(sc.values()) <= 2 or sum(sc.values()) < 11: stats["low_score"] += 1; continue
    if any(m["role"] == "assistant" and BAD.search(m["content"]) for m in r["messages"]): stats["bad_words"] += 1; continue
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
nval = max(40, len(keep) // 12)
os.makedirs(OUT, exist_ok=True)
for name, part in (("val", keep[:nval]), ("train", keep[nval:])):
    with open(os.path.join(OUT, f"{name}.jsonl"), "w", encoding="utf-8") as f:
        for r in part: f.write(json.dumps(fmt(r), ensure_ascii=False) + "\n")
after = [m["content"] for r in keep for m in r["messages"] if m["role"] == "assistant"]
rep = {"raw": len(recs), "kept": len(keep), "train": len(keep) - nval, "val": nval, **stats,
       "replies": len(after), "포터어_rate": round(sum("포터어" in x for x in after) / len(after), 3),
       "착각_rate": round(sum("착각하지 마" in x for x in after) / len(after), 3),
       "허접_rate": round(sum("허접" in x for x in after) / len(after), 3),
       "역겹_rate": round(sum("역겹" in x for x in after) / len(after), 3),
       "sources": collections.Counter(r["src"] for r in keep), "cats": collections.Counter(r["cat"] for r in keep), "stages": collections.Counter(r["stage"] for r in keep)}
json.dump(rep, open(os.path.join(OUT, "report.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(json.dumps(rep, ensure_ascii=False, indent=1))
