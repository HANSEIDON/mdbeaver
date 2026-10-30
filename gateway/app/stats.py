"""Anonymous daily totals: how many files were converted, of which kind, how many pages, how many
needed the GPU or failed. The page reports each finished file; nothing about who sent it (IP, file
name, contents) is stored, only the per-day sums in a small JSON file:

    {"2026-10-30": {"files": 12, "pages": 340, "gpu": 3, "failed": 1, "kinds": {"pdf": 9, "hwp": 3}}}

Command line (on the server: mdb-stats, see deploy/mdb-stats):
    python -m app.stats              last 30 days
    python -m app.stats --days 7
"""

import argparse
import datetime as dt
import json
import os
import threading
from pathlib import Path

KINDS = {"pdf", "docx", "pptx", "hwp", "hwpx"}
MAX_PAGES = 5000


class Stats:
    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.Lock()

    def load(self) -> dict:
        try:
            return json.loads(self.path.read_text("utf-8"))
        except FileNotFoundError:
            return {}

    def _save(self, data: dict) -> None:
        tmp = self.path.with_suffix(".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(json.dumps(data, separators=(",", ":")))
        os.replace(tmp, self.path)

    def add(self, kind: str, pages: int, gpu: bool, ok: bool) -> None:
        day = dt.datetime.now(dt.timezone.utc).date().isoformat()
        with self._lock:
            data = self.load()
            d = data.setdefault(day, {"files": 0, "pages": 0, "gpu": 0, "failed": 0, "kinds": {}})
            d["files"] += 1
            d["pages"] += max(0, min(pages, MAX_PAGES))
            d["gpu"] += int(gpu)
            d["failed"] += int(not ok)
            d["kinds"][kind] = d["kinds"].get(kind, 0) + 1
            self._save(data)


def main() -> None:
    from .config import load_settings

    ap = argparse.ArgumentParser(prog="mdb-stats", description="Daily conversion totals (UTC days).")
    ap.add_argument("--days", type=int, default=30)
    days = ap.parse_args().days
    data = Stats(load_settings(require_token=False).stats_file).load()
    rows = sorted(data.items())[-days:]
    if not rows:
        print("No conversions counted yet.")
        return
    print(f"{'day':<12}{'files':>7}{'pages':>8}{'gpu':>6}{'failed':>8}  kinds")
    for day, d in rows:
        kinds = " ".join(f"{k} {n}" for k, n in sorted(d["kinds"].items(), key=lambda x: -x[1]))
        print(f"{day:<12}{d['files']:>7}{d['pages']:>8}{d['gpu']:>6}{d['failed']:>8}  {kinds}")
    total = {k: sum(d[k] for _, d in rows) for k in ("files", "pages", "gpu", "failed")}
    print(f"{'total':<12}{total['files']:>7}{total['pages']:>8}{total['gpu']:>6}{total['failed']:>8}")


if __name__ == "__main__":
    main()
