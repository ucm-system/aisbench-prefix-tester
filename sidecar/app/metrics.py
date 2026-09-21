"""Prometheus /metrics collector.

- Polls every pod endpoint (default 5s) and extracts a whitelist of
  vllm:* / ucm:* counters & gauges grouped by (pod, engine, worker_rank).
- Snapshot-diff hit rates (Δhits/Δqueries) — same口径 as the original CLI tool.
- Writes a JSONL time series per run and broadcasts samples over the event bus.
- Detects UCM presence via the `ucm:` metric prefix.
"""
from __future__ import annotations

import asyncio
import logging
import math
import re
import time
from typing import Any, Callable, Dict, List, Optional

import httpx

from . import events

logger = logging.getLogger(__name__)

# metric-name suffix -> key in the sample dict
WHITELIST = {
    "vllm:prefix_cache_queries_total": "hbm_q",
    "vllm:prefix_cache_hits_total": "hbm_h",
    "vllm:external_prefix_cache_queries_total": "ext_q",
    "vllm:external_prefix_cache_hits_total": "ext_h",
    "vllm:num_requests_running": "running",
    "vllm:num_requests_waiting": "waiting",
    "vllm:num_requests_swapped": "swapped",
    "vllm:kv_cache_usage_perc": "kv_usage",
    "vllm:prompt_tokens_total": "prompt_tok",
    "vllm:generation_tokens_total": "gen_tok",
    "vllm:time_to_first_token_seconds_sum": "ttft_sum",
    "vllm:time_to_first_token_seconds_count": "ttft_cnt",
    "vllm:inter_token_latency_seconds_sum": "itl_sum",
    "vllm:inter_token_latency_seconds_count": "itl_cnt",
    "vllm:e2e_request_latency_seconds_sum": "e2e_sum",
    "vllm:e2e_request_latency_seconds_count": "e2e_cnt",
    "vllm:request_success_total": "success",
    "ucm:total_prefix_query_tokens_total": "ucm_q_tok",
    "ucm:gpu_hbm_hit_tokens_total": "ucm_hbm_tok",
    "ucm:ucm_hit_tokens_total": "ucm_hit_tok",
    "ucm:cache_lookup_hit_blocks_total": "cache_hit_blk",
    "ucm:cache_lookup_miss_blocks_total": "cache_miss_blk",
    "ucm:posix_lookup_query_blocks_total": "posix_q_blk",
    "ucm:posix_lookup_hit_blocks_total": "posix_hit_blk",
    "ucm:load_bytes_total": "ucm_load_bytes",
    "ucm:save_bytes_total": "ucm_save_bytes",
    # UCM storage usage + bandwidth (metrics_lite 口径)
    "ucm:cache_load_bytes_total": "ucm_cache_load",
    "ucm:cache_dump_bytes_total": "ucm_cache_dump",
    "ucm:posix_s2h_bytes_total": "ucm_posix_s2h",
    "ucm:posix_h2s_bytes_total": "ucm_posix_h2s",
    "ucm:posix_store_used_bytes": "posix_used",
    "ucm:posix_store_capacity_bytes": "posix_cap",
    "posix_store_health": "posix_health",
    "mooncake_store_health": "mooncake_health",
    "yuanrong_dram_usage_ratio": "yr_dram_ratio",
    "yuanrong_ssd_usage_ratio": "yr_ssd_ratio",
}

_LABEL_RE = re.compile(r'(\w+)="([^"]*)"')
_LINE_RE = re.compile(r"^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+([0-9eE+.+-]+|NaN)\s*$")


def parse_pod_address(pod: str) -> tuple[str, str]:
    """Supports IPv4 `ip:port`, `[ipv6]:port` and bare ipv6 (last colon)."""
    pod = pod.strip()
    if pod.startswith("["):
        bracket_end = pod.index("]")
        return pod[1:bracket_end], pod[bracket_end + 2:]
    if pod.count(":") > 1:
        ip, port = pod.rsplit(":", 1)
        return ip, port
    ip, port = pod.split(":")
    return ip, port


def parse_metrics_text(text: str) -> dict[tuple, dict[str, float]]:
    """Return {(engine, worker_rank): {key: value}} from a Prometheus exposition."""
    series: dict[tuple, dict[str, float]] = {}

    def bucket(engine: str, worker: str) -> dict[str, float]:
        return series.setdefault((engine, worker), {})

    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        m = _LINE_RE.match(line)
        if not m:
            continue
        name, labels_raw, value_raw = m.group(1), m.group(2) or "", m.group(3)
        key = WHITELIST.get(name)
        if key is None:
            # still track ucm presence for any ucm:* family
            if name.startswith("ucm:"):
                bucket("0", "0").setdefault("_ucm_seen", 1.0)
            continue
        labels = dict(_LABEL_RE.findall(labels_raw))
        engine = labels.get("engine", "0")
        worker = labels.get("worker_rank", "0")
        try:
            value = float(value_raw)
        except ValueError:
            continue
        if not math.isfinite(value):
            continue  # NaN/inf would poison diffs and break JSONL/JSON round-trips
        bucket(engine, worker)[key] = bucket(engine, worker).get(key, 0.0) + value
        if name.startswith("ucm:"):
            bucket(engine, worker).setdefault("_ucm_seen", 1.0)
    return series


async def fetch_metrics(client: httpx.AsyncClient, pod: str) -> Optional[str]:
    ip, port = parse_pod_address(pod)
    url = f"http://{ip}:{port}/metrics"
    try:
        resp = await client.get(url)
        if resp.status_code != 200:
            return None
        return resp.text
    except Exception as exc:  # noqa: BLE001
        logger.debug("metrics fetch failed for %s: %s", pod, exc)
        return None


def merge_pod_series(target: dict, parsed: dict[tuple, dict[str, float]]) -> None:
    """Accumulate per-(engine,worker) counters (multi-pod same-engine sums, as original)."""
    for series_key, keys in parsed.items():
        dst = target.setdefault(series_key, {})
        for k, v in keys.items():
            dst[k] = dst.get(k, 0.0) + v


def compute_hit_rate(before: dict, after: dict) -> dict:
    """Δhits/Δqueries per engine (dp domain) and aggregated — ported口径.
    Keys may be (engine, worker) or (pod, engine, worker); the pod dimension is
    additionally broken out per endpoint for PD/multi-port deployments."""
    per_dp: dict[str, dict] = {}
    per_pod: dict[str, dict] = {}
    agg = {"hbm_q": 0, "hbm_h": 0, "ext_q": 0, "ext_h": 0}

    series_keys = set(after) | set(before)
    for series_key in series_keys:
        a = after.get(series_key, {})
        b = before.get(series_key, {})
        pod, engine = (series_key[0], series_key[1])
        dp_key = f"dp{engine}"
        slot = per_dp.setdefault(
            dp_key, {"hbm_queries": 0, "hbm_hits": 0, "ext_queries": 0, "ext_hits": 0})
        pod_slot = per_pod.setdefault(
            f"{pod}|{dp_key}", {"hbm_queries": 0, "hbm_hits": 0,
                                "ext_queries": 0, "ext_hits": 0})
        for dst, src in (("hbm_queries", "hbm_q"), ("hbm_hits", "hbm_h"),
                         ("ext_queries", "ext_q"), ("ext_hits", "ext_h")):
            delta = int(a.get(src, 0) - b.get(src, 0))
            slot[dst] += delta
            pod_slot[dst] += delta
            agg[src] += delta

    for dp_key, dp_data in per_dp.items():
        hbm_rate = dp_data["hbm_hits"] / dp_data["hbm_queries"] if dp_data["hbm_queries"] > 0 else 0.0
        ext_rate = dp_data["ext_hits"] / dp_data["ext_queries"] if dp_data["ext_queries"] > 0 else 0.0
        dp_data["hbm_hit_rate"] = round(hbm_rate, 6)
        dp_data["ext_hit_rate"] = round(ext_rate, 6)
    for pod_key, pod_data in per_pod.items():
        hbm_rate = pod_data["hbm_hits"] / pod_data["hbm_queries"] if pod_data["hbm_queries"] > 0 else 0.0
        ext_rate = pod_data["ext_hits"] / pod_data["ext_queries"] if pod_data["ext_queries"] > 0 else 0.0
        pod_data["hbm_hit_rate"] = round(hbm_rate, 6)
        pod_data["ext_hit_rate"] = round(ext_rate, 6)

    aggregated = {
        "hbm_hit_rate": round(agg["hbm_h"] / agg["hbm_q"], 6) if agg["hbm_q"] > 0 else 0.0,
        "hbm_queries": agg["hbm_q"], "hbm_hits": agg["hbm_h"],
        "ext_hit_rate": round(agg["ext_h"] / agg["ext_q"], 6) if agg["ext_q"] > 0 else 0.0,
        "ext_queries": agg["ext_q"], "ext_hits": agg["ext_h"],
    }
    if aggregated["hbm_queries"] and aggregated["ext_queries"]:
        aggregated["composite_hit_rate"] = round(
            aggregated["ext_hit_rate"] * (1 - aggregated["hbm_hit_rate"])
            + aggregated["hbm_hit_rate"], 6)
    return {"per_dp": per_dp, "per_pod": per_pod, "aggregated": aggregated}


def flatten_snapshot(snapshot: dict[tuple, dict[str, float]]) -> dict[str, dict[str, float]]:
    """{(engine, worker): counters} -> {engine: counters} (workers summed)."""
    out: dict[str, dict[str, float]] = {}
    for (engine, _worker), counters in snapshot.items():
        dst = out.setdefault(engine, {})
        for k, v in counters.items():
            dst[k] = dst.get(k, 0.0) + v
    return out


class Collector:
    """Async poll loop for one run. snapshot() is safe from the runner thread."""

    def __init__(self, pods: List[str], interval: float = 5.0,
                 on_sample: Optional[Callable[[dict], None]] = None):
        self.pods = pods
        self.interval = interval
        self.on_sample = on_sample
        self.latest: dict[tuple, dict[str, float]] = {}
        self.ucm_detected = False
        self._task: Optional[asyncio.Task] = None
        self._stop = asyncio.Event()
        self._lock = asyncio.Lock()

    async def _poll_once(self) -> bool:
        any_ok = False
        merged: dict[tuple, dict[str, float]] = {}
        async with httpx.AsyncClient(trust_env=False, timeout=3.0) as client:
            results = await asyncio.gather(*(fetch_metrics(client, p) for p in self.pods))
        for pod, raw in zip(self.pods, results):
            if raw is None:
                continue
            any_ok = True
            parsed = parse_metrics_text(raw)
            # pod dimension preserved: key = (pod, engine, worker)
            for (engine, worker), counters in parsed.items():
                key = (pod, engine, worker)
                dst = merged.setdefault(key, {})
                for k, v in counters.items():
                    dst[k] = dst.get(k, 0) + v
        async with self._lock:
            if any_ok:
                self.latest = merged
                if any(c.get("_ucm_seen") for c in merged.values()):
                    self.ucm_detected = True
        if any_ok and self.on_sample:
            try:
                self.on_sample(self.public_sample())
            except Exception:  # noqa: BLE001
                logger.exception("on_sample callback failed")
        return any_ok

    def public_sample(self) -> dict:
        return {
            "ts": time.time(),
            "engines": {f"{p}|{e}|{w}": c for (p, e, w), c in self.latest.items()},
            "ucm_detected": self.ucm_detected,
            "pods_ok": True,
        }

    async def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                await self._poll_once()
            except Exception:  # noqa: BLE001
                logger.exception("poll cycle failed")
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=self.interval)
            except asyncio.TimeoutError:
                pass

    async def start(self) -> None:
        self._task = asyncio.get_running_loop().create_task(self._loop())

    async def stop(self) -> None:
        self._stop.set()
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass

    async def snapshot(self) -> dict[tuple, dict[str, float]]:
        """Force an immediate poll and return the current counters."""
        await self._poll_once()
        async with self._lock:
            return dict(self.latest)


async def reset_prefix_cache(pods: List[str]) -> dict:
    """POST /reset_prefix_cache on every pod (vLLM OpenAI-server endpoint).

    Returns {pod: 'ok'|error-string} for the run event stream.
    """
    results: dict[str, str] = {}
    async with httpx.AsyncClient(trust_env=False, timeout=5.0) as client:
        for pod in pods:
            ip, port = parse_pod_address(pod)
            try:
                resp = await client.post(f"http://{ip}:{port}/reset_prefix_cache")
                results[pod] = "ok" if resp.status_code == 200 else f"http {resp.status_code}"
            except Exception as exc:  # noqa: BLE001
                results[pod] = f"error: {exc}"[:200]
    return results
