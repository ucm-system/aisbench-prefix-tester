"""PyInstaller entry point: absolute-import bootstrap for the sidecar app."""
import multiprocessing
import os
import sys

# unix-only stdlib stubs (fcntl/resource) must precede ais_bench imports
_compat = os.path.join(os.path.dirname(os.path.abspath(__file__)), "app", "compat")
if os.path.isdir(_compat):
    sys.path.insert(0, _compat)


def _run_aisbench_child():
    """packaged exe re-invokes itself with --child-aisbench to run the
    bundled ais_bench CLI in-process."""
    idx = sys.argv.index("--child-aisbench")
    sys.argv = ["ais_bench"] + sys.argv[idx + 1:]
    from ais_bench.benchmark.cli.main import main as aisbench_main
    sys.exit(aisbench_main())


def _run_server():
    from app.main import main as server_main
    server_main()


if __name__ == "__main__":
    # spawned multiprocessing workers re-import this file as __mp_main__,
    # so everything below must stay inside the main guard
    multiprocessing.freeze_support()

    if "--child-aisbench" in sys.argv:
        _run_aisbench_child()
    else:
        _run_server()
