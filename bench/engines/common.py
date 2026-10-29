"""Shared helpers for the GPU engine benchmark (run inside each engine's WSL venv, stdlib only).

Each engine script writes bench/out/<engine>/<doc>.md plus metrics.json:
  {"engine", "load_s", "vram_baseline_mib", "vram_peak_mib", "docs": [{"doc", "pages", "seconds", "chars"}]}
"""

import json
import subprocess
import threading
import time
from pathlib import Path

BENCH = Path(__file__).resolve().parent.parent
DOCS = BENCH / "docs"
OUT = BENCH / "out"


def doc_paths() -> list[Path]:
    return sorted(DOCS.glob("*.pdf"))


def vram_used_mib() -> int:
    out = subprocess.run(
        ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
        capture_output=True, text=True, check=True,
    )
    return int(out.stdout.split()[0])


class VramSampler:
    """Polls nvidia-smi every 0.5s; VRAM is GPU-wide, so the Windows desktop's share is the baseline."""

    def __init__(self):
        self.baseline = vram_used_mib()
        self.peak = self.baseline
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def _run(self):
        while not self._stop.wait(0.5):
            try:
                self.peak = max(self.peak, vram_used_mib())
            except (subprocess.SubprocessError, ValueError):
                pass

    def __enter__(self):
        self._thread.start()
        return self

    def __exit__(self, *exc):
        self._stop.set()
        self._thread.join()


class Metrics:
    def __init__(self, engine: str):
        self.engine = engine
        self.dir = OUT / engine
        self.dir.mkdir(parents=True, exist_ok=True)
        self.data = {"engine": engine, "load_s": None, "docs": []}

    def add(self, doc: Path, pages: int, seconds: float, markdown: str):
        (self.dir / f"{doc.stem}.md").write_text(markdown, encoding="utf-8")
        self.data["docs"].append(
            {"doc": doc.stem, "pages": pages, "seconds": round(seconds, 2), "chars": len(markdown)}
        )
        print(f"[{self.engine}] {doc.stem}: {pages}p in {seconds:.1f}s ({len(markdown)} chars)", flush=True)

    def save(self, sampler: VramSampler):
        self.data["vram_baseline_mib"] = sampler.baseline
        self.data["vram_peak_mib"] = sampler.peak
        (self.dir / "metrics.json").write_text(json.dumps(self.data, indent=2), encoding="utf-8")


def timer():
    start = time.perf_counter()
    return lambda: time.perf_counter() - start
