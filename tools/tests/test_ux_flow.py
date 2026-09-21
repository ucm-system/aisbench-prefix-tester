"""UX v0.2 redesign end-to-end flow (source-mode sidecar + mock vllm @8091).

Walks the exact API surface the redesigned UI depends on:
  1. 发起: POST /api/runs (2 rounds) with mock aisbench command
  2. 监控: WS status/metrics events; replay via /metrics + /events journal
     (phase boundaries with ts — the C2 replay source); adaptive sample
     carries the `active` flag (U5.3)
  3. 记录: list/detail; soft-delete → hidden; restore → visible;
     purge → rows + artifacts gone (D1 undo window contract)
  4. 对比: /api/compare of two runs + xlsx export (PK header)

Run: py -3.11 tools/tests/test_ux_flow.py   (mock vllm must be up on 8091)
"""
import asyncio
import json
import os
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
MOCK_PORT = 8091
TOKENIZER = r"D:\Models\Qwen3-32B"

FAILURES = []


def check(name: str, ok: bool, detail: str = ""):
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  [{detail}]" if detail else ""))
    if not ok:
        FAILURES.append(name)


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


def run_cfg(name: str, rounds: int = 2):
    return {
        "host_ip": "127.0.0.1", "host_port": MOCK_PORT,
        "model_name": "mock-model", "model_path": TOKENIZER,
        "tokenizer": TOKENIZER,
        "input_len": 96, "output_len": 8, "data_num": 6, "prefix_num": 2,
        "concurrency": 3, "request_rate": 0, "dp": 1, "seed": 42,
        "repeat_rate": "90%", "test_name": name,
        "pod_info": [f"127.0.0.1:{MOCK_PORT}"],
        "cache_reset": "each_round", "collection_interval": 1.0,
        "rounds": [{"test_name": f"{name}-R1"}, {"test_name": f"{name}-R2"}][:rounds],
    }


async def wait_terminal(api: httpx.AsyncClient, run_id: str, timeout=180):
    t0 = time.time()
    while time.time() - t0 < timeout:
        d = (await api.get(f"/api/runs/{run_id}")).json()
        if d["status"] in ("completed", "failed", "cancelled"):
            return d
        await asyncio.sleep(1.5)
    raise TimeoutError(f"run {run_id} not terminal")


async def main() -> int:
    home = tempfile.mkdtemp(prefix="aisbench_ux_flow_")
    port_file = Path(home) / "sidecar.port"
    logs = []
    sidecar = start_proc([PY, "-m", "app.main", "--home", home,
                          "--port-file", str(port_file)],
                         env={"PYTHONPATH": str(SIDECAR)}, cwd=str(SIDECAR))
    import threading
    threading.Thread(target=drain, args=(sidecar, logs), daemon=True).start()
    try:
        info = await wait_port_file(port_file)
        base = f"http://127.0.0.1:{info['port']}"
        headers = {"Authorization": f"Bearer {info['token']}"}
        async with httpx.AsyncClient(base_url=base, headers=headers, trust_env=False,
                                     timeout=30) as api:
            mock_cmd = str(ROOT / "tools" / "mock_aisbench.py")
            await api.put("/api/settings", json={"aisbench_command": f"{PY} {mock_cmd}"})

            # ---- 1. 发起（含 WS 监控事件） ----
            cfg = run_cfg("ux-flow-run")
            r = (await api.post("/api/runs", json={"config": cfg, "name": "ux-flow-run"})).json()
            rid = r["run_id"]
            ws = await websockets.connect(
                f"ws://127.0.0.1:{info['port']}/ws/runs/{rid}?token={info['token']}")
            status_events, metrics_events = [], []
            async def collect_ws():
                try:
                    while True:
                        ev = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
                        if ev["type"] == "status":
                            status_events.append(ev)
                        elif ev["type"] == "metrics":
                            metrics_events.append(ev)
                except (asyncio.TimeoutError, websockets.ConnectionClosed):
                    pass
            ws_task = asyncio.create_task(collect_ws())
            d = await wait_terminal(api, rid)
            await asyncio.sleep(0.5)
            ws_task.cancel()
            check("F1 run 完成", d["status"] == "completed", d["status"])
            check("F1 轮次=2", len(d["rounds"]) == 4, f"{len(d['rounds'])} 阶段行")
            check("F1 WS status 事件含 phase 边界",
                  any(e.get("phase") == "warmup" for e in status_events)
                  and any(e.get("phase") == "full" for e in status_events),
                  f"{len(status_events)} status 事件")
            check("F1 WS metrics 事件", len(metrics_events) >= 2, f"{len(metrics_events)}")

            # ---- 2. 监控回放数据源 ----
            ev2 = (await api.get(f"/api/runs/{rid}/events")).json()["events"]
            check("F2 事件日志回放（阶段边界带 ts）",
                  any(e["type"] == "status" and e.get("phase") == "warmup" for e in ev2)
                  and any(e["type"] == "status" and e.get("phase") == "full" for e in ev2)
                  and all("ts" in e for e in ev2 if e["type"] == "status"),
                  f"{len(ev2)} 条")
            check("F2 cache_reset 事件已落盘",
                  any(e["type"] == "cache_reset" for e in ev2))
            samples = (await api.get(f"/api/runs/{rid}/metrics")).json()["samples"]
            check("F2 回放样本含 engines", len(samples) >= 2 and
                  all("engines" in s for s in samples), f"{len(samples)} 样本")
            check("F2 自适应采样 active 标记",
                  all("active" in s for s in samples))
            logs_r = (await api.get(f"/api/runs/{rid}/logs?tail=50")).json()
            check("F2 stdout 日志回放", len(logs_r["lines"]) > 0)
            stderr_r = (await api.get(f"/api/runs/{rid}/logs?stream=stderr&tail=50")).json()
            check("F2 stderr 端点可用", "lines" in stderr_r)

            # ---- 3. 记录列表 + 软删除/撤销/清除 ----
            runs = (await api.get("/api/runs?kind=manual")).json()
            check("F3 列表含新 run", any(x["run_id"] == rid for x in runs))
            tr = (await api.post("/api/runs/trash", json={"run_ids": [rid]})).json()
            check("F3 软删除生效", rid in tr["deleted"])
            runs = (await api.get("/api/runs?kind=manual")).json()
            check("F3 软删除后列表隐藏", not any(x["run_id"] == rid for x in runs))
            trash_list = (await api.get("/api/runs/trash")).json()
            check("F3 回收站列表", any(x["run_id"] == rid for x in trash_list))
            rr = (await api.post("/api/runs/restore", json={"run_ids": [rid]})).json()
            check("F3 撤销恢复", rid in rr["restored"])
            runs = (await api.get("/api/runs?kind=manual")).json()
            check("F3 恢复后列表可见", any(x["run_id"] == rid for x in runs))
            await api.post("/api/runs/trash", json={"run_ids": [rid]})
            pr = (await api.post("/api/runs/purge", json={"run_ids": [rid]})).json()
            check("F3 清除（硬删）", rid in pr["purged"])
            check("F3 清除后输出目录删除",
                  not (Path(home) / "outputs" / rid).exists())

            # ---- 4. 对比 + 导出 ----
            r1 = (await api.post("/api/runs", json={"config": run_cfg("ux-flow-a", 1), "name": "ux-flow-a"})).json()
            d1 = await wait_terminal(api, r1["run_id"])
            r2 = (await api.post("/api/runs", json={"config": {**run_cfg("ux-flow-b", 1), "concurrency": 2}, "name": "ux-flow-b"})).json()
            d2 = await wait_terminal(api, r2["run_id"])
            check("F4 两个 run 完成",
                  d1["status"] == "completed" and d2["status"] == "completed")
            cmp = (await api.post("/api/compare", json={
                "run_ids": [r1["run_id"], r2["run_id"]],
                "exclude_warmup": True, "exclude_practice": True})).json()
            check("F4 对比含指标与 Δ",
                  "ttft_avg_ms" in cmp["metrics"]
                  and r2["run_id"] in cmp["metrics"]["ttft_avg_ms"]["deltas"])
            check("F4 对比含配置差异",
                  any(row["diff"] for row in cmp["config_diff"]))
            xr = await api.get(f"/api/compare/export?format=xlsx&run_ids={r1['run_id']},{r2['run_id']}")
            check("F4 xlsx 导出（PK 头）", xr.status_code == 200 and xr.content[:2] == b"PK")

        print(f"\n=== UX FLOW RESULT: {'PASS' if not FAILURES else 'FAIL'} ({len(FAILURES)} failed) ===")
        if FAILURES:
            print("failed:", "; ".join(FAILURES))
        return 0 if not FAILURES else 1
    finally:
        if sidecar.poll() is None:
            sidecar.terminate()
            try:
                sidecar.wait(timeout=10)
            except subprocess.TimeoutExpired:
                sidecar.kill()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
