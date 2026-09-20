#!/usr/bin/env python3
"""End-to-end acceptance for the packaged exe child mode (HANDOFF §5).

Starts the packaged sidecar exe with a dedicated --home, points
aisbench_command at `<exe> --child-aisbench`, runs one benchmark round
against the target service, then asserts:
  1. run status == completed
  2. stdout.log contains no PyInstaller bootstrap errors (PYI-...ERROR)
  3. AISBench per-task detail perf data was really produced
     (results/<ts>/performances/**/gsm8k_details.jsonl — the file the
     SUMM-FILE-001 error complained about)
  4. optional: HBM hit rate in the full phase is plausible (--min-hit)

Usage:
  py -3.11 tools/verify_exe_child.py --exe sidecar/dist/aisbench-sidecar/aisbench-sidecar.exe \
      --target-host 203.0.113.10 --target-port 8101 --model qwen3 --min-hit 0.3

Exit code 0 = all assertions passed.
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--exe", required=True)
    ap.add_argument("--target-host", required=True)
    ap.add_argument("--target-port", type=int, required=True)
    ap.add_argument("--model", default="qwen3")
    ap.add_argument("--tokenizer", default=r"D:\Models\Qwen3-0.6B")
    ap.add_argument("--input-len", type=int, default=4096)
    ap.add_argument("--output-len", type=int, default=32)
    ap.add_argument("--data-num", type=int, default=32)
    ap.add_argument("--prefix-num", type=int, default=4)
    ap.add_argument("--repeat-rate", default="0.9")
    ap.add_argument("--concurrency", type=int, default=8)
    ap.add_argument("--min-hit", type=float, default=None,
                    help="assert full-phase HBM hit rate >= this (e.g. 0.3)")
    ap.add_argument("--name", default="")
    ap.add_argument("--run-timeout", type=int, default=1800)
    ap.add_argument("--label", default="verify")
    args = ap.parse_args()

    exe = Path(args.exe).resolve()
    assert exe.is_file(), f"exe not found: {exe}"
    home = ROOT / f".exe-verify-home-{args.label}"
    if home.exists():
        shutil.rmtree(home)
    home.mkdir(parents=True)
    port_file = home / "sidecar.port"
    server_log = open(home / "exe-server.log", "w", encoding="utf-8")

    print(f"[verify] starting exe sidecar: {exe}")
    print(f"[verify] home: {home}")
    proc = subprocess.Popen(
        [str(exe), "--home", str(home), "--host", "127.0.0.1",
         "--port", "0", "--port-file", str(port_file)],
        stdout=server_log, stderr=subprocess.STDOUT)
    try:
        deadline = time.time() + 180
        while time.time() < deadline:
            if proc.poll() is not None:
                raise RuntimeError(f"exe exited early code={proc.returncode}; "
                                   f"see {server_log.name}")
            if port_file.is_file():
                break
            time.sleep(0.5)
        else:
            raise RuntimeError("port file never appeared")
        info = json.loads(port_file.read_text(encoding="utf-8"))
        base, token = f"http://127.0.0.1:{info['port']}", info["token"]
        c = httpx.Client(base_url=base, headers={"Authorization": f"Bearer {token}"},
                         trust_env=False, timeout=30)
        print(f"[verify] sidecar up on {base}")

        r = c.put("/api/settings", json={
            "aisbench_command": f"{exe} --child-aisbench"}).json()
        assert r.get("ok"), r
        print(f"[verify] aisbench_command = {exe} --child-aisbench")

        cfg = {
            "host_ip": args.target_host, "host_port": args.target_port,
            "model_name": args.model, "tokenizer": args.tokenizer,
            "input_len": args.input_len, "output_len": args.output_len,
            "data_num": args.data_num, "prefix_num": args.prefix_num,
            "repeat_rate": args.repeat_rate, "concurrency": args.concurrency,
            "dp": 1, "pod_info": [f"{args.target_host}:{args.target_port}"],
            "rounds": [{}],
        }
        run_id = c.post("/api/runs", json={"config": cfg, "name": args.name}
                        ).json()["run_id"]
        print(f"[verify] run started: {run_id}")

        t0, status = time.time(), None
        while time.time() - t0 < args.run_timeout:
            d = c.get(f"/api/runs/{run_id}").json()
            status = d["status"]
            if status in ("completed", "failed", "cancelled"):
                break
            time.sleep(3)
        print(f"[verify] run finished: status={status}")

        run_dir = home / "outputs" / run_id
        stdout_log = (run_dir / "stdout.log").read_text(encoding="utf-8",
                                                        errors="replace")
        pyi_lines = [ln for ln in stdout_log.splitlines()
                     if "PYI-" in ln and "ERROR" in ln]

        details = list(run_dir.glob("results/*/performances/*/gsm8k_details.jsonl"))
        bench_csv = run_dir / "results" / "prefix_bench_result.csv"

        full_rounds = [r for r in d.get("rounds", []) if r.get("phase") == "full"]
        hits = [(r.get("hit_rate") or {}).get("aggregated", {}).get("hbm_hit_rate")
                for r in full_rounds]

        checks = {
            "status_completed": status == "completed",
            "no_pyi_errors": not pyi_lines,
            "perf_details_produced": bool(details) and all(
                p.stat().st_size > 0 for p in details),
            "bench_csv_present": bench_csv.is_file(),
        }
        if args.min_hit is not None:
            checks["hbm_hit_rate_plausible"] = bool(hits) and all(
                h is not None and h >= args.min_hit for h in hits)

        print(json.dumps({
            "run_id": run_id, "status": status,
            "hbm_hit_rates_full": hits,
            "perf_detail_files": [str(p.relative_to(run_dir)) for p in details],
            "checks": checks,
        }, ensure_ascii=False, indent=2))
        if pyi_lines:
            print("[verify] PYI error lines:")
            for ln in pyi_lines[:5]:
                print("   ", ln[:200])

        ok = all(checks.values())
        print(f"[verify] {'PASS' if ok else 'FAIL'}")
        return 0 if ok else 1
    finally:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
        server_log.close()


if __name__ == "__main__":
    sys.exit(main())
