"""Dataset generator — ported from aisbench_auto_tools_prefix/dataset_generator.py
with enhancements required by the desktop tool:

  1. Custom vocab file sampling (vocab.txt, one word/piece per line)
  2. tokenid mode (token-id first construction, single final decode)
  3. Progress callback with cooperative cancel + resume checkpoint
  4. Generation stats: measured token-length histogram, estimated hit rate

Random-vocab synthesis is intentionally dataset-free: the GSM8K JSONL shape
({"question": ..., "answer": "none"}) is only a container for the AISBench
gsm8k_gen_0_shot_cot_str_perf loader — no real GSM8K data is involved.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import random
from pathlib import Path
from typing import Callable, List, Optional

logger = logging.getLogger(__name__)

ProgressFn = Callable[[int, int], bool]  # (done, total) -> False means cancel


def parse_prefix_ratio(r: str | float | int) -> float:
    """'50%' -> 0.5, '0.5' -> 0.5 (ported verbatim)."""
    r = str(r).strip()
    if r.endswith("%"):
        v = float(r[:-1]) / 100.0
    else:
        v = float(r)
    if not (0.0 <= v <= 1.0):
        raise ValueError("repeat_rate must be in [0,1] or percent [0%,100%]")
    return v


class TokenizerWrapper:
    """Deterministic random-token generation on top of an HF tokenizer (ported)."""

    def __init__(self, tokenizer_path: str):
        from transformers import AutoTokenizer

        self.path = tokenizer_path
        # tokenizer paths are always local dirs (tokenizer_mgr.resolve) —
        # local_files_only keeps loading deterministic and network-free
        self._tok = AutoTokenizer.from_pretrained(
            tokenizer_path, trust_remote_code=True, local_files_only=True)
        self._safe_token_ids: Optional[List[int]] = None
        self._safe_words: Optional[List[str]] = None

    def count_tokens(self, text: str, include_special: bool = True) -> int:
        if not text:
            return 0
        return len(self._tok.encode(text, add_special_tokens=include_special))

    # ---- original behavior: sample ids from model vocab ----
    def get_some_tokens(self, num_tokens: int, seed: Optional[int] = None) -> str:
        ids = self.get_token_ids(num_tokens, seed)
        return self._tok.decode(ids, skip_special_tokens=True)

    def get_token_ids(self, num_tokens: int, seed: Optional[int] = None) -> List[int]:
        if num_tokens <= 0:
            return []
        rng = random.Random() if seed in (None, 0) else random.Random(seed)
        selected = rng.choices(self._get_or_build_safe_ids(), k=num_tokens)
        # decode→encode calibration (original step 3) applied on the text path;
        # in pure id mode we validate after the final decode instead.
        return selected

    def calibrated_text_from_ids(self, ids: List[int], num_tokens: int) -> str:
        text = self._tok.decode(ids, skip_special_tokens=True)
        encoded = self._tok.encode(text, add_special_tokens=False)
        if len(encoded) > num_tokens:
            text = self._tok.decode(encoded[:num_tokens], skip_special_tokens=True)
        return text

    # ---- enhancement: sample words from a custom vocab file ----
    def get_some_tokens_from_vocab(self, vocab_words: List[str], num_tokens: int,
                                   seed: Optional[int] = None) -> str:
        if num_tokens <= 0:
            return ""
        rng = random.Random() if seed in (None, 0) else random.Random(seed)
        for _ in range(4):  # a few calibration attempts
            words = [rng.choice(vocab_words) for _ in range(max(1, num_tokens))]
            text = " ".join(words)
            encoded = self._tok.encode(text, add_special_tokens=False)
            if len(encoded) == num_tokens:
                return text
            if len(encoded) > num_tokens:
                text = self._tok.decode(encoded[:num_tokens], skip_special_tokens=True)
                return text
        # final fallback: pad by repetition at id level
        return self.calibrated_text_from_ids(encoded, num_tokens)

    def _get_or_build_safe_ids(self) -> List[int]:
        if self._safe_token_ids is None:
            self._safe_token_ids = self._build_safe_token_ids()
        return self._safe_token_ids

    def _build_safe_token_ids(self) -> List[int]:
        vocab = self._tok.get_vocab()
        all_ids = set(vocab.values())
        special_ids = set(self._tok.all_special_ids)
        safe_ids_set = all_ids - special_ids
        safe_ids = []
        for tid in safe_ids_set:
            try:
                if self._tok.decode([tid], skip_special_tokens=True).strip():
                    safe_ids.append(tid)
            except Exception:
                continue
        safe_ids.sort()  # cross-environment determinism
        return safe_ids or list(safe_ids_set)

    def load_custom_vocab(self, path: str) -> List[str]:
        if self._safe_words is None:
            words = []
            with open(path, "r", encoding="utf-8", errors="ignore") as f:
                for line in f:
                    w = line.strip()
                    if w and not w.startswith("#"):
                        words.append(w)
            if not words:
                raise ValueError(f"vocab file is empty: {path}")
            self._safe_words = words
        return self._safe_words


def sample_target_length(rng, fixed_length, length_mean=None, length_std=None,
                         length_min=None, length_max=None) -> int:
    fixed_length = max(1, int(fixed_length))
    has_gauss = (length_mean is not None) and (length_std is not None)
    has_range = (length_min is not None) and (length_max is not None)
    lo = 1 if length_min is None else max(1, int(length_min))
    hi = None if length_max is None else max(1, int(length_max))
    if hi is not None and lo > hi:
        lo, hi = hi, lo
    if has_gauss:
        mu = max(1, int(length_mean))
        sigma = max(0.0, float(length_std))
        val = mu if sigma == 0 else int(round(rng.gauss(mu, sigma)))
        if hi is not None:
            val = min(val, hi)
        return max(1, max(lo, val))
    if has_range:
        return rng.randint(lo, hi)
    return fixed_length


def build_length_tag(input_len, length_mean, length_std, length_min, length_max) -> str:
    if (length_mean is not None) and (length_std is not None):
        tag = f"G{int(length_mean)}_{str(length_std).replace('.', 'd')}"
        if (length_min is not None) and (length_max is not None):
            tag += f"_C{int(length_min)}_{int(length_max)}"
        return tag
    if (length_min is not None) and (length_max is not None):
        return f"U{int(length_min)}_{int(length_max)}"
    return f"L{int(input_len)}"


def truncate_or_pad_text(tokenizer, text: str, target_len: int) -> str:
    tokens = tokenizer.encode(text, add_special_tokens=False)
    if len(tokens) >= target_len:
        tokens = tokens[:target_len]
    else:
        repeat_times = (target_len + len(tokens) - 1) // len(tokens)
        tokens = (tokens * repeat_times)[:target_len]
    return tokenizer.decode(tokens, skip_special_tokens=True)


def write_jsonl(path: str, dataset: list, num: Optional[int] = None) -> None:
    if num is not None:
        if not dataset:
            raise ValueError("empty dataset")
        if len(dataset) < num:
            repeats = num // len(dataset)
            remainder = num % len(dataset)
            dataset = dataset * repeats + dataset[:remainder]
        else:
            dataset = dataset[:num]
    with open(path, "w", encoding="utf-8") as f:
        for item in dataset:
            f.write(json.dumps({"question": item, "answer": "none"}, ensure_ascii=False))
            f.write("\n")


# ---------------------------------------------------------------------------
# Generation entry point
# ---------------------------------------------------------------------------

def generate_dataset(
    tokenizer_path: str,
    input_len: int,
    number: int,
    save_path: str,
    dp: int,
    repeat_rate: float,
    seed: int,
    prefix_num: int,
    output_len_unused: int = 0,
    length_mean: Optional[int] = None,
    length_std: Optional[float] = None,
    length_min: Optional[int] = None,
    length_max: Optional[int] = None,
    mode: str = "text",            # text | tokenid
    vocab_file: Optional[str] = None,
    progress: Optional[ProgressFn] = None,
) -> dict:
    """Generate prefix + full dataset files.

    Returns dict: {prefix_path, dataset_path, prefix_len, separator_len,
                   stats:{rows, sampled_lengths, est_hit_rate, tokenizer, drift}}
    Raises DatasetCancelled when progress() returns False.
    """
    wrapper = TokenizerWrapper(tokenizer_path)
    tokenizer = wrapper._tok
    Path(save_path).mkdir(parents=True, exist_ok=True)

    vocab_words = wrapper.load_custom_vocab(vocab_file) if vocab_file else None
    total_steps = prefix_num + number * 2 if repeat_rate < 1.0 else prefix_num
    done = 0

    def tick(inc: int = 1) -> None:
        nonlocal done
        done += inc
        if progress is not None and not progress(done, total_steps):
            raise DatasetCancelled(f"cancelled at {done}/{total_steps}")

    base_name = os.path.basename(os.path.normpath(tokenizer_path))
    prefix_len = int(input_len * repeat_rate)
    separator_len = 3
    suffix_len = max(0, int(input_len - prefix_len - separator_len))

    drift = 0.0

    def make_text(num_tokens: int, s: int) -> str:
        if vocab_words is not None:
            return wrapper.get_some_tokens_from_vocab(vocab_words, num_tokens, seed=s)
        if mode == "tokenid":
            ids = wrapper.get_token_ids(num_tokens, seed=s)
            return wrapper.calibrated_text_from_ids(ids, num_tokens)
        return wrapper.get_some_tokens(num_tokens, seed=s)

    # ---- prefix pool ----
    prefix_pool: List[str] = []
    for i in range(prefix_num):
        prefix_seed = 0 if seed == 0 else seed + i
        prefix_pool.append(make_text(prefix_len, prefix_seed))
        tick()

    prefix_dataset: List[str] = []
    for i in range(prefix_num):
        prefix_dataset.extend([prefix_pool[i]] * dp)

    prefix_path = os.path.join(
        save_path, f"prefix-GSM8K-in{prefix_len}-num{dp * prefix_num}-{base_name}.jsonl")
    write_jsonl(prefix_path, prefix_dataset, dp * prefix_num)

    if repeat_rate >= 1.0:
        dataset_path = os.path.join(
            save_path, f"GSM8K-in{prefix_len}-num{number}-{base_name}-repeatRate{repeat_rate}.jsonl")
        write_jsonl(dataset_path, prefix_dataset, number)
        sampled = _sample_lengths(tokenizer, prefix_dataset, input_len)
        return _result(prefix_path, dataset_path, prefix_len, separator_len,
                       number, sampled, repeat_rate, base_name, 0.0)

    # ---- separators ----
    separator_pool: List[str] = []
    for i in range(number):
        sep_seed = 0 if seed == 0 else seed + prefix_num + i
        separator_pool.append(make_text(separator_len, sep_seed))
        tick()

    # ---- suffixes ----
    suffix_pool: List[str] = []
    for i in range(number):
        suffix_seed = 0 if seed == 0 else seed + prefix_num + number + i
        suffix_pool.append(make_text(suffix_len, suffix_seed))
        tick()

    dataset = [prefix_pool[i % prefix_num] + separator_pool[i] + suffix_pool[i]
               for i in range(number)]

    dataset_path = os.path.join(
        save_path, f"GSM8K-in{input_len}-num{number}-{base_name}-repeatRate{repeat_rate}.jsonl")
    write_jsonl(dataset_path, dataset, number)

    # tokenid-mode drift check: re-encode one row, compare against target
    sample = dataset[min(3, len(dataset) - 1)]
    actual = len(tokenizer.encode(sample, add_special_tokens=False))
    drift = abs(actual - input_len) / max(1, input_len)

    sampled = _sample_lengths(tokenizer, dataset, input_len)
    return _result(prefix_path, dataset_path, prefix_len, separator_len,
                   number, sampled, repeat_rate, base_name, drift)


class DatasetCancelled(RuntimeError):
    pass


def _sample_lengths(tokenizer, dataset: List[str], input_len: int, n: int = 40) -> list[int]:
    step = max(1, len(dataset) // n)
    lengths = []
    for row in dataset[::step][:n]:
        lengths.append(len(tokenizer.encode(row, add_special_tokens=False)))
    return lengths


def _result(prefix_path, dataset_path, prefix_len, separator_len, rows,
            sampled, repeat_rate, tokenizer_name, drift) -> dict:
    est = repeat_rate * (1 - separator_len / max(1, prefix_len + 1))
    return {
        "prefix_path": prefix_path,
        "dataset_path": dataset_path,
        "stats": {
            "rows": rows,
            "sampled_lengths": sampled,
            "est_hit_rate": round(est, 4),
            "tokenizer": tokenizer_name,
            "prefix_len": prefix_len,
            "separator_len": separator_len,
            "drift": round(drift, 4),
        },
        "hash": hashlib.sha1(
            (dataset_path + str(os.path.getmtime(dataset_path))).encode()).hexdigest()[:10],
    }


def preview_dataset(tokenizer_path: str, input_len: int, repeat_rate: float,
                    prefix_num: int = 4, seed: int = 1, mode: str = "text",
                    vocab_file: Optional[str] = None) -> dict:
    """Generate a few rows quickly for UI preview (no files written)."""
    wrapper = TokenizerWrapper(tokenizer_path)
    tokenizer = wrapper._tok
    vocab_words = wrapper.load_custom_vocab(vocab_file) if vocab_file else None
    prefix_len = int(input_len * repeat_rate)
    separator_len = 3
    suffix_len = max(0, input_len - prefix_len - separator_len)

    def make(num, s):
        if vocab_words is not None:
            return wrapper.get_some_tokens_from_vocab(vocab_words, num, seed=s)
        if mode == "tokenid":
            return wrapper.calibrated_text_from_ids(wrapper.get_token_ids(num, seed=s), num)
        return wrapper.get_some_tokens(num, seed=s)

    samples = []
    for i in range(min(prefix_num, 3)):
        parts = {
            "prefix": make(prefix_len, seed + i),
            "separator": make(separator_len, seed + 100 + i),
            "suffix": make(suffix_len, seed + 200 + i),
        }
        samples.append(parts)
    measured = [len(tokenizer.encode(s["prefix"] + s["separator"] + s["suffix"],
                                     add_special_tokens=False)) for s in samples]
    est = repeat_rate * (1 - separator_len / max(1, prefix_len + 1))
    return {
        "samples": [{k: v[:1200] for k, v in s.items()} for s in samples],
        "segment_lengths": {"prefix": prefix_len, "separator": separator_len,
                            "suffix": suffix_len},
        "measured_lengths": measured,
        "target": input_len,
        "est_hit_rate": round(est, 4),
    }
