"""Benchmark C, step 2 — AI accuracy per input variant (docs/BENCHMARK.md).

For every question in bench/docs/questions.json, a local LLM (LM Studio, OpenAI-compatible API)
answers from one variant of the document at a time: the markdown variants written by variants.mjs,
plus `images` (the page images themselves, standing in for handing the AI the PDF). Answers are
graded against the reference: a substring rule first, then the same model as judge.
Prompt tokens come from the server's own usage counts (the answering model's tokenizer).

  python bench/accuracy.py [--variants plain,browser,...] [--limit N]
Env: MDB_LLM_URL (default http://127.0.0.1:813/v1), MDB_LLM_MODEL (default qwen/qwen3.8-27b)
Writes bench/results/accuracy-<timestamp>.json and prints a summary.
"""

import argparse
import base64
import json
import os
import re
import time
import urllib.request
from collections import defaultdict
from pathlib import Path

BENCH = Path(__file__).resolve().parent
URL = os.environ.get("MDB_LLM_URL", "http://127.0.0.1:813/v1").rstrip("/")
MODEL = os.environ.get("MDB_LLM_MODEL", "qwen/qwen3.8-27b")
VARIANTS = ["plain", "browser", "hybrid", "best", "precise", "browser+pages", "hybrid+pages", "best+pages",
            "precise+pages", "images"]

SYSTEM = (
    "Answer the question using only the document provided. Reply with the short answer only "
    "(a few words, a number or a formula), in the language of the question. "
    "If the document does not contain the answer, reply exactly: NOT FOUND"
)
JUDGE = (
    "You grade answers. Question: {q}\nReference answer: {ref}\nGiven answer: {ans}\n"
    "Is the given answer correct and consistent with the reference (same meaning; formatting, "
    "notation and language may differ)? Reply with exactly YES or NO."
)


def chat(content, system=None, max_tokens=1024):
    messages = ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": content}]
    body = json.dumps({"model": MODEL, "messages": messages, "temperature": 0, "max_tokens": max_tokens}).encode()
    req = urllib.request.Request(f"{URL}/chat/completions", body, {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=600) as resp:
        data = json.load(resp)
    text = data["choices"][0]["message"].get("content") or ""
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip()  # reasoning, if inlined
    return text, data.get("usage", {}).get("prompt_tokens", 0)


def norm(s: str) -> str:
    s = s.lower().replace("−", "-").replace("×", "x").replace("’", "'")
    return re.sub(r"[\s\\{}$]", "", s)


def rule_says_correct(item, answer: str) -> bool:
    a = norm(answer)
    if len(a) > 80 or "notfound" in a:  # long answers can contain the token by accident
        return False
    if item.get("all"):
        return all(norm(t) in a for t in item["all"])
    if item.get("any"):
        return any(norm(t) in a for t in item["any"])
    return False


def document(doc: str, variant: str):
    if variant == "images":
        pages = sorted((BENCH / "out" / "pages").glob(f"{doc}-*.jpg"), key=lambda p: int(p.stem.rsplit("-", 1)[1]))
        return [{"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(p.read_bytes()).decode()}}
                for p in pages]
    text = (BENCH / "out" / "variants" / doc / f"{variant}.md").read_text(encoding="utf-8")
    return [{"type": "text", "text": f"<document>\n{text}\n</document>"}]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--variants", default=",".join(VARIANTS))
    ap.add_argument("--limit", type=int, default=0, help="only the first N questions (smoke test)")
    args = ap.parse_args()
    questions = json.loads((BENCH / "docs" / "questions.json").read_text(encoding="utf-8"))
    if args.limit:
        questions = questions[: args.limit]

    rows, started = [], time.time()
    # Same document + variant back to back, so the server can reuse the cached prompt prefix.
    for variant in args.variants.split(","):
        for item in questions:
            for doc in item["docs"]:
                content = document(doc, variant) + [{"type": "text", "text": f"Question: {item['q']}"}]
                answer, tokens = chat(content, SYSTEM)
                correct = rule_says_correct(item, answer)
                how = "rule"
                if not correct and "NOT FOUND" not in answer.upper():
                    verdict, _ = chat(JUDGE.format(q=item["q"], ref=item["answer"], ans=answer), max_tokens=512)
                    correct, how = verdict.strip().upper().startswith("YES"), "judge"
                rows.append({"variant": variant, "doc": doc, "id": item["id"], "type": item["type"],
                             "answer": answer, "correct": correct, "graded_by": how, "prompt_tokens": tokens})
                print(f"[{variant:13s}] {doc:17s} {item['id']:6s} {'OK ' if correct else 'NO '} {tokens:6d}t  {answer[:60]!r}", flush=True)

    stamp = time.strftime("%Y-%m-%dT%H-%M-%S")
    out = BENCH / "results" / f"accuracy-{stamp}.json"
    out.write_text(json.dumps({"model": MODEL, "minutes": round((time.time() - started) / 60, 1), "rows": rows},
                              ensure_ascii=False, indent=1), encoding="utf-8")
    summarize(rows)
    print(f"\nSaved {out}")


def summarize(rows):
    by = defaultdict(list)
    for r in rows:
        by[r["variant"]].append(r)
    types = sorted({r["type"] for r in rows})
    print(f"\n{'variant':14s} {'acc':>6s} {'tokens/q':>9s} {'acc/1k tok':>10s}  " + " ".join(f"{t:>8s}" for t in types))
    for v, rs in by.items():
        acc = sum(r["correct"] for r in rs) / len(rs)
        tok = sum(r["prompt_tokens"] for r in rs) / len(rs)
        per_type = []
        for t in types:
            sub = [r for r in rs if r["type"] == t]
            per_type.append(f"{sum(r['correct'] for r in sub) / len(sub):8.0%}" if sub else f"{'-':>8s}")
        print(f"{v:14s} {acc:6.0%} {tok:9.0f} {acc / tok * 1000 if tok else 0:10.3f}  " + " ".join(per_type))


if __name__ == "__main__":
    main()
