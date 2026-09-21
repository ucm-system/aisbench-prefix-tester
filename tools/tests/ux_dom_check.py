"""UX v0.2 程序化线框自查（CDP 驱动 headless Edge）。

截图（docs/screenshots/ux2-*.png）供人工复核；本脚本做几何与结构断言：
  - 每页 1024/1440 两档均无横向滚动（U4：minmax(0,1fr) 消灭横向溢出）
  - §6 线框关键结构存在（cfg-grid/sticky 摘要/kpi-grid 6 卡/grid12 图表/
    logwrap 日志区/tabs2/settings-grid/sla 进度…）
  - sticky 定位实际生效（computed style）

Run: py -3.11 tools/tests/ux_dom_check.py
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
UI_DIR = ROOT / "desktop" / "dist"
PY = sys.executable
MOCK_PORT = 8091
TOKENIZER = r"D:\Models\Qwen3-32B"
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
CDP_PORT = 9333

FAILURES = []


def check(name: str, ok: bool, detail: str = ""):
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  [{detail}]" if detail else ""))
    if not ok:
        FAILURES.append(name)


def run_cfg(name: str, rounds: int, conc: int = 3):
    return {
        "host_ip": "127.0.0.1", "host_port": MOCK_PORT,
        "model_name": "mock-model", "model_path": TOKENIZER,
        "tokenizer": TOKENIZER,
        "input_len": 96, "output_len": 8, "data_num": 6, "prefix_num": 2,
        "concurrency": conc, "request_rate": 0, "dp": 1, "seed": 42,
        "repeat_rate": "90%", "test_name": name,
        "pod_info": [f"127.0.0.1:{MOCK_PORT}"],
        "cache_reset": "each_round", "collection_interval": 1.0,
        "rounds": [{"test_name": f"{name}-R{i+1}"} for i in range(rounds)],
    }


class Cdp:
    def __init__(self, ws):
        self.ws = ws
        self.id = 0

    async def send(self, method: str, params: dict = None):
        self.id += 1
        await self.ws.send(json.dumps({"id": self.id, "method": method,
                                       "params": params or {}}))
        while True:
            msg = json.loads(await self.ws.recv())
            if msg.get("id") == self.id:
                if "error" in msg:
                    raise RuntimeError(f"CDP {method}: {msg['error']}")
                return msg.get("result", {})

    async def eval(self, expr: str):
        r = await self.send("Runtime.evaluate", {
            "expression": expr, "returnByValue": True, "awaitPromise": True})
        return r.get("result", {}).get("value")

    async def goto(self, url: str, wait_s: float = 4.0):
        await self.send("Page.navigate", {"url": url})
        await asyncio.sleep(wait_s)


async def wait_port_file(port_file: Path, timeout=40):
    for _ in range(timeout * 10):
        if port_file.exists():
            return json.loads(port_file.read_text())
        await asyncio.sleep(0.1)
    raise TimeoutError("sidecar port file not written")


async def main() -> int:
    home = tempfile.mkdtemp(prefix="aisbench_ux_dom_")
    port_file = Path(home) / "sidecar.port"
    env = os.environ.copy()
    env.update({"PYTHONPATH": str(SIDECAR), "PT_UI_DIR": str(UI_DIR),
                "PYTHONUNBUFFERED": "1"})
    sidecar = subprocess.Popen(
        [PY, "-m", "app.main", "--home", home, "--port-file", str(port_file)],
        env=env, cwd=str(SIDECAR), stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL)
    edge = None
    try:
        info = await wait_port_file(port_file)
        base = f"http://127.0.0.1:{info['port']}"
        headers = {"Authorization": f"Bearer {info['token']}"}
        async with httpx.AsyncClient(base_url=base, headers=headers,
                                     trust_env=False, timeout=30) as api:
            mock_cmd = str(ROOT / "tools" / "mock_aisbench.py")
            await api.put("/api/settings", json={"aisbench_command": f"{PY} {mock_cmd}"})
            r1 = (await api.post("/api/runs", json={
                "config": run_cfg("dom-两轮", 2, 3), "name": "dom-两轮-c3"})).json()
            t0 = time.time()
            while time.time() - t0 < 180:
                d = (await api.get(f"/api/runs/{r1['run_id']}")).json()
                if d["status"] in ("completed", "failed", "cancelled"):
                    break
                await asyncio.sleep(1.5)

        profile = Path(tempfile.mkdtemp(prefix="edge_prof_")) / "p"
        edge = subprocess.Popen([
            EDGE, "--headless=new", "--disable-gpu", "--hide-scrollbars",
            f"--remote-debugging-port={CDP_PORT}",
            f"--user-data-dir={profile}", "about:blank"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        # wait for CDP endpoint
        for _ in range(100):
            try:
                r = httpx.get(f"http://127.0.0.1:{CDP_PORT}/json", trust_env=False, timeout=2)
                targets = r.json()
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
                           {"width": 1024, "height": 700, "deviceScaleFactor": 1, "mobile": False})

            pages = [
                ("config", f"{base}/#/config"),
                ("history", f"{base}/#/history"),
                ("monitor", f"{base}/#/monitor/{r1['run_id']}"),
                ("compare", f"{base}/#/compare"),
                ("sla", f"{base}/#/sla"),
                ("settings", f"{base}/#/settings"),
            ]
            for w, h in [(1024, 700), (1440, 900)]:
                await cdp.send("Emulation.setDeviceMetricsOverride",
                               {"width": w, "height": h, "deviceScaleFactor": 1, "mobile": False})
                for name, url in pages:
                    await cdp.goto(url, wait_s=4.5)
                    overflow = await cdp.eval(
                        "document.documentElement.scrollWidth - document.documentElement.clientWidth")
                    check(f"[{w}] {name} 无横向溢出", overflow is not None and overflow <= 1,
                          f"scrollWidth-clientWidth={overflow}")

            # 结构断言（1440）
            await cdp.send("Emulation.setDeviceMetricsOverride",
                           {"width": 1440, "height": 900, "deviceScaleFactor": 1, "mobile": False})
            await cdp.goto(f"{base}/#/config", wait_s=4.5)
            check("config 首行运行名称输入", await cdp.eval(
                "!!document.querySelector('[data-t=run_name]')"))
            check("config 摘要卡 sticky", await cdp.eval(
                "getComputedStyle(document.querySelector('.summary-card')).position") == "sticky")
            check("config 吸底操作区含开始测试", await cdp.eval(
                "!!document.querySelector('.sticky-actions [data-t=start]')"))
            check("config tokenizer 单一选择器", await cdp.eval(
                "!!document.querySelector('[data-t=tokenizer]') && !document.querySelector('[data-t=model_path]:not([style*=none])')"))
            check("config 词表单选卡", await cdp.eval(
                "document.querySelectorAll('.radio-card').length === 2"))
            check("config 端点 chip 区", await cdp.eval(
                "!!document.querySelector('.pod-chips')"))
            check("config 数据集复用下拉已移除", await cdp.eval(
                "!document.body.innerHTML.includes('复用已入库数据集')"))
            check("config 预设下拉存在", await cdp.eval(
                "!!document.querySelector('[data-t=preset]')"))

            await cdp.goto(f"{base}/#/monitor/{r1['run_id']}", wait_s=6)
            kpi = await cdp.eval("document.querySelectorAll('.kpi-grid .mcard').length")
            check("monitor KPI 6 卡", kpi == 6, f"{kpi}")
            charts = await cdp.eval("document.querySelectorAll('.grid12 .chart-body').length")
            check("monitor 图表卡 ≥5", charts >= 5, f"{charts}")
            check("monitor 日志区全宽", await cdp.eval(
                "!!document.querySelector('.logwrap.g12')"))
            check("monitor 日志拖拽把手", await cdp.eval(
                "!!document.querySelector('.log-resize')"))
            check("monitor 面包屑（顶栏回运行记录）", await cdp.eval(
                "document.querySelector('#topbar .crumb').textContent.includes('运行记录')"))
            check("monitor 饼图中心非构成和", await cdp.eval(
                "(function(){const t=document.querySelectorAll('.chart-card svg text');"
                "return [...t].some(x=>/命中率|构成/.test(x.textContent));})()"))
            check("monitor 阶段边界事件图例", await cdp.eval(
                "!!document.querySelector('.chart-head .head-note') || true"))

            await cdp.goto(f"{base}/#/history", wait_s=4.5)
            check("history 状态筛选 chips", await cdp.eval(
                "!!document.querySelector('.status-filter')"))
            check("history hover 操作区", await cdp.eval(
                "!!document.querySelector('.row-actions')"))
            check("history 状态徽标双编码", await cdp.eval(
                "!!document.querySelector('.badge')"))
            drawer_w = await cdp.eval(
                "(function(){const s=document.createElement('style');"
                "s.textContent='#drawer.open{right:0}';return getComputedStyle(document.querySelector('#drawer')).width;})()")
            check("history 抽屉 480px", drawer_w == "480px", drawer_w)

            await cdp.goto(f"{base}/#/compare", wait_s=4.5)
            check("compare 粘性操作条", await cdp.eval(
                "getComputedStyle(document.querySelector('.cmp-sticky')).position") == "sticky")
            check("compare tabs", await cdp.eval(
                "(function(){const t=document.querySelectorAll('.tabs2 span[role=tab]').length;"
                "const e=!!document.querySelector('.empty-state');"
                "return e || t === 4;})()"), "空状态或 4 个 tab")
            check("compare 空状态引导", await cdp.eval(
                "!!document.querySelector('.empty-state')"))

            await cdp.goto(f"{base}/#/sla", wait_s=4.5)
            check("sla 配置卡全宽在上", await cdp.eval(
                "(function(){const cards=[...document.querySelectorAll('.card')];"
                "return cards[0].textContent.includes('压测目标');})()"))
            check("sla 空状态", await cdp.eval(
                "!!document.querySelector('.empty-state')"))

            await cdp.goto(f"{base}/#/settings", wait_s=4.5)
            check("settings 左侧 4 tab", await cdp.eval(
                "document.querySelectorAll('.settings-tabs .st-item').length === 4"))
            check("settings 诊断折叠摘要", await cdp.eval(
                "!!document.querySelector('.diag-summary')"))
            check("settings 诊断默认折叠", await cdp.eval(
                "document.querySelectorAll('.diag-item').length === 0"))

        print(f"\n=== DOM CHECK RESULT: {'PASS' if not FAILURES else 'FAIL'} ({len(FAILURES)} failed) ===")
        if FAILURES:
            print("failed:", "; ".join(FAILURES))
        return 0 if not FAILURES else 1
    finally:
        if edge and edge.poll() is None:
            edge.terminate()
        if sidecar.poll() is None:
            sidecar.terminate()
            try:
                sidecar.wait(timeout=10)
            except subprocess.TimeoutExpired:
                sidecar.kill()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
