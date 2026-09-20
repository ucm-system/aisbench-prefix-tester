"""SLA auto-tune: find the max concurrency that still meets latency/throughput
targets under a FIXED workload shape (same dataset ⇒ same hit-rate context),
in the spirit of EvalScope's SLA auto-tuning.

Strategy: exponential ladder from `start_concurrency` (×2) until the SLA breaks
or `max_concurrency` is reached, then binary search between the last good and
first bad probe. Every probe is a real run (single round) executed by the
runner, so results come from the same pipeline as manual tests.
"""
from __future__ import annotations

import json
import threading
import time
import uuid
from pathlib import Path
from typing import Callable, Optional

from . import config, events, runner, store
from .dataset_gen import generate_dataset, parse_prefix_ratio

_JOBS: dict[str, "SlaTuner"] = {}
_lock = threading.Lock()

# SLA condition keys: "<metric>_<stat>" with metric in ttft/tpot/e2el and
# stat in avg/min/max/median/p50/p75/p90/p99 (any percentile the AISBench
# perf table reports), plus "throughput_min" for a floor on output throughput.
SLA_METRICS = {"ttft": "TTFT", "tpot": "TPOT", "e2el": "E2EL"}
SLA_STATS = ("avg", "min", "max", "median", "p50", "p75", "p90", "p99")


def sla_label(key: str) -> str:
    if key == "throughput_min":
        return "输出吞吐下限 (tok/s)"
    metric, _, stat = key.partition("_")
    return f"{SLA_METRICS.get(metric, metric)} {stat.upper()} (ms)"


def parse_sla_spec(sla: dict) -> dict:
    """Normalize {ttft_p90: 3000, throughput_min: 100, ...} → limits dict.

    Tolerates the `ttft_p90_ms` style (trailing `_ms`) that older clients send.
    """
    out = {}
    for key, value in sla.items():
        if value is None:
            continue
        try:
            fv = float(value)
        except (TypeError, ValueError):
            raise ValueError(f"SLA 值必须是数字: {key}={value!r}")
        if fv <= 0:
            raise ValueError(f"SLA 值必须 > 0: {key}={value!r}（0 或负数的阈值无意义）")
        if key == "throughput_min":
            out[key] = fv
            continue
        norm = key.removesuffix("_ms")
        metric, _, stat = norm.partition("_")
        if metric not in SLA_METRICS or stat not in SLA_STATS:
            raise ValueError(f"unknown SLA key: {key}")
        out[norm] = fv
    return out


def get_job(job_id: str) -> Optional[dict]:
    with _lock:
        t = _JOBS.get(job_id)
    return t.snapshot() if t else None


def is_alive(job_id: str) -> bool:
    """True while the tuner thread is registered in this process (a DB row
    whose job is NOT alive and still shows a non-terminal state is stale)."""
    with _lock:
        return job_id in _JOBS


def cancel_job(job_id: str) -> bool:
    with _lock:
        t = _JOBS.get(job_id)
    if not t:
        return False
    t.cancelled.set()
    return True


class SlaTuner(threading.Thread):
    def __init__(self, job_id: str, base_cfg: dict, sla: dict, start_c: int,
                 max_c: int, loop):
        super().__init__(daemon=True, name=f"sla-{job_id}")
        self.job_id = job_id
        self.base_cfg = dict(base_cfg)
        self.sla = parse_sla_spec(sla)
        self.start_c = max(1, int(start_c))
        self.max_c = max(self.start_c, int(max_c))
        self.loop = loop
        self.cancelled = threading.Event()
        self.probes: list[dict] = []
        self.state = "pending"
        self.max_ok: Optional[int] = None
        self.dataset_files: Optional[dict] = None
        self.note = ""
        self.created_at = time.time()

    # ---------------------------------------------------------------- state
    def snapshot(self) -> dict:
        with _lock:
            return {
                "job_id": self.job_id, "state": self.state,
                "created_at": self.created_at,
                "sla": self.sla, "max_ok": self.max_ok,
                "probes": [dict(p) for p in self.probes], "note": self.note,
                "current": getattr(self, "current", None),
            }

    def _publish(self):
        events.publish("*", "sla", **self.snapshot())
        try:
            store.save_sla_job(self.snapshot())
        except Exception:  # noqa: BLE001 — persistence must never break tuning
            pass

    def _set(self, state: str, **kw):
        self.state = state
        for k, v in kw.items():
            setattr(self, k, v)
        self._publish()

    # ---------------------------------------------------------------- probes
    def _probe(self, concurrency: int) -> dict:
        t0 = time.time()
        cfg = dict(self.base_cfg)
        cfg["concurrency"] = concurrency
        cfg["test_name"] = f"sla-c{concurrency}"
        if self.dataset_files:
            cfg["dataset_files"] = self.dataset_files
        cfg.pop("rounds", None)
        run_id = store.create_run(cfg, name=(f"SLA c={concurrency}"
                                             + (f" · {self.base_cfg.get('test_name')}"
                                                if self.base_cfg.get('test_name') else "")),
                                  kind="sla")
        runner.start_run(run_id, self.loop)
        while True:
            if self.cancelled.is_set():
                runner.stop_run(run_id)
                return {"concurrency": concurrency, "ok": False, "run_id": run_id,
                        "state": "cancelled", "elapsed_s": round(time.time() - t0, 1)}
            d = store.get_run(run_id)
            if d is None:
                # run deleted under us → treat as interrupted
                return {"concurrency": concurrency, "ok": False, "run_id": run_id,
                        "state": "cancelled", "reason": "run deleted",
                        "elapsed_s": round(time.time() - t0, 1)}
            if d["status"] in ("completed", "failed", "cancelled"):
                break
            time.sleep(2)
        fulls = [r for r in store.get_rounds(run_id) if r["phase"] == "full"]
        if not fulls:
            return {"concurrency": concurrency, "ok": False, "run_id": run_id,
                    "state": d["status"], "reason": "no full-phase result",
                    "elapsed_s": round(time.time() - t0, 1)}
        m = fulls[0]["metrics"]
        h = (fulls[0]["hit_rate"] or {}).get("aggregated", {})
        probe = {
            "concurrency": concurrency, "run_id": run_id, "state": d["status"],
            "elapsed_s": round(time.time() - t0, 1),
            "ttft_avg_ms": m.get("ttft_avg_ms", -1),
            "ttft_p90_ms": m.get("ttft_p90_ms", -1),
            "tpot_avg_ms": m.get("tpot_avg_ms", -1),
            "tpot_p90_ms": m.get("tpot_p90_ms", -1),
            "output_token_throughput": m.get("output_token_throughput", -1),
            "hbm_hit_rate": h.get("hbm_hit_rate", 0.0),
            "ext_hit_rate": h.get("ext_hit_rate", 0.0),
        }
        ok, reason = self._sla_check(probe)
        probe["ok"] = ok and d["status"] == "completed"
        probe["reason"] = reason
        return probe

    def _sla_check(self, probe: dict) -> tuple[bool, str]:
        if probe.get("state") != "completed":
            return False, f"run {probe.get('state')}"
        bad = []
        for key, limit in self.sla.items():
            if key == "throughput_min":
                v = probe.get("output_token_throughput", -1)
                if v < limit:
                    bad.append(f"吞吐 {v:.0f} < {limit:.0f}")
                continue
            v = probe.get(key + "_ms", -1)
            if v < 0:
                bad.append(f"{sla_label(key)} 无数据")
            elif v > limit:
                bad.append(f"{sla_label(key)} {v:.0f} > {limit:.0f}")
        return (False, "; ".join(bad)) if bad else (True, "SLA 满足")

    # ---------------------------------------------------------------- search
    def _preflight(self) -> Optional[dict]:
        """One probe at concurrency=1: the latency-easiest point. If the SLA
        already fails here, no feasible concurrency exists — fail fast with
        measured evidence instead of burning the whole ladder+bisect search."""
        if not any(k != "throughput_min" for k in self.sla):
            return None  # throughput-only SLA: c=1 is the hardest point, no conclusion
        if self.start_c <= 1:
            return None  # the ladder's first probe IS the preflight
        pre = self._probe(1)
        pre["preflight"] = True
        self.probes.append(pre)
        self._publish()
        if not pre["ok"]:
            self.max_ok = 0
            self.note = ("预检失败：并发=1 即无法满足 SLA（" + (pre.get("reason") or "") +
                         "）；阈值与真实服务能力矛盾，请放宽后重试")
            self._set("done")
            return pre
        return pre

    def run(self):
        try:
            self._set("running")
            # generate the dataset once so every probe shares the hit-rate context
            rc = dict(self.base_cfg)
            self.dataset_files = self._prepare_dataset(rc)
            self.note = f"数据集已生成（所有探针复用，命中率口径一致）"
            self._publish()

            pre = self._preflight()
            if pre is not None and not pre["ok"]:
                return

            # phase 1: exponential ladder
            cur = self.start_c
            last_ok = None
            first_bad = None
            while cur <= self.max_c and not self.cancelled.is_set():
                self._set("ladder", current=cur)
                probe = self._probe(cur)
                self.probes.append(probe)
                self._publish()
                if probe["ok"]:
                    last_ok = probe
                    cur *= 2
                else:
                    first_bad = probe
                    break
            if last_ok is None and first_bad is None:
                self.max_ok = self.max_c  # never broken within bounds
            elif last_ok is None:
                self.max_ok = 0
            # phase 2: binary search
            lo = last_ok["concurrency"] if last_ok else 0
            hi = first_bad["concurrency"] if first_bad else None
            if hi is not None:
                it = 0
                while hi - lo > max(2, lo // 8) and it < 5 and not self.cancelled.is_set():
                    mid = (lo + hi) // 2
                    self._set("bisect", current=mid)
                    probe = self._probe(mid)
                    self.probes.append(probe)
                    self._publish()
                    if probe["ok"]:
                        lo = mid
                        if last_ok is None or mid > last_ok["concurrency"]:
                            last_ok = probe
                    else:
                        hi = mid
                        first_bad = first_bad or probe
                    it += 1
            self.max_ok = last_ok["concurrency"] if last_ok else (
                self.max_c if first_bad is None else 0)
            self.note = (f"SLA 内最大并发 = {self.max_ok}"
                         if not self.cancelled.is_set() else "已取消")
            self._set("done")
        except Exception as exc:  # noqa: BLE001
            self.state = "failed"
            self.note = str(exc)[:300]
            self._publish()

    def _prepare_dataset(self, rc: dict) -> dict:
        if rc.get("dataset_id"):
            ds = store.get_dataset(rc["dataset_id"])
            if ds and ds.get("files"):
                return {"prefix_path": ds["files"].get("prefix_path", ""),
                        "dataset_path": ds["files"]["dataset_path"]}
        tokenizer = tokenizer_resolve(rc)
        result = generate_dataset(
            tokenizer_path=tokenizer,
            input_len=int(rc["input_len"]), number=int(rc["data_num"]),
            save_path=str(config.datasets_dir()), dp=int(rc["dp"]),
            repeat_rate=parse_prefix_ratio(rc["repeat_rate"]), seed=int(rc["seed"]),
            prefix_num=int(rc["prefix_num"]), mode=rc.get("dataset_mode", "text"),
            vocab_file=rc.get("vocab_file"),
        )
        return {"prefix_path": result["prefix_path"],
                "dataset_path": result["dataset_path"]}


def tokenizer_resolve(rc: dict) -> str:
    from . import tokenizer_mgr
    tok = rc.get("tokenizer") or rc.get("model_path")
    try:
        return tokenizer_mgr.resolve(tok)
    except ValueError:
        return tok


def start_job(base_cfg: dict, sla: dict, start_c: int, max_c: int, loop) -> str:
    job_id = uuid.uuid4().hex[:10]
    t = SlaTuner(job_id, base_cfg, sla, start_c, max_c, loop)
    with _lock:
        _JOBS[job_id] = t
    t.start()
    return job_id
