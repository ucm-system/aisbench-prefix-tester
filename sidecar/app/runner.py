"""Run orchestration: rounds × (warmup → full) with live metrics & cache resets.

Port of prefix_bench.py::run_single_round with desktop additions:
  - per-phase snapshot-diff hit rates broadcast over the event bus
  - cache_reset policy (each_round | first_round_only | never) calling
    POST /reset_prefix_cache on every pod, plus residual-cache risk detection
  - cooperative cancel, process-tree kill, crash-safe on-disk artifacts
"""
from __future__ import annotations

import asyncio
import copy
import json
import logging
import os
import shlex
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Dict, Optional

from . import aisbench_env, config, events, metrics, store, tokenizer_mgr
from .dataset_gen import DatasetCancelled, generate_dataset, parse_prefix_ratio
from .result_parse import build_result_row, parse_aisbench_log, write_results

logger = logging.getLogger(__name__)

ROUND_OVERRIDABLE_KEYS = [
    "input_len", "output_len", "data_num", "concurrency",
    "request_rate", "prefix_num", "repeat_rate", "dp", "seed", "test_name",
]

DEFAULTS = {
    "host_ip": "localhost", "host_port": 8000, "url": "",
    "model_name": "", "model_path": "", "npu_num": 1,
    "test_name": "", "input_len": 3500, "output_len": 1500,
    "data_num": 8192, "concurrency": 2048, "request_rate": 0,
    "test_type": "stream", "enable_think": False,
    "prefix_num": 1, "repeat_rate": 0.5, "dp": 1, "seed": 1,
    "length_mean": None, "length_std": None, "length_min": None, "length_max": None,
    "summarizer": "default_perf", "api_key": "",
    "pod_info": [], "tokenizer": "", "vocab_file": None, "dataset_mode": "text",
    "dataset_id": None,
    "cache_reset": "each_round",        # each_round | first_round_only | never
    "per_round_seed_offset": False,     # round i uses seed + (i-1)*1000
    "collection_interval": 5.0,
}

_active: Dict[str, "RunHandle"] = {}
_lock = threading.Lock()


class RunHandle:
    def __init__(self, run_id: str, loop: asyncio.AbstractEventLoop):
        self.run_id = run_id
        self.loop = loop
        self.cancelled = threading.Event()
        self.proc: Optional[subprocess.Popen] = None
        self.thread: Optional[threading.Thread] = None
        self.phase = ""
        self.round_index = 0
        self.total_rounds = 1


def get_active(run_id: str) -> Optional[RunHandle]:
    return _active.get(run_id)


def start_run(run_id: str, loop: asyncio.AbstractEventLoop) -> None:
    handle = RunHandle(run_id, loop)
    handle.thread = threading.Thread(target=_execute, args=(handle,), daemon=True,
                                     name=f"run-{run_id}")
    with _lock:
        _active[run_id] = handle
    handle.thread.start()


def stop_run(run_id: str) -> bool:
    handle = _active.get(run_id)
    if not handle:
        return False
    handle.cancelled.set()
    _kill_tree(handle.proc)
    return True


def _kill_tree(proc: Optional[subprocess.Popen]) -> None:
    if proc is None or proc.poll() is not None:
        return
    try:
        if config.IS_WINDOWS:
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                           capture_output=True, timeout=10)
        else:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except Exception:  # noqa: BLE001
        try:
            proc.kill()
        except Exception:  # noqa: BLE001
            pass


def _status(handle: RunHandle, status: str, **extra) -> None:
    store.update_run(handle.run_id, status=status)
    events.publish(handle.run_id, "status", status=status,
                   round=handle.round_index, total_rounds=handle.total_rounds,
                   phase=handle.phase, **extra)


def _sync_await(coro):
    """Run a coroutine on the sidecar's asyncio loop from the runner thread."""
    fut = asyncio.run_coroutine_threadsafe(coro, _main_loop)
    return fut.result(timeout=60)


_main_loop: Optional[asyncio.AbstractEventLoop] = None


def bind_loop(loop: asyncio.AbstractEventLoop) -> None:
    global _main_loop
    _main_loop = loop


# ---------------------------------------------------------------------------
# Execution
# ---------------------------------------------------------------------------

def _normalize(cfg: dict) -> dict:
    out = copy.deepcopy(DEFAULTS)
    for key in out:
        if key in cfg and cfg[key] is not None:
            out[key] = cfg[key]
    if isinstance(out["repeat_rate"], str):
        out["repeat_rate"] = parse_prefix_ratio(out["repeat_rate"])
    out["pod_info"] = [p for p in (out["pod_info"] or []) if str(p).strip()]
    if not out["pod_info"]:
        if out["url"]:
            import re
            m = re.search(r"https?://([^:/]+):(\d+)", out["url"])
            out["pod_info"] = [f"{m.group(1)}:{m.group(2)}"] if m else []
        if not out["pod_info"]:
            out["pod_info"] = [f"{out['host_ip']}:{out['host_port']}"]
    rounds = cfg.get("rounds") or [{}]
    if isinstance(rounds, dict):
        rounds = [rounds]
    cleaned = []
    for r in rounds:
        if not isinstance(r, dict):
            raise ValueError(f"rounds[{r!r}] 必须是对象")
        cleaned.append({k: v for k, v in r.items() if k in ROUND_OVERRIDABLE_KEYS})
    out["rounds"] = cleaned or [{}]
    return out


def _execute(handle: RunHandle) -> None:
    run_id = handle.run_id
    run = store.get_run(run_id)
    cfg = _normalize(run["config"])
    run_dir = config.outputs_dir() / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "config.json").write_text(json.dumps(cfg, ensure_ascii=False, indent=2),
                                         encoding="utf-8")
    stdout_log = open(run_dir / "stdout.log", "a", encoding="utf-8")
    stderr_log = open(run_dir / "stderr.log", "a", encoding="utf-8")
    ts_file = open(run_dir / "metrics_timeseries.jsonl", "a", encoding="utf-8")

    def on_sample(sample: dict) -> None:
        ts_file.write(json.dumps(sample, ensure_ascii=False) + "\n")
        ts_file.flush()
        flat = {}
        for key, counters in sample["engines"].items():
            for k, v in counters.items():
                flat[k] = v  # last-wins for UI big numbers; per-engine kept in file
        events.publish(run_id, "metrics", sample={**sample, "flat": flat})

    collector = metrics.Collector(cfg["pod_info"], cfg["collection_interval"], on_sample)

    def collector_snapshot():
        return _sync_await(collector.snapshot())

    handle.total_rounds = len(cfg["rounds"])
    # AISBench workspace. When `work_path` is configured (pip-installed
    # ais_bench -> site-packages root), configs/datasets must be written into
    # the package itself for name-based resolution, so no per-run subdir.
    # Otherwise (mock/dev), isolate per run to avoid clobbering.
    wp_setting = store.get_setting("work_path", "")
    child_mode = _is_child_mode(store.get_setting("aisbench_command", ""))
    work_path = (wp_setting if wp_setting else str(config.work_path() / run_id))
    run_work = str(Path(work_path) / run_id) if wp_setting else work_path
    try:
        _sync_await(collector.start())
        _status(handle, "running")
        settings_cmd = store.get_setting("aisbench_command", "ais_bench")
        run_failed = False

        for round_index, overrides in enumerate(cfg["rounds"], start=1):
            if handle.cancelled.is_set():
                break
            rc = _merge_round(cfg, overrides)
            rc["repeat_rate"] = parse_prefix_ratio(rc["repeat_rate"])
            if not rc.get("model_path") and rc.get("tokenizer"):
                try:
                    rc["model_path"] = tokenizer_mgr.resolve(rc["tokenizer"])
                except ValueError:
                    pass
            if cfg["per_round_seed_offset"] and round_index > 1:
                rc["seed"] = int(rc["seed"]) + (round_index - 1) * 1000
            handle.round_index = round_index
            handle.phase = "warmup"
            events.publish(run_id, "status", status="running", round=round_index,
                           total_rounds=handle.total_rounds, phase="warmup")

            warnings = _reset_cache_if_needed(handle, cfg, round_index)

            # ---- dataset (generate or reuse) ----
            dataset = _ensure_dataset(handle, rc, cfg, str(run_dir))
            prefix_file, data_file = dataset["prefix_path"], dataset["dataset_path"]

            child_mode = _is_child_mode(settings_cmd)
            pt_configs = run_dir / "pt_configs"
            (pt_configs / "models").mkdir(parents=True, exist_ok=True)
            # child mode resolves configs via --config-dir (pt_configs);
            # source mode resolves via the ais_bench package/workspace (work_path)
            cfg_root = str(pt_configs) if child_mode else work_path

            # ---- phase 1: warmup (concurrency=dp, output_len=1) ----
            events.publish(run_id, "log", stream="stdout",
                           line=f"[Round {round_index}/{handle.total_rounds}] Phase 1 warmup: "
                                f"concurrency={rc['dp']}, output_len=1")
            model_cfg_path = aisbench_env.write_model_config(
                cfg_root,
                rc["model_path"], rc["model_name"], rc["host_ip"], rc["host_port"],
                rc["url"], rc["dp"], 1, rc["request_rate"], rc["test_type"],
                rc["enable_think"], rc.get("api_key", ""))
            import shutil as _shutil
            (pt_configs / "models").mkdir(parents=True, exist_ok=True)
            _shutil.copyfile(model_cfg_path, pt_configs / "models" / "vllm_api_chat_temp.py")
            ds_link = None
            if prefix_file:
                ds_link = aisbench_env.link_dataset(cfg_root, prefix_file)
            if child_mode:
                ds_cfg_out = pt_configs / "datasets" / "gsm8k_gen_0_shot_cot_str_perf.py"
                ds_cfg_out.parent.mkdir(parents=True, exist_ok=True)
                aisbench_env.write_dataset_config(ds_link or data_file, str(ds_cfg_out))
                aisbench_env.copy_summarizer(cfg["summarizer"], str(pt_configs))
                base_args = aisbench_env.build_aisbench_command(
                    cfg["summarizer"], str(run_dir / "results"))
                aisbench_args = (["--config-dir", str(pt_configs),
                                  "--models", "vllm_api_chat_temp",
                                  "--datasets", "gsm8k_gen_0_shot_cot_str_perf"]
                                 + base_args[4:])
            else:
                aisbench_args = aisbench_env.build_aisbench_command(
                    cfg["summarizer"], str(run_dir / "results"))
            before = collector_snapshot()
            ret = _run_phase(handle, settings_cmd, aisbench_args, stdout_log, stderr_log, work_path)
            after = collector_snapshot()
            rate = metrics.compute_hit_rate(before, after)
            events.publish(run_id, "phase_rate", round=round_index, phase="warmup", rate=rate)
            perf, _ = parse_aisbench_log(str(run_dir / "aisbench.log"),
                                         str(rc["request_rate"]), rc["npu_num"])
            row = build_result_row(perf, rate, rc, phase="warmup", round_index=round_index,
                                   warnings=";".join(warnings))
            write_results(row, str(run_dir))
            store.upsert_round(run_id, round_index, "warmup", True, rc, perf, rate,
                               ";".join(warnings))
            events.publish(run_id, "result", round=round_index, phase="warmup", row=row)

            if handle.cancelled.is_set():
                break

            # ---- phase 2: full ----
            handle.phase = "full"
            events.publish(run_id, "status", status="running", round=round_index,
                           total_rounds=handle.total_rounds, phase="full")
            events.publish(run_id, "log", stream="stdout",
                           line=f"[Round {round_index}/{handle.total_rounds}] Phase 2 full: "
                                f"concurrency={rc['concurrency']}, output_len={rc['output_len']}")
            model_cfg_path = aisbench_env.write_model_config(
                cfg_root,
                rc["model_path"], rc["model_name"], rc["host_ip"], rc["host_port"],
                rc["url"], rc["concurrency"], rc["output_len"], rc["request_rate"],
                rc["test_type"], rc["enable_think"], rc.get("api_key", ""))
            import shutil as _shutil
            (pt_configs / "models").mkdir(parents=True, exist_ok=True)
            _shutil.copyfile(model_cfg_path, pt_configs / "models" / "vllm_api_chat_temp.py")
            ds_link = aisbench_env.link_dataset(cfg_root, data_file)
            if child_mode:
                ds_cfg_out = pt_configs / "datasets" / "gsm8k_gen_0_shot_cot_str_perf.py"
                ds_cfg_out.parent.mkdir(parents=True, exist_ok=True)
                aisbench_env.write_dataset_config(ds_link or data_file, str(ds_cfg_out))
            before = collector_snapshot()
            ret = _run_phase(handle, settings_cmd, aisbench_args, stdout_log, stderr_log, work_path)
            if ret != 0 and not handle.cancelled.is_set():
                _status(handle, "failed", exit_code=ret)
                events.publish(run_id, "log", stream="stderr",
                               line=f"AISBench exited with code {ret}")
                run_failed = True
                break
            after = collector_snapshot()
            rate = metrics.compute_hit_rate(before, after)
            events.publish(run_id, "phase_rate", round=round_index, phase="full", rate=rate)
            perf, _ = parse_aisbench_log(str(run_dir / "aisbench.log"),
                                         str(rc["request_rate"]), rc["npu_num"])
            row = build_result_row(perf, rate, rc, phase="full", round_index=round_index,
                                   warnings=";".join(warnings))
            write_results(row, str(run_dir))
            store.upsert_round(run_id, round_index, "full", False, rc, perf, rate,
                               ";".join(warnings))
            events.publish(run_id, "result", round=round_index, phase="full", row=row)

        if handle.cancelled.is_set():
            _status(handle, "cancelled")
        elif not run_failed:
            # never overwrite a failed/cancelled status set inside the loop
            _status(handle, "completed")
    except DatasetCancelled:
        _status(handle, "cancelled")
    except Exception as exc:  # noqa: BLE001
        logger.exception("run %s failed", run_id)
        events.publish(run_id, "log", stream="stderr", line=f"runner error: {exc}")
        _status(handle, "failed", error=str(exc)[:300])
    finally:
        _sync_await(collector.stop())
        stdout_log.close()
        stderr_log.close()
        ts_file.close()
        with _lock:
            _active.pop(run_id, None)


def _is_child_mode(settings_cmd: str) -> bool:
    return "--child-aisbench" in (settings_cmd or "")


def _merge_round(cfg: dict, overrides: dict) -> dict:
    rc = {k: v for k, v in cfg.items() if k != "rounds"}
    rc.update(overrides)
    if isinstance(rc["repeat_rate"], str):
        rc["repeat_rate"] = parse_prefix_ratio(rc["repeat_rate"])
    return rc


def _reset_cache_if_needed(handle: RunHandle, cfg: dict, round_index: int) -> list[str]:
    policy = cfg.get("cache_reset", "each_round")
    warnings: list[str] = []
    need = (policy == "each_round") or (policy == "first_round_only" and round_index == 1)
    if policy == "never":
        warnings.append("cache_reset=never: 轮间可能存在残留命中")
        events.publish(handle.run_id, "warning", message=warnings[0])
        return warnings
    if not need:
        return warnings
    events.publish(handle.run_id, "log", stream="stdout",
                   line=f"[Round {round_index}] resetting prefix cache on {len(cfg['pod_info'])} pod(s)")
    results = _sync_await(metrics.reset_prefix_cache(cfg["pod_info"]))
    failed = {p: r for p, r in results.items() if r != "ok"}
    if failed:
        warnings.append(f"cache reset failed on {len(failed)} pod(s); residual hits possible")
        events.publish(handle.run_id, "warning",
                       message=f"reset_prefix_cache 失败: {failed}，轮间可能残留命中")
    events.publish(handle.run_id, "cache_reset", results=results, round=round_index)
    return warnings


def _ensure_dataset(handle: RunHandle, rc: dict, cfg: dict, run_dir: str) -> dict:
    if cfg.get("dataset_files"):
        return {"prefix_path": cfg["dataset_files"].get("prefix_path", ""),
                "dataset_path": cfg["dataset_files"]["dataset_path"]}
    if cfg.get("dataset_id"):
        ds = store.get_dataset(cfg["dataset_id"])
        if ds and ds.get("files"):
            return {"prefix_path": ds["files"].get("prefix_path", ""),
                    "dataset_path": ds["files"]["dataset_path"]}
    tokenizer = rc.get("tokenizer") or rc["model_path"]
    try:
        tokenizer = tokenizer_mgr.resolve(tokenizer)  # registry name -> local path
    except ValueError:
        pass  # a raw model-dir path: resolve() already validated existence
    events.publish(handle.run_id, "progress", stage="dataset", percent=0.0)

    def progress(done: int, total: int) -> bool:
        events.publish(handle.run_id, "progress", stage="dataset",
                       percent=round(100.0 * done / max(1, total), 1))
        return not handle.cancelled.is_set()

    result = generate_dataset(
        tokenizer_path=tokenizer,
        input_len=int(rc["input_len"]),
        number=int(rc["data_num"]),
        save_path=str(config.datasets_dir()),
        dp=int(rc["dp"]),
        repeat_rate=float(rc["repeat_rate"]),
        seed=int(rc["seed"]),
        prefix_num=int(rc["prefix_num"]),
        mode=cfg.get("dataset_mode", "text"),
        vocab_file=cfg.get("vocab_file"),
        progress=progress,
    )
    events.publish(handle.run_id, "progress", stage="dataset", percent=100.0)
    return result


def _run_phase(handle: RunHandle, command: str, args: list[str],
               stdout_log, stderr_log, work_path: str) -> int:
    if command and store.get_setting("aisbench_command") is None and getattr(sys, "frozen", False):
        # packaged exe: self-reuse to run the bundled ais_bench CLI
        argv = [sys.executable, "--child-aisbench"] + args
    else:
        argv = shlex.split(command, posix=False) + args if command else args
    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    env["AISBENCH_PT_WORK"] = work_path  # workspace root (mock_aisbench reads it)
    # benchmark traffic must reach the service directly: kill proxy env vars and
    # the Windows registry proxy that requests/urllib would otherwise honor
    for k in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
              "http_proxy", "https_proxy", "all_proxy"):
        env.pop(k, None)
    env["NO_PROXY"] = "*"
    env["no_proxy"] = "*"
    # ais_bench imports unix-only fcntl/resource; shim them on Windows
    if config.IS_WINDOWS:
        compat_dir = str(Path(__file__).resolve().parent / "compat")
        env["PYTHONPATH"] = compat_dir + os.pathsep + env.get("PYTHONPATH", "")
    events.publish(handle.run_id, "log", stream="stdout",
                   line="$ " + " ".join(argv))
    # mirrors the original tool's `> aisbench.log` redirect: parse_aisbench_log
    # consumes this file after each phase
    aisbench_log = open(config.outputs_dir() / handle.run_id / "aisbench.log",
                        "a", encoding="utf-8")
    handle.proc = subprocess.Popen(
        argv, cwd=str(config.outputs_dir() / handle.run_id), env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        encoding="utf-8", errors="replace", bufsize=1)
    assert handle.proc.stdout is not None
    pyi_error = False
    for line in handle.proc.stdout:
        if not pyi_error and "PYI-" in line and "ERROR" in line:
            # PyInstaller bootstrap crash inside a re-invoked child (e.g. task
            # script re-entered the exe). Some wrappers still exit 0, so this
            # must never be reported as a successful phase (mock false positive).
            pyi_error = True
        stdout_log.write(line)
        aisbench_log.write(line)
        stdout_log.flush()
        aisbench_log.flush()
        events.publish_log(handle.run_id, "stdout", line)
    ret = handle.proc.wait()
    handle.proc = None
    aisbench_log.close()
    if pyi_error:
        stderr_log.write("[PYI-ERROR in child output; phase marked failed]\n")
        stderr_log.flush()
        events.publish(handle.run_id, "log", stream="stderr",
                       line="PyInstaller bootstrap error in AISBench output; marking phase failed")
        ret = ret or 1
    if ret != 0:
        stderr_log.write(f"[exit {ret}]\n")
        stderr_log.flush()
    return ret
