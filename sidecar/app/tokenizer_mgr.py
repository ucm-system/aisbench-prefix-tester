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
    """Try loading with AutoTokenizer; report vocab size and special tokens.

    Also round-trips a Chinese sample: loading alone does NOT catch the
    transformers-5.17 upstream bug where LlamaTokenizer-family tokenizers
    (e.g. DeepSeek) load successfully but encode Chinese to zero ids — which
    would silently corrupt generated datasets."""
    path = resolve(name_or_path)
    try:
        w = _load(path)
        vocab = w._tok.get_vocab()
        ids = w._tok.encode("前缀缓存命中率校验")
        # 10 个互不相同的汉字：合法编码必然 ≥2 个 token。返回 0 个（DeepSeek-V3/R1
        # 系）或塌缩成 1 个（Step 系，实测 id=[0]）都是 transformers 5.17 的上游
        # CJK bug——加载"成功"但编码已损坏，会静默毁掉数据集
        if not ids or len(ids) < 2:
            return {
                "ok": False, "path": path,
                "error": f"中文编码异常（10 字样本返回 {len(ids)} 个 token，"
                         f"transformers 5.17 上游 bug：DeepSeek-V3/V3.1/V3.2/R1 与 Step 系受影响；"
                         "4.57.x 正常。建议换用其他 tokenizer 或锁定 4.57.x）",
            }
        return {
            "ok": True,
            "path": path,
            "vocab_size": len(vocab),
            "special_tokens": len(w._tok.all_special_ids),
            "zh_probe_tokens": len(ids),
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
