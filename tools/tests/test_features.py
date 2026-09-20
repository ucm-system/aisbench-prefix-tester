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


def test_metrics_hit_rate():
    """Δhits/Δqueries per pod/dp + aggregated + composite, and empty-snapshot safety."""
    before = {("10.0.0.1", "0", "0"): {"hbm_q": 1000, "hbm_h": 100},
              ("10.0.0.2", "1", "0"): {"hbm_q": 500, "hbm_h": 50, "ext_q": 200, "ext_h": 40}}
    after = {("10.0.0.1", "0", "0"): {"hbm_q": 2000, "hbm_h": 1000},
             ("10.0.0.2", "1", "0"): {"hbm_q": 700, "hbm_h": 70, "ext_q": 300, "ext_h": 90}}
    r = metrics.compute_hit_rate(before, after)
    dp0, dp1 = r["per_dp"]["dp0"], r["per_dp"]["dp1"]
    assert dp0["hbm_queries"] == 1000 and dp0["hbm_hits"] == 900
    assert dp0["hbm_hit_rate"] == 0.9
    assert dp1["hbm_hit_rate"] == round(20 / 200, 6)
    assert r["per_pod"]["10.0.0.1|dp0"]["hbm_hits"] == 900
    assert r["per_pod"]["10.0.0.2|dp1"]["ext_hit_rate"] == 0.5
    agg = r["aggregated"]
    assert agg["hbm_hit_rate"] == round(920 / 1200, 6)
    assert agg["composite_hit_rate"] == round(
        agg["ext_hit_rate"] * (1 - agg["hbm_hit_rate"]) + agg["hbm_hit_rate"], 6)
    # empty snapshots: no division errors, zeros out
    empty = metrics.compute_hit_rate({}, {})
    assert empty["aggregated"]["hbm_hit_rate"] == 0.0 and not empty["per_dp"]
    # counters that only exist in `before` (reset mid-run) must not go negative-crash
    neg = metrics.compute_hit_rate({("p", "0", "0"): {"hbm_q": 100}}, {})
    assert neg["aggregated"]["hbm_queries"] == -100
    print("metrics hit-rate OK")


def test_parse_pod_and_metrics_text():
    assert metrics.parse_pod_address("1.2.3.4:8101") == ("1.2.3.4", "8101")
    assert metrics.parse_pod_address("[::1]:8101") == ("::1", "8101")
    assert metrics.parse_pod_address("fd00::1:8101") == ("fd00::1", "8101")
    text = """
# HELP vllm:prefix_cache_queries_total queries
vllm:prefix_cache_queries_total{model_name="q",engine="1",worker_rank="0"} 10
vllm:prefix_cache_hits_total{model_name="q",engine="1",worker_rank="0"} 4
vllm:prefix_cache_queries_total{model_name="q",engine="1",worker_rank="0"} 2
ucm:posix_lookup_query_blocks_total{engine="1",worker_rank="0"} 7
some_other_metric{engine="1"} 999
broken line without value
vllm:num_requests_running{engine="1",worker_rank="0"} NaN
"""
    series = metrics.parse_metrics_text(text)
    assert set(series.keys()) == {("1", "0")}
    c = series[("1", "0")]
    assert c["hbm_q"] == 12 and c["hbm_h"] == 4  # same series summed
    assert c["posix_q_blk"] == 7 and c.get("_ucm_seen") == 1.0
    assert "running" not in c  # NaN skipped
    assert "some_other_metric" not in c  # whitelist only
    print("pod parse + metrics text OK")


def test_parse_aisbench_log(tmp):
    from app.result_parse import build_result_row, parse_aisbench_log, write_results
    log = """[2026-09-20 16:09:47] Current exp folder: D:\\ws\\results\\20260920_160947
│ Performance Parameters   │ Stage   │ Average        │ Min            │ Max            │ Median         │ P75            │ P90            │ P99            │  N  │
│ TTFT                     │ total   │ 343.1 ms       │ 166.3 ms       │ 638.0 ms       │ 304.0 ms       │ 336.9 ms       │ 635.0 ms       │ 637.7 ms       │ 32  │
│ TPOT                     │ total   │ 20.5 ms        │ 18.0 ms        │ 25.0 ms        │ 20.0 ms        │ 21.0 ms        │ 24.0 ms        │ 24.9 ms        │ 32  │
│ E2EL                     │ total   │ 123.4 ms       │ 100.0 ms       │ 200.0 ms       │ 120.0 ms       │ 130.0 ms       │ 150.0 ms       │ 190.0 ms       │ 32  │
Request Throughput (req/s): 11.8726
Prefill Token Throughput: 12554.3482 token/s
Output Token Throughput: 379.9217 token/s
Total Requests: 32
"""
    p = Path(tmp) / "aisbench.log"
    p.write_text(log, encoding="utf-8")
    perf, log_dir = parse_aisbench_log(str(p), request_rate="0", npu_num=2)
    assert log_dir.endswith("20260920_160947")
    assert perf["ttft_avg_ms"] == 343.1 and perf["ttft_p90_ms"] == 635.0
    assert perf["ttft_p99_ms"] == 637.7 and perf["ttft_min_ms"] == 166.3
    assert perf["tpot_avg_ms"] == 20.5 and perf["e2el_avg_ms"] == 123.4
    assert perf["output_token_throughput"] == 379.9217
    assert perf["single_output_throughput"] == 379.9217 / 2
    assert perf["request_throughput_qps"] == 11.8726
    assert perf["request_throughput_qpm"] == 11.8726 * 60
    assert perf["total_requests"] == 32
    # missing file → defaults, no raise
    perf2, _ = parse_aisbench_log(str(Path(tmp) / "nope.log"))
    assert perf2["ttft_avg_ms"] == -1
    # result row + CSV header merging across schema growth
    hr = {"per_dp": {"dp0": {"hbm_hit_rate": 0.9, "hbm_queries": 100, "hbm_hits": 90,
                             "ext_hit_rate": 0.1, "ext_queries": 10, "ext_hits": 1}},
          "aggregated": {"hbm_hit_rate": 0.9, "hbm_queries": 100, "hbm_hits": 90,
                         "ext_hit_rate": 0.1, "ext_queries": 10, "ext_hits": 1}}
    params = {"input_len": 128, "concurrency": 4, "test_name": "t"}
    row1 = build_result_row(perf, hr, params, phase="full", round_index=1, warnings="w1")
    assert row1["hbm_hit_rate_dp0"] == 0.9 and row1["hbm_hit_rate_total"] == 0.9
    assert row1["warnings"] == "w1"
    run_dir = Path(tmp) / "rd"
    csv1, jsonl1 = write_results(row1, str(run_dir))
    row2 = build_result_row(perf, hr, {**params, "extra_metric_x": 1}, phase="full", round_index=2)
    csv2, jsonl2 = write_results(row2, str(run_dir))
    assert csv1 == csv2 and jsonl1 == jsonl2
    import csv as _csv
    with open(csv2, encoding="utf-8", newline="") as f:
        rows = list(_csv.DictReader(f))
    assert len(rows) == 2 and rows[0]["round"] == "1" and rows[1]["round"] == "2"
    print("aisbench log parse + result writer OK")


def test_sla_check_matrix():
    from app.sla import SlaTuner
    t = SlaTuner("j", {"host_ip": "h", "host_port": 1}, {"ttft_p90": 3000, "throughput_min": 100}, 2, 4, None)
    base = {"state": "completed", "ttft_p90_ms": 2500.0, "output_token_throughput": 150.0}
    ok, why = t._sla_check(base)
    assert ok, why
    ok, why = t._sla_check({**base, "ttft_p90_ms": 3000.0})  # exactly at limit → pass
    assert ok
    ok, why = t._sla_check({**base, "ttft_p90_ms": 3000.1})
    assert not ok and "TTFT" in why
    ok, why = t._sla_check({**base, "output_token_throughput": 99.9})
    assert not ok and "吞吐" in why
    ok, why = t._sla_check({**base, "ttft_p90_ms": -1})
    assert not ok and "无数据" in why
    ok, why = t._sla_check({**base, "state": "failed"})
    assert not ok and "failed" in why
    print("sla check matrix OK")


def test_dataset_gen_real(tmp):
    """Offline dataset generation against the packaged Qwen3-0.6B tokenizer."""
    from app.dataset_gen import parse_prefix_ratio
    assert parse_prefix_ratio("90%") == 0.9 and parse_prefix_ratio(0.5) == 0.5
    assert parse_prefix_ratio("0.9") == 0.9
    try:
        parse_prefix_ratio("abc")
        raise AssertionError("invalid ratio must raise")
    except ValueError:
        pass
    tok = ROOT / "assets" / "model" / "Qwen3-0.6B"
    if not (tok / "tokenizer.json").exists():
        print("dataset gen SKIP (no local tokenizer)")
        return
    from app.dataset_gen import generate_dataset
    out = Path(tmp) / "ds"
    r = generate_dataset(tokenizer_path=str(tok), input_len=32, number=6,
                         save_path=str(out), dp=1, repeat_rate=0.9, seed=42,
                         prefix_num=2, mode="text")
    ds = Path(r["dataset_path"])
    assert ds.is_file() and ds.stat().st_size > 0
    lines = ds.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 6, f"expected 6 rows, got {len(lines)}"
    import json as _json
    for ln in lines:
        row = _json.loads(ln)
        assert row, "empty row"
    assert Path(r["prefix_path"]).is_file()
    print("dataset gen (real tokenizer, offline) OK")


def test_tokenizer_mgr(tmp):
    from app import tokenizer_mgr
    tok = ROOT / "assets" / "model" / "Qwen3-0.6B"
    if not (tok / "tokenizer.json").exists():
        print("tokenizer mgr SKIP (no local tokenizer)")
        return
    reg = tokenizer_mgr.register("test-pack", str(tok))
    assert reg["source"] == "custom"
    assert tokenizer_mgr.resolve("test-pack") == str(tok)
    try:
        tokenizer_mgr.register("bad", str(tmp))  # dir without tokenizer files
        raise AssertionError("must reject dir without tokenizer files")
    except ValueError:
        pass
    v = tokenizer_mgr.verify("test-pack")
    assert v["ok"] and v["vocab_size"] > 100000, v
    tokenizer_mgr.delete("test-pack")
    try:
        tokenizer_mgr.resolve("test-pack")
        raise AssertionError("deleted tokenizer must not resolve")
    except ValueError:
        pass
    print("tokenizer mgr OK")


def test_resolve_command():
    """Frozen builds are self-contained (self re-entry); source keeps external CLI."""
    from app import runner
    argv, child = runner.resolve_command("ais_bench", frozen=False)
    assert argv == ["ais_bench"] and not child
    argv, child = runner.resolve_command("", frozen=False)
    assert argv == ["ais_bench"] and not child
    argv, child = runner.resolve_command("py -3.11 mock.py", frozen=False)
    assert argv == ["py", "-3.11", "mock.py"] and not child
    # frozen: default / legacy value / explicit marker → self re-entry
    for cmd in ("", "ais_bench", "D:\\x\\app.exe --child-aisbench"):
        argv, child = runner.resolve_command(cmd, frozen=True)
        assert child, cmd
    assert runner.resolve_command("", frozen=True)[0][1] == "--child-aisbench"
    # frozen custom command (mock) still honored
    argv, child = runner.resolve_command("py -3.11 mock.py", frozen=True)
    assert not child and argv == ["py", "-3.11", "mock.py"]
    print("resolve command OK")


def _sla_fake_runner(ttft_p90_ms: float):
    """Patch runner.start_run so probes complete instantly with fixed ttft_p90."""
    from app import runner as _runner
    orig = _runner.start_run

    def fake_start(run_id, loop=None):
        c = store.get_run(run_id)["config"]["concurrency"]
        store.update_run(run_id, status="completed")
        store.upsert_round(run_id, 1, "full", False, {},
                           {"ttft_p90_ms": ttft_p90_ms}, {})
    _runner.start_run = fake_start
    return orig


def test_sla_preflight_fastfail():
    """Threshold impossible even at concurrency=1 → refuse without the search."""
    from app.sla import SlaTuner
    orig = _sla_fake_runner(9000.0)
    try:
        t = SlaTuner("pf1", {"host_ip": "h", "host_port": 1, "seed": 1,
                             "input_len": 64, "data_num": 2, "prefix_num": 1,
                             "repeat_rate": "90%", "dp": 1},
                     {"ttft_p90": 5000}, 4, 32, None)
        t._prepare_dataset = lambda rc: {"prefix_path": "", "dataset_path": "x"}
        t.run()
    finally:
        from app import runner as _runner
        _runner.start_run = orig
    assert t.max_ok == 0
    assert t.state == "done" and len(t.probes) == 1 and t.probes[0].get("preflight")
    assert "预检失败" in t.note, t.note
    print("sla preflight fast-fail OK")


def test_sla_search_fake_runner():
    """All probes pass → ladder covers [start..max] and max_ok == max."""
    from app.sla import SlaTuner
    orig = _sla_fake_runner(100.0)
    try:
        t = SlaTuner("fs1", {"host_ip": "h", "host_port": 1, "seed": 1,
                             "input_len": 64, "data_num": 2, "prefix_num": 1,
                             "repeat_rate": "90%", "dp": 1},
                     {"ttft_p90": 100000}, 2, 4, None)
        t._prepare_dataset = lambda rc: {"prefix_path": "", "dataset_path": "x"}
        t.run()
    finally:
        from app import runner as _runner
        _runner.start_run = orig
    assert t.state == "done" and t.max_ok == 4
    # preflight runs first when start_c > 1, then the ladder
    assert [p["concurrency"] for p in t.probes] == [1, 2, 4], t.probes
    assert t.probes[0].get("preflight") and all(p["ok"] for p in t.probes)
    print("sla search fake-runner OK")


if __name__ == "__main__":
    tmp = tempfile.mkdtemp(prefix="pt_features_")
    config.init_home(str(tmp))
    store.connect()
    test_sla_spec()
    test_validate_config()
    test_pod_and_events()
    test_metrics_hit_rate()
    test_parse_pod_and_metrics_text()
    test_runner_normalize()
    test_aisbench_env(tmp)
    test_store_kinds_delete_sla_jobs()
    test_sla_check_matrix()
    test_parse_aisbench_log(tmp)
    test_dataset_gen_real(tmp)
    test_tokenizer_mgr(tmp)
    test_resolve_command()
    test_sla_preflight_fastfail()
    test_sla_search_fake_runner()
    # compare + reports need runs in the same home
    test_compare_engine(tmp)
    test_reports(tmp)
    print("ALL FEATURE TESTS PASSED")
