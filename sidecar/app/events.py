"""In-process event bus bridging runner/collector threads to WebSocket clients.

Each run has a set of subscriber queues; the daemon channel carries
sidecar lifecycle events. Publishing from sync threads is safe.
"""
from __future__ import annotations

import asyncio
import json
import threading
import time
from collections import defaultdict
from typing import Any

_subs: dict[str, set[asyncio.Queue]] = defaultdict(set)
_loop: asyncio.AbstractEventLoop | None = None
_lock = threading.Lock()


def bind_loop(loop: asyncio.AbstractEventLoop) -> None:
    global _loop
    _loop = loop


def subscribe(channel: str) -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue(maxsize=2000)
    with _lock:
        _subs[channel].add(q)
    return q


def unsubscribe(channel: str, q: asyncio.Queue) -> None:
    with _lock:
        _subs[channel].discard(q)


def _put(q: asyncio.Queue, item: dict) -> None:
    try:
        q.put_nowait(item)
    except asyncio.QueueFull:
        pass  # drop oldest-pressure events rather than block the runner


def publish(channel: str, etype: str, **data: Any) -> None:
    event = {"type": etype, "ts": time.time(), **data}
    with _lock:
        queues = list(_subs.get(channel, ())) + list(_subs.get("*", ()))
    for q in queues:
        if _loop is not None and _loop.is_running():
            _loop.call_soon_threadsafe(_put, q, event)
        else:
            _put(q, event)


def publish_log(run_id: str, stream: str, line: str) -> None:
    publish(run_id, "log", stream=stream, line=line.rstrip("\n"))


def dumps(event: dict) -> str:
    return json.dumps(event, ensure_ascii=False, default=str)
