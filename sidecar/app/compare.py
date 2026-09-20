"""Multi-run comparison engine.

Rounds are aligned by round_index; warmup phases and practice runs are
excluded by default (is_warmup / is_practice metadata per the design).
Metric deltas are direction-aware: hit-rate/throughput up = good,
latency/duration up = bad.
"""
from __future__ import annotations

import statistics
from typing import Any

from . import store

# metric -> (label, higher_is_better)
METRICS: dict[str, tuple[str, bool]] = {
    "hbm_hit_rate": ("HBM 命中率", True),
    "ext_hit_rate": ("Ext 命中率", True),
    "composite_hit_rate": ("综合命中率", True),
    "ttft_avg_ms": ("TTFT avg (ms)", False),
    "ttft_p90_ms": ("TTFT P90 (ms)", False),
    "tpot_avg_ms": ("TPOT avg (ms)", False),
    "tpot_p90_ms": ("TPOT P90 (ms)", False),
    "output_token_throughput": ("输出吞吐 (tok/s)", True),
    "total_token_throughput": ("总吞吐 (tok/s)", True),
    "benchmark_duration_s": ("时长 (s)", False),
    "request_throughput_qps": ("QPS", True),
    "measured_concurrency": ("实测并发", True),
}

DIFF_KEYS = ["input_len", "output_len", "data_num", "concurrency", "request_rate",
             "prefix_num", "repeat_rate", "dp", "seed", "test_type", "enable_think",
             "cache_reset", "model_name", "host_ip", "host_port"]


def _full_rounds(run_id: str) -> list[dict]:
    return [r for r in store.get_rounds(run_id) if r["phase"] == "full"]


def compare(run_ids: list[str], exclude_warmup: bool = True,
            exclude_practice: bool = True) -> dict:
    series: dict[str, dict] = {}
    for run_id in run_ids:
        run = store.get_run(run_id)
        if not run:
            continue
        if exclude_practice and run.get("is_practice"):
            continue
        rounds = store.get_rounds(run_id)
        if exclude_warmup:
            rounds = [r for r in rounds if not r["is_warmup"]]
        fulls = [r for r in rounds if r["phase"] == "full"]
        per_round: dict[int, dict] = {}
        for r in fulls:
            m = r.get("metrics", {})
            h = (r.get("hit_rate") or {}).get("aggregated", {})
            row = {
                "hbm_hit_rate": h.get("hbm_hit_rate", 0.0),
                "ext_hit_rate": h.get("ext_hit_rate", 0.0),
                "composite_hit_rate": h.get("composite_hit_rate",
                                            round(h.get("ext_hit_rate", 0.0)
                                                  * (1 - h.get("hbm_hit_rate", 0.0))
                                                  + h.get("hbm_hit_rate", 0.0), 6)),
                "ttft_avg_ms": m.get("ttft_avg_ms", -1),
                "ttft_p90_ms": m.get("ttft_p90_ms", -1),
                "tpot_avg_ms": m.get("tpot_avg_ms", -1),
                "tpot_p90_ms": m.get("tpot_p90_ms", -1),
                "output_token_throughput": m.get("output_token_throughput", -1),
                "total_token_throughput": m.get("total_token_throughput", -1),
                "benchmark_duration_s": m.get("benchmark_duration_s", -1),
                "request_throughput_qps": m.get("request_throughput_qps", -1),
                "measured_concurrency": m.get("measured_concurrency", -1),
            }
            per_round[r["round_index"]] = row
        # per-dp hit rates of the last full round for the heatmap
        dp_matrix = {}
        if fulls:
            per_dp = (fulls[-1].get("hit_rate") or {}).get("per_dp", {})
            for dp_key, dp_data in per_dp.items():
                dp_matrix[dp_key] = {
                    "hbm_hit_rate": dp_data.get("hbm_hit_rate", 0.0),
                    "ext_hit_rate": dp_data.get("ext_hit_rate", 0.0),
                }
        series[run_id] = {
            "name": run.get("name") or run_id,
            "status": run.get("status"),
            "config": run.get("config", {}),
            "per_round": per_round,
            "mean": {k: (statistics.mean(v[k] for v in per_round.values()
                         if v.get(k, -1) >= 0) if any(v.get(k, -1) >= 0 for v in per_round.values())
                         else -1)
                     for k in METRICS},
            "dp_matrix": dp_matrix,
        }

    ids = [r for r in run_ids if r in series]
    baseline = series[ids[0]]["mean"] if ids else {}

    deltas = {}
    for key, (label, higher_better) in METRICS.items():
        values = {rid: series[rid]["mean"].get(key, -1) for rid in ids}
        base = values.get(ids[0], -1) if ids else -1
        delta = {}
        for rid in ids[1:]:
            cur = values[rid]
            if base and base > 0 and cur is not None and cur >= 0:
                pct = round((cur - base) / base * 100, 2)
                good = (cur >= base) if higher_better else (cur <= base)
                delta[rid] = {"abs": round(cur - base, 4), "pct": pct, "good": good}
        deltas[key] = {"label": label, "higher_is_better": higher_better,
                       "values": values, "deltas": delta}

    # config diff
    diff_rows = []
    keys = DIFF_KEYS[:]
    for rid in ids[1:]:
        keys += [k for k in series[rid]["config"] if k in DIFF_KEYS and k not in keys]
    for key in keys:
        values = [series[rid]["config"].get(key) for rid in ids]
        diff_rows.append({"key": key, "values": values,
                          "diff": any(v != values[0] for v in values)})

    missing_rounds = []
    if ids:
        max_round = max((len(series[rid]["per_round"]) for rid in ids), default=0)
        for rid in ids:
            for i in range(1, max_round + 1):
                if i not in series[rid]["per_round"]:
                    missing_rounds.append({"run": rid, "round": i})

    return {"runs": ids, "names": {rid: series[rid]["name"] for rid in ids},
            "metrics": deltas, "config_diff": diff_rows,
            "per_round": {rid: series[rid]["per_round"] for rid in ids},
            "dp_matrix": {rid: series[rid]["dp_matrix"] for rid in ids},
            "missing_rounds": missing_rounds}
