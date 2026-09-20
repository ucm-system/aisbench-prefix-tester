"""PyInstaller entry point: absolute-import bootstrap for the sidecar app."""
import sys
from app.main import main

if __name__ == "__main__":
    sys.exit(main())
