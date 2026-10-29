"""Conversion engines share one interface: convert(path, kind, mode, pages) -> markdown.

`pages` is a list of 1-based page numbers to convert, or None for all; every converted page
starts with a `<!-- page N -->` marker carrying its number in the original document.

Swap engines with MDB_ENGINE without touching the worker loop.
"""

from importlib import import_module

ENGINES = {
    "basic": "engines.basic",  # CPU text-layer extraction, no OCR
    "mineru": "engines.mineru",  # GPU: MinerU 4 API in WSL (worker/mineru-server.sh)
}


def get_engine(name: str):
    if name not in ENGINES:
        raise ValueError(f"unknown engine: {name}")
    return import_module(ENGINES[name])
