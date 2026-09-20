"""AISBench workspace preparation & config injection — ported from prefix_bench.py.

Model config is produced by placeholder-substitution over templates/default_api.py
and materialised into {work_path}/ais_bench/benchmark/configs/models/vllm_api/.
Datasets are linked as {work_path}/ais_bench/datasets/gsm8k/test.jsonl.
"""
from __future__ import annotations

import errno
import logging
import os
import re
import shutil
from pathlib import Path

logger = logging.getLogger(__name__)

TEMPLATE_PATH = Path(__file__).parent / "templates" / "default_api.py"


def symlink_force(target: str, link_name: str) -> None:
    """Symlink with Windows-privilege fallback to a copy (datasets are read-only usage)."""
    logger.info("link: %s -> %s", link_name, target)
    link = Path(link_name)
    if link.exists() or link.is_symlink():
        link.unlink()
    try:
        os.symlink(target, link_name)
    except OSError as exc:
        if exc.errno in (errno.EPERM, errno.EACCES, errno.EINVAL, 1314):  # 1314: no symlink privilege
            shutil.copyfile(target, link_name)
            logger.warning("symlink unavailable, copied %s -> %s", target, link_name)
        else:
            raise


def prepare_workspace(work_path: str) -> tuple[str, str]:
    """Create {work}/configs/models/vllm_api and {work}/datasets/gsm8k (with empty train.jsonl)."""
    cfg_dir = Path(work_path) / "ais_bench" / "benchmark" / "configs" / "models" / "vllm_api"
    ds_dir = Path(work_path) / "ais_bench" / "datasets" / "gsm8k"
    cfg_dir.mkdir(parents=True, exist_ok=True)
    ds_dir.mkdir(parents=True, exist_ok=True)
    train = ds_dir / "train.jsonl"
    if not train.exists():
        train.write_text("", encoding="utf-8")
    if not (Path(work_path) / "ais_bench" / "benchmark").exists():
        logger.warning("AISBench package not found under %s (config dir created for injection)",
                       work_path)
    return str(cfg_dir), str(ds_dir)


def write_model_config(
    work_path: str,
    model_path: str, model_name: str,
    host_ip: str, host_port: int, url: str,
    concurrency: int, output_len: int, request_rate: int,
    test_type: str, enable_think: bool, api_key: str = "",
) -> str:
    """Render templates/default_api.py into the AISBench config dir; returns written path."""
    if test_type == "text":
        api_class, api_abbr = "VLLMCustomAPIChat", "vllm-api-general-chat"
    else:
        api_class, api_abbr = "VLLMCustomAPIChatStream", "vllm-api-stream-chat"

    generation_kwargs = "temperature=0,\n            ignore_eos=True"
    if enable_think:
        generation_kwargs += ',\n            chat_template_kwargs={"enable_thinking": True}'

    replacements = {
        "model_path_for_replace": model_path,
        "model_name_for_replace": model_name,
        "rr_for_replace": str(request_rate),
        "test_type_for_replace": api_class,
        "test_abbr_for_replace": api_abbr,
        "ip_for_replace": host_ip,
        "port_for_replace": str(host_port),
        "url_for_replace": url,
        "outputlen_for_replace": str(output_len),
        "concurrency_for_replace": str(concurrency),
        "api_key_for_replace": api_key,
        "generation_kwargs_for_replace": generation_kwargs,
    }

    lines = TEMPLATE_PATH.read_text(encoding="utf-8").splitlines(keepends=True)
    out_lines = []
    for line in lines:
        t = line
        for key, value in replacements.items():
            t = re.sub(key, value.replace("\\", "\\\\"), t)
        out_lines.append(t)

    cfg_dir, _ = prepare_workspace(work_path)
    target = Path(cfg_dir) / "vllm_api_chat_temp.py"
    target.write_text("".join(out_lines), encoding="utf-8")
    logger.info("model config written: %s", target)
    return str(target)


def link_dataset(work_path: str, src_file: str) -> str:
    _, ds_dir = prepare_workspace(work_path)
    dst = os.path.join(ds_dir, "test.jsonl")
    symlink_force(src_file, dst)
    return dst


def build_aisbench_command(summarizer: str, output_dir: str) -> list[str]:
    """Argv form of the original shell command (no shell -> clean pipe/kill semantics)."""
    return [
        "--models", "vllm_api_chat_temp",
        "--datasets", "gsm8k_gen_0_shot_cot_str_perf",
        "--mode", "perf",
        "--summarizer", summarizer,
        "--work-dir", output_dir,
        "--debug",
        "--num-warmups", "0",
    ]

DATASET_TPL = Path(__file__).parent / "templates" / "gsm8k_perf_dataset.py"


def write_dataset_config(test_jsonl_path: str, out_path: str) -> str:
    """Render the gsm8k perf dataset config pointing at an absolute test.jsonl."""
    src = DATASET_TPL.read_text(encoding="utf-8")
    src = src.replace("ds_path_for_replace", str(test_jsonl_path).replace("\\", "/"))
    Path(out_path).write_text(src, encoding="utf-8")
    logger.info("dataset config written: %s", out_path)
    return out_path

def copy_summarizer(summarizer: str, config_dir: str) -> str:
    """Copy the summarizer config (default_perf.py etc.) into {config_dir}/summarizers/
    so --config-dir mode can resolve it."""
    import importlib.util
    spec = importlib.util.find_spec("ais_bench")
    src = None
    if spec and spec.origin:
        root = Path(os.path.dirname(os.path.dirname(spec.origin)))
        base = root / "ais_bench" / "benchmark" / "configs" / "summarizers"
        for cand in (base / f"{summarizer}.py", base / "perf" / f"{summarizer}.py"):
            if Path(cand).exists():
                src = cand
                break
    dst = Path(config_dir) / "summarizers" / f"{summarizer}.py"
    dst.parent.mkdir(parents=True, exist_ok=True)
    if src and Path(src).exists():
        shutil.copyfile(src, dst)
    else:
        dst.write_text("# placeholder summarizer\n", encoding="utf-8")
    return str(dst)
