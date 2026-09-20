# ModelScope Tokenizer 下载与打包指南

> 面向本工具的 tokenizer 资产流水线：从 ModelScope（魔搭）下载 → 放入 `assets/model/<名字>/` → 应用自动注册 → 打包随 exe 分发。
> 本文所有命令与文件清单均在本机实测通过（2026-09-20）。

## 1. 打包位置与应用侧约定

- **资产目录**：`<仓库根>/assets/model/<tokenizer名字>/`，每个子目录一个 tokenizer（HuggingFace 格式）。
- **自动注册**：sidecar 启动时 `tokenizer_mgr.refresh_defaults()` 会扫描该目录，把每个含 `tokenizer.json` 或 `vocab.json` 的子目录注册进 tokenizer 注册表（`source="assets"`）。与 `D:\Models` 同名时本地目录优先。
- **随包分发**：`aisbench-sidecar.spec` 会自动把 `assets/model` 打进产物 `_internal/assets/model/`，冻结模式下同样被扫描注册——干净机器无需 `D:\Models`。
- **git 策略**：`.gitignore` 对 `assets/` 整目录忽略是**有意为之**——本目录是打包暂存区，不进仓库；换机/重建时按 §3 命令重新下载即可。
- **数据集生成**：`dataset_gen.TokenizerWrapper` 用 `AutoTokenizer.from_pretrained(path, trust_remote_code=True)` 加载，只读不写。

## 2. 最小文件集（实测结论）

| 文件 | 必需性 | 说明 |
|---|---|---|
| `tokenizer.json` | 强烈建议 | fast tokenizer，自包含（词表+合并规则+特殊 token），单文件即可工作 |
| `tokenizer_config.json` | 强烈建议 | tokenizer_class、特殊 token、chat_template（内联） |
| `vocab.json` + `merges.txt` | 建议 | BPE 词表与合并规则；慢速分词器兜底与部分工具链依赖 |
| `config.json` | 可选 | tokenizer 加载不依赖；但保留可让 AutoConfig/离线自检更稳 |
| `chat_template.jinja` | 可选 | 新版 Qwen 把聊天模板放在独立文件（config 里已内联时可省） |
| `*.safetensors` / `*.bin` | **不要下** | 模型权重，tokenizer 不需要（Qwen3.5-0.8B 权重 1.7GB） |

实测：Qwen3.5-0.8B 仅 4 文件（config/tokenizer.json/tokenizer_config/vocab.json）即可 `AutoTokenizer.from_pretrained` 离线加载成功；补全后 6 文件 ~23MB。

## 3. 下载方法（按推荐顺序）

### 方法 A：直连 HTTP（零依赖，最简单，已实测）

文件 URL 规律：`https://modelscope.cn/models/<org>/<repo>/resolve/master/<file>`

```powershell
$base = 'https://modelscope.cn/models/Qwen/Qwen3.5-0.8B/resolve/master'
$dst  = 'D:\Vibe_Workspace\AISBench_PrefixTest_Tools\assets\model\Qwen3.5-0.8B'
foreach ($f in 'tokenizer.json','tokenizer_config.json','vocab.json','merges.txt') {
  curl.exe -s -L -o "$dst\$f" "$base/$f"
}
```

查仓库文件清单（确定要下哪些文件）：

```
https://modelscope.cn/api/v1/models/<org>/<repo>/repo/files?Recursive=true
```

返回 JSON 的 `Data.Files[]` 含 `Path`/`Size`。公开模型无需登录 token。

### 方法 B：modelscope CLI（SDK，已实测）

安装：`py -3.11 -m pip install modelscope -i https://mirrors.aliyun.com/pypi/simple`

```powershell
modelscope download --model Qwen/Qwen3.5-0.8B `
  --local_dir D:\Vibe_Workspace\AISBench_PrefixTest_Tools\assets\model\Qwen3.5-0.8B `
  --include tokenizer.json tokenizer_config.json vocab.json merges.txt config.json
```

要点（当前版本 CLI 实测）：
- 入口是 Scripts 目录下的 `modelscope.exe`；`py -m modelscope download` 会报 `No module named modelscope.__main__`。
- `--local_dir` 直接落到指定目录；不给则进缓存目录（`MODELSCOPE_CACHE`，默认 `~/.cache/modelscope`，布局 `<cache>/models/<org>/<repo>/`）。
- `--include` / `--exclude` 控制文件子集；`--revision` 指定分支/tag；`--endpoint` 可换镜像站。
- 公开模型不需要 `--token`；下载私有模型或限流时才需要 `MODELSCOPE_API_TOKEN`。

### 方法 C：Python SDK

```python
from modelscope import snapshot_download
snapshot_download(
    "Qwen/Qwen3.5-0.8B",
    local_dir=r"D:\...\assets\model\Qwen3.5-0.8B",
    allow_patterns=["tokenizer.json", "tokenizer_config.json",
                    "vocab.json", "merges.txt", "config.json"],
)
```

### 不推荐：git clone + git lfs（要装 LFS、会拉全量权重历史）

## 4. 本仓库已打包的 tokenizer（实测通过）

| 目录 | 来源仓库 | 文件 | 离线验证 |
|---|---|---|---|
| `assets/model/Qwen3.5-0.8B` | Qwen/Qwen3.5-0.8B | config / tokenizer.json / tokenizer_config / vocab / merges / chat_template.jinja（~23MB） | `Qwen2TokenizerFast`，vocab=248044，chat 模板 ✓ |
| `assets/model/Qwen3-0.6B` | Qwen/Qwen3-0.6B | tokenizer.json / tokenizer_config / vocab / merges（~16MB） | `Qwen2TokenizerFast`，vocab=151643，chat 模板 ✓ |

> 注意（HANDOFF §7）：Qwen3.5 混合架构模型在本工具的命中率口径恒为 0（1024 token 对齐），测前缀复用请用 Qwen3-0.6B；Qwen3.5-0.8B tokenizer 仅供长度对齐/分词研究。

## 5. 离线验证

```python
from transformers import AutoTokenizer
tok = AutoTokenizer.from_pretrained(r"...\assets\model\Qwen3.5-0.8B", trust_remote_code=True)
print(type(tok).__name__, tok.vocab_size, bool(tok.chat_template))
```

应用内等价操作：数据集页 / `POST /api/tokenizers/verify`。
