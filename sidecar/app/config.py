"""Application paths and defaults.

Home resolution order:
  1. --home CLI argument (wired by Electron / tests)
  2. AISBENCH_PT_HOME env var
  3. %APPDATA%/AISBenchPrefixTester  (fallback: ~/.aisbench_prefix_tester)
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

# Populated by main.py before any other module reads these.
HOME: Path = Path(os.getcwd())
PORT: int = 0
TOKEN: str = ""


def init_home(home: str | None = None) -> Path:
    global HOME
    if home:
        HOME = Path(home).resolve()  # absolute: symlink targets must survive cwd changes
    else:
        env = os.environ.get("AISBENCH_PT_HOME")
        if env:
            HOME = Path(env)
        elif os.environ.get("APPDATA"):
            HOME = Path(os.environ["APPDATA"]) / "AISBenchPrefixTester"
        else:
            HOME = Path.home() / ".aisbench_prefix_tester"
    HOME.mkdir(parents=True, exist_ok=True)
    return HOME


def db_path() -> Path:
    return HOME / "app.db"


def outputs_dir() -> Path:
    p = HOME / "outputs"
    p.mkdir(parents=True, exist_ok=True)
    return p


def datasets_dir() -> Path:
    p = HOME / "datasets"
    p.mkdir(parents=True, exist_ok=True)
    return p


def assets_dir() -> Path:
    p = HOME / "assets" / "tokenizers"
    p.mkdir(parents=True, exist_ok=True)
    return p


def port_file() -> Path:
    return HOME / "sidecar.port"


def work_path() -> Path:
    """AISBench workspace root (mirrors original config.WORK_PATH)."""
    p = HOME / "ais_bench_workspace"
    p.mkdir(parents=True, exist_ok=True)
    return p


def bundled_assets_model_dir() -> Path | None:
    """Tokenizer assets shipped with the app: <repo>/assets/model in source
    mode, sys._MEIPASS/assets/model in the frozen onedir build."""
    if getattr(sys, "frozen", False):
        p = Path(getattr(sys, "_MEIPASS", "")) / "assets" / "model"
    else:
        p = Path(__file__).resolve().parents[2] / "assets" / "model"
    return p if p.is_dir() else None


def _looks_like_tokenizer_dir(child: Path) -> bool:
    """Standard fast-tokenizer layouts ship tokenizer.json / vocab files; the
    tiktoken & custom-code layouts (Kimi, old ChatGLM) ship tokenizer_config
    plus tokenizer.model / tiktoken.model / tokenization_*.py instead."""
    if any((child / f).exists() for f in ("tokenizer.json", "vocab.json", "vocab.txt")):
        return True
    if (child / "tokenizer_config.json").exists():
        return (child / "tokenizer.model").exists() \
            or (child / "tiktoken.model").exists() \
            or any(child.glob("tokenization_*.py"))
    return False


def default_tokenizer_candidates() -> list[dict]:
    """First-party tokenizer sources: user's local D:\\Models, the extension
    pack drop dir (<home>/assets/tokenizers), plus bundled assets."""
    found: list[dict] = []
    # assets_dir() (extension-pack drop location) is scanned BEFORE the bundle
    # so an extracted pack wins on name collisions with bundled copies
    roots = [Path("D:/Models"), assets_dir(), assets_dir().parent.parent,
             Path.home() / "models"]
    bundle = bundled_assets_model_dir()
    if bundle:
        roots.append(bundle)
    seen: set[str] = set()
    for root in roots:
        if not root.is_dir():
            continue
        try:
            for child in sorted(root.iterdir()):
                if not child.is_dir() or child.name in {"blobs", "manifests"}:
                    continue
                if child.name.lower() in seen:
                    continue
                if _looks_like_tokenizer_dir(child):
                    seen.add(child.name.lower())
                    src = "assets" if bundle and root == bundle else (
                        "local" if str(root).startswith("D:") else "assets")
                    found.append({"name": child.name, "path": str(child), "source": src})
        except OSError:
            continue
    return found


IS_WINDOWS = sys.platform == "win32"
