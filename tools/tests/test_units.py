"""Unit-level checks for sidecar modules (no server). Run: py -3.11 tools/tests/test_units.py"""
import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "sidecar"))

from app.dataset_gen import generate_dataset, preview_dataset  # noqa: E402
from app.result_parse import build_result_row, parse_aisbench_log  # noqa: E402
from app import metrics  # noqa: E402


def test_metrics_parsing():
    text = """
vllm:prefix_cache_queries_total{model_name="m",engine="0",worker_rank="0"} 100
vllm:prefix_cache_hits_total{model_name="m",engine="0",worker_rank="0"} 90
vllm:external_prefix_cache_queries_total{model_name="m",engine="1"} 50
vllm:external_prefix_cache_hits_total{model_name="m",engine="1"} 40
vllm:num_requests_running{model_name="m",engine="0"} 12
ucm:ucm_hit_tokens_total{model_name="m",engine="0"} 999
vllm:time_to_first_token_seconds_sum{engine="0"} 4.2
vllm:time_to_first_token_seconds_count{engine="0"} 30
"""
    parsed = metrics.parse_metrics_text(text)
    assert parsed[("0", "0")]["hbm_q"] == 100
    assert parsed[("0", "0")]["hbm_h"] == 90
    assert parsed[("1", "0")]["ext_q"] == 50
    assert parsed[("0", "0")]["ucm_hit_tok"] == 999
    assert parsed[("0", "0")]["_ucm_seen"] == 1.0
    assert abs(parsed[("0", "0")]["ttft_sum"] - 4.2) < 1e-9

    before = {("0", "0"): {"hbm_q": 100, "hbm_h": 90, "ext_q": 50, "ext_h": 40}}
    after = {("0", "0"): {"hbm_q": 200, "hbm_h": 180, "ext_q": 80, "ext_h": 70}}
    rate = metrics.compute_hit_rate(before, after)
    assert abs(rate["aggregated"]["hbm_hit_rate"] - 0.9) < 1e-6
    assert abs(rate["aggregated"]["ext_hit_rate"] - 1.0) < 1e-6
    assert "composite_hit_rate" in rate["aggregated"]
    print("metrics parsing + hit-rate diff OK")


def test_dataset(tokenizer: str):
    tmp = tempfile.mkdtemp()
    r = generate_dataset(tokenizer, input_len=128, number=8, save_path=tmp, dp=2,
                         repeat_rate=0.9, seed=42, prefix_num=4, mode="text")
    with open(r["dataset_path"], encoding="utf-8") as f:
        first = json.loads(f.readline())
    assert set(first) == {"question", "answer"} and first["answer"] == "none"
    rows = [json.loads(l)["question"] for l in open(r["dataset_path"], encoding="utf-8")]
    assert len(rows) == 8
    # with prefix_num=4: rows i and i+4 share the same prefix
    half = len(rows[0]) // 2
    assert rows[0][:half] == rows[4][:half], "rows with same prefix index must share text head"
    assert rows[0][:half] != rows[1][:half], "different prefix index must differ"
    stats = r["stats"]
    assert stats["drift"] < 0.05, stats
    print("dataset text-mode OK | sampled lengths:", stats["sampled_lengths"][:6],
          "| est_hit_rate:", stats["est_hit_rate"])

    r2 = generate_dataset(tokenizer, input_len=64, number=4, save_path=tmp, dp=1,
                          repeat_rate=0.8, seed=7, prefix_num=2, mode="tokenid")
    assert r2["stats"]["drift"] < 0.02
    print("dataset tokenid-mode OK | drift:", r2["stats"]["drift"])

    pv = preview_dataset(tokenizer, input_len=128, repeat_rate=0.9)
    expected_est = 0.9 * (1 - 3 / 128)  # rr × (1 − separator/input_len)
    assert abs(pv["est_hit_rate"] - expected_est) < 0.005
    print("preview OK | measured:", pv["measured_lengths"], "target:", pv["target"],
          "est:", pv["est_hit_rate"])


def test_log_parser():
    log = tempfile.mktemp(suffix=".log")
    Path(log).write_text(
        "Current exp folder: /x/y/20260920\n"
        "| TTFT (ms)   | 412.30 | 300.10 | 400.00 | 990.10 | 1500.20 | 1208.44 |\n"
        "| TPOT (ms)   | 55.20 | 40.10 | 52.00 | 88.40 | 110.20 | 60.50 |\n"
        "Total Requests: 160\n"
        "Max Concurrency: 40\n"
        "Concurrency (measured): 38.50\n"
        "Benchmark Duration (ms): 752000.00\n"
        "Output Token Throughput: 3214.50 tok/s\n"
        "Total Token Throughput: 99644.50 tok/s\n"
        "Request Throughput: 0.21 req/s\n"
        "InputTokens: 5242880\n"
        "OutputTokens: 81920\n", encoding="utf-8")
    perf, log_dir = parse_aisbench_log(log, "0", 1)
    assert log_dir == "/x/y/20260920"
    assert perf["ttft_avg_ms"] == 412.30 and perf["ttft_p90_ms"] == 1208.44, perf
    assert perf["tpot_avg_ms"] == 55.20 and perf["tpot_p90_ms"] == 60.50
    assert perf["total_requests"] == 160 and perf["max_concurrency"] == "40"
    assert perf["measured_concurrency"] == 38.50
    assert abs(perf["benchmark_duration_s"] - 752.0) < 0.01
    assert abs(perf["output_token_throughput"] - 3214.50) < 0.01
    assert perf["total_input_tokens"] == 5242880

    row = build_result_row(perf, {"per_dp": {"dp0": {
        "hbm_hit_rate": 0.9, "hbm_queries": 100, "hbm_hits": 90,
        "ext_hit_rate": 0.8, "ext_queries": 50, "ext_hits": 40}},
        "aggregated": {"hbm_hit_rate": 0.9, "hbm_queries": 100, "hbm_hits": 90,
                       "ext_hit_rate": 0.8, "ext_queries": 50, "ext_hits": 40}},
        {"test_name": "t", "input_len": 32768, "output_len": 512, "data_num": 160,
         "concurrency": 40, "request_rate": 0, "dp": 1, "prefix_num": 160,
         "repeat_rate": 0.9, "seed": 42, "model_path": "x", "host_ip": "h",
         "host_port": 8000, "url": "", "npu_num": 1}, phase="full")
    assert row["hbm_hit_rate_dp0"] == 0.9 and row["hbm_hit_rate_total"] == 0.9
    print("log parser + result row OK")


if __name__ == "__main__":
    test_metrics_parsing()
    tok = sys.argv[1] if len(sys.argv) > 1 else r"D:\Models\Qwen3-32B"
    test_dataset(tok)
    test_log_parser()
    print("ALL UNIT CHECKS PASSED")
