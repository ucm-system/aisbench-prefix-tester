"""Mock ais_bench CLI — a real mini benchmark client for pipeline testing.

Mimics the surface the sidecar runner depends on, but instead of pretending,
it actually drives the target service:
  1. Reads the injected model config (vllm_api_chat_temp.py) for host/port/url,
     batch_size (concurrency), max_out_len and stream mode.
  2. Reads the linked dataset (test.jsonl, GSM8K container) row texts.
  3. Sends the rows to /v1/chat/completions with the configured concurrency,
     streaming when configured.
  4. Emits an AISBench-style perf summary from *measured* latencies, whose
     lines the sidecar's parse_aisbench_log() can parse.

This makes the mock chain semantically real: warmup rows inject prefixes into
the mock vLLM cache, full rows hit it, and the collector measures it.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx


def read_model_config() -> dict:
    work = Path(os.environ.get("AISBENCH_PT_WORK", "."))
    cfg_path = work / "ais_bench/benchmark/configs/models/vllm_api/vllm_api_chat_temp.py"
    cfg = {"host_ip": "localhost", "host_port": 8000, "url": "", "batch_size": 8,
           "max_out_len": 128, "type": "VLLMCustomAPIChatStream"}
    if cfg_path.exists():
        text = cfg_path.read_text(encoding="utf-8")
        for key, pattern in (("host_ip", r'host_ip="([^"]*)"'),
                             ("host_port", r"host_port=(\d+)"),
                             ("url", r'url="([^"]*)"'),
                             ("batch_size", r"batch_size=(\d+)"),
                             ("max_out_len", r"max_out_len=(\d+)"),
                             ("type", r"type=(\w+)")):
            m = re.search(pattern, text)
            if m:
                cfg[key] = m.group(1) if key in ("host_ip", "url", "type") else int(m.group(1))
    return cfg


def read_dataset_rows() -> list[str]:
    work = Path(os.environ.get("AISBENCH_PT_WORK", "."))
    ds_path = work / "ais_bench/datasets/gsm8k/test.jsonl"
    rows = []
    if ds_path.exists():
        for line in ds_path.read_text(encoding="utf-8", errors="replace").splitlines():
            if not line.strip():
                continue
            try:
                rows.append(json.loads(line).get("question", ""))
            except json.JSONDecodeError:
                continue
    return rows or ["hello world, a plain fallback prompt for the mock benchmark"]


def send_one(client: httpx.Client, base: str, text: str, stream: bool,
             max_tokens: int, stats: dict) -> None:
    payload = {"model": "mock-model", "stream": stream, "max_tokens": max_tokens,
               "messages": [{"role": "user", "content": text}], "temperature": 0}
    t0 = time.perf_counter()
    first = None
    with client.stream("POST", f"{base}/v1/chat/completions", json=payload,
                       timeout=120.0) as resp:
        for line in resp.iter_lines():
            if first is None and line.strip():
                first = time.perf_counter() - t0
    if first is None:
        first = time.perf_counter() - t0
    stats["ttfts"].append(first)
    stats["e2e"].append(time.perf_counter() - t0)


def main() -> int:
    parser = argparse.ArgumentParser(prog="ais_bench(mock)")
    parser.add_argument("--models", default="")
    parser.add_argument("--datasets", default="")
    parser.add_argument("--mode", default="perf")
    parser.add_argument("--summarizer", default="default_perf")
    parser.add_argument("--work-dir", dest="work_dir", default="./outputs")
    parser.add_argument("--debug", action="store_true")
    parser.add_argument("--num-warmups", type=int, default=0)
    args, _unknown = parser.parse_known_args()

    cfg = read_model_config()
    rows = read_dataset_rows()
    concurrency = max(1, int(cfg["batch_size"]))
    max_tokens = max(1, min(int(cfg["max_out_len"]), 128))
    base = cfg["url"].rstrip("/") if cfg["url"] else f"http://{cfg['host_ip']}:{cfg['host_port']}"
    stream = "Stream" in cfg["type"]

    print(f"mock ais_bench: base={base} rows={len(rows)} concurrency={concurrency} "
          f"stream={stream} max_tokens={max_tokens}", flush=True)

    stats = {"ttfts": [], "e2e": []}
    started = time.time()
    done = 0
    with httpx.Client(trust_env=False) as client, \
            ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = [pool.submit(send_one, client, base, row, stream, max_tokens, stats)
                   for row in rows]
        for fut in futures:
            fut.result()
            done += 1
            if done % max(1, len(rows) // 4) == 0:
                print(f"processing: {done}/{len(rows)} requests completed", flush=True)
    duration_ms = (time.time() - started) * 1000

    ttfts = sorted(stats["ttfts"]) or [0.0]
    e2es = sorted(stats["e2e"]) or [0.0]

    def pct(vals, p):
        return vals[min(len(vals) - 1, int(len(vals) * p))]

    ttft_avg = sum(ttfts) / len(ttfts) * 1000
    ttft_p90 = pct(ttfts, 0.9) * 1000
    tpot_vals = [max(0.1, (e - f) * 1000 / max(1, max_tokens)) for e, f in zip(stats["e2e"], stats["ttfts"])]
    tpot_avg = sum(tpot_vals) / len(tpot_vals)
    tpot_p90 = pct(sorted(tpot_vals), 0.9)

    exp_dir = Path(args.work_dir) / time.strftime("%Y%m%d_%H%M%S")
    exp_dir.mkdir(parents=True, exist_ok=True)
    total_input = sum(max(1, len(r) // 4) for r in rows)
    summary_lines = [
        f"Current exp folder: {exp_dir.resolve()}",
        "-" * 72,
        f"{'Metric':<28}{'avg':>10}{'min':>10}{'p50':>10}{'p75':>10}{'p99':>10}{'p90':>10}",
        "-" * 72,
        f"{'TTFT (ms)':<28}{ttft_avg:>10.2f}{ttfts[0]*1000:>10.2f}"
        f"{pct(ttfts,0.5)*1000:>10.2f}{pct(ttfts,0.75)*1000:>10.2f}{pct(ttfts,0.99)*1000:>10.2f}{ttft_p90:>10.2f}",
        f"{'TPOT (ms)':<28}{tpot_avg:>10.2f}{min(tpot_vals):>10.2f}"
        f"{pct(sorted(tpot_vals),0.5):>10.2f}{pct(sorted(tpot_vals),0.75):>10.2f}{pct(sorted(tpot_vals),0.99):>10.2f}{tpot_p90:>10.2f}",
        "-" * 72,
        f"Total Requests: {len(rows)}",
        f"Max Concurrency: {concurrency}",
        f"Concurrency (measured): {len(rows) / max(0.001, duration_ms / 1000):.2f}",
        f"Benchmark Duration (ms): {duration_ms:.2f}",
        f"Output Token Throughput: {len(rows) * max_tokens / max(0.001, duration_ms / 1000):.2f} tok/s",
        f"Input Token Throughput: {total_input / max(0.001, duration_ms / 1000):.2f} tok/s",
        f"Total Token Throughput: {(total_input + len(rows) * max_tokens) / max(0.001, duration_ms / 1000):.2f} tok/s",
        f"Request Throughput: {len(rows) / max(0.001, duration_ms / 1000):.2f} req/s",
        f"InputTokens: {total_input}",
        f"OutputTokens: {len(rows) * max_tokens}",
    ]
    text = "\n".join(summary_lines)
    print(text, flush=True)
    (exp_dir / "log.txt").write_text(text + "\n", encoding="utf-8")
    print("mock ais_bench: done", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
