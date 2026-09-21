"""R1/R2 修复的真实服务端到端验证。

- mock run（8091，UCM 分支）：饼图中心 ≤100%、无「指标不自洽」标注（R1.4）
- 真实 run（203.0.113.10:8101，2 轮）：KPI「理论 ≈9x%」不再 ×100（R2.1）、
  图表有路径且 y 刻度不塌缩（R2.4）
- 采样间隔分析：阶段窗口内中位间隔 ≈1s（R2.3 阶段驱动采样生效）

Run: py -3.11 tools/tests/ux_refix_verify.py
"""
import asyncio
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import httpx
import websockets

ROOT = Path(__file__).resolve().parents[2]
SIDECAR = ROOT / "sidecar"
UI_DIR = ROOT / "desktop" / "dist"
PY = sys.executable
MOCK_PORT = 8091
REAL_HOST, REAL_PORT = "203.0.113.10", 8101
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
CDP_PORT = 9335

FAILURES = []


def check(name, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  [{detail}]" if detail else ""))
    if not ok:
        FAILURES.append(name)


class Cdp:
    def __init__(self, ws):
        self.ws = ws
        self.id = 0
        self.events = []  # console/exception events seen between commands

    async def send(self, method, params=None):
        self.id += 1
        await self.ws.send(json.dumps({"id": self.id, "method": method, "params": params or {}}))
        while True:
            msg = json.loads(await self.ws.recv())
            if msg.get("id") == self.id:
                if "error" in msg:
                    raise RuntimeError(f"CDP {method}: {msg['error']}")
                return msg.get("result", {})
            if msg.get("method") in ("Runtime.exceptionThrown", "Runtime.consoleAPICalled"):
                self.events.append(msg)

    async def eval(self, expr):
        r = await self.send("Runtime.evaluate", {"expression": expr, "returnByValue": True})
        return r.get("result", {}).get("value")

    async def goto(self, url, wait_s=6.0):
        await self.send("Page.navigate", {"url": url})
        await asyncio.sleep(wait_s)


async def wait_port_file(port_file, timeout=40):
    for _ in range(timeout * 10):
        if port_file.exists():
            return json.loads(port_file.read_text())
        await asyncio.sleep(0.1)
    raise TimeoutError("sidecar port file not written")


def mock_cfg():
    return {
        "host_ip": "127.0.0.1", "host_port": MOCK_PORT,
        "model_name": "mock-model", "tokenizer": "Qwen3-0.6B",
        "input_len": 96, "output_len": 8, "data_num": 6, "prefix_num": 2,
        "concurrency": 3, "request_rate": 0, "dp": 1, "seed": 42,
        "repeat_rate": "90%", "test_name": "refix-mock",
        "pod_info": [f"127.0.0.1:{MOCK_PORT}"],
        "collection_interval": 5.0, "rounds": [{}],
    }


def real_cfg():
    return {
        "host_ip": REAL_HOST, "host_port": REAL_PORT,
        "model_name": "qwen3", "tokenizer": "Qwen3-0.6B",
        "input_len": 2048, "output_len": 32, "data_num": 16, "prefix_num": 4,
        "concurrency": 8, "request_rate": 0, "dp": 1, "seed": 42,
        "repeat_rate": "90%", "test_name": "refix-real",
        "pod_info": [f"{REAL_HOST}:{REAL_PORT}"],
        "collection_interval": 5.0,
        "rounds": [{"test_name": "refix-real-R1"}, {"test_name": "refix-real-R2"}],
    }


async def wait_terminal(api, run_id, timeout=900):
    t0 = time.time()
    while time.time() - t0 < timeout:
        d = (await api.get(f"/api/runs/{run_id}")).json()
        if d["status"] in ("completed", "failed", "cancelled"):
            return d
        await asyncio.sleep(2)
    raise TimeoutError(f"run {run_id} not terminal")


async def main():
    mock_only = "--mock-only" in sys.argv
    try:  # GBK console cannot print ✕/≈ etc.
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    home = tempfile.mkdtemp(prefix="refix_verify_")
    port_file = Path(home) / "sidecar.port"
    env = os.environ.copy()
    env.update({"PYTHONPATH": str(SIDECAR), "PT_UI_DIR": str(UI_DIR)})
    sidecar = subprocess.Popen(
        [PY, "-m", "app.main", "--home", home, "--port-file", str(port_file)],
        env=env, cwd=str(SIDECAR), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    edge = None
    try:
        info = await wait_port_file(port_file)
        base = f"http://127.0.0.1:{info['port']}"
        headers = {"Authorization": f"Bearer {info['token']}"}
        async with httpx.AsyncClient(base_url=base, headers=headers,
                                     trust_env=False, timeout=60) as api:
            # ---- Phase A: mock run（UCM 分支饼图） ----
            mock_cmd = str(ROOT / "tools" / "mock_aisbench.py")
            await api.put("/api/settings", json={"aisbench_command": f"{PY} {mock_cmd}"})
            rid_mock = (await api.post("/api/runs", json={
                "config": mock_cfg(), "name": "refix-mock"})).json()["run_id"]
            d_mock = await wait_terminal(api, rid_mock, timeout=300)
            check("A1 mock run 完成", d_mock["status"] == "completed", d_mock["status"])
            m_samples = (await api.get(f"/api/runs/{rid_mock}/metrics")).json()["samples"]
            print(f"  [diag] mock run rounds={len(d_mock.get('rounds') or [])} "
                  f"samples={len(m_samples)} "
                  f"agg={bool(((d_mock.get('rounds') or [{}])[-1].get('hit_rate') or {}).get('aggregated'))}")

            # ---- Phase B: 真实服务 run（真实 ais_bench CLI） ----
            if mock_only:
                rid_real = None
            else:
                await api.put("/api/settings", json={"aisbench_command": ""})  # 回落本机 ais_bench
                rid_real = (await api.post("/api/runs", json={
                    "config": real_cfg(), "name": "refix-real-8101"})).json()["run_id"]
                d_real = await wait_terminal(api, rid_real, timeout=900)
                check("B1 真实 run 完成", d_real["status"] == "completed", d_real["status"])
                r_samples = (await api.get(f"/api/runs/{rid_real}/metrics")).json()["samples"]
                print(f"  [diag] real run rounds={len(d_real.get('rounds') or [])} "
                      f"samples={len(r_samples)}")
                fulls = [r for r in d_real["rounds"] if r["phase"] == "full"]
                hbm = fulls[-1]["hit_rate"]["aggregated"]["hbm_hit_rate"] if fulls else 0
                check("B1b 真实命中率合理(0.5-1.0)", 0.5 <= hbm <= 1.0, f"{hbm:.3f}")

                # ---- R2.3 采样间隔分析（真实 run，阶段窗口内） ----
                events = (await api.get(f"/api/runs/{rid_real}/events")).json()["events"]
                samples = (await api.get(f"/api/runs/{rid_real}/metrics")).json()["samples"]
                spans = []
                for i, e in enumerate(events):
                    if e["type"] == "status" and e.get("phase") in ("warmup", "full"):
                        end = events[i + 1]["ts"] if i + 1 < len(events) else time.time()
                        spans.append((e["ts"], end))
                phase_ts = sorted(ts for s in samples for ts in [s["ts"]]
                                  if any(a <= s["ts"] <= b for a, b in spans))
                gaps = [b - a for a, b in zip(phase_ts, phase_ts[1:]) if 0.05 < b - a < 30]
                med = sorted(gaps)[len(gaps) // 2] if gaps else None
                check("B2 阶段窗口采样间隔 ≈0.3s（R2.3b 生效）",
                      med is not None and med <= 0.5, f"median={med and round(med, 2)}s, n={len(gaps)}")
                # R2.3b：0.3s 阶段采样应捕获到真实并发脉冲（reviewer 微基准：
                # 8 并发 0.4s 完成，1s 采样全错过；本 run full 阶段 c=8）
                max_run = 0
                for s in samples:
                    for counters in (s.get("engines") or {}).values():
                        max_run = max(max_run, counters.get("running", 0) or 0)
                check("B4 真实 run 捕获到 running>0（亚秒脉冲）",
                      max_run > 0, f"max running={max_run}")
                idle_ts = sorted(s["ts"] for s in samples
                                 if not any(a <= s["ts"] <= b for a, b in spans))
                idle_gaps = [b - a for a, b in zip(idle_ts, idle_ts[1:]) if 0.2 < b - a < 60]
                med_idle = sorted(idle_gaps)[len(idle_gaps) // 2] if idle_gaps else None
                print(f"  [info] 空闲期采样间隔 median={med_idle and round(med_idle, 1)}s "
                      f"(n={len(idle_gaps)}) — 阶段外的样本很少，仅参考")

            # ---- CDP 渲染检查 ----
            profile = Path(tempfile.mkdtemp(prefix="edge_prof_")) / "p"
            edge = subprocess.Popen([
                EDGE, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                f"--remote-debugging-port={CDP_PORT}", f"--user-data-dir={profile}",
                "about:blank"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            page = None
            for _ in range(100):
                try:
                    targets = httpx.get(f"http://127.0.0.1:{CDP_PORT}/json",
                                       trust_env=False, timeout=2).json()
                    page = next((t for t in targets if t["type"] == "page"), None)
                    if page:
                        break
                except Exception:
                    pass
                await asyncio.sleep(0.3)
            async with websockets.connect(page["webSocketDebuggerUrl"], max_size=10**7) as ws:
                cdp = Cdp(ws)
                await cdp.send("Page.enable")
                await cdp.send("Runtime.enable")
                await cdp.send("Emulation.setDeviceMetricsOverride",
                               {"width": 1440, "height": 900, "deviceScaleFactor": 1, "mobile": False})

                pages = [("mock", rid_mock)] + ([("real", rid_real)] if rid_real else [])
                for label, rid in pages:
                    await cdp.goto(f"{base}/#/monitor/{rid}", wait_s=7)
                    root_len = await cdp.eval("document.getElementById('root').innerHTML.length")
                    sample_n = await cdp.eval(
                        "document.querySelectorAll('.kpi-grid .mcard').length")
                    print(f"  [{label}] root={root_len} chars, kpi cards={sample_n}, "
                          f"console events={len(cdp.events)}")
                    if label == "mock":
                        txt = await cdp.eval(
                            "document.getElementById('root').innerText.slice(0, 500)")
                        print(f"  [{label}] innerText[:500]: {txt!r}")
                        raw_tick = await cdp.eval(
                            "document.querySelectorAll('.chart-body svg text.chart-axis').length")
                        raw_text = await cdp.eval(
                            "document.querySelectorAll('.chart-body svg text').length")
                        first_text = await cdp.eval(
                            "(document.querySelector('.grid12 .chart-body svg text')||{}).outerHTML")
                        print(f"  [{label}] raw chart-axis={raw_tick}, svg text={raw_text}")
                        print(f"  [{label}] first svg text: {str(first_text)[:140]}")
                    for cv in cdp.events[:3]:
                        if cv["method"] == "Runtime.exceptionThrown":
                            d = cv["params"]["exceptionDetails"]
                            print(f"  [{label}] EXC: {d.get('text')} "
                                  f"{d.get('exception', {}).get('description', '')[:200]}")
                    cdp.events.clear()
                    theo = await cdp.eval(
                        "(function(){const el=[...document.querySelectorAll('.kpi-grid .mcard .s')]"
                        ".find(e=>e.textContent.includes('理论'));"
                        "if(!el)return null;const m=el.textContent.match(/理论\\s*≈\\s*([\\d.]+)%/);"
                        "return m?parseFloat(m[1]):null;})()")
                    check(f"[{label}] KPI 理论值 <150%（R2.1）",
                          theo is not None and theo < 150, f"理论≈{theo}%")
                    pcts = await cdp.eval(
                        "[...document.querySelectorAll('.chart-card svg text')]"
                        ".map(e=>e.textContent).filter(t=>/^\\d+(\\.\\d+)?%$/.test(t.trim()))"
                        ".map(t=>parseFloat(t))")
                    check(f"[{label}] 饼图中心 ≤100%（R1.4）",
                          bool(pcts) and all(p <= 100.01 for p in pcts), str(pcts[:3]))
                    inconsistent = await cdp.eval(
                        "!![...document.querySelectorAll('.tag.warn')]"
                        ".find(e=>e.textContent.includes('指标不自洽'))")
                    check(f"[{label}] 无「指标不自洽」标注", not inconsistent)
                    paths = await cdp.eval(
                        "document.querySelectorAll('.grid12 .chart-body svg path').length")
                    check(f"[{label}] 图表序列已绘制（R2.4）", bool(paths) and paths >= 3, f"{paths} paths")
                    ticks = await cdp.eval(
                        "(function(){const t=[...document.querySelectorAll('.chart-body svg text.chart-axis')]"
                        ".map(e=>e.textContent.trim());return [...new Set(t)];})()")
                    check(f"[{label}] y 刻度不塌缩（R2.4）",
                          bool(ticks) and len(ticks) >= 3, f"{len(ticks or [])} distinct")
                    cdp.events.clear()

        print(f"\n=== REFIX VERIFY RESULT: {'PASS' if not FAILURES else 'FAIL'} ({len(FAILURES)} failed) ===")
        if FAILURES:
            print("failed:", "; ".join(FAILURES))
        return 0 if not FAILURES else 1
    finally:
        if edge and edge.poll() is None:
            edge.terminate()
        if sidecar.poll() is None:
            sidecar.terminate()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
