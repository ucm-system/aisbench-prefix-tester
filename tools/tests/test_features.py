"""Feature-level tests running against a throwaway home dir.

Covers: SLA spec parsing/labels, config validation rules, compare engine
(direction-aware deltas, practice/warmup exclusion, round alignment),
xlsx/html report generation, AISBench config injection, runner config
normalization, pod address parsing, event bus.
Run: py -3.11 tools/tests/test_features.py
"""
import asyncio
import json
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "sidecar"))

from app import config, compare, events, metrics, report, runner, store  # noqa: E402
from app.main import validate_config  # noqa: E402
from app.sla import parse_sla_spec, sla_label  # noqa: E402


def test_sla_spec():
    spec = parse_sla_spec({"ttft_p90": 3000, "tpot_avg": 50, "throughput_min": 100,
                           "e2el_p99": None})
    assert spec == {"ttft_p90": 3000.0, "tpot_avg": 50.0, "throughput_min": 100.0}, spec
    try:
        parse_sla_spec({"latency_p90": 1})
        raise AssertionError("invalid metric must raise")
    except ValueError:
        pass
    try:
        parse_sla_spec({"ttft_p95": 1})
        raise AssertionError("unsupported stat must raise")
    except ValueError:
        pass
    assert "P99" in sla_label("ttft_p99") and "TTFT" in sla_label("ttft_p99")
    assert "吞吐" in sla_label("throughput_min")
    print("sla spec OK")


def test_validate_config():
    ok = {"model_path": "x", "host_ip": "1.2.3.4", "input_len": 1024,
          "data_num": 32, "prefix_num": 4, "repeat_rate": "90%",
          "concurrency": 8, "cache_reset": "each_round"}
    r = validate_config(ok)
    assert not r["errors"], r["errors"]
    bad = dict(ok, model_path="", host_ip="")
    r = validate_config(bad)
    assert len(r["errors"]) >= 2
    warn = dict(ok, prefix_num=64, data_num=8, cache_reset="never")
    r = validate_config(warn)
    assert any("prefix_num" in w for w in r["warnings"]), r["warnings"]
    assert any("残留" in w for w in r["warnings"])
    half = dict(ok, length_mean=10)
    assert validate_config(half)["errors"], "unpaired length params must error"
    print("config validate OK")


def test_compare_engine(tmp):
    config.init_home(str(tmp))
    store.connect()
    cfg = {"input_len": 4096, "output_len": 32, "data_num": 32, "concurrency": 8,
           "repeat_rate": 0.9, "dp": 1, "host_port": 8101, "test_type": "stream"}

    def m(ttft, thr):
        return {"ttft_avg_ms": ttft, "ttft_p90_ms": ttft * 2, "tpot_avg_ms": 20,
                "tpot_p90_ms": 40, "output_token_throughput": thr,
                "total_token_throughput": thr * 10, "benchmark_duration_s": 60,
                "request_throughput_qps": 1, "measured_concurrency": 8,
                "total_requests": 32}

    def h(hbm, ext):
        return {"aggregated": {"hbm_hit_rate": hbm, "ext_hit_rate": ext,
                "composite_hit_rate": ext * (1 - hbm) + hbm}}

    id_a = store.create_run({**cfg, "host_ip": "h"}, "A")
    store.upsert_round(id_a, 1, "warmup", True, {}, {"ttft_avg_ms": -1}, {"aggregated": {}})
    store.upsert_round(id_a, 1, "full", False, {}, m(400, 300), h(0.90, 0.10))
    # practice run: must be excluded by default
    id_p = store.create_run({**cfg, "host_ip": "h"}, "P-practice")
    store.update_run(id_p, is_practice=1)
    store.upsert_round(id_p, 1, "full", False, {}, m(100, 999), h(0.99, 0.99))
    id_c = store.create_run({**cfg, "host_ip": "h"}, "C")
    store.upsert_round(id_c, 1, "full", False, {}, m(500, 350), h(0.80, 0.50))

    res = compare.compare([id_a, id_p, id_c])
    assert id_p not in res["runs"], "practice run must be excluded"
    d = res["metrics"]["ttft_avg_ms"]
    assert d["values"][id_a] == 400 and d["values"][id_c] == 500
    dd = d["deltas"][id_c]
    assert dd["pct"] == 25.0 and dd["good"] is False, dd  # latency up = bad
    thr = res["metrics"]["output_token_throughput"]["deltas"][id_c]
    assert thr["good"] is True  # 350 > 300, throughput up = good
    assert res["metrics"]["ext_hit_rate"]["deltas"][id_c]["good"] is True
    print("compare OK | ttft delta:", dd, "| missing:", res["missing_rounds"])


def test_reports(tmp):
    res = compare.compare.__self__ if False else None
    from app import config as cfgmod
    r = {"run_ids": []}
    # reuse whatever exists in this home
    ids = [x["run_id"] for x in store.list_runs()]
    assert ids, "need runs for report"
    x = report.export_xlsx(ids[:2] if len(ids) >= 2 else ids)
    h = report.export_html(ids[:2] if len(ids) >= 2 else ids)
    assert Path(x).exists() and Path(x).stat().st_size > 5000
    html = Path(h).read_text(encoding="utf-8")
    assert "<svg" in html and "对比" in html
    assert "{title}" not in html and "{delta_cards}" not in html, "template placeholders left"
    print("reports OK |", Path(x).name, Path(h).name)


def test_pod_and_events():
    assert metrics.parse_pod_address("1.2.3.4:8000") == ("1.2.3.4", "8000")
    assert metrics.parse_pod_address("[::1]:8000") == ("::1", "8000")
    assert metrics.parse_pod_address("fe80::1:8000") == ("fe80::1", "8000")
    asyncio.set_event_loop(asyncio.new_event_loop())
    loop = asyncio.get_event_loop()
    events.bind_loop(loop)

    async def collect():
        q = events.subscribe("*")
        events.publish("*", "test", hello=1)
        return await q.get()

    ev = loop.run_until_complete(collect())
    assert ev["type"] == "test" and ev["hello"] == 1
    loop.close()
    print("pod parse + event bus OK")


def test_runner_normalize():
    from app.runner import _normalize
    cfg = {"host_ip": "1.2.3.4", "host_port": 8000, "url": "http://5.6.7.8:9000",
           "repeat_rate": "90%", "rounds": [{"bogus": 1, "concurrency": 16}],
           "pod_info": [" ", "1.2.3.4:8000"]}
    n = _normalize(cfg)
    assert n["pod_info"] == ["1.2.3.4:8000"]
    assert n["rounds"] == [{"concurrency": 16}]
    assert n["repeat_rate"] == 0.9
    try:
        _normalize({**cfg, "rounds": ["junk"]})
        raise AssertionError("non-dict round must raise")
    except ValueError:
        pass
    n2 = _normalize({"host_ip": "h", "host_port": 1, "url": "http://9.9.9.9:1234",
                     "pod_info": []})
    assert n2["pod_info"] == ["9.9.9.9:1234"], "url pod fallback"
    print("runner normalize OK")


def test_aisbench_env(tmp):
    from app import aisbench_env
    work = tempfile.mkdtemp()
    out = aisbench_env.write_model_config(
        work, "D:/m", "demo-model", "1.2.3.4", 9999, "", 16, 128, 7,
        "stream", True)
    text = Path(out).read_text(encoding="utf-8")
    assert "VLLMCustomAPIChatStream" in text and "demo-model" in text
    assert "9999" in text and "D:/m" in text
    assert "enable_thinking" in text
    ds = aisbench_env.link_dataset(work, __file__)
    assert Path(ds).exists()
    argv = aisbench_env.build_aisbench_command("default_perf", "D:/out")
    assert "--num-warmups" in argv and "0" in argv
    print("aisbench env injection OK")


def test_store_kinds_delete_sla_jobs():
    """kind filter (manual vs sla), run delete, SLA job persistence."""
    rid_m = store.create_run({"host_ip": "h", "host_port": 1, "test_name": "t-manual"},
                             kind="manual")
    rid_s = store.create_run({"host_ip": "h", "host_port": 1, "test_name": "sla-c8"},
                             kind="sla")
    allk = {r["run_id"] for r in store.list_runs()}
    assert rid_m in allk and rid_s in allk
    manual = {r["run_id"] for r in store.list_runs(kind="manual")}
    slak = {r["run_id"] for r in store.list_runs(kind="sla")}
    assert rid_m in manual and rid_s not in manual
    assert rid_s in slak and rid_m not in slak
    store.delete_run(rid_m)
    assert store.get_run(rid_m) is None
    assert rid_m not in {r["run_id"] for r in store.list_runs()}

    store.save_sla_job({"job_id": "j1", "state": "done", "sla": {"ttft_p90": 3000},
                        "max_ok": 16, "note": "ok", "probes": [{"concurrency": 8}]})
    store.save_sla_job({"job_id": "j2", "state": "ladder", "sla": {}, "max_ok": None,
                        "note": "", "probes": [], "created_at": time.time() + 5})
    jobs = store.list_sla_jobs()
    assert [j["job_id"] for j in jobs] == ["j2", "j1"], "newest first"
    assert jobs[1]["sla"] == {"ttft_p90": 3000}
    assert jobs[1]["probes"][0]["concurrency"] == 8
    assert store.get_sla_job("j1")["state"] == "done"
    print("store kinds/delete/sla-jobs OK")


if __name__ == "__main__":
    tmp = tempfile.mkdtemp(prefix="pt_features_")
    config.init_home(str(tmp))
    store.connect()
    test_sla_spec()
    test_validate_config()
    test_pod_and_events()
    test_runner_normalize()
    test_aisbench_env(tmp)
    test_store_kinds_delete_sla_jobs()
    # compare + reports need runs in the same home
    test_compare_engine(tmp)
    test_reports(tmp)
    print("ALL FEATURE TESTS PASSED")
