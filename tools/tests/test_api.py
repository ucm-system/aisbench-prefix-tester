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


def test_sla_start_validation():
    """Invalid SLA keys and missing config fields must be 400s, not 500s/ghost jobs."""
    bad = c.post("/api/sla/start", headers=H,
                 json={"config": {"host_ip": "h", "host_port": 1, "seed": 1,
                                  "input_len": 1, "data_num": 1, "prefix_num": 1,
                                  "repeat_rate": "0.9", "dp": 1},
                       "sla": {"latency_p90": 5}})
    assert bad.status_code == 400 and "SLA" in bad.json()["detail"], bad.text
    cfg = {"host_ip": "h", "host_port": 1, "input_len": 1, "data_num": 1,
           "prefix_num": 1, "repeat_rate": "0.9", "dp": 1}
    bad2 = c.post("/api/sla/start", headers=H,
                  json={"config": cfg, "sla": {"ttft_p90": 5}})
    assert bad2.status_code == 400 and "seed" in bad2.json()["detail"], bad2.text
    bad3 = c.post("/api/sla/start", headers=H,
                  json={"config": {**cfg, "seed": 1}, "sla": {"ttft_p90": 0}})
    assert bad3.status_code == 400 and "无意义" in bad3.json()["detail"], bad3.text
    print("sla start validation OK")


def test_runs_active_and_settings_whitelist():
    a = c.get("/api/runs/active", headers=H).json()
    assert "run" in a  # None or an active run — shape pin for the UI chip
    r = c.put("/api/settings", headers=H, json={"evil_key": "x"})
    assert r.status_code == 400, r.status_code
    print("runs/active + settings whitelist OK")


def test_stop_never_rewrites_history():
    rid = store.create_run({"host_ip": "h", "host_port": 1})
    store.update_run(rid, status="completed")
    c.post(f"/api/runs/{rid}/stop", headers=H)
    assert store.get_run(rid)["status"] == "completed", "stop must not rewrite history"
    store.delete_run(rid)
    print("stop history guard OK")


def test_parse_sla_ms_suffix():
    from app.sla import parse_sla_spec
    assert parse_sla_spec({"ttft_p90_ms": 3000}) == {"ttft_p90": 3000.0}
    print("sla _ms suffix tolerance OK")


def test_datasets_preview():
    r = c.post("/api/datasets/preview", headers=H,
               json={"tokenizer": TOK_PATH, "input_len": 32,
                     "repeat_rate": 0.9, "mode": "text", "seed": 1})
    assert r.status_code == 200, r.text
    pv = r.json()
    assert pv["measured_lengths"], pv
    print("dataset preview OK")


def test_diagnosis_runtime_ready():
    d = c.get("/api/diagnosis", headers=H).json()
    names = [i["name"] for i in d["items"]]
    assert any("运行模式" in n for n in names), names
    assert any("AISBench" in n for n in names), names
    print("diagnosis OK")


def test_run_detail_404():
    r = c.get("/api/runs/nope", headers=H)
    assert r.status_code == 404
    print("run detail 404 OK")


def test_reconcile_orphans():
    """Runs/SLA jobs left 'running' by a killed process must become interrupted
    at startup — no more forever-running zombies contradicting the SLA page."""
    rid = store.create_run(RUN_CFG, name="zombie-reconcile")
    store.update_run(rid, status="running")
    store.save_sla_job({"job_id": "zjob-reconcile", "state": "running", "sla": {}})
    out = store.reconcile_orphans()
    assert out["runs"] >= 1 and out["sla_jobs"] >= 1, out
    assert store.get_run(rid)["status"] == "interrupted"
    assert store.get_run(rid)["finished_at"] > 0
    assert store.get_sla_job("zjob-reconcile")["state"] == "interrupted"
    # idempotent: a second pass finds nothing left to fix
    again = store.reconcile_orphans()
    assert again == {"runs": 0, "sla_jobs": 0}, again
    store.delete_run(rid)
    print("reconcile orphans OK")


def test_warmup_crash_marks_run_failed():
    """R2.2 regression: a run whose FIRST phase (warmup) exits nonzero must be
    failed — it used to fall through as 'completed' with 0 rounds (the runner
    only checked exit codes in the full phase; also the exe-smoke
    false-positive root cause)."""
    stub = str(ROOT / "tools" / "tests" / "stub_aisbench.py")
    r = c.put("/api/settings", headers=H, json={"aisbench_command": f"py -3.11 {stub} --fail-once"})
    assert r.json()["ok"]
    rid = c.post("/api/runs", headers=H,
                 json={"config": RUN_CFG, "name": "warmup-crash"}).json()["run_id"]
    d = wait_run(rid)
    assert d["status"] == "failed", f"warmup crash must fail, got {d['status']}"
    assert d.get("rounds") == [] or not d.get("rounds"), "no rounds should be recorded"
    # restore the always-succeed stub for subsequent tests
    c.put("/api/settings", headers=H, json={"aisbench_command": f"py -3.11 {stub}"})
    print("warmup crash marks run failed OK")


def test_zero_round_completed_backfill():
    """R2.2 data repair: legacy 'completed' runs with no rounds rows are
    re-marked failed at migration time (idempotent)."""
    rid = store.create_run(RUN_CFG, name="legacy-dirty-completed")
    store.update_run(rid, status="completed")  # no rounds inserted on purpose
    from app import store as _s
    with _s._LOCK:
        _s._migrate(_s.connect())
        _s.connect().commit()
    d = store.get_run(rid)
    assert d["status"] == "failed", d["status"]
    assert "warmup" in (d.get("notes") or "")
    store.delete_run(rid)
    print("zero-round completed backfill OK")


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
        test_sla_start_validation()
        test_runs_active_and_settings_whitelist()
        test_stop_never_rewrites_history()
        test_parse_sla_ms_suffix()
        test_datasets_preview()
        test_diagnosis_runtime_ready()
        test_run_detail_404()
        test_reconcile_orphans()
        test_warmup_crash_marks_run_failed()
        test_zero_round_completed_backfill()
    print("ALL API TESTS PASSED")


if __name__ == "__main__":
    main()
