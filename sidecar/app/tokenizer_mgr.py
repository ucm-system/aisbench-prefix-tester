"""Tokenizer registry: local model dirs (D:\\Models, app assets) + user-registered dirs."""
from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import Optional

from . import config, store

logger = logging.getLogger(__name__)
_load_lock = threading.Lock()
_cache: dict[str, object] = {}


def refresh_defaults() -> None:
    """Seed the registry with first-party tokenizer dirs found on this machine."""
    for cand in config.default_tokenizer_candidates():
        existing = {t["name"] for t in store.list_tokenizers()}
        if cand["name"] not in existing:
            store.upsert_tokenizer(cand["name"], cand["path"], cand["source"])
            logger.info("registered default tokenizer %s -> %s", cand["name"], cand["path"])


def list_tokenizers() -> list[dict]:
    refresh_defaults()
    return store.list_tokenizers()


def register(name: str, path: str) -> dict:
    p = Path(path)
    if not p.is_dir():
        raise ValueError(f"directory not found: {path}")
    has_marker = any(
        (p / f).exists()
        for f in ("tokenizer.json", "tokenizer_config.json", "vocab.json", "vocab.txt")
    )
    if not has_marker:
        raise ValueError("no tokenizer files (tokenizer.json / tokenizer_config.json / vocab.json) in directory")
    store.upsert_tokenizer(name or p.name, str(p), "custom")
    return {"name": name or p.name, "path": str(p), "source": "custom"}


def delete(name: str) -> None:
    store.delete_tokenizer(name)
    _cache.pop(name, None)


def resolve(name_or_path: Optional[str]) -> str:
    """Map a registry name to a filesystem path; pass raw paths through."""
    if not name_or_path:
        raise ValueError("tokenizer is required")
    cand = Path(name_or_path)
    if cand.exists():
        return str(cand)
    for t in store.list_tokenizers():
        if t["name"] == name_or_path:
            return t["path"]
    raise ValueError(f"unknown tokenizer: {name_or_path}")


def verify(name_or_path: str) -> dict:
    """Try loading with AutoTokenizer; report vocab size and special tokens."""
    path = resolve(name_or_path)
    try:
        w = _load(path)
        vocab = w._tok.get_vocab()
        return {
            "ok": True,
            "path": path,
            "vocab_size": len(vocab),
            "special_tokens": len(w._tok.all_special_ids),
        }
    except Exception as exc:  # noqa: BLE001 — report the reason to the UI
        return {"ok": False, "path": path, "error": str(exc)[:500]}


def _load(path: str):
    from .dataset_gen import TokenizerWrapper

    with _load_lock:
        w = _cache.get(path)
        if w is None:
            w = TokenizerWrapper(path)
            _cache[path] = w
        return w


def get_wrapper(name_or_path: str):
    return _load(resolve(name_or_path))
