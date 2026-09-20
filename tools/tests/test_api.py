"""API-layer regression suite (FastAPI TestClient, offline).

Covers: auth, settings roundtrip, tokenizer registry, runs lifecycle via a
harmless stub command (fast fail + fast success), kind filtering, delete
(single/batch/404), SLA routes, dataset preview. Run:
  py -3.11 tools/tests/test_api.py
"""
import json
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "sidecar"))

from app import config, store  # noqa: E402

HOME = Path(tempfile.mkdtemp(prefix="pt_api_tests_"))
config.init_home(str(HOME))
store.connect()

from fastapi.testclient import TestClient  # noqa: E402
from app.main import app, _state  # noqa: E402

_state["token"] = "test-token-123"
H = {"Authorization": "Bearer test-token-123"}
BAD = {"Authorization": "Bearer wrong"}
# NOTE: the app must be used inside `with TestClient(...)` so the portal event
# loop stays alive for the whole suite — the runner thread keeps a reference to
# the loop it was handed (mirrors the long-lived uvicorn loop in production).
c: TestClient = None  # set in main()

TOK_PATH = str(ROOT / "assets" / "model" / "Qwen3-0.6B")
RUN_CFG = {"host_ip": "127.0.0.1", "host_port": 8091, "model_name": "mock-model",
           "tokenizer": TOK_PATH, "input_len": 64, "output_len": 8,
           "data_num": 4, "prefix_num": 2, "repeat_rate": 0.9,
           "concurrency": 2, "dp": 1, "pod_info": ["127.0.0.1:8091"],
           "rounds": [{}]}


def wait_run(run_id: str, timeout: float = 60) -> dict:
    t0 = time.time()
    while time.time() - t0 < timeout:
        d = c.get(f"/api/runs/{run_id}", headers=H).json()
        if d["status"] in ("completed", "failed", "cancelled"):
            return d
        time.sleep(0.3)
    raise AssertionError(f"run {run_id} did not finish in {timeout}s")


def test_auth():
    r = c.get("/api/settings")
    assert r.status_code == 401, r.status_code
    r = c.get("/api/settings", headers=BAD)
    assert r.status_code == 401
    r = c.get("/api/settings", headers=H)
    assert r.status_code == 200
    print("auth OK")


def test_settings_roundtrip():
    stub = str(ROOT / "tools" / "tests" / "stub_aisbench.py")
    r = c.put("/api/settings", headers=H,
              json={"aisbench_command": f"py -3.11 {stub}",
                    "collection_interval": "5"})
    assert r.json()["ok"]
    s = c.get("/api/settings", headers=H).json()
    assert s["aisbench_command"] == f"py -3.11 {stub}"
    print("settings roundtrip OK")


def test_tokenizers_registry():
    toks = c.get("/api/tokenizers", headers=H).json()
    names = {t["name"] for t in toks}
    assert "Qwen3-0.6B" in names, names  # auto-registered (assets/model, or D:\Models if present)
    src = {t["name"]: t["source"] for t in toks}
    assert src["Qwen3-0.6B"] in ("local", "assets")
    # the bundled assets root must be discovered on the repo layout
    from app import config as app_config
    assert app_config.bundled_assets_model_dir() is not None
    # register a custom dir + verify offline
    r = c.post("/api/tokenizers", headers=H,
               json={"name": "api-test-pack", "path": TOK_PATH})
    assert r.status_code == 200, r.text
    v = c.post("/api/tokenizers/verify", headers=H,
               json={"name_or_path": "api-test-pack"}).json()
    assert v["ok"] and v["vocab_size"] > 100000, v
    r = c.post("/api/tokenizers", headers=H, json={"name": "bad", "path": str(HOME)})
    assert r.status_code == 400, r.status_code
    print("tokenizer registry OK")


def test_run_validation_400():
    r = c.post("/api/runs", headers=H, json={"config": {"host_ip": "x"}})
    assert r.status_code == 400
    errs = r.json()["detail"]
    assert isinstance(errs, list) and any("tokenizer" in e or "模型" in e for e in errs), errs
    print("run validation OK")


def test_run_lifecycle_completed():
    """Stub command exits 0 → both phases 'succeed' → run completes."""
    rid = c.post("/api/runs", headers=H, json={"config": RUN_CFG, "name": "api-ok"}).json()["run_id"]
    d = wait_run(rid)
    assert d["status"] == "completed", d
    assert d["rounds"], "rounds must be recorded"
    fulls = [r for r in d["rounds"] if r["phase"] == "full"]
    assert fulls, "full phase row missing"
    # logs + metrics endpoints exist for the run
    logs = c.get(f"/api/runs/{rid}/logs", headers=H)
    assert logs.status_code == 200
    met = c.get(f"/api/runs/{rid}/metrics", headers=H)
    assert met.status_code == 200
    print(f"run lifecycle (completed) OK  [{rid}]")


def test_run_lifecycle_failed():
    """Stub command that fails → run must end 'failed', never silently completed."""
    stub = str(ROOT / "tools" / "tests" / "stub_aisbench.py")
    c.put("/api/settings", headers=H,
          json={"aisbench_command": f"py -3.11 {stub} --fail"})
    rid = c.post("/api/runs", headers=H, json={"config": RUN_CFG, "name": "api-fail"}).json()["run_id"]
    d = wait_run(rid)
    assert d["status"] == "failed", f"expected failed, got {d['status']}"
    stub_ok = str(ROOT / "tools" / "tests" / "stub_aisbench.py")
    c.put("/api/settings", headers=H, json={"aisbench_command": f"py -3.11 {stub_ok}"})
    print(f"run lifecycle (failed) OK  [{rid}]")


def test_kind_filter_and_delete():
    # store-level creation with kind=sla must be invisible in manual filter
    rid_s = store.create_run({"host_ip": "h", "host_port": 1}, kind="sla")
    manual = {x["run_id"] for x in c.get("/api/runs?kind=manual", headers=H).json()}
    assert rid_s not in manual
    slas = {x["run_id"] for x in c.get("/api/runs?kind=sla", headers=H).json()}
    assert rid_s in slas
    # 404 delete
    r = c.delete("/api/runs/does-not-exist", headers=H)
    assert r.status_code == 404
    # batch delete: one existing sla run + one bogus id
    r = c.post("/api/runs/delete-batch", headers=H,
               json={"run_ids": [rid_s, "bogus"]})
    assert r.json()["deleted"] == [rid_s]
    assert store.get_run(rid_s) is None
    print("kind filter + delete OK")


def test_sla_routes_empty():
    cur = c.get("/api/sla/current", headers=H).json()
    assert cur == {"job": None}
    jobs = c.get("/api/sla/jobs", headers=H).json()
    assert jobs == []
    r = c.get("/api/sla/no-such-job", headers=H)
    assert r.status_code == 404
    print("sla routes OK")


def test_datasets_preview():
    r = c.post("/api/datasets/preview", headers=H,
               json={"tokenizer": TOK_PATH, "input_len": 32,
                     "repeat_rate": 0.9, "mode": "text", "seed": 1})
    assert r.status_code == 200, r.text
    pv = r.json()
    assert pv["measured_lengths"], pv
    print("dataset preview OK")


def test_run_detail_404():
    r = c.get("/api/runs/nope", headers=H)
    assert r.status_code == 404
    print("run detail 404 OK")


def main():
    global c
    with TestClient(app) as client:
        c = client
        test_auth()
        test_settings_roundtrip()
        test_tokenizers_registry()
        test_run_validation_400()
        test_run_lifecycle_completed()
        test_run_lifecycle_failed()
        test_kind_filter_and_delete()
        test_sla_routes_empty()
        test_datasets_preview()
        test_run_detail_404()
    print("ALL API TESTS PASSED")


if __name__ == "__main__":
    main()
