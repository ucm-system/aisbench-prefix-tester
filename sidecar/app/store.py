"""SQLite persistence — runs / rounds / datasets / tokenizers / presets / settings.

Single-writer design: one connection guarded by a re-entrant lock; SQLite in
WAL mode so readers (API queries) never block the runner thread.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from . import config

_CONN: sqlite3.Connection | None = None
_LOCK = threading.RLock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  name TEXT, status TEXT, created_at REAL, finished_at REAL,
  config_json TEXT, model_name TEXT, host TEXT,
  is_practice INTEGER DEFAULT 0, notes TEXT DEFAULT '',
  kind TEXT DEFAULT 'manual'
);
CREATE TABLE IF NOT EXISTS sla_jobs (
  job_id TEXT PRIMARY KEY, created_at REAL, state TEXT, sla_json TEXT,
  max_ok INTEGER, note TEXT, probes_json TEXT DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT, round_index INTEGER, phase TEXT, is_warmup INTEGER DEFAULT 0,
  params_json TEXT, metrics_json TEXT, hit_rate_json TEXT, warnings TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS datasets (
  id TEXT PRIMARY KEY, name TEXT, mode TEXT, tokenizer TEXT, vocab_source TEXT,
  params_json TEXT, files_json TEXT, stats_json TEXT, created_at REAL
);
CREATE TABLE IF NOT EXISTS tokenizers (
  name TEXT PRIMARY KEY, path TEXT, source TEXT, version TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS presets (
  name TEXT PRIMARY KEY, config_json TEXT, updated_at REAL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY, value TEXT
);
"""


def connect() -> sqlite3.Connection:
    global _CONN
    with _LOCK:
        if _CONN is None:
            _CONN = sqlite3.connect(str(config.db_path()), check_same_thread=False)
            _CONN.row_factory = sqlite3.Row
            _CONN.execute("PRAGMA journal_mode=WAL")
            _CONN.executescript(SCHEMA)
            _migrate(_CONN)
            _CONN.commit()
        return _CONN


def _migrate(con: sqlite3.Connection) -> None:
    """Lightweight migrations for DBs created before a column existed."""
    cols = {r["name"] for r in con.execute("PRAGMA table_info(runs)").fetchall()}
    if "kind" not in cols:
        con.execute("ALTER TABLE runs ADD COLUMN kind TEXT DEFAULT 'manual'")
        # backfill: pre-kind SLA probe runs are named "SLA c=<n> · ..."
        con.execute("UPDATE runs SET kind='sla' WHERE kind='manual' AND name LIKE 'SLA c=%'")
    # backfill: SLA probe runs whose stored config lost the rounds marker
    con.execute(
        "UPDATE runs SET config_json = json_set(config_json, '$.rounds', json('[{}]'))"
        " WHERE kind='sla' AND config_json NOT LIKE '%\"rounds\"%'")


def reconcile_orphans() -> dict:
    """Mark runs / SLA jobs left in a live state by an unclean shutdown.

    Called once at sidecar startup: no runner handles can exist in a fresh
    process, so any row still pending/running is stale bookkeeping from the
    previous process (e.g. app killed mid-run). Without this the UI shows a
    forever-"running" zombie while the SLA page correctly says interrupted.
    """
    with _LOCK:
        con = connect()
        now = time.time()
        runs = con.execute(
            "UPDATE runs SET status='interrupted', finished_at=COALESCE(finished_at, ?)"
            " WHERE status IN ('pending','running')", (now,)).rowcount
        jobs = con.execute(
            "UPDATE sla_jobs SET state='interrupted'"
            " WHERE state IN ('pending','running','ladder','bisect')").rowcount
        con.commit()
    return {"runs": runs, "sla_jobs": jobs}


def _row_to_dict(row: sqlite3.Row | None) -> dict | None:
    return {k: row[k] for k in row.keys()} if row is not None else None


# ---------------------------------------------------------------- runs
def create_run(cfg: dict, name: str = "", kind: str = "manual") -> str:
    run_id = time.strftime("%Y%m%d_%H%M%S") + "_" + uuid.uuid4().hex[:4]
    with _LOCK:
        connect().execute(
            "INSERT INTO runs (run_id, name, status, created_at, config_json, model_name, host, kind)"
            " VALUES (?,?,?,?,?,?,?,?)",
            (
                run_id,
                name or cfg.get("test_name", "") or run_id,
                "pending",
                time.time(),
                json.dumps(cfg, ensure_ascii=False),
                cfg.get("model_name", ""),
                f"{cfg.get('host_ip', '')}:{cfg.get('host_port', '')}",
                kind,
            ),
        )
        connect().commit()
    return run_id


def update_run(run_id: str, **fields: Any) -> None:
    if not fields:
        return
    cols = ", ".join(f"{k}=?" for k in fields)
    with _LOCK:
        connect().execute(f"UPDATE runs SET {cols} WHERE run_id=?", (*fields.values(), run_id))
        connect().commit()


def get_run(run_id: str) -> dict | None:
    with _LOCK:
        row = connect().execute("SELECT * FROM runs WHERE run_id=?", (run_id,)).fetchone()
    d = _row_to_dict(row)
    if d and d.get("config_json"):
        d["config"] = json.loads(d.pop("config_json"))
    return d


def list_runs(status: str | None = None, q: str | None = None,
              kind: str | None = None) -> list[dict]:
    sql = "SELECT * FROM runs"
    conds, params = [], []
    if status:
        conds.append("status=?")
        params.append(status)
    if q:
        conds.append("(run_id LIKE ? OR name LIKE ? OR notes LIKE ?)")
        params += [f"%{q}%"] * 3
    if kind:
        conds.append("kind=?")
        params.append(kind)
    if conds:
        sql += " WHERE " + " AND ".join(conds)
    sql += " ORDER BY created_at DESC"
    with _LOCK:
        rows = connect().execute(sql, params).fetchall()
    out = []
    for row in rows:
        d = _row_to_dict(row)
        d.pop("config_json", None)
        # attach summary metrics from the latest full-phase round
        rounds = get_rounds(d["run_id"])
        fulls = [r for r in rounds if r["phase"] == "full"]
        if fulls:
            m = fulls[-1].get("metrics") or {}
            h = ((fulls[-1].get("hit_rate") or {}).get("aggregated", {}))
            d["summary"] = {
                "hbm_hit_rate": h.get("hbm_hit_rate", 0.0),
                "ext_hit_rate": h.get("ext_hit_rate", 0.0),
                "ttft_avg_ms": m.get("ttft_avg_ms", -1),
                "output_token_throughput": m.get("output_token_throughput", -1),
                "rounds_done": len(rounds),
            }
        out.append(d)
    return out


def delete_run(run_id: str) -> None:
    with _LOCK:
        connect().execute("DELETE FROM rounds WHERE run_id=?", (run_id,))
        connect().execute("DELETE FROM runs WHERE run_id=?", (run_id,))
        connect().commit()


# ---------------------------------------------------------------- rounds
def upsert_round(run_id: str, round_index: int, phase: str, is_warmup: bool,
                 params: dict, metrics: dict, hit_rate: dict, warnings: str = "") -> None:
    with _LOCK:
        con = connect()
        con.execute("DELETE FROM rounds WHERE run_id=? AND round_index=? AND phase=?",
                    (run_id, round_index, phase))
        con.execute(
            "INSERT INTO rounds (run_id, round_index, phase, is_warmup, params_json,"
            " metrics_json, hit_rate_json, warnings) VALUES (?,?,?,?,?,?,?,?)",
            (run_id, round_index, phase, int(is_warmup),
             json.dumps(params, ensure_ascii=False),
             json.dumps(metrics, ensure_ascii=False),
             json.dumps(hit_rate, ensure_ascii=False), warnings),
        )
        con.commit()


def get_rounds(run_id: str) -> list[dict]:
    with _LOCK:
        rows = connect().execute(
            "SELECT * FROM rounds WHERE run_id=? ORDER BY id", (run_id,)
        ).fetchall()
    out = []
    for row in rows:
        d = _row_to_dict(row)
        for key in ("params_json", "metrics_json", "hit_rate_json"):
            if d.get(key):
                d[key.replace("_json", "")] = json.loads(d.pop(key))
            else:
                d.pop(key, None)
        out.append(d)
    return out


# ---------------------------------------------------------------- datasets
def save_dataset(d: dict) -> str:
    ds_id = d.get("id") or uuid.uuid4().hex[:10]
    with _LOCK:
        connect().execute(
            "INSERT OR REPLACE INTO datasets (id, name, mode, tokenizer, vocab_source,"
            " params_json, files_json, stats_json, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
            (ds_id, d["name"], d["mode"], d.get("tokenizer", ""), d.get("vocab_source", ""),
             json.dumps(d.get("params", {}), ensure_ascii=False),
             json.dumps(d.get("files", {}), ensure_ascii=False),
             json.dumps(d.get("stats", {}), ensure_ascii=False),
             time.time()),
        )
        connect().commit()
    return ds_id


def list_datasets() -> list[dict]:
    with _LOCK:
        rows = connect().execute("SELECT * FROM datasets ORDER BY created_at DESC").fetchall()
    out = []
    for row in rows:
        d = _row_to_dict(row)
        for key in ("params_json", "files_json", "stats_json"):
            if d.get(key):
                d[key.replace("_json", "")] = json.loads(d.pop(key))
        out.append(d)
    return out


def get_dataset(ds_id: str) -> dict | None:
    with _LOCK:
        row = connect().execute("SELECT * FROM datasets WHERE id=?", (ds_id,)).fetchone()
    d = _row_to_dict(row)
    if not d:
        return None
    for key in ("params_json", "files_json", "stats_json"):
        if d.get(key):
            d[key.replace("_json", "")] = json.loads(d.pop(key))
    return d


def delete_dataset(ds_id: str) -> None:
    with _LOCK:
        connect().execute("DELETE FROM datasets WHERE id=?", (ds_id,))
        connect().commit()


# ---------------------------------------------------------------- tokenizers
def list_tokenizers() -> list[dict]:
    with _LOCK:
        rows = connect().execute("SELECT * FROM tokenizers ORDER BY source, name").fetchall()
    return [_row_to_dict(r) for r in rows]


def upsert_tokenizer(name: str, path: str, source: str, version: str = "") -> None:
    with _LOCK:
        connect().execute(
            "INSERT OR REPLACE INTO tokenizers (name, path, source, version) VALUES (?,?,?,?)",
            (name, path, source, version),
        )
        connect().commit()


def delete_tokenizer(name: str) -> None:
    with _LOCK:
        connect().execute("DELETE FROM tokenizers WHERE name=?", (name,))
        connect().commit()


# ---------------------------------------------------------------- presets & settings
def list_presets() -> list[dict]:
    with _LOCK:
        rows = connect().execute("SELECT name, config_json, updated_at FROM presets ORDER BY name").fetchall()
    return [{"name": r["name"], "config": json.loads(r["config_json"]), "updated_at": r["updated_at"]} for r in rows]


def save_preset(name: str, cfg: dict) -> None:
    with _LOCK:
        connect().execute(
            "INSERT OR REPLACE INTO presets (name, config_json, updated_at) VALUES (?,?,?)",
            (name, json.dumps(cfg, ensure_ascii=False), time.time()),
        )
        connect().commit()


def delete_preset(name: str) -> None:
    with _LOCK:
        connect().execute("DELETE FROM presets WHERE name=?", (name,))
        connect().commit()


def get_setting(key: str, default: str | None = None) -> str | None:
    with _LOCK:
        row = connect().execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return row["value"] if row else default


def set_setting(key: str, value: str) -> None:
    with _LOCK:
        connect().execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)", (key, value))
        connect().commit()


# ---------------------------------------------------------------- sla jobs
def save_sla_job(job: dict) -> None:
    """Upsert a SLA tuner snapshot so job history survives sidecar restarts."""
    with _LOCK:
        connect().execute(
            "INSERT OR REPLACE INTO sla_jobs (job_id, created_at, state, sla_json,"
            " max_ok, note, probes_json) VALUES (?,?,?,?,?,?,?)",
            (
                job["job_id"],
                job.get("created_at") or time.time(),
                job.get("state", "pending"),
                json.dumps(job.get("sla") or {}, ensure_ascii=False),
                job.get("max_ok"),
                job.get("note", ""),
                json.dumps(job.get("probes") or [], ensure_ascii=False),
            ),
        )
        connect().commit()


def get_sla_job(job_id: str) -> dict | None:
    with _LOCK:
        row = connect().execute("SELECT * FROM sla_jobs WHERE job_id=?", (job_id,)).fetchone()
    return _sla_row(row)


def list_sla_jobs() -> list[dict]:
    with _LOCK:
        rows = connect().execute("SELECT * FROM sla_jobs ORDER BY created_at DESC").fetchall()
    return [_sla_row(r) for r in rows]


def _sla_row(row: sqlite3.Row | None) -> dict | None:
    if row is None:
        return None
    d = {k: row[k] for k in row.keys()}
    d["sla"] = json.loads(d.pop("sla_json") or "{}")
    d["probes"] = json.loads(d.pop("probes_json") or "[]")
    return d
