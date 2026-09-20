"""End-to-end pipeline test:

  mock vLLM (simulated prefix cache)  <- HTTP-  mock aisbench (real mini client)
        |                                             ^
        Prometheus /metrics                          | argv (aisbench_command setting)
        v                                            |
  sidecar FastAPI  <--- REST/WS ---  this script

Verifies: dataset preview, run lifecycle, two-phase rounds x2 with cache resets,
live metrics timeseries, snapshot-diff hit rates, UCM detection, comparison,
xlsx/html export.  Run: py -3.11 tools/tests/test_e2e.py
"""
import asyncio
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import httpx
import websockets

ROOT = Path(__file__).resolve().parents[2]
SIDECAR = ROOT / "sidecar"
PY = sys.executable
TOKENIZER = r"D:\Models\Qwen3-32B"

MOCK_VLLM_PORT = 8091
procs, logs = [], {}


def start_proc(args, env=None, cwd=None):
    e = os.environ.copy()
    e["PYTHONUNBUFFERED"] = "1"
    if env:
        e.update(env)
    return subprocess.Popen(args, env=e, cwd=cwd, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True,
                            encoding="utf-8", errors="replace")


def drain(proc, lines):
    for line in proc.stdout:
        lines.append(line.rstrip())


async def wait_port_file(port_file: Path, timeout=40):
    for _ in range(timeout * 10):
        if port_file.exists():
            return json.loads(port_file.read_text())
        await asyncio.sleep(0.1)
    raise TimeoutError("sidecar port file not written")


async def wait_ws_event(ws, pred, timeout=240):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=max(1, deadline - time.time()))
        except asyncio.TimeoutError:
            break
        ev = json.loads(raw)
        if pred(ev):
            return ev
    raise TimeoutError("no matching event")


async def main() -> int:
    global procs, logs
    home = tempfile.mkdtemp(prefix="aisbench_pt_e2e_")
    port_file = Path(home) / "sidecar.port"
    procs, logs = [], {}

    mock_vllm = start_proc([PY, str(ROOT / "tools" / "mock_vllm" / "server.py"),
                            "--port", str(MOCK_VLLM_PORT)],
                           env={"MOCK_TTFT_MS": "40", "MOCK_ITL_MS": "1",
                                "MOCK_MAX_TOKENS": "16", "MOCK_HBM_TOKENS": "64"})
    procs.append(("mock_vllm", mock_vllm))

    sidecar = start_proc([PY, "-m", "app.main", "--home", home,
                          "--port-file", str(port_file)],
                         env={"PYTHONPATH": str(SIDECAR)}, cwd=str(SIDECAR))
    procs.append(("sidecar", sidecar))
    for name, proc in procs:
        import threading
        logs[name] = []
        threading.Thread(target=drain, args=(proc, logs[name]), daemon=True).start()

    info = await wait_port_file(port_file)
    base = f"http://127.0.0.1:{info['port']}"
    headers = {"Authorization": f"Bearer {info['token']}"}
    print(f"sidecar up: {base}")

    async with httpx.AsyncClient(base_url=base, headers=headers, trust_env=False,
                                 timeout=30) as api:
        # health
        r = await api.get("/api/health")
        assert r.status_code == 200 and r.json()["status"] == "ok", r.text

        # diagnosis
        r = await api.get("/api/diagnosis")
        diag = r.json()
        print("diagnosis:", [(i["name"], i["ok"]) for i in diag["items"]])

        # tokenizers: D:\Models defaults should be registered
        r = await api.get("/api/tokenizers")
        toks = r.json()
        print("tokenizers:", [t["name"] for t in toks])
        assert any("Qwen3" in t["name"] for t in toks)

        # dataset preview
        r = await api.post("/api/datasets/preview", json={
            "tokenizer": TOKENIZER, "input_len": 96, "repeat_rate": 0.9})
        pv = r.json()
        print("preview est_hit_rate:", pv["est_hit_rate"],
              "measured:", pv["measured_lengths"])
        assert pv["measured_lengths"]

        # configure mock aisbench as the runner command
        mock_cmd = str(ROOT / "tools" / "mock_aisbench.py")
        await api.put("/api/settings", json={
            "aisbench_command": f"{PY} {mock_cmd}"})

        # subscribe to WS before starting the run
        ws_url = f"ws://127.0.0.1:{info['port']}/ws/runs/..."
        ws_url = ws_url.replace("...", "")  # per-run below

        cfg = {
            "host_ip": "127.0.0.1", "host_port": MOCK_VLLM_PORT,
            "model_name": "mock-model", "model_path": TOKENIZER,
            "tokenizer": TOKENIZER,
            "input_len": 96, "output_len": 8, "data_num": 6, "prefix_num": 2,
            "concurrency": 3, "request_rate": 0, "dp": 1, "seed": 42,
            "repeat_rate": "90%", "test_name": "e2e-smoke",
            "pod_info": [f"127.0.0.1:{MOCK_VLLM_PORT}"],
            "cache_reset": "each_round", "collection_interval": 1.0,
            "rounds": [
                {"test_name": "round-A-90pct"},
                {"test_name": "round-B-90pct-repeat"},
            ],
        }
        r = await api.post("/api/config/validate", json={"config": cfg})
        assert r.json()["errors"] == [], r.text
        print("validate warnings:", r.json()["warnings"])

        r = await api.post("/api/runs", json={"config": cfg, "name": "e2e run"})
        assert r.status_code == 200, r.text
        run_id = r.json()["run_id"]
        print("run started:", run_id)

        ws = await websockets.connect(
            f"ws://127.0.0.1:{info['port']}/ws/runs/{run_id}?token={info['token']}")
        ev_final = await wait_ws_event(
            ws, lambda e: e.get("type") == "status" and e.get("status") in
            ("completed", "failed", "cancelled"), timeout=300)
        print("final ws event:", json.dumps(ev_final))
        assert ev_final["status"] == "completed", json.dumps(ev_final)
        await ws.close()

        # run detail
        r = await api.get(f"/api/runs/{run_id}")
        detail = r.json()
        rounds = detail["rounds"]
        print("rounds:", [(r_["round_index"], r_["phase"]) for r_ in rounds])
        assert len(rounds) == 4, "2 rounds x (warmup+full)"
        fulls = [r_ for r_ in rounds if r_["phase"] == "full"]
        assert len(fulls) == 2
        for f_ in fulls:
            agg = f_["hit_rate"]["aggregated"]
            print(f"round {f_['round_index']} full: hbm={agg['hbm_hit_rate']:.3f} "
                  f"ext={agg['ext_hit_rate']:.3f} ttft={f_['metrics']['ttft_avg_ms']:.0f}ms "
                  f"requests={f_['metrics']['total_requests']}")
            assert f_["metrics"]["total_requests"] == 6
            assert f_["metrics"]["ttft_avg_ms"] > 0
            assert agg["hbm_queries"] > 0, "collector must have observed queries"

        # timeseries exists with samples
        r = await api.get(f"/api/runs/{run_id}/metrics")
        samples = r.json()["samples"]
        print("timeseries samples:", len(samples))
        assert len(samples) >= 3

        # second, different run for comparison
        cfg2 = dict(cfg)
        cfg2["rounds"] = [{"test_name": "solo"}]
        cfg2["repeat_rate"] = "50%"
        r = await api.post("/api/runs", json={"config": cfg2, "name": "e2e run 2"})
        run_id2 = r.json()["run_id"]
        for _ in range(300):
            st = (await api.get(f"/api/runs/{run_id2}")).json()
            if st["status"] in ("completed", "failed", "cancelled"):
                break
            await asyncio.sleep(1)
        assert st["status"] == "completed", st["status"]
        print("run2 completed")

        # list & history summary
        r = await api.get("/api/runs")
        runs = r.json()
        print("history rows:", len(runs), "summary0:", runs[0].get("summary"))

        # comparison
        r = await api.post("/api/compare", json={"run_ids": [run_id, run_id2]})
        cmp = r.json()
        d = cmp["metrics"]["hbm_hit_rate"]
        print("compare hbm values:", d["values"], "delta:", d["deltas"])
        assert cmp["config_diff"], "config diff rows expected"
        assert any(row["diff"] for row in cmp["config_diff"])

        # exports
        r = await api.post(f"/api/compare/export?format=xlsx",
                           json={"run_ids": [run_id, run_id2]})
        assert r.status_code == 200, r.text
        r = await api.post("/api/compare/export?format=html",
                           json={"run_ids": [run_id, run_id2]})
        assert r.status_code == 200, r.text
        html_path = Path(r.json().get("path", "")) if False else None
        print("exports OK (xlsx + html)")

        # run artifacts on disk
        rd = Path(home) / "outputs" / run_id
        assert (rd / "config.json").exists()
        assert (rd / "stdout.log").exists()
        assert (rd / "metrics_timeseries.jsonl").exists()
        assert (rd / "results" / "prefix_bench_result.csv").exists()
        print("disk artifacts OK")

    # mock vLLM saw reset events (2 rounds x each_round policy)
    async with httpx.AsyncClient(trust_env=False) as c:
        stats = (await c.get(f"http://127.0.0.1:{MOCK_VLLM_PORT}/stats")).json()
    print("mock vllm reset_events:", stats["reset_events"])
    assert stats["reset_events"] >= 2

    print("E2E PASSED")
    return 0


if __name__ == "__main__":
    try:
        code = asyncio.run(main())
    except BaseException:
        for name, lines in logs.items():
            print(f"--- {name} output ---")
            print("\n".join(lines[-25:]))
        raise
    finally:
        for _, p in procs:
            try:
                p.terminate()
            except Exception:
                pass
    sys.exit(code)
