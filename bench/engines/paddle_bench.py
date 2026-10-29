"""PaddleOCR-VL-1.6 via the `paddleocr doc_parser` CLI with a vLLM server as the VL recognition backend.

The native Paddle backend decoded at ~12% GPU / 100% CPU on this machine (one 3-page doc > 10 min),
so the VLM runs in vLLM as recommended by the vLLM recipe for PaddleOCR-VL-1.6. vLLM comes from the
OvisOCR2 venv (vllm 0.22.1 >= the recipe's 0.11.1) and serves the weights PaddleOCR already downloaded.
Layout detection still runs in Paddle inside the CLI.

Per-page time comes from the CLI's "Processed item N in X ms" log, so model loading is excluded;
load_s is the vLLM server start-up time.
"""

import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from common import Metrics, VramSampler, doc_paths, timer

CLI = Path(sys.executable).with_name("paddleocr")
VLLM = Path.home() / "mdb" / "venvs" / "ovis" / "bin" / "vllm"
WEIGHTS = Path.home() / ".paddlex" / "official_models" / "PaddleOCR-VL-1.6"
MODEL_NAME = "PaddlePaddle/PaddleOCR-VL-1.6"
PORT = 8118
ENV = {
    **os.environ,
    "PADDLE_PDX_MODEL_SOURCE": "modelscope",
    "PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK": "True",
    # save_all renders visualizations; a local font avoids fetching one from Baidu BOS.
    "PADDLE_PDX_LOCAL_FONT_FILE_PATH": "/mnt/c/Windows/Fonts/simhei.ttf",
}
ITEM_MS = re.compile(r"Processed item \d+ in ([\d.]+) ms")


def page_index(path: Path) -> int:
    nums = re.findall(r"\d+", path.stem)
    return int(nums[-1]) if nums else 0


def wait_ready(server: subprocess.Popen, limit: float = 600):
    deadline = time.monotonic() + limit
    while time.monotonic() < deadline:
        if server.poll() is not None:
            raise RuntimeError(f"vllm exited with {server.returncode}")
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{PORT}/health", timeout=2)
            return
        except (urllib.error.URLError, OSError):
            time.sleep(1)
    raise TimeoutError("vllm did not start")


def main():
    metrics = Metrics("paddle")
    log = (metrics.dir / "vllm.log").open("w")
    with VramSampler() as sampler:
        elapsed = timer()
        server = subprocess.Popen(
            [str(VLLM), "serve", str(WEIGHTS), "--served-model-name", MODEL_NAME, "--port", str(PORT),
             "--trust-remote-code", "--max-num-batched-tokens", "16384", "--no-enable-prefix-caching",
             "--mm-processor-cache-gb", "0", "--gpu-memory-utilization", "0.5"],
            stdout=log, stderr=subprocess.STDOUT,
        )
        try:
            wait_ready(server)
            metrics.data["load_s"] = round(elapsed(), 1)
            for doc in doc_paths():
                save_dir = metrics.dir / "raw" / doc.stem
                proc = subprocess.run(
                    [str(CLI), "doc_parser", "-i", str(doc), "--save_path", str(save_dir),
                     "--pipeline_version", "v1.6", "--vl_rec_backend", "vllm-server",
                     "--vl_rec_server_url", f"http://127.0.0.1:{PORT}/v1", "--vl_rec_api_model_name", MODEL_NAME],
                    capture_output=True, text=True, env=ENV,
                )
                page_ms = [float(ms) for ms in ITEM_MS.findall(proc.stdout + proc.stderr)]
                pages = sorted(save_dir.glob("*.md"), key=page_index)
                if proc.returncode != 0 or not pages:
                    print(f"[paddle] {doc.stem} FAILED rc={proc.returncode}\n{(proc.stdout + proc.stderr)[-1500:]}",
                          flush=True)
                    continue
                markdown = "\n\n".join(
                    f"<!-- page {i} -->\n\n{p.read_text(encoding='utf-8').strip()}" for i, p in enumerate(pages, 1)
                )
                metrics.add(doc, len(pages), sum(page_ms) / 1000, markdown)
        finally:
            server.terminate()
            server.wait(timeout=60)
    metrics.save(sampler)


if __name__ == "__main__":
    main()
