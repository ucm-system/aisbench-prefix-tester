#!/usr/bin/env python3
"""Prefix Tester CLI — thin client for the sidecar API, built for agents.

Usage:
  python pt.py --port-file PATH <command> [args]
  python pt.py --host 127.0.0.1:8180 --token TOKEN <command> [args]

Commands:
  health                          sidecar health
  probe HOST PORT                 probe a vLLM service (models/metrics/UCM)
  run --host H --port P [--key VALUE ...]   start a test run
  wait RUN_ID [TIMEOUT]           block until a run finishes, print result
  runs [STATUS]                   list runs
  show RUN_ID                     run detail (rounds/metrics/hit rates)
  compare RUN_ID1 RUN_ID2 [...]   compare runs (JSON)
  export RUN_ID [xlsx|html]       export a report
  sla --host H --port P --ttft-p90 2000 [--tpot-avg 50] [--key VALUE ...]
                                  SLA auto-tune (max concurrency within SLA)
  sla-wait JOB_ID [TIMEOUT]       block until SLA tuning finishes

Common run/sla --key options: tokenizer input_len output_len data_num
prefix_num repeat_rate dp seed concurrency pod_info model_name cache_reset
per_round_seed_offset collection_interval
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import httpx

INT_KEYS = {"host_port", "input_len", "output_len", "data_num", "prefix_num",
            "dp", "seed", "concurrency", "request_rate", "npu_num",
            "start_concurrency", "max_concurrency", "collection_interval"}


def client(args) -> httpx.Client:
    if args.port_file:
        info = json.loads(Path(args.port_file).read_text())
        base, token = f"http://127.0.0.1:{info['port']}", info["token"]
    else:
        base, token = args.host.rstrip("/"), args.token
    return httpx.Client(base_url=base, headers={"Authorization": f"Bearer {token}"},
                        trust_env=False, timeout=30)


def kv_pairs(values) -> dict:
    out = {}
    for kv in values or []:
        k, _, v = kv.partition("=")
        if k in INT_KEYS or (v.lstrip("-").isdigit() and k != "test_name"):
            out[k] = int(v)
        else:
            out[k] = v
    return out


def wait_run(c, run_id, timeout):
    t0 = time.time()
    while time.time() - t0 < timeout:
        d = c.get(f"/api/runs/{run_id}").json()
        if d["status"] in ("completed", "failed", "cancelled"):
            return d
        time.sleep(3)
    return c.get(f"/api/runs/{run_id}").json()


def print_run(d):
    print(f"run {d['run_id']} [{d['status']}] {d.get('name','')}")
    for r in d.get("rounds", []):
        a = (r.get("hit_rate") or {}).get("aggregated", {})
        m = r.get("metrics", {})
        print(f"  R{r['round_index']} {r['phase']:6s} hbm={a.get('hbm_hit_rate',0):.4f} "
              f"ext={a.get('ext_hit_rate',0):.4f} ttft={m.get('ttft_avg_ms',-1):.0f}ms "
              f"thr={m.get('output_token_throughput',-1):.0f}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--port-file", default=".sidecar.port")
    g.add_argument("--host", default=None)
    ap.add_argument("--token", default="")
    ap.add_argument("--timeout", type=int, default=3600, help="wait timeout seconds")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("health", "runs", "diagnosis"):
        sub.add_parser(name)
    sp = sub.add_parser("probe"); sp.add_argument("host"); sp.add_argument("port", type=int)
    sp = sub.add_parser("run"); sp.add_argument("--host", dest="tgt_host", required=True)
    sp.add_argument("--port", dest="tgt_port", type=int, required=True)
    sp.add_argument("--name", default=""); sp.add_argument("--wait", action="store_true")
    sp.add_argument("kv", nargs="*", help="key=value pairs")
    sub.add_parser("wait").add_argument("run_id")
    sub.add_parser("show").add_argument("run_id")
    sub.add_parser("compare").add_argument("run_ids", nargs="+")
    sp = sub.add_parser("export"); sp.add_argument("run_id"); sp.add_argument("fmt", nargs="?", default="xlsx")
    sp = sub.add_parser("sla"); sp.add_argument("--host", dest="tgt_host", required=True)
    sp.add_argument("--port", dest="tgt_port", type=int, required=True)
    sp.add_argument("--ttft-p90", type=float, default=None)
    sp.add_argument("--tpot-avg", type=float, default=None)
    sp.add_argument("--start", type=int, default=4)
    sp.add_argument("--max", type=int, default=128)
    sp.add_argument("kv", nargs="*", help="key=value pairs (dataset config)")
    sub.add_parser("sla-wait").add_argument("job_id")
    args = ap.parse_args()

    c = client(args)
    if args.cmd == "health":
        print(c.get("/api/health").json())
    elif args.cmd == "diagnosis":
        for i in c.get("/api/diagnosis").json()["items"]:
            print(("OK  " if i["ok"] else "FAIL"), i["name"], "-", i["detail"])
    elif args.cmd == "probe":
        r = c.post("/api/probe", json={"host": args.host, "port": args.port}).json()
        print(json.dumps(r, ensure_ascii=False))
    elif args.cmd == "runs":
        for r in c.get("/api/runs").json():
            print(r["run_id"], r["status"], r.get("name", ""),
                  json.dumps(r.get("summary") or {}, ensure_ascii=False))
    elif args.cmd == "run":
        cfg = {"host_ip": args.tgt_host, "host_port": args.tgt_port, "rounds": [{}]}
        cfg.update(kv_pairs(args.kv))
        pod = cfg.get("pod_info")
        if isinstance(pod, str):
            cfg["pod_info"] = [x for x in pod.replace(";", ",").split(",") if x]
        rid = c.post("/api/runs", json={"config": cfg, "name": args.name}).json()["run_id"]
        print("started", rid)
        if args.wait:
            print_run(wait_run(c, rid, args.timeout))
        else:
            print(rid)
    elif args.cmd == "wait":
        print_run(wait_run(c, args.run_id, args.timeout))
    elif args.cmd == "show":
        print(json.dumps(c.get(f"/api/runs/{args.run_id}").json(), ensure_ascii=False, indent=2, default=str))
    elif args.cmd == "compare":
        print(json.dumps(c.post("/api/compare", json={"run_ids": args.run_ids}).json(),
                         ensure_ascii=False, indent=2, default=str))
    elif args.cmd == "export":
        r = c.get(f"/api/runs/{args.run_id}/export?format={args.fmt}")
        print(json.dumps(r.json(), ensure_ascii=False) if r.headers.get("content-type", "").startswith("application/json") else r.status_code)
    elif args.cmd == "sla":
        cfg = {"host_ip": args.tgt_host, "host_port": args.tgt_port, "rounds": [{}]}
        cfg.update(kv_pairs(args.kv))
        pod = cfg.get("pod_info")
        if isinstance(pod, str):
            cfg["pod_info"] = [x for x in pod.replace(";", ",").split(",") if x]
        sla = {}
        if args.ttft_p90: sla["ttft_p90_ms"] = args.ttft_p90
        if args.tpot_avg: sla["tpot_avg_ms"] = args.tpot_avg
        job = c.post("/api/sla/start", json={"config": cfg, "sla": sla,
                                             "start_concurrency": args.start,
                                             "max_concurrency": args.max}).json()
        print("sla job", job["job_id"])
        t0 = time.time()
        while time.time() - t0 < args.timeout:
            j = c.get(f"/api/sla/{job['job_id']}").json()
            if j["state"] in ("done", "failed", "cancelled"):
                break
            time.sleep(3)
        print(json.dumps(j, ensure_ascii=False, indent=2))
    elif args.cmd == "sla-wait":
        t0 = time.time()
        while time.time() - t0 < args.timeout:
            j = c.get(f"/api/sla/{args.job_id}").json()
            if j["state"] in ("done", "failed", "cancelled"):
                break
            time.sleep(3)
        print(json.dumps(j, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    sys.exit(main())
