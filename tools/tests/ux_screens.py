"""UX v0.2 截图自查驱动：REDESIGN §6 线框对照（1440 与 1024 两档）。

- 以容器模式（PT_UI_DIR=desktop/dist）启动源码 sidecar，同源服务 UI
- 用 mock aisbench 灌两个 run（一个 2 轮、一个 1 轮不同并发）作为种子数据
- headless Edge 截 6 页 × 2 视口 → docs/screenshots/ux2-<page>-<w>.png

Run: py -3.11 tools/tests/ux_screens.py
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

ROOT = Path(__file__).resolve().parents[2]
SIDECAR = ROOT / "sidecar"
UI_DIR = ROOT / "desktop" / "dist"
PY = sys.executable
MOCK_PORT = 8091
TOKENIZER = r"D:\Models\Qwen3-32B"
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
OUT = ROOT / "docs" / "screenshots"
VIEWPORTS = [(1440, 900), (1024, 700)]


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


def screenshot(url: str, out: Path, w: int, h: int, profile: str):
    subprocess.run([
        EDGE, "--headless=new", "--disable-gpu", "--hide-scrollbars",
        f"--window-size={w},{h}", f"--user-data-dir={profile}",
        "--virtual-time-budget=9000", f"--screenshot={out}", url,
    ], capture_output=True, timeout=90)
    print(f"  shot {out.name} ({w}x{h}) {'OK' if out.exists() else 'MISSING'}")


async def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    home = tempfile.mkdtemp(prefix="aisbench_ux_shot_")
    port_file = Path(home) / "sidecar.port"
    env = os.environ.copy()
    env.update({"PYTHONPATH": str(SIDECAR), "PT_UI_DIR": str(UI_DIR),
                "PYTHONUNBUFFERED": "1"})
    sidecar = subprocess.Popen(
        [PY, "-m", "app.main", "--home", home, "--port-file", str(port_file),
         "--host", "127.0.0.1", "--port", "8123"],
        env=env, cwd=str(SIDECAR), stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL)
    try:
        for _ in range(300):
            if port_file.exists():
                break
            await asyncio.sleep(0.2)
        info = json.loads(port_file.read_text())
        base = f"http://127.0.0.1:{info['port']}"
        headers = {"Authorization": f"Bearer {info['token']}"}
        print(f"sidecar up: {base}")
        async with httpx.AsyncClient(base_url=base, headers=headers,
                                     trust_env=False, timeout=30) as api:
            mock_cmd = str(ROOT / "tools" / "mock_aisbench.py")
            await api.put("/api/settings", json={"aisbench_command": f"{PY} {mock_cmd}"})
            r1 = (await api.post("/api/runs", json={
                "config": run_cfg("截图-两轮-90%重复", 2, 3),
                "name": "截图-两轮-90%重复-c3"})).json()
            r2 = (await api.post("/api/runs", json={
                "config": run_cfg("截图-单轮-c8", 1, 8),
                "name": "截图-单轮-c8"})).json()
            for rid in (r1["run_id"], r2["run_id"]):
                t0 = time.time()
                while time.time() - t0 < 180:
                    d = (await api.get(f"/api/runs/{rid}")).json()
                    if d["status"] in ("completed", "failed", "cancelled"):
                        break
                    await asyncio.sleep(1.5)
            print("seed runs ready:", r1["run_id"], r2["run_id"])

        pages = [
            ("config", f"{base}/#/config"),
            ("history", f"{base}/#/history"),
            ("monitor", f"{base}/#/monitor/{r1['run_id']}"),
            ("compare", f"{base}/#/compare"),
            ("sla", f"{base}/#/sla"),
            ("settings", f"{base}/#/settings"),
        ]
        for w, h in VIEWPORTS:
            profile = Path(tempfile.mkdtemp(prefix="edge_prof_")) / "p"
            for name, url in pages:
                out = OUT / f"ux2-{name}-{w}.png"
                screenshot(url, out, w, h, str(profile))
        return 0
    finally:
        if sidecar.poll() is None:
            sidecar.terminate()
            try:
                sidecar.wait(timeout=10)
            except subprocess.TimeoutExpired:
                sidecar.kill()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
