# -*- coding: utf-8 -*-
"""构建 Tokenizer 扩展包 zip（v0.2.1 发版拆分）。

安装包只内置核心双 tokenizer（Qwen3-0.6B / Qwen3.5-0.8B）；本脚本把其余
健康 tokenizer 目录 + manifest/README + 安装说明打成
`AISBenchPrefixTester-Tokenizers-<version>.zip`，用户解压到
  %USERPROFILE%\\AISBenchPrefixTester\\assets\\tokenizers\\
即可被应用自动注册（该目录优先于内置资产）。

排除项：
  - transformers 5.17 上游 CJK 编码 bug 的家族（DeepSeek-V3/V3.1/V3.2/R1、
    Step-3.5/3.7-Flash：中文编码为 0/1 个 token）——安装包与扩展包都不发
  - 核心双 tokenizer（安装包已内置）
  - smoke 证据文件（开发产物）

Run: py -3.11 tools/make_tokenizer_pack.py [--version 0.2.1] [--out D:\\pt-release]
"""
import argparse
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets" / "model"
OUT_DEFAULT = Path("D:/pt-release")

# transformers 5.17 下 CJK 编码损坏（亲测复现：0 token 或塌缩为 1 个 token）
BROKEN_5_17 = ("DeepSeek-V3", "DeepSeek-R1", "Step-")
# 安装包已内置的核心对
BUNDLED_CORE = {"Qwen3-0.6B", "Qwen3.5-0.8B"}

INSTALL_NOTE = """AISBench 前缀复用测试器 — Tokenizer 扩展包
================================================

安装方法：把本压缩包内的全部目录解压到
    %USERPROFILE%\\AISBenchPrefixTester\\assets\\tokenizers\\
（即数据目录下的 assets\\tokenizers；解压后应能在该目录直接看到
 Qwen3-8B、GLM-5、Kimi-K3 等文件夹。）

启动应用后自动注册，无需其他操作；可在「设置 → Tokenizer 资产」
点「测试加载」逐个验证（词表大小 + 中文编码往返）。

注意：
- 本包不含 DeepSeek-V3/V3.1/V3.2/R1 与 Step-3.5/3.7-Flash —— 它们在应用
  内置的 transformers 5.17 下存在上游中文编码 bug（详见 README「已知限制」）。
- Qwen3-0.6B 与 Qwen3.5-0.8B 已随安装包内置，本包不重复包含。
- 完整清单、SHA256 与版本兼容矩阵见包内 manifest.json / README.md。
"""


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", default="0.2.1")
    ap.add_argument("--out", default=str(OUT_DEFAULT))
    args = ap.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    zip_path = out_dir / f"AISBenchPrefixTester-Tokenizers-{args.version}.zip"

    dirs = sorted(d for d in ASSETS.iterdir() if d.is_dir())
    included, excluded_broken, excluded_core = [], [], []
    for d in dirs:
        if any(d.name.startswith(p) for p in BROKEN_5_17):
            excluded_broken.append(d.name)
        elif d.name in BUNDLED_CORE:
            excluded_core.append(d.name)
        else:
            included.append(d)

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        zf.writestr("安装说明.txt", INSTALL_NOTE)
        for name in ("manifest.json", "README.md"):
            p = ASSETS / name
            if p.is_file():
                zf.write(p, name)
        for d in included:
            for f in sorted(d.rglob("*")):
                if f.is_file():
                    zf.write(f, f.relative_to(ASSETS))

    raw = sum(sum(f.stat().st_size for f in d.rglob("*") if f.is_file())
              for d in included)
    print(f"pack: {zip_path}")
    print(f"  tokenizer dirs : {len(included)}")
    print(f"  raw size       : {raw / 1e6:.1f} MB")
    print(f"  zip size       : {zip_path.stat().st_size / 1e6:.1f} MB")
    print(f"  excluded (5.17 CJK bug): {', '.join(excluded_broken)}")
    print(f"  excluded (bundled core): {', '.join(excluded_core)}")


if __name__ == "__main__":
    main()
