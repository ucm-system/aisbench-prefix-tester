#!/usr/bin/env python3
"""Stub ais_bench command for API tests: swallows any args, exit code controllable.

Usage (as aisbench_command setting):
  py -3.11 tools/tests/stub_aisbench.py            -> exit 0 (phase 'succeeds')
  py -3.11 tools/tests/stub_aisbench.py --fail     -> exit 1
"""
import sys

if __name__ == "__main__":
    raise SystemExit(1 if "--fail" in sys.argv else 0)
