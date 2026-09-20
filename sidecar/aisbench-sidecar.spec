# -*- mode: python ; coding: utf-8 -*-
block_cipher = None

a = Analysis(
    ['run_sidecar.py'],
    pathex=['.'],
    binaries=[],
    datas=[
        ('app/templates', 'app/templates'),
        ('app/compat', 'app/compat'),
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
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name='aisbench-sidecar',
          console=True, disable_windowed_traceback=False)
coll = COLLECT(exe, a.binaries, a.zipfiles, a.datas, name='aisbench-sidecar')
