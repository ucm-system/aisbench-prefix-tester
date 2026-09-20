# ModelScope Tokenizer 下载与打包指南

> 面向本工具的 tokenizer 资产流水线：从 ModelScope（魔搭）下载 → 放入 `assets/model/<名字>/` → 应用自动注册 → 打包随 exe 分发。
> 本文所有命令与文件清单均在本机实测通过（2026-09-20）。

## 1. 打包位置与应用侧约定

- **资产目录**：`<仓库根>/assets/model/<tokenizer名字>/`，每个子目录一个 tokenizer（HuggingFace 格式）。
- **自动注册**：sidecar 启动时 `tokenizer_mgr.refresh_defaults()` 会扫描该目录，把每个含 `tokenizer.json` 或 `vocab.json` 的子目录注册进 tokenizer 注册表（`source="assets"`）。与 `D:\Models` 同名时本地目录优先。
- **随包分发**：`aisbench-sidecar.spec` 会自动把 `assets/model` 打进产物 `_internal/assets/model/`，冻结模式下同样被扫描注册——干净机器无需 `D:\Models`。
- **git 策略**：`.gitignore` 对 `assets/` 整目录忽略是**有意为之**——本目录是打包暂存区，不进仓库；换机/重建时按 §3 命令重新下载即可。
- **数据集生成**：`dataset_gen.TokenizerWrapper` 用 `AutoTokenizer.from_pretrained(path, trust_remote_code=True)` 加载，只读不写。

## 2. 最小文件集（实测 + 官方语义核对）

| 文件 | 必要性 | 说明 |
|---|---|---|
| `tokenizer.json` | 有则必下 | fast tokenizer 单文件全量（词表+合并规则+特殊 token），单文件即可工作 |
| `tokenizer_config.json` | 必须 | tokenizer_class、特殊 token、常内联 chat_template |
| `vocab.json` + `merges.txt` | GPT2/Qwen 风格 BPE 必需 | 慢速分词器兜底与部分工具链依赖 |
| `vocab.txt` | BERT 风格必需 | WordPiece 类模型 |
| `tokenizer.model` / `spiece.model` | SentencePiece 类必需 | LLaMA/Mistral/T5 系 |
| `special_tokens_map.json` / `added_tokens.json` | 仓库有则带上 | Qwen3 系特殊 token 已内联进 tokenizer_config.json，仓库不含这两个文件 |
| `chat_template.jinja` | 聊天场景建议 | transformers≥4.43 独立模板文件（Qwen3.5 新增；config 内联时可省） |
| `config.json` | 建议 | tokenizer 加载不依赖；保留利于离线自检 |
| `generation_config.json` | 可选 | 生成参数，非 tokenizer |
| `*.safetensors` / `*.bin` / `*.gguf` / `*.onnx` | **不要下** | 模型权重（Qwen3.5-0.8B 权重 1.7GB） |

实测：Qwen3.5-0.8B 仅 4 文件（config/tokenizer.json/tokenizer_config/vocab.json）即可 `AutoTokenizer.from_pretrained` 离线加载成功；补全后 6 文件 ~23MB。

## 3. 下载方法（按推荐顺序）

### 方法 A：直连 HTTP（零依赖，最简单，已实测）

文件 URL 规律（无跳转直接回源；存在 200 / 不存在 404，匿名可用）：

```
https://modelscope.cn/models/<org>/<repo>/resolve/master/<file>
```

查仓库文件清单（确定要下哪些文件；返回 `Data.Files[]`，含 `Path/Size/Sha256/IsLFS`）：

```
https://modelscope.cn/api/v1/models/<org>/<repo>/repo/files?Recursive=true
```

```powershell
$base = 'https://modelscope.cn/models/Qwen/Qwen3.5-0.8B/resolve/master'
$dst  = 'D:\Vibe_Workspace\AISBench_PrefixTest_Tools\assets\model\Qwen3.5-0.8B'
foreach ($f in 'tokenizer.json','tokenizer_config.json','vocab.json','merges.txt') {
  curl.exe -s -L -o "$dst\$f" "$base/$f"
}
```

### 方法 B：modelscope CLI（SDK，已实测）

安装（二选一，下载专用选轻量包）：

```powershell
# 推荐：只做下载/管理 → 轻量官方包（2026 起 hub 能力拆分于此）
py -3.11 -m pip install modelscope-hub -i https://mirrors.aliyun.com/pypi/simple
# 完整包（含训练框架，较重；from modelscope import snapshot_download 需要 它）
py -3.11 -m pip install modelscope -i https://mirrors.aliyun.com/pypi/simple
```

新式语法（位置参数，modelscope-hub / modelscope≥1.38）：

```powershell
# 快照模式 + 黑名单排除（推荐，保证不漏 tokenizer 文件）
modelscope download Qwen/Qwen3.5-0.8B `
  --local-dir D:\Vibe_Workspace\AISBench_PrefixTest_Tools\assets\model\Qwen3.5-0.8B `
  --exclude "*.safetensors" "*.bin" "*.gguf" "*.onnx" "*.pt" "*.pth" "*.h5" "*.md" ".gitattributes"

# 指定文件模式（注意：此模式下 --include/--exclude 不生效）
modelscope download Qwen/Qwen3.5-0.8B tokenizer.json tokenizer_config.json vocab.json merges.txt `
  --local-dir D:\Vibe_Workspace\AISBench_PrefixTest_Tools\assets\model\Qwen3.5-0.8B
```

要点（实测 + 官方源码核对）：
- 入口是 Scripts 目录下的 `modelscope.exe`（`py -m modelscope download` 报 `No module named modelscope.__main__`）。
- `--local-dir` 直接落盘该目录（不走缓存布局），正合资产打包需求；不给则进缓存根 `MODELSCOPE_CACHE`（缺省 `~/.cache/modelscope`，≥1.38 布局 `{cache}\models\{owner}--{name}\snapshots\{revision}\`）。
- **`--include/--exclude` 只在快照模式生效**（不列具体文件时）；模式 `fnmatch` 匹配仓库相对路径，`*` 跨 `/`。
- 默认分支是 **master**（不是 HF 的 main）；`--revision` 可固定 commit hash 保证可复现。
- 公开模型全程匿名，无需 token；私有/gated 模型才需要 `MODELSCOPE_API_TOKEN`（ms-xxx，modelscope.cn/my/myaccesstoken 创建）或 CLI `--token`。
- 完整性校验：`ms-hub cache verify <repo> --local-dir <dir> --fail-on-missing-files`（SHA256 逐文件核对）；SDK 自带 Range 断点续传与 sha256 校验自动重下。
- 旧式 `--model X --local_dir Y`（下划线）仍兼容但已废弃（本机 1.37.1 帮助即旧式；1.38+ 走 modelscope-hub 新式）。

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

已下文件 SHA256 与 ModelScope 仓库逐字节核对一致（4/4 MATCH）。

### Qwen3 家族等价性与换代警告（调研代理逐仓哈希矩阵结论）

- **一份 Qwen3-0.6B 四件套可代表整个 Qwen3 instruct 家族**：0.6B-FP8 / 1.7B / 4B / 8B / 14B / 32B / 30B-A3B / 235B-A22B 的 tokenizer.json（`aeb13307…`）/ vocab（`ca10d7e9…`）/ merges（`8831e4f1…`）/ tokenizer_config（`d5d09f07…`）**字节级完全一致**（连 chat_template 都相同）。Qwen3-0.6B 四件套 SHA256：
  - tokenizer.json `aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4`
  - tokenizer_config.json `d5d09f07b48c3086c508b30d1c9114bd1189145b74e982a265350c923acd8101`
  - vocab.json `ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910`
  - merges.txt `8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5`
- 例外（打包代次差异，plain-text 计数等价但字节不同）：`0.6B-Base`（精简版 tokenizer.json `c0382117…`，与 Qwen2.5 系同哈希）、Coder 系（`19564a48…`）、`2507`/Thinking 后缀（模板不同）、Embedding 系（微差）。
- **Qwen3.5 是换代词表**（~248k vs 151,669，`chat_template.jinja` 独立文件、多模态 preprocessor 配置）：**Qwen3 的 tokenizer 不能用于 Qwen3.5**，id 空间不同 → prefix cache 语义完全不同。Qwen3.5 家族（0.8B/4B/9B/35B-A3B/397B-A17B）需要单独打包（本仓库已含 0.8B 一份）。
- **只取官方 `Qwen` org**：`LLM-Research/Qwen3-0.6B`、`AI-ModelScope/Qwen3-0.6B` 均 404；第三方镜像（如 `unsloth/Qwen3-0.6B`）的 tokenizer_config.json 被改动过——离线打包一律取官方仓。
- Qwen3 全系 tokenizer_class=`Qwen2Tokenizer`、无 `auto_map` → 不需要 trust_remote_code、不需要任何 .py 文件。

> 注意（HANDOFF §7）：Qwen3.5 混合架构模型在本工具的命中率口径恒为 0（1024 token 对齐），测前缀复用请用 Qwen3-0.6B；Qwen3.5-0.8B tokenizer 仅供长度对齐/分词研究。

## 5. 离线验证

```python
from transformers import AutoTokenizer
tok = AutoTokenizer.from_pretrained(r"...\assets\model\Qwen3.5-0.8B", trust_remote_code=True)
print(type(tok).__name__, tok.vocab_size, bool(tok.chat_template))
```

应用内等价操作：数据集页 / `POST /api/tokenizers/verify`。

> `trust_remote_code`：仅当仓库自带自定义分词 Python（如 ChatGLM/GLM 系的 `tokenization_*.py`）才真正需要——此时离线打包必须把这些 `.py` 一并带上；Qwen/Llama 等标准 fast tokenizer 不需要（本工具 `dataset_gen` 统一传 `trust_remote_code=True`，对标准模型无副作用）。缺文件典型报错：`KeyError: 'tokenizer_class'` / `unrecognized tokenizer_class`。
