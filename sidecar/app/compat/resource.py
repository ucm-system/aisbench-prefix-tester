"""Windows compatibility shim for the Unix-only `resource` module (no-op)."""
RESOURCE_ERROR_LIMIT = 0


def getrusage(*args, **kwargs):
    class _Usage:
        ru_maxrss = 0

    return _Usage()


def setrlimit(*args, **kwargs):
    return None


def getrlimit(*args, **kwargs):
    return (-1, -1)
