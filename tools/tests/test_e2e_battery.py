#!/usr/bin/env python3
"""End-to-end battery against the PACKAGED sidecar exe (frozen) + mock vllm.

Scenarios:
  A  frozen diagnosis (runtime=frozen, bundled ais_bench/tokenizers)
  B  tokenizer registry + offline verify (bundled assets inside the exe)
  C  multi-round run (3 rounds, cache_reset=each_round) -> 6 ordered phase rows
  D  cancel mid-run -> cancelled
  E  export xlsx (PK magic) + html
  F  compare two runs + compare-export xlsx
  G  SLA end-to-end (loose threshold) -> max_ok == max, kind=sla runs recorded
  H  persistence across sidecar restart (settings + history)
  I  cleanup delete-batch

Usage: py -3.11 tools/tests/test_e2e_battery.py [--exe PATH]
Default exe: sidecar/dist/aisbench-sidecar/aisbench-sidecar.exe
"""
import argparse
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[2]
MOCK = "http://127.0.0.1:8091"
FAILED = []


def check(name: str, cond: bool, extra: str = ""):
    print(("PASS  " if cond else "FAIL  ") + name + (("  | " + extra) if extra and not cond else ""))
    if not cond:
        FAILED.append(name)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--exe", default=str(ROOT / "sidecar" / "dist" / "aisbench-sidecar" / "aisbench-sidecar.exe"))
    args = ap.parse_args()
    exe = Path(args.exe)
    assert exe.is_file(), f"exe not found: {exe}"

    home = Path(tempfile.mkdtemp(prefix="pt_e2e_battery_"))
    port_file = home / "sidecar.port"
    server_log = open(home / "server.log", "w", encoding="utf-8")
    srv = subprocess.Popen([str(exe), "--home", str(home), "--host", "127.0.0.1",
                            "--port", "0", "--port-file", str(port_file)],
                           stdout=server_log, stderr=subprocess.STDOUT)
    c = None

    def start_sidecar():
        return subprocess.Popen([str(exe), "--home", str(home), "--host", "127.0.0.1",
                                 "--port", "0", "--port-file", str(port_file)],
                                stdout=server_log, stderr=subprocess.STDOUT)

    def wait_ready(timeout=180):
        t0 = time.time()
        while time.time() - t0 < timeout:
            if port_file.is_file():
                try:
                    info = json.loads(port_file.read_text())
                    r = httpx.get("http://127.0.0.1:%d/api/health" % info["port"],
                                  headers={"Authorization": "Bearer " + info["token"]},
                                  trust_env=False, timeout=5)
                    if r.status_code == 200:
                        return info
                except Exception:
                    pass
            time.sleep(0.5)
        raise RuntimeError("sidecar not ready")

    def client():
        return httpx.Client(base_url="http://127.0.0.1:%d" % c["port"],
                            headers={"Authorization": "Bearer " + c["token"]},
                            trust_env=False, timeout=30)

    def wait_run(rid, timeout=600):
        t0 = time.time()
        while time.time() - t0 < timeout:
            d = cl.get("/api/runs/" + rid).json()
            if d["status"] in ("completed", "failed", "cancelled"):
                return d
            time.sleep(2)
        raise RuntimeError("run timeout " + rid)

    try:
        c = wait_ready()
        cl = client()
        tok_path = str(ROOT / "assets" / "model" / "Qwen3.5-0.8B")

        # ---- A: frozen diagnosis ----
        diag = cl.get("/api/diagnosis").json()["items"]
        mode = next((i for i in diag if i["name"] == "运行模式"), {})
        ais = next((i for i in diag if "AISBench" in i["name"]), {})
        health = cl.get("/api/health").json()
        check("A1 runtime=frozen", health.get("runtime") == "frozen", str(health))
        check("A2 自包含模式声明", "自包含" in (mode.get("detail") or ""), str(mode))
        check("A3 内置 AISBench ok", bool(ais.get("ok")), str(ais))

        # ---- B: tokenizer registry + verify ----
        toks = cl.get("/api/tokenizers").json()
        names = {t["name"] for t in toks}
        check("B1 assets tokenizer 注册", "Qwen3.5-0.8B" in names or "Qwen3-0.6B" in names, str(names)[:120])
        v = cl.post("/api/tokenizers/verify", json={"name_or_path": "Qwen3.5-0.8B"}).json()
        check("B2 tokenizer 离线 verify", v.get("ok") and v.get("vocab_size", 0) > 100000, str(v)[:150])

        # ---- C: multi-round (3 rounds, reset each round) ----
        cfg = {"host_ip": "127.0.0.1", "host_port": 8091, "model_name": "mock-model",
               "tokenizer": tok_path, "input_len": 128, "output_len": 8,
               "data_num": 8, "prefix_num": 2, "repeat_rate": 0.9, "concurrency": 2,
               "dp": 1, "pod_info": ["127.0.0.1:8091"], "cache_reset": "each_round",
               "rounds": [{}, {}, {}]}
        rid1 = cl.post("/api/runs", json={"config": cfg, "name": "e2e-multi3"}).json()["run_id"]
        d1 = wait_run(rid1)
        rows = d1.get("rounds", [])
        check("C1 多轮 completed", d1["status"] == "completed", d1["status"])
        check("C2 六个阶段行", len(rows) == 6, str(len(rows)))
        order = [(r["round_index"], r["phase"]) for r in rows]
        check("C3 阶段时序正确", order == [(1, "warmup"), (1, "full"), (2, "warmup"),
                                        (2, "full"), (3, "warmup"), (3, "full")], str(order))
        logs = cl.get(f"/api/runs/{rid1}/logs?tail=50").json().get("lines", [])
        check("C4 日志回填非空", len(logs) > 0, str(len(logs)))

        # ---- D: cancel mid-run ----
        big = dict(cfg, data_num=64, input_len=1024, rounds=[{}], cache_reset="never")
        rid2 = cl.post("/api/runs", json={"config": big, "name": "e2e-cancel"}).json()["run_id"]
        time.sleep(4)
        cl.post(f"/api/runs/{rid2}/stop")
        t0 = time.time()
        while time.time() - t0 < 60:
            dd = cl.get(f"/api/runs/{rid2}").json()
            if dd["status"] in ("cancelled", "completed", "failed"):
                break
            time.sleep(1)
        check("D1 停止后状态 cancelled", dd["status"] == "cancelled", dd["status"])

        # ---- E: export ----
        x = cl.get(f"/api/runs/{rid1}/export?format=xlsx").content
        h = cl.get(f"/api/runs/{rid1}/export?format=html").content
        check("E1 xlsx 有效 (PK)", x[:2] == b"PK" and len(x) > 1000, str(len(x)))
        check("E2 html 有效", b"<html" in h[:400].lower() and len(h) > 1000, str(len(h)))

        # ---- F: compare two runs ----
        rid3 = cl.post("/api/runs", json={"config": cfg, "name": "e2e-second"}).json()["run_id"]
        wait_run(rid3)
        cmp = cl.post("/api/compare", json={"run_ids": [rid1, rid3],
                                            "exclude_warmup": True,
                                            "exclude_practice": True}).json()
        check("F1 compare 两个 run", len(cmp.get("runs", [])) == 2 and "metrics" in cmp, str(list(cmp))[:80])
        cx = cl.get(f"/api/compare/export?format=xlsx&run_ids={rid1},{rid3}").content
        check("F2 compare 导出 xlsx", cx[:2] == b"PK", str(len(cx)))

        # ---- G: SLA end-to-end (loose threshold -> hits max) ----
        sla_cfg = {"host_ip": "127.0.0.1", "host_port": 8091, "model_name": "mock-model",
                   "tokenizer": tok_path, "input_len": 128, "output_len": 8,
                   "data_num": 8, "prefix_num": 2, "repeat_rate": 0.9,
                   "concurrency": 2, "dp": 1, "pod_info": ["127.0.0.1:8091"],
                   "seed": 42, "test_name": "e2e-sla"}
        j = cl.post("/api/sla/start", json={"config": sla_cfg,
                                            "sla": {"ttft_p90": 60000, "tpot_avg": 5000},
                                            "start_concurrency": 2, "max_concurrency": 4}).json()
        t0 = time.time()
        while time.time() - t0 < 600:
            sj = cl.get("/api/sla/" + j["job_id"]).json()
            if sj["state"] in ("done", "failed", "cancelled", "interrupted"):
                break
            time.sleep(2)
        check("G1 SLA job done", sj["state"] == "done", str(sj))
        check("G2 max_ok == 上限", sj.get("max_ok") == 4, str(sj.get("max_ok")))
        sla_runs = cl.get("/api/runs?kind=sla").json()
        check("G3 SLA 探针入库 kind=sla", len(sla_runs) >= 2, str(len(sla_runs)))
        check("G4 探针带 run_id 溯源", all(p.get("run_id") for p in sj["probes"]), "")

        # ---- H: persistence across restart ----
        cl.put("/api/settings", json={"collection_interval": "7"})
        runs_before = len(cl.get("/api/runs").json())
        srv.terminate()
        srv.wait(timeout=15)
        port_file.unlink(missing_ok=True)
        srv = start_sidecar()
        c = wait_ready()
        cl = client()
        s = cl.get("/api/settings").json()
        check("H1 设置跨重启保留", s.get("collection_interval") == "7", str(s))
        runs_after = len(cl.get("/api/runs").json())
        check("H2 历史跨重启保留", runs_after >= runs_before, f"{runs_before}->{runs_after}")

        # ---- I: cleanup ----
        all_ids = [r["run_id"] for r in cl.get("/api/runs").json()]
        r = cl.post("/api/runs/delete-batch", json={"run_ids": all_ids}).json()
        check("I1 批量删除全部", len(r["deleted"]) == len(all_ids), str(r))
        check("I2 删除后列表为空", cl.get("/api/runs").json() == [])

        print("\n=== BATTERY RESULT: %s (%d failed) ===" % (
            "PASS" if not FAILED else "FAIL", len(FAILED)))
        if FAILED:
            print("failed:", "; ".join(FAILED))
        return 0 if not FAILED else 1
    finally:
        if srv.poll() is None:
            srv.terminate()
            try:
                srv.wait(timeout=10)
            except subprocess.TimeoutExpired:
                srv.kill()
        server_log.close()


if __name__ == "__main__":
    sys.exit(main())
