#!/usr/bin/env python3
"""Stub ais_bench command for API tests: swallows any args, exit code controllable.

Usage (as aisbench_command setting):
  py -3.11 tools/tests/stub_aisbench.py             -> exit 0 (every phase 'succeeds')
  py -3.11 tools/tests/stub_aisbench.py --fail      -> exit 1 (every invocation)
  py -3.11 tools/tests/stub_aisbench.py --fail-once -> exit 1 on the FIRST
     invocation in the cwd, 0 afterwards — simulates a warmup-phase crash
     followed by a healthy full phase (R2.2 regression: the run must be
     failed, never "completed · 0 rounds"). The runner executes every phase
     with cwd=outputs/<run_id>, so a counter file there is per-run state.
"""
import sys
from pathlib import Path

if __name__ == "__main__":
    if "--fail" in sys.argv:
        raise SystemExit(1)
    if "--fail-once" in sys.argv:
        marker = Path(".stub_count")
        n = int(marker.read_text()) if marker.exists() else 0
        marker.write_text(str(n + 1))
        raise SystemExit(1 if n == 0 else 0)
    raise SystemExit(0)
