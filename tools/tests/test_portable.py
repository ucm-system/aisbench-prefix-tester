#!/usr/bin/env python3
"""Portable-exe end-to-end test: launch the portable, drive its embedded sidecar."""
import json
import subprocess
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(r"D:\Vibe_Workspace\AISBench_PrefixTest_Tools")
PORTABLE = Path(r"D:\pt-release\AISBenchPrefixTester-Portable.exe")
TOK = str(ROOT / "assets" / "model" / "Qwen3.5-0.8B")
DATA_DIR = Path.home() / "AISBenchPrefixTester"
PORT_FILE = DATA_DIR / "sidecar.port"
FAILED = []

def check(name, cond, extra=""):
    print(("PASS  " if cond else "FAIL  ") + name + (("  | " + extra) if extra and not cond else ""))
    if not cond:
        FAILED.append(name)

def kill_all():
    subprocess.run(["taskkill", "/F", "/IM", "AISBenchPrefixTester.exe", "/T"],
                   capture_output=True)
    subprocess.run(["taskkill", "/F", "/IM", "aisbench-sidecar.exe", "/T"],
                   capture_output=True)

kill_all()
time.sleep(2)
PORT_FILE.unlink(missing_ok=True)

print("[portable] launching", PORTABLE.name)
srv = subprocess.Popen([str(PORTABLE)], cwd=str(PORTABLE.parent))
try:
    t0 = time.time()
    info = None
    while time.time() - t0 < 180:
        if PORT_FILE.is_file():
            try:
                info = json.loads(PORT_FILE.read_text())
                r = httpx.get("http://127.0.0.1:%d/api/health" % info["port"],
                              headers={"Authorization": "Bearer " + info["token"]},
                              trust_env=False, timeout=5)
                if r.status_code == 200:
                    break
            except Exception:
                pass
        time.sleep(1)
    else:
        raise RuntimeError("portable sidecar not ready in 180s")
    c = httpx.Client(base_url="http://127.0.0.1:%d" % info["port"],
                     headers={"Authorization": "Bearer " + info["token"]},
                     trust_env=False, timeout=30)
    print("[portable] sidecar up in %.0fs" % (time.time() - t0))

    h = c.get("/api/health").json()
    check("P1 runtime=frozen", h.get("runtime") == "frozen", str(h))

    diag = c.get("/api/diagnosis").json()["items"]
    mode = next((i for i in diag if i["name"] == "运行模式"), {})
    ais = next((i for i in diag if "AISBench" in i["name"]), {})
    # honest-diagnosis contract: with an effective aisbench_command override the
    # mode item must say so; on a clean self-contained home it must claim 内置.
    override = (c.get("/api/settings").json().get("aisbench_command") or "").strip()
    expect_override = bool(override) and override != "ais_bench" and "--child-aisbench" not in override
    mode_d = mode.get("detail") or ""
    check("P2 运行模式声明自洽",
          ("已被自定义命令覆盖" in mode_d) if expect_override else ("自包含" in mode_d),
          f"cmd={override!r} | {mode}")
    check("P3 内置 AISBench ok", bool(ais.get("ok")), str(ais))

    toks = c.get("/api/tokenizers").json()
    check("P4 内置 tokenizer 资产", any(t["name"] in ("Qwen3.5-0.8B", "Qwen3-0.6B")
                                     for t in toks), str([t["name"] for t in toks])[:120])

    cfg = {"host_ip": "127.0.0.1", "host_port": 8091, "model_name": "mock-model",
           "tokenizer": TOK, "input_len": 128, "output_len": 8, "data_num": 8,
           "prefix_num": 2, "repeat_rate": 0.9, "concurrency": 2, "dp": 1,
           "pod_info": ["127.0.0.1:8091"], "rounds": [{}, {}]}
    rid = c.post("/api/runs", json={"config": cfg, "name": "portable-e2e"}).json()["run_id"]
    t0 = time.time()
    while time.time() - t0 < 300:
        d = c.get("/api/runs/" + rid).json()
        if d["status"] in ("completed", "failed", "cancelled"):
            break
        time.sleep(2)
    check("P5 mock 压测 completed", d["status"] == "completed", d["status"])
    check("P6 阶段行完整", len(d.get("rounds", [])) == 4, str(len(d.get("rounds", []))))
    logs = c.get("/api/runs/" + rid + "/logs?tail=30").json().get("lines", [])
    check("P7 日志可读", len(logs) > 0 and "Qwen3.5" not in "".join(logs)[:0] or len(logs) > 0, str(len(logs)))

    print("\n=== PORTABLE RESULT: %s (%d failed) ===" % ("PASS" if not FAILED else "FAIL", len(FAILED)))
    sys.exit(0 if not FAILED else 1)
finally:
    kill_all()
    time.sleep(2)
