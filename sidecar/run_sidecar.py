"""PyInstaller entry point: absolute-import bootstrap for the sidecar app."""
import multiprocessing
import os
import sys

# unix-only stdlib stubs (fcntl/resource) must precede ais_bench imports
_compat = os.path.join(os.path.dirname(os.path.abspath(__file__)), "app", "compat")
if os.path.isdir(_compat):
    sys.path.insert(0, _compat)


def _force_utf8_open() -> None:
    """Frozen children run with the Windows locale codec (GBK on zh-CN) because
    PyInstaller ignores PYTHONUTF8/PYTHONIOENCODING. Every file in this
    pipeline is UTF-8, so default implicit open() calls to UTF-8 for
    script-mode children (ais_bench reads/writes debug jsonl via bare open())."""
    import builtins

    orig_open = builtins.open

    def open_utf8(file, mode="r", *args, **kwargs):
        if "b" not in mode and "encoding" not in kwargs:
            kwargs["encoding"] = "utf-8"
        return orig_open(file, mode, *args, **kwargs)

    builtins.open = open_utf8


def _run_aisbench_child():
    """packaged exe re-invokes itself with --child-aisbench to run the
    bundled ais_bench CLI in-process."""
    _force_utf8_open()
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

    _force_utf8_open()
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
