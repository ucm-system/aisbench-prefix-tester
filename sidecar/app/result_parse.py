"""AISBench log parsing & result row construction — ported from result_writer.py."""
from __future__ import annotations

import logging
import re
import time
from typing import Dict, Optional

logger = logging.getLogger(__name__)

METRIC_DEFAULTS = {
    "ttft_min_ms": -1, "ttft_max_ms": -1, "ttft_median_ms": -1,
    "ttft_p50_ms": -1, "ttft_p75_ms": -1, "ttft_p99_ms": -1,
    "tpot_min_ms": -1, "tpot_max_ms": -1, "tpot_median_ms": -1,
    "tpot_p50_ms": -1, "tpot_p75_ms": -1, "tpot_p99_ms": -1,
    "e2el_avg_ms": -1, "e2el_p90_ms": -1, "e2el_p99_ms": -1,
    "total_requests": -1,
    "max_concurrency": -1,
    "measured_concurrency": -1,
    "ttft_avg_ms": -1,
    "ttft_p90_ms": -1,
    "tpot_avg_ms": -1,
    "tpot_p90_ms": -1,
    "benchmark_duration_s": -1,
    "output_token_throughput": -1,
    "single_output_throughput": -1,
    "input_token_throughput": -1,
    "total_token_throughput": -1,
    "single_total_throughput": -1,
    "prefill_token_throughput": -1,
    "request_throughput_qps": -1,
    "request_throughput_qpm": -1,
    "total_input_tokens": -1,
    "total_output_tokens": -1,
}


def parse_aisbench_log(log_path: str, request_rate: str = "0", npu_num: int = 1) -> tuple[Dict, str]:
    """Extract perf metrics from an AISBench summary log (ported verbatim)."""
    result = METRIC_DEFAULTS.copy()
    result["request_rate"] = request_rate
    log_dir = ""
    try:
        with open(log_path, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
        # Perf-table header (AISBench >=3.x): map rows like
        # "| TTFT | total | 343.1 ms | ... |" onto named stats.
        header_cells: list[str] = []
        HEADER_ALIASES = {"average": "avg", "median": "p50", "p75": "p75",
                          "p90": "p90", "p99": "p99", "min": "min", "max": "max"}
        for line in lines:
            m = re.search(r"Current exp folder:\s*(.+)$", line)
            if m:
                log_dir = m.group(1).strip()

            # capture perf-table header once per table
            if "Performance Parameters" in line:
                header_cells = [c.strip() for c in line.split("│") if c.strip()]
                continue
            for row_name, prefix in (("TTFT", "ttft"), ("TPOT", "tpot"), ("E2EL", "e2el")):
                if line.startswith("│ " + row_name) and header_cells:
                    cells = [c.strip() for c in line.split("│") if c.strip()]
                    if cells and cells[0] == row_name:
                        names = header_cells[2:]
                        values = cells[2:]
                        for cname, cval in zip(names, values):
                            stat = HEADER_ALIASES.get(cname.lower())
                            mm = re.match(r"([0-9.]+)", cval)
                            if stat and mm:
                                result[f"{prefix}_{stat}_ms"] = float(mm.group(1))
                    break

            if "TTFT" in line and "Time To First Token" not in line:
                vals = list(map(float, re.findall(r"(\d+\.\d+)", line)))
                if vals:
                    result["ttft_avg_ms"] = vals[0] if len(vals) > 0 else -1
                    result["ttft_p90_ms"] = vals[5] if len(vals) > 5 else -1

            if "TPOT" in line and "Time Per Output Token" not in line:
                vals = list(map(float, re.findall(r"(\d+\.\d+)", line)))
                if vals:
                    result["tpot_avg_ms"] = vals[0] if len(vals) > 0 else -1
                    result["tpot_p90_ms"] = vals[5] if len(vals) > 5 else -1

            if "Benchmark Duration" in line:
                nums = re.findall(r"(\d+\.\d+)", line)
                if nums:
                    result["benchmark_duration_s"] = float(nums[0]) / 1000

            if "Concurrency" in line and "Max Concurrency" not in line:
                nums = re.findall(r"(\d+\.\d+)", line)
                if nums:
                    result["measured_concurrency"] = float(nums[0])

            if "Max Concurrency" in line:
                parts = re.findall(r"[\w']+", line)
                if parts:
                    result["max_concurrency"] = parts[-1]

            if "Output Token Throughput" in line:
                nums = re.findall(r"(\d+\.\d+)", line)
                if nums:
                    result["output_token_throughput"] = float(nums[0])
                    result["single_output_throughput"] = float(nums[0]) / max(1, npu_num)

            if "Input Token Throughput" in line:
                nums = re.findall(r"(\d+\.\d+)", line)
                if nums:
                    result["input_token_throughput"] = float(nums[0])

            if "Total Token Throughput" in line:
                nums = re.findall(r"(\d+\.\d+)", line)
                if nums:
                    result["total_token_throughput"] = float(nums[0])
                    result["single_total_throughput"] = float(nums[0]) / max(1, npu_num)

            if "InputTokens" in line:
                nums = re.findall(r"(\d+\.?\d*)", line)
                if nums:
                    result["total_input_tokens"] = float(nums[0])

            if "OutputTokens" in line:
                nums = re.findall(r"(\d+\.?\d*)", line)
                if nums:
                    result["total_output_tokens"] = float(nums[0])

            if "Total Requests" in line and "Request Throughput" not in line:
                nums = re.findall(r"(\d+\.?\d*)", line)
                if nums:
                    result["total_requests"] = float(nums[0])

            if "Request Throughput" in line:
                nums = re.findall(r"(\d+\.\d+)", line)
                if nums:
                    result["request_throughput_qps"] = float(nums[0])
                    result["request_throughput_qpm"] = float(nums[0]) * 60

            if "Prefill Token Throughput" in line:
                nums = re.findall(r"(\d+\.\d+)", line)
                if nums:
                    result["prefill_token_throughput"] = float(nums[0])
    except FileNotFoundError:
        logger.error("AISBench log file not found: %s", log_path)
    except Exception as exc:  # noqa: BLE001
        logger.error("Error parsing AISBench log: %s", exc)
    return result, log_dir


def build_result_row(
    perf: Dict, hit_rate: Dict, params: Dict, phase: str = "full",
    round_index: int = 1, warnings: str = "",
) -> Dict:
    """Flat row for CSV/JSONL — schema-compatible with the original tool's output."""
    row = {
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "round": round_index,
        "test_name": params.get("test_name", ""),
        "phase": phase,
        **{k: params.get(k) for k in (
            "input_len", "output_len", "data_num", "concurrency", "request_rate",
            "dp", "prefix_num", "repeat_rate", "seed", "model_path",
            "host_ip", "host_port", "url", "npu_num")},
        **{k: perf.get(k, -1) for k in METRIC_DEFAULTS},
    }
    per_dp = hit_rate.get("per_dp", {})
    for dp_key, dp_data in sorted(per_dp.items()):
        row[f"hbm_hit_rate_{dp_key}"] = dp_data.get("hbm_hit_rate", 0.0)
        row[f"hbm_queries_{dp_key}"] = dp_data.get("hbm_queries", 0)
        row[f"hbm_hits_{dp_key}"] = dp_data.get("hbm_hits", 0)
        row[f"ext_hit_rate_{dp_key}"] = dp_data.get("ext_hit_rate", 0.0)
        row[f"ext_queries_{dp_key}"] = dp_data.get("ext_queries", 0)
        row[f"ext_hits_{dp_key}"] = dp_data.get("ext_hits", 0)
    agg = hit_rate.get("aggregated", {})
    row["hbm_hit_rate_total"] = agg.get("hbm_hit_rate", 0.0)
    row["hbm_queries_total"] = agg.get("hbm_queries", 0)
    row["hbm_hits_total"] = agg.get("hbm_hits", 0)
    row["ext_hit_rate_total"] = agg.get("ext_hit_rate", 0.0)
    row["ext_queries_total"] = agg.get("ext_queries", 0)
    row["ext_hits_total"] = agg.get("ext_hits_total", agg.get("ext_hits", 0))
    row["warnings"] = warnings
    return row


def write_results(row: Dict, run_dir: str) -> tuple[str, str]:
    """Append row to results/prefix_bench_result.csv + .jsonl (header-merging CSV)."""
    import csv as _csv
    import json as _json
    import os

    res_dir = os.path.join(run_dir, "results")
    os.makedirs(res_dir, exist_ok=True)
    csv_path = os.path.join(res_dir, "prefix_bench_result.csv")
    jsonl_path = os.path.join(res_dir, "prefix_bench_result.jsonl")

    if os.path.exists(csv_path):
        with open(csv_path, "r", encoding="utf-8", newline="") as f:
            reader = _csv.reader(f)
            existing_headers = next(reader)
        new_cols = [k for k in row if k not in existing_headers]
        all_headers = existing_headers + new_cols
        with open(csv_path, "r", encoding="utf-8", newline="") as f:
            existing_rows = list(_csv.DictReader(f))
        with open(csv_path, "w", encoding="utf-8", newline="") as f:
            writer = _csv.DictWriter(f, fieldnames=all_headers, extrasaction="ignore")
            writer.writeheader()
            for old in existing_rows:
                writer.writerow(old)
            writer.writerow(row)
    else:
        with open(csv_path, "w", encoding="utf-8", newline="") as f:
            writer = _csv.DictWriter(f, fieldnames=list(row.keys()))
            writer.writeheader()
            writer.writerow(row)

    with open(jsonl_path, "a", encoding="utf-8") as f:
        _json.dump(row, f, ensure_ascii=False, default=str)
        f.write("\n")
    return csv_path, jsonl_path
