# -*- mode: python ; coding: utf-8 -*-
import importlib.util
import os

block_cipher = None

# mmengine config files under ais_bench/benchmark/configs are loaded
# dynamically (never imported), so they are not part of the module graph
# and must be shipped as data for copy_summarizer / CLI name resolution.
_ab_spec = importlib.util.find_spec('ais_bench')
if not _ab_spec or not _ab_spec.origin:
    raise SystemExit('ais_bench is not importable in the build environment')
_ab_pkg = os.path.dirname(_ab_spec.origin)
_ab_configs = os.path.join(_ab_pkg, 'benchmark', 'configs')
if not os.path.isdir(_ab_configs):
    raise SystemExit(f'ais_bench configs dir not found: {_ab_configs}')

a = Analysis(
    ['run_sidecar.py'],
    pathex=['.'],
    binaries=[],
    datas=[
        ('app/templates', 'app/templates'),
        ('app/compat', 'app/compat'),
        (_ab_configs, 'ais_bench/benchmark/configs'),
    ],
    hiddenimports=[
        'uvicorn.logging', 'uvicorn.loops', 'uvicorn.loops.auto',
        'uvicorn.protocols', 'uvicorn.protocols.http', 'uvicorn.protocols.http.auto',
        'uvicorn.protocols.websockets', 'uvicorn.protocols.websockets.auto',
        'uvicorn.lifespan', 'uvicorn.lifespan.on',
        'anyio._backends._asyncio',
        'multidict', 'frozenlist',
        'ais_bench.benchmark.tasks.custom_tasks',
    ],
    excludes=['matplotlib', 'tkinter', 'polars', 'babel',
           'onnxruntime', 'sphinx', 'IPython', 'jupyter', 'pygments', 'numba'],
    noarchive=False,
    # ais_bench task scripts must exist as real .py files on disk:
    # openicl_api_infer.get_command() re-invokes `<sys.executable> __file__
    # <cfg>` and run_sidecar's script-mode dispatch runpy-executes argv[1],
    # which requires __file__ to resolve to an existing path.
    module_collection_mode={'ais_bench': 'py'},
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name='aisbench-sidecar',
          console=True, disable_windowed_traceback=False)
coll = COLLECT(exe, a.binaries, a.zipfiles, a.datas, name='aisbench-sidecar')
