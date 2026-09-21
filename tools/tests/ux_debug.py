"""调试：容器模式 sidecar + CDP Edge，抓 console 异常与页面 HTML 概要。"""
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
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"


async def main():
    home = tempfile.mkdtemp(prefix="ux_dbg_")
    port_file = Path(home) / "sidecar.port"
    env = os.environ.copy()
    env.update({"PYTHONPATH": str(SIDECAR), "PT_UI_DIR": str(UI_DIR)})
    sidecar = subprocess.Popen(
        [PY, "-m", "app.main", "--home", home, "--port-file", str(port_file)],
        env=env, cwd=str(SIDECAR), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    edge = None
    try:
        for _ in range(200):
            if port_file.exists():
                break
            await asyncio.sleep(0.2)
        info = json.loads(port_file.read_text())
        base = f"http://127.0.0.1:{info['port']}"
        print("sidecar:", base)

        # sanity: UI html served?
        r = httpx.get(f"{base}/", trust_env=False, timeout=5)
        print("GET / ->", r.status_code, len(r.text), "bytes")
        r2 = httpx.get(f"{base}/api/boot", trust_env=False, timeout=5)
        print("GET /api/boot ->", r2.status_code, r2.text[:120])

        profile = Path(tempfile.mkdtemp(prefix="edge_prof_")) / "p"
        edge = subprocess.Popen([
            EDGE, "--headless=new", "--disable-gpu",
            "--remote-debugging-port=9334", f"--user-data-dir={profile}",
            "about:blank"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        page = None
        for _ in range(100):
            try:
                targets = httpx.get("http://127.0.0.1:9334/json",
                                   trust_env=False, timeout=2).json()
                page = next((t for t in targets if t["type"] == "page"), None)
                if page:
                    break
            except Exception:
                pass
            await asyncio.sleep(0.3)
        print("cdp target:", page and page["url"])

        async with websockets.connect(page["webSocketDebuggerUrl"], max_size=10**7) as ws:
            mid = 0
            console = []

            async def send(method, params=None):
                nonlocal mid
                mid += 1
                await ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
                while True:
                    msg = json.loads(await ws.recv())
                    if msg.get("id") == mid:
                        return msg.get("result", {})
                    if msg.get("method") in ("Runtime.exceptionThrown", "Runtime.consoleAPICalled"):
                        console.append(msg)

            await send("Page.enable")
            await send("Runtime.enable")
            await send("Page.navigate", {"url": f"{base}/#/config"})
            await asyncio.sleep(6)
            res = await send("Runtime.evaluate", {
                "expression": "document.getElementById('root').innerHTML.length", "returnByValue": True})
            print("root innerHTML length:", res.get("result", {}).get("value"))
            res2 = await send("Runtime.evaluate", {
                "expression": "document.getElementById('root').innerText.slice(0, 300)", "returnByValue": True})
            print("root text:", repr(res2.get("result", {}).get("value"))[:400])
            print("console/exception events:", len(console))
            for c in console[:6]:
                if c["method"] == "Runtime.exceptionThrown":
                    d = c["params"]["exceptionDetails"]
                    print("EXC:", d.get("text"), d.get("exception", {}).get("description", "")[:300])
                else:
                    print("LOG:", c["params"].get("type"),
                          str(c["params"].get("args", []))[:200])
    finally:
        if edge and edge.poll() is None:
            edge.terminate()
        if sidecar.poll() is None:
            sidecar.terminate()


if __name__ == "__main__":
    asyncio.run(main())
