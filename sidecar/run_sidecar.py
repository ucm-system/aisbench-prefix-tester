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


def _is_script_child_request() -> bool:
    """True when this frozen exe was re-invoked as `exe <script>.py <cfg>.py`.

    ais_bench runners build task commands as `<sys.executable> <task_script>
    <params.py>` (openicl_api_infer.get_command), so when the packaged exe is
    sys.executable its task subprocesses re-enter this entry with the script
    path as argv[1]. Checked after freeze_support() so multiprocessing-fork
    children are consumed first."""
    if len(sys.argv) < 2:
        return False
    first = sys.argv[1]
    return first.lower().endswith(".py") and os.path.isfile(first)


def _run_script_child():
    """Execute the re-invoked task script (e.g. openicl_api_infer.py) as
    __main__, mirroring `python <script> <cfg>` semantics."""
    import runpy

    script = sys.argv[1]
    sys.argv = sys.argv[1:]
    runpy.run_path(script, run_name="__main__")


def _run_server():
    from app.main import main as server_main
    server_main()


if __name__ == "__main__":
    # spawned multiprocessing workers re-import this file as __mp_main__,
    # so everything below must stay inside the main guard
    multiprocessing.freeze_support()

    if "--child-aisbench" in sys.argv:
        _run_aisbench_child()
    elif _is_script_child_request():
        _run_script_child()
    else:
        _run_server()
