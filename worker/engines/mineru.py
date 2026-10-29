"""GPU engine: MinerU 4 (MinerU2.5-Pro VLM) through its local parsing API.

The API runs in WSL (worker/mineru-server.sh) and the worker reaches it over localhost.
Markdown is rebuilt from MinerU's per-page `structured_content` blocks so every page gets a
`<!-- page N -->` marker; MinerU's own markdown has no page boundaries. Images and charts become a
`<!-- figure: caption -->` marker plus whatever MinerU read from them, never base64 image data
(~58x the tokens, see bench/results/engines-2026-10-29.md). Final formatting is left to web/js/output.js.

MinerU's licence requires services built on it to say so publicly (attribution).
"""

import base64
import io
import os
import time
from pathlib import Path

import httpx
import pypdfium2 as pdfium

NAME = "mineru"
API = os.environ.get("MDB_MINERU_URL", "http://127.0.0.1:8010").rstrip("/")
TIERS = {"fast": "standard", "precise": "advanced"}
# The GPU is a single home card shared with other work; long documents would hold it for many
# minutes per job. Larger files still convert in the browser. The gateway may raise the limit per
# job (friend codes); this is the default when it does not say.
MAX_PAGES = int(os.environ.get("MDB_MAX_GPU_PAGES", 50))
WAIT_SECONDS = 900  # per MinerU call; at least this long, 6 s a page beyond that
CHUNK = 100  # pages per MinerU call: long documents go in pieces, with progress after each
SKIP_BLOCKS = {"header", "footer", "page_number"}


def _captions(block: dict) -> list[str]:
    return [c["content"] for c in block.get("captions") or [] if c.get("content")]


def _footnotes(block: dict) -> list[str]:
    return [c["content"] for c in block.get("footnotes") or [] if c.get("content")]


def _render(block: dict) -> str:
    kind, content = block["type"], (block.get("content") or "").strip()
    if kind in ("doc_title", "paragraph_title"):
        return f"{'#' * min(block.get('level') or 1, 6)} {content}"
    if kind == "equation":
        return f"$$\n{content}\n$$"
    if kind in ("image", "chart"):
        # The picture itself is not in the text: leave a marker (output.js adds the page) so the AI
        # knows a figure was here; whatever MinerU read from it (table, Mermaid, description) follows.
        caption = " ".join(_captions(block)).replace("--", "-").replace("\n", " ")
        marker = f"<!-- figure: {caption} -->" if caption else "<!-- figure -->"
        return "\n\n".join([marker, *([content] if content else []), *_footnotes(block)])
    if kind in ("table", "code"):
        return "\n\n".join([*_captions(block), *([content] if content else []), *_footnotes(block)])
    return content


def _page_markdown(page: dict) -> str:
    parts = [_render(b) for b in page["blocks"] if b["type"] not in SKIP_BLOCKS]
    return "\n\n".join(p for p in parts if p)


def _result(client: httpx.Client, resp: httpx.Response, wait: float) -> dict:
    """file_parse answers 200 when done, or 202 if its own wait ran out; then poll the task."""
    deadline = time.monotonic() + wait
    body = resp.json()
    while resp.status_code == 202:
        if time.monotonic() > deadline:
            raise ValueError("engine_timeout")
        time.sleep(2)
        resp = client.get(body["result_url"])
        resp.raise_for_status()
        body = resp.json()
    resp.raise_for_status()
    return body


def _parse(client: httpx.Client, data: bytes, mode: str, wait: float) -> list[dict]:
    """One MinerU call on a whole (small) PDF; returns its structured pages."""
    request = {
        "files": [{"source": {"type": "inline", "name": "input.pdf", "data": base64.b64encode(data).decode()}}],
        "tier": TIERS.get(mode, "standard"),
        "output_formats": ["structured_content"],
    }
    try:
        resp = client.post("/v1/file_parse", json=request, timeout=httpx.Timeout(wait, connect=10))
    except httpx.ConnectError:
        raise ValueError("engine_offline") from None
    body = _result(client, resp, wait)
    file = body["files"][0]
    try:
        if file.get("status") not in ("completed", None) or file.get("error"):
            raise ValueError("engine_failed")
        return file["content"]["structured_content"]["pages"]
    finally:
        # The server keeps the input and every output as files; none may outlive the job
        # (privacy). The server's retention window is only a backstop.
        outputs = [ref["file_id"] for ref in (file.get("output_files") or {}).values() if ref]
        for file_id in filter(None, [file.get("file_id"), *outputs]):
            client.delete(f"/v1/files/{file_id}")


def _subset(src: pdfium.PdfDocument, pages: list[int]) -> bytes:
    """A new PDF holding only these (1-based) pages, so MinerU never gets the whole file."""
    out = pdfium.PdfDocument.new()
    try:
        out.import_pages(src, [p - 1 for p in pages])
        buf = io.BytesIO()
        out.save(buf)
        return buf.getvalue()
    finally:
        out.close()


def convert(path: Path, kind: str, mode: str, pages: list[int] | None = None,
            max_pages: int | None = None, on_progress=None) -> str:
    """Long documents go through MinerU CHUNK pages at a time: each chunk is its own small PDF
    (retried once if it fails), and on_progress(done, total) is called after each one."""
    if kind != "pdf":
        raise ValueError("unsupported_kind")
    src = pdfium.PdfDocument(str(path))
    try:
        total = len(src)
        wanted = sorted({p for p in pages if 0 < p <= total}) if pages else list(range(1, total + 1))
        if len(wanted) > (max_pages or MAX_PAGES):
            raise ValueError("too_many_pages")
        parts = []
        with httpx.Client(base_url=API) as client:
            for start in range(0, len(wanted), CHUNK):
                chunk = wanted[start:start + CHUNK]
                data = path.read_bytes() if len(chunk) == total else _subset(src, chunk)
                for attempt in (1, 2):
                    try:
                        result = _parse(client, data, mode, max(WAIT_SECONDS, len(chunk) * 6))
                        break
                    except ValueError as exc:
                        if attempt == 2 or str(exc) == "engine_offline":
                            raise
                # Chunk page i is original page chunk[i]: markers keep the document's numbering.
                parts += [f"<!-- page {chunk[p['page_idx']]} -->\n\n{_page_markdown(p)}" for p in result]
                if on_progress:
                    on_progress(start + len(chunk), len(wanted))
    finally:
        src.close()
    return "\n\n".join(parts) + "\n"
