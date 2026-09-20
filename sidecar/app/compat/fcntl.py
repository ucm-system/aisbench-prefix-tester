"""Windows compatibility shim for the Unix-only `fcntl` module.

ais_bench uses fcntl.flock() to guard concurrent summary writes; a benchmark
run has a single writer process, so no-op stubs are sufficient here.
Activate via PYTHONPATH injection in runner._run_phase (win32 only).
"""
LOCK_EX = 2
LOCK_SH = 1
LOCK_UN = 8
LOCK_NB = 4


def fcntl(fd, cmd, arg=0):
    return 0


def ioctl(fd, cmd, arg=0):
    return 0


def flock(fd, operation):
    return 0


def lockf(fd, operation, length=0, start=0, whence=0):
    return 0
