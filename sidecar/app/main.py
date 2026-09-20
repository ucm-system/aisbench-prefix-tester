"""Sidecar entry: FastAPI on 127.0.0.1:<ephemeral> behind a bearer token.

Launch:  python -m app.main --home <dir> --port-file <path>
The bound port + token are written to the port file for Electron/IPC discovery.
"""
from __future__ import annotations

import argparse
import asyncio
import os
import json
import logging
import secrets
import shlex
import shutil
import threading
import time
import uuid
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

from . import compare as compare_mod
from . import config, events, metrics, report, runner, sla, store, tokenizer_mgr
from .dataset_gen import DatasetCancelled, generate_dataset, preview_dataset
from .version import SIDECAR_VERSION

logging.basicConfig(level=logging.INFO, format="[sidecar %(levelname)s] %(message)s")
logger = logging.getLogger("sidecar")

app = FastAPI(title="AISBench Prefix Tester Sidecar", version=SIDECAR_VERSION)
# The sidecar binds 127.0.0.1 only and every request is bearer-token guarded,
# so a permissive CORS policy is safe (renderer origins vary in dev/Electron).
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"],
                   allow_headers=["*"])
_state = {"token": "", "started_at": time.time()}

_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()


def _auth(authorization: str) -> None:
    if not authorization or not authorization.endswith(_state["token"]) or \
            not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="unauthorized")


def _auth_query(token: str) -> None:
    """Alternative auth for browser downloads (window.open cannot set headers)."""
    if token != _state["token"]:
        raise HTTPException(status_code=401, detail="unauthorized")


# --------------------------------------------------------------------------- models
class TokenizerReq(BaseModel):
    name: str = ""
    path: str


class DatasetPreviewReq(BaseModel):
    tokenizer: str
    input_len: int = 32768
    repeat_rate: float | str = 0.9
    prefix_num: int = 3
    seed: int = 1
    mode: str = "text"
    vocab_file: str | None = None


class DatasetGenReq(DatasetPreviewReq):
    data_num: int = 160
    dp: int = 1
    name: str = ""


class RunCreateReq(BaseModel):
    config: dict = Field(default_factory=dict)
    name: str = ""


class RunPatchReq(BaseModel):
    name: str | None = None
    notes: str | None = None
    is_practice: bool | None = None


class CompareReq(BaseModel):
    run_ids: list[str]
    exclude_warmup: bool = True
    exclude_practice: bool = True


class ValidateReq(BaseModel):
    config: dict


# --------------------------------------------------------------------------- lifecycle
@app.on_event("startup")
async def _startup() -> None:
    events.bind_loop(asyncio.get_running_loop())
    runner.bind_loop(asyncio.get_running_loop())
    store.connect()
    tokenizer_mgr.refresh_defaults()
    # auto-default the AISBench workspace to the installed package root so the
    # pip-installed CLI resolves config/dataset names without manual setup
    if not store.get_setting("work_path"):
        import sys
        if getattr(sys, "frozen", False):
            # PyInstaller onedir: collected ais_bench configs/data live in _internal
            root = os.path.dirname(sys._MEIPASS)  # noqa: SLF001
            store.set_setting("work_path", root)
            logger.info("work_path auto-set to frozen bundle %s", root)
        else:
            # find_spec locates the package without executing it (mmengine import
            # at startup costs seconds); parent of ais_bench = workspace root
            import importlib.util
            spec = importlib.util.find_spec("ais_bench")
            if spec and spec.origin:
                root = os.path.dirname(os.path.dirname(spec.origin))
                store.set_setting("work_path", root)
                logger.info("work_path auto-set to %s", root)


@app.get("/api/health")
async def health(authorization: str = Header(default="")):
    _auth(authorization)
    aisbench = store.get_setting("aisbench_command", "ais_bench")
    return {
        "status": "ok",
        "version": SIDECAR_VERSION,
        "uptime_s": round(time.time() - _state["started_at"], 1),
        "aisbench_command": aisbench,
        "home": str(config.HOME),
    }


# --------------------------------------------------------------------------- settings & presets
@app.get("/api/settings")
async def get_settings(authorization: str = Header(default="")):
    _auth(authorization)
    return {
        "aisbench_command": store.get_setting("aisbench_command", "ais_bench"),
        "collection_interval": store.get_setting("collection_interval", "5"),
        "work_path": store.get_setting("work_path", ""),
        "theme": store.get_setting("theme", "dark"),
        "language": store.get_setting("language", "zh"),
    }


@app.put("/api/settings")
async def put_settings(body: dict, authorization: str = Header(default="")):
    _auth(authorization)
    for k, v in body.items():
        store.set_setting(k, str(v))
    return {"ok": True}


@app.get("/api/presets")
async def presets_get(authorization: str = Header(default="")):
    _auth(authorization)
    return store.list_presets()


@app.post("/api/presets")
async def presets_post(body: dict, authorization: str = Header(default="")):
    _auth(authorization)
    store.save_preset(body["name"], body.get("config", {}))
    return {"ok": True}


@app.delete("/api/presets/{name}")
async def presets_delete(name: str, authorization: str = Header(default="")):
    _auth(authorization)
    store.delete_preset(name)
    return {"ok": True}


# --------------------------------------------------------------------------- tokenizers
@app.get("/api/tokenizers")
async def tokenizers_get(authorization: str = Header(default="")):
    _auth(authorization)
    return tokenizer_mgr.list_tokenizers()


@app.post("/api/tokenizers")
async def tokenizers_post(body: TokenizerReq, authorization: str = Header(default="")):
    _auth(authorization)
    try:
        return tokenizer_mgr.register(body.name, body.path)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.delete("/api/tokenizers/{name}")
async def tokenizers_delete(name: str, authorization: str = Header(default="")):
    _auth(authorization)
    tokenizer_mgr.delete(name)
    return {"ok": True}


@app.post("/api/tokenizers/verify")
async def tokenizers_verify(body: dict, authorization: str = Header(default="")):
    _auth(authorization)
    return tokenizer_mgr.verify(body.get("name_or_path", ""))


# --------------------------------------------------------------------------- datasets
@app.post("/api/datasets/preview")
async def datasets_preview(body: DatasetPreviewReq, authorization: str = Header(default="")):
    _auth(authorization)
    try:
        path = tokenizer_mgr.resolve(body.tokenizer)
        return preview_dataset(path, body.input_len, body.repeat_rate,
                               body.prefix_num, body.seed, body.mode, body.vocab_file)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)[:400])


def _run_gen_job(job_id: str, body: DatasetGenReq) -> None:
    with _jobs_lock:
        job = _jobs[job_id]

    def progress(done: int, total: int) -> bool:
        job["percent"] = round(100.0 * done / max(1, total), 1)
        events.publish("*", "job", job_id=job_id, stage="dataset",
                       percent=job["percent"], state=job["state"])
        return not job["cancel"].is_set()

    try:
        job["state"] = "running"
        path = tokenizer_mgr.resolve(body.tokenizer)
        result = generate_dataset(
            tokenizer_path=path, input_len=body.input_len, number=body.data_num,
            save_path=str(config.datasets_dir()), dp=body.dp,
            repeat_rate=body.repeat_rate, seed=body.seed, prefix_num=body.prefix_num,
            mode=body.mode, vocab_file=body.vocab_file, progress=progress)
        rr = body.repeat_rate
        rr_pct = int(float(str(rr).rstrip("%"))) if "%" in str(rr) else int(float(rr) * 100)
        ds_id = store.save_dataset({
            "name": body.name or f"{body.mode}·{body.input_len}·{rr_pct}%",
            "mode": body.mode, "tokenizer": body.tokenizer,
            "vocab_source": body.vocab_file or "tokenizer",
            "params": body.model_dump(),
            "files": {"prefix_path": result["prefix_path"],
                      "dataset_path": result["dataset_path"]},
            "stats": result["stats"],
        })
        job["state"] = "completed"
        job["result"] = {"dataset_id": ds_id, **result["stats"]}
    except DatasetCancelled:
        job["state"] = "cancelled"
    except Exception as exc:  # noqa: BLE001
        logger.exception("dataset job failed")
        job["state"] = "failed"
        job["error"] = str(exc)[:400]
    events.publish("*", "job", job_id=job_id, state=job["state"],
                   percent=100.0 if job["state"] == "completed" else job["percent"])


@app.post("/api/datasets/generate")
async def datasets_generate(body: DatasetGenReq, authorization: str = Header(default="")):
    _auth(authorization)
    job_id = uuid.uuid4().hex[:10]
    with _jobs_lock:
        _jobs[job_id] = {"state": "pending", "percent": 0.0, "cancel": threading.Event()}
    threading.Thread(target=_run_gen_job, args=(job_id, body), daemon=True).start()
    return {"job_id": job_id}


@app.get("/api/jobs/{job_id}")
async def job_status(job_id: str, authorization: str = Header(default="")):
    _auth(authorization)
    with _jobs_lock:
        job = _jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="job not found")
        return {"job_id": job_id, "state": job["state"], "percent": job["percent"],
                "result": job.get("result"), "error": job.get("error")}


@app.post("/api/jobs/{job_id}/cancel")
async def job_cancel(job_id: str, authorization: str = Header(default="")):
    _auth(authorization)
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job:
            job["cancel"].set()
    return {"ok": True}


@app.get("/api/datasets")
async def datasets_get(authorization: str = Header(default="")):
    _auth(authorization)
    return store.list_datasets()


@app.delete("/api/datasets/{ds_id}")
async def datasets_delete(ds_id: str, authorization: str = Header(default="")):
    _auth(authorization)
    store.delete_dataset(ds_id)
    return {"ok": True}


# --------------------------------------------------------------------------- runs
@app.post("/api/runs")
async def runs_create(body: RunCreateReq, authorization: str = Header(default="")):
    _auth(authorization)
    errors = validate_config(body.config)
    if errors["errors"]:
        raise HTTPException(status_code=400, detail=errors["errors"])
    run_id = store.create_run(body.config, body.name)
    runner.start_run(run_id, asyncio.get_running_loop())
    return {"run_id": run_id}


@app.get("/api/runs")
async def runs_list(status: str | None = None, q: str | None = None,
                    kind: str | None = None,
                    authorization: str = Header(default="")):
    _auth(authorization)
    return store.list_runs(status, q, kind)


class DeleteRunsReq(BaseModel):
    run_ids: list[str]


def _delete_run_payload(run_id: str) -> None:
    d = store.get_run(run_id)
    if d and d.get("status") == "running":
        runner.stop_run(run_id)
    store.delete_run(run_id)
    shutil.rmtree(config.outputs_dir() / run_id, ignore_errors=True)


@app.delete("/api/runs/{run_id}")
async def run_delete(run_id: str, authorization: str = Header(default="")):
    _auth(authorization)
    if not store.get_run(run_id):
        raise HTTPException(status_code=404, detail="run not found")
    _delete_run_payload(run_id)
    return {"ok": True, "deleted": [run_id]}


@app.post("/api/runs/delete-batch")
async def runs_delete_batch(body: DeleteRunsReq, authorization: str = Header(default="")):
    _auth(authorization)
    deleted = []
    for rid in body.run_ids:
        if store.get_run(rid):
            _delete_run_payload(rid)
            deleted.append(rid)
    return {"ok": True, "deleted": deleted}


@app.get("/api/runs/{run_id}")
async def run_detail(run_id: str, authorization: str = Header(default="")):
    _auth(authorization)
    run = store.get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="run not found")
    run["rounds"] = store.get_rounds(run_id)
    return run


@app.patch("/api/runs/{run_id}")
async def run_patch(run_id: str, body: RunPatchReq, authorization: str = Header(default="")):
    _auth(authorization)
    if not store.get_run(run_id):
        raise HTTPException(status_code=404, detail="run not found")
    fields = {k: v for k, v in body.model_dump().items() if v is not None}
    if "is_practice" in fields:
        fields["is_practice"] = int(fields["is_practice"])
    store.update_run(run_id, **fields)
    return {"ok": True}


@app.post("/api/runs/{run_id}/stop")
async def run_stop(run_id: str, authorization: str = Header(default="")):
    _auth(authorization)
    if not runner.stop_run(run_id):
        store.update_run(run_id, status="cancelled") if store.get_run(run_id) else None
    return {"ok": True}


@app.delete("/api/runs/{run_id}")
async def run_delete(run_id: str, authorization: str = Header(default="")):
    _auth(authorization)
    runner.stop_run(run_id)
    import shutil
    run_dir = config.outputs_dir() / run_id
    if run_dir.exists():
        shutil.rmtree(run_dir, ignore_errors=True)
    store.delete_run(run_id)
    return {"ok": True}


@app.get("/api/runs/{run_id}/logs")
async def run_logs(run_id: str, stream: str = "stdout", tail: int = 500,
                   authorization: str = Header(default="")):
    _auth(authorization)
    path = config.outputs_dir() / run_id / f"{stream}.log"
    if not path.exists():
        return {"lines": []}
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    return {"lines": lines[-max(1, tail):]}


@app.get("/api/runs/{run_id}/logs/download")
async def run_logs_download(run_id: str, stream: str = "stdout", token: str = "",
                            authorization: str = Header(default="")):
    if token:
        _auth_query(token)
    else:
        _auth(authorization)
    path = config.outputs_dir() / run_id / f"{stream}.log"
    if not path.exists():
        raise HTTPException(status_code=404, detail="log not found")
    return FileResponse(path, filename=f"{run_id}_{stream}.log")


@app.get("/api/runs/{run_id}/metrics")
async def run_metrics(run_id: str, authorization: str = Header(default="")):
    _auth(authorization)
    path = config.outputs_dir() / run_id / "metrics_timeseries.jsonl"
    if not path.exists():
        return {"samples": []}
    samples = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            samples.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return {"samples": samples}


@app.get("/api/runs/{run_id}/export")
async def run_export(run_id: str, format: str = "xlsx", token: str = "",
                     authorization: str = Header(default="")):
    if token:
        _auth_query(token)
    else:
        _auth(authorization)
    if format == "xlsx":
        path = report.export_xlsx([run_id])
    elif format == "html":
        path = report.export_html([run_id])
    else:
        raise HTTPException(status_code=400, detail="format must be xlsx|html")
    return FileResponse(path, filename=Path(path).name)


# --------------------------------------------------------------------------- compare
@app.post("/api/compare")
async def compare_runs(body: CompareReq, authorization: str = Header(default="")):
    _auth(authorization)
    return compare_mod.compare(body.run_ids, body.exclude_warmup, body.exclude_practice)


@app.get("/api/compare/export")
async def compare_export_get(run_ids: str, format: str = "xlsx",
                             exclude_warmup: bool = True, token: str = "",
                             authorization: str = Header(default="")):
    if token:
        _auth_query(token)
    else:
        _auth(authorization)
    ids = [r for r in run_ids.split(",") if r.strip()]
    if not ids:
        raise HTTPException(status_code=400, detail="run_ids required")
    if format == "xlsx":
        path = report.export_xlsx(ids, exclude_warmup)
    elif format == "html":
        path = report.export_html(ids, exclude_warmup)
    else:
        raise HTTPException(status_code=400, detail="format must be xlsx|html")
    return FileResponse(path, filename=Path(path).name)


@app.post("/api/compare/export")
async def compare_export(body: CompareReq, format: str = "xlsx", token: str = "",
                         authorization: str = Header(default="")):
    if token:
        _auth_query(token)
    else:
        _auth(authorization)
    if format == "xlsx":
        path = report.export_xlsx(body.run_ids, body.exclude_warmup)
    elif format == "html":
        path = report.export_html(body.run_ids, body.exclude_warmup)
    else:
        raise HTTPException(status_code=400, detail="format must be xlsx|html")
    return FileResponse(path, filename=Path(path).name)


# --------------------------------------------------------------------------- SLA auto-tune
class SlaStartReq(BaseModel):
    config: dict
    sla: dict  # e.g. {"ttft_p90_ms": 2000, "tpot_avg_ms": 50, "min_throughput": 100}
    start_concurrency: int = 4
    max_concurrency: int = 128


@app.post("/api/sla/start")
async def sla_start(body: SlaStartReq, authorization: str = Header(default="")):
    _auth(authorization)
    job_id = sla.start_job(body.config, body.sla, body.start_concurrency,
                           body.max_concurrency, asyncio.get_running_loop())
    return {"job_id": job_id}


_SLAS_ACTIVE = ("pending", "running", "ladder", "bisect")


@app.get("/api/sla/jobs")
async def sla_jobs(authorization: str = Header(default="")):
    """Job history (DB-persisted); stale non-terminal rows are marked interrupted."""
    _auth(authorization)
    jobs = store.list_sla_jobs()
    for j in jobs:
        if j["state"] in _SLAS_ACTIVE and not sla.is_alive(j["job_id"]):
            j["state"] = "interrupted"
    return jobs


@app.get("/api/sla/current")
async def sla_current(authorization: str = Header(default="")):
    """Live in-process job if any, else the most recent persisted job (for
    restoring the SLA page after navigation or app restart)."""
    _auth(authorization)
    jobs = store.list_sla_jobs()
    if not jobs:
        return {"job": None}
    latest = jobs[0]
    if sla.is_alive(latest["job_id"]):
        return {"job": sla.get_job(latest["job_id"])}
    if latest["state"] in _SLAS_ACTIVE:
        latest["state"] = "interrupted"
    return {"job": latest}


@app.get("/api/sla/{job_id}")
async def sla_status(job_id: str, authorization: str = Header(default="")):
    _auth(authorization)
    job = sla.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    return job


@app.post("/api/sla/{job_id}/cancel")
async def sla_cancel(job_id: str, authorization: str = Header(default="")):
    _auth(authorization)
    sla.cancel_job(job_id)
    return {"ok": True}


# --------------------------------------------------------------------------- validate & diagnosis
def validate_config(cfg: dict) -> dict:
    errors, warnings = [], []
    if not cfg.get("model_path") and not cfg.get("tokenizer"):
        errors.append("模型目录或 tokenizer 必填（数据集生成依赖）")
    if not cfg.get("host_ip") and not cfg.get("url"):
        errors.append("服务地址必填")
    input_len = int(cfg.get("input_len", 3500) or 0)
    if input_len < 1:
        errors.append("input_len 必须 ≥ 1")
    prefix_num = int(cfg.get("prefix_num", 1) or 1)
    data_num = int(cfg.get("data_num", 1) or 1)
    if prefix_num > data_num:
        warnings.append(f"prefix_num({prefix_num}) > data_num({data_num})：每个样本使用独立前缀，命中率将≈0")
    lm, ls = cfg.get("length_mean"), cfg.get("length_std")
    lmin, lmax = cfg.get("length_min"), cfg.get("length_max")
    if (lm is None) != (ls is None):
        errors.append("length_mean 与 length_std 必须成对出现")
    if (lmin is None) != (lmax is None):
        errors.append("length_min 与 length_max 必须成对出现")
    if lm is not None and float(lm) < 1:
        errors.append("length_mean 必须 ≥ 1")
    rr = cfg.get("repeat_rate", 0.5)
    try:
        from .dataset_gen import parse_prefix_ratio
        v = parse_prefix_ratio(rr)
        if not (0 < v <= 1):
            warnings.append("repeat_rate 建议在 (0,1] 区间")
    except ValueError as exc:
        errors.append(str(exc))
    if cfg.get("cache_reset") == "never":
        warnings.append("cache_reset=never：多轮测试轮间将存在残留命中")
    cr = int(cfg.get("concurrency", 1) or 1)
    if cr > data_num > 0:
        warnings.append(f"并发({cr}) 大于数据条数({data_num})，实际并发将受限于数据量")
    return {"errors": errors, "warnings": warnings}


class ProbeReq(BaseModel):
    host: str = ""
    port: int = 0
    url: str = ""


@app.post("/api/probe")
async def probe_service(body: ProbeReq, authorization: str = Header(default="")):
    """Outbound probe of the target service (/v1/models + /metrics) — performed
    by the sidecar so the renderer never talks to the service directly."""
    import httpx

    _auth(authorization)
    base = body.url.rstrip("/") or f"http://{body.host}:{body.port}"
    out: dict = {"base": base, "models_ok": False, "models": [], "metrics_ok": False,
                 "ucm_detected": False, "error": ""}
    try:
        async with httpx.AsyncClient(trust_env=False, timeout=4.0) as client:
            try:
                r = await client.get(f"{base}/v1/models")
                if r.status_code == 200:
                    out["models_ok"] = True
                    out["models"] = [m.get("id") for m in r.json().get("data", [])][:10]
            except Exception:  # noqa: BLE001
                pass
            try:
                r = await client.get(f"{base}/metrics")
                if r.status_code == 200:
                    out["metrics_ok"] = True
                    out["ucm_detected"] = "ucm:" in r.text
            except Exception:  # noqa: BLE001
                pass
    except Exception as exc:  # noqa: BLE001
        out["error"] = str(exc)[:200]
    return out


@app.post("/api/config/validate")
async def config_validate(body: ValidateReq, authorization: str = Header(default="")):
    _auth(authorization)
    return validate_config(body.config)


@app.get("/api/diagnosis")
async def diagnosis(authorization: str = Header(default="")):
    _auth(authorization)
    items = []

    def add(ok: bool, name: str, detail: str, hint: str = ""):
        items.append({"ok": ok, "name": name, "detail": detail, "hint": hint})

    add(True, "Sidecar 服务", f"运行中 · 版本 {SIDECAR_VERSION} · home={config.HOME}")
    add(True, "Python", f"{__import__('sys').version.split()[0]}")

    cmd = store.get_setting("aisbench_command", "ais_bench")
    argv = shlex.split(cmd, posix=False)
    found = False
    version = ""
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv[:1], "--version", stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE)
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=8)
        if proc.returncode == 0:
            found, version = True, out.decode(errors="replace").strip()[:120]
    except Exception:  # noqa: BLE001
        pass
    try:
        import importlib.util
        if importlib.util.find_spec("ais_bench"):
            found = True
            version = version or "python module ais_bench 可导入"
    except Exception:  # noqa: BLE001
        pass
    add(found, "AISBench", version or "未找到 ais_bench 命令或模块",
        "" if found else "pip install ais_bench_benchmark==3.1.20260630（或在设置中把 aisbench_command 指向 mock）")

    try:
        import transformers
        add(True, "transformers", f"v{transformers.__version__}（GLM 系列词表需 ≥5.0，其余 4.x 可用）")
    except ImportError:
        add(False, "transformers", "未安装", "pip install transformers>=4.40")

    toks = tokenizer_mgr.list_tokenizers()
    ok_toks = []
    for t in toks[:6]:
        p = Path(t["path"])
        ok_toks.append(f"{t['name']}({'✓' if (p/'tokenizer.json').exists() else '?'})")
    add(bool(toks), "Tokenizer 注册表", f"{len(toks)} 项: " + ", ".join(ok_toks),
        "" if toks else "在数据集页注册包含 tokenizer.json 的模型目录")

    disk_ok = True
    try:
        usage = __import__("shutil").disk_usage(str(config.HOME))
        free_gb = usage.free / 1e9
        disk_ok = free_gb > 2
        add(disk_ok, "磁盘空间", f"{config.HOME.drive if config.HOME.drive else 'home'} 剩余 {free_gb:.0f} GB",
            "" if disk_ok else "剩余空间不足 2GB")
    except Exception:  # noqa: BLE001
        add(True, "磁盘空间", "无法检测（跳过）")

    return {"items": items}


@app.get("/api/boot")
async def boot():
    """Same-origin bootstrap for container deployments where the UI is served
    by this sidecar: returns the bearer token to the already-trusted client."""
    return {"port": _state.get("public_port") or 0, "token": _state["token"],
            "same_origin": True}


# --------------------------------------------------------------------------- websocket
@app.websocket("/ws/runs/{run_id}")
async def ws_run(ws: WebSocket, run_id: str):
    token = ws.query_params.get("token", "")
    if token != _state["token"]:
        await ws.close(code=4401)
        return
    await ws.accept()
    queue = events.subscribe(run_id)
    try:
        while True:
            event = await queue.get()
            await ws.send_text(events.dumps(event))
    except WebSocketDisconnect:
        pass
    finally:
        events.unsubscribe(run_id, queue)


@app.websocket("/ws/daemon")
async def ws_daemon(ws: WebSocket):
    token = ws.query_params.get("token", "")
    if token != _state["token"]:
        await ws.close(code=4401)
        return
    await ws.accept()
    queue = events.subscribe("*")
    try:
        while True:
            event = await queue.get()
            await ws.send_text(events.dumps(event))
    except WebSocketDisconnect:
        pass
    finally:
        events.unsubscribe("*", queue)


# --------------------------------------------------------------------------- main
def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--home", default=None)
    parser.add_argument("--port-file", default=None)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--child-aisbench", action="store_true", dest="child_aisbench",
                        help="run the bundled ais_bench CLI in-process (packaged mode)")
    args, passthrough = parser.parse_known_args()

    if args.child_aisbench:
        # packaged exe re-invokes itself to run the bundled ais_bench CLI
        import sys
        from ais_bench.benchmark.cli.main import main as aisbench_main
        sys.argv = ["ais_bench"] + passthrough
        sys.exit(aisbench_main())

    config.init_home(args.home)
    _state["token"] = secrets.token_urlsafe(24)

    import socket

    import uvicorn

    # bind the ephemeral port ourselves so the port file can be written
    # before uvicorn takes over the socket
    sock = socket.socket(socket.AF_INET if ":" not in args.host else socket.AF_INET6,
                         socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((args.host, args.port))
    sock.listen(2048)
    port = sock.getsockname()[1]
    Path(args.port_file).write_text(json.dumps(
        {"port": port, "token": _state["token"]}), encoding="utf-8")
    logger.info("listening on %s:%s (port file %s)", args.host, port, args.port_file)

    server = uvicorn.Server(uvicorn.Config(app, log_level="warning"))
    server.run(sockets=[sock])


if __name__ == "__main__":
    main()

# --------------------------------------------------------------------------- static UI (container mode)
_UI_DIR = Path(os.environ["PT_UI_DIR"]) if os.environ.get("PT_UI_DIR") else None
if _UI_DIR and _UI_DIR.is_dir():
    from fastapi.staticfiles import StaticFiles

    app.mount("/", StaticFiles(directory=str(_UI_DIR), html=True), name="ui")
    logger.info("serving UI from %s", _UI_DIR)
