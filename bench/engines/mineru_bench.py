"""MinerU 4 (standard tier: small models + MinerU2.5 VLM) via a local api-server.

The server preloads models once (load_s); each document is then parsed through `mineru-kit parse
--remote-url`, so per-document time excludes model loading.
"""

import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from common import Metrics, VramSampler, doc_paths, timer

KIT = Path(sys.executable).with_name("mineru-kit")
PORT = 8010
URL = f"http://127.0.0.1:{PORT}"
ENV = {**os.environ, "MINERU_MODEL_SOURCE": "modelscope"}


def wait_ready(server: subprocess.Popen, limit: float = 600):
    deadline = time.monotonic() + limit
    while time.monotonic() < deadline:
        if server.poll() is not None:
            raise RuntimeError(f"api-server exited with {server.returncode}")
        try:
            urllib.request.urlopen(URL, timeout=2)
            return
        except urllib.error.HTTPError:
            return  # any HTTP answer means it is listening
        except (urllib.error.URLError, OSError):
            time.sleep(1)
    raise TimeoutError("api-server did not start")


def page_count(pdf: Path) -> int:
    import pypdfium2 as pdfium
    return len(pdfium.PdfDocument(str(pdf)))


def main():
    metrics = Metrics("mineru")
    log = (metrics.dir / "server.log").open("w")
    with VramSampler() as sampler:
        elapsed = timer()
        server = subprocess.Popen(
            [str(KIT), "api-server", "--port", str(PORT), "--tier", "standard", "--preload-models",
             "--allow-local-source"],
            stdout=log, stderr=subprocess.STDOUT, env=ENV,
        )
        try:
            wait_ready(server)
            metrics.data["load_s"] = round(elapsed(), 1)
            for doc in doc_paths():
                out = metrics.dir / f"{doc.stem}.md"
                elapsed = timer()
                proc = subprocess.run(
                    [str(KIT), "parse", str(doc), "-o", str(out), "--tier", "standard", "--remote-url", URL],
                    capture_output=True, text=True, env=ENV,
                )
                seconds = elapsed()
                if proc.returncode != 0 or not out.exists():
                    print(f"[mineru] {doc.stem} FAILED rc={proc.returncode}\n{(proc.stdout + proc.stderr)[-1500:]}",
                          flush=True)
                    continue
                metrics.add(doc, page_count(doc), seconds, out.read_text(encoding="utf-8"))
        finally:
            server.terminate()
            server.wait(timeout=60)
    metrics.save(sampler)


if __name__ == "__main__":
    main()
