"""Conversion engines share one interface: convert(path, kind, mode) -> markdown.

Swap engines with MDB_ENGINE without touching the worker loop.
"""

from importlib import import_module

ENGINES = {
    "basic": "engines.basic",  # CPU text-layer extraction (placeholder until GPU engines land)
}


def get_engine(name: str):
    if name not in ENGINES:
        raise ValueError(f"unknown engine: {name}")
    return import_module(ENGINES[name])
