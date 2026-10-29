"""CPU-only engine: reads the PDF text layer with pypdfium2.

No OCR, tables or formulas — it exists so the full pipeline can run before
the GPU engines are installed. Scanned pages come back marked as such.
"""

import re
from pathlib import Path

import pypdfium2 as pdfium

NAME = "basic"
MAX_PAGES = 500


def _clean(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"(\w)-\n(\w)", r"\1\2", text)  # re-join hyphenated line breaks
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def convert(path: Path, kind: str, mode: str, pages: list[int] | None = None) -> str:
    if kind != "pdf":
        raise ValueError("unsupported_kind")
    pdf = pdfium.PdfDocument(str(path))
    try:
        if len(pdf) > MAX_PAGES:
            raise ValueError("too_many_pages")
        parts = []
        for i in (p - 1 for p in pages if 0 < p <= len(pdf)) if pages else range(len(pdf)):
            page = pdf[i]
            textpage = page.get_textpage()
            text = _clean(textpage.get_text_range())
            textpage.close()
            page.close()
            parts.append(f"<!-- page {i + 1} -->\n\n{text or '_(no text layer — scanned page, needs OCR)_'}")
        return "\n\n".join(parts) + "\n"
    finally:
        pdf.close()
