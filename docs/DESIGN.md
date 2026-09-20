# AISBench 前缀复用测试器（桌面版）— 功能与 UI 设计 v1.0

> 版本：v1.1 ｜ 日期：2026-09-20 ｜ 状态：评审稿（v1.1 合并用户反馈：轮间缓存清理、D:\Models 预置 tokenizer、mock 测试链路、并发参数补全）
> 配套交付：`prototype/index.html`（高保真交互原型，暗色 Lobe 风格）

---

## 0. 调研结论摘要（设计依据）

以下结论来自对 `aisbench_auto_tools_prefix` 源码、UCM 指标配置与 Grafana 面板、AISBench 官方文档、@lobehub/ui 的调研，是本设计的直接依据。

### 0.1 原工具（aisbench_auto_tools_prefix）的真实行为

1. **调用方式**：通过 `os.system` 调用 `ais_bench` CLI（非 import 库），固定命令
   `ais_bench --models vllm_api_chat_temp --datasets gsm8k_gen_0_shot_cot_str_perf --mode perf --summarizer {s} --work-dir {dir} --debug --num-warmups 0`，
   模型参数通过模板 `default_api.py` 占位符替换后 symlink 注入 AISBench 配置目录。
2. **两阶段执行**：每一"轮"内部有两个 Phase——
   - **Phase 1 预埋（warmup）**：并发 = `dp`，`output_len=1`，数据集为"前缀文件"（每个前缀复制 dp 份，共 `dp×prefix_num` 行），目的是把每个前缀注入各 DP 域缓存；
   - **Phase 2 全量（full）**：并发 = `concurrency`，数据集为全量文件（每行 = `前缀池[i%prefix_num] + 3 token 分隔符 + 独立后缀`）。
   - **含义**：需求文档中的"预埋轮"在实现上是轮内阶段（phase=warmup），设计上以 `phase` 字段标记并在对比时排除，而非独立 run。
3. **数据集生成**：**已经**基于 tokenizer 词表随机采样（`safe_ids = vocab - special_ids`，decode→re-encode 校准到精确 token 数），输出 GSM8K 兼容 JSONL（`{"question": ..., "answer": "none"}`）。"随机词表"并非缺失能力；真正缺失的是：**自定义词表文件、纯 tokenid 模式、生成进度回调与中断续传**——这三点是本工具的增强点。
4. **repeat_rate 双格式**：CLI `--repeat_rate` 只收 float；`"90%"` 字符串仅在 `--rounds` JSON 中由 `parse_prefix_ratio` 解析。UI 统一支持两种输入，内部归一化为 float。
5. **多轮机制**：`--rounds` 接收内联 JSON 或 JSON 文件（或环境变量 `AISBENCH_TEST_CASE`），每轮仅可覆盖 10 个键：`input_len, output_len, data_num, concurrency, request_rate, prefix_num, repeat_rate, dp, seed, test_name`。UI 多轮编辑器直接按此 schema 设计。
6. **命中率采集（原版）**：**阶段前后快照差分**（非轮询），curl 各 pod 的 `/metrics`，仅抓 4 个指标：
   `vllm:prefix_cache_{queries,hits}_total`（HBM）、`vllm:external_prefix_cache_{queries,hits}_total`（External），
   按 `engine="N"` label 分组（→ `dp{N}` 域），命中率 = Δhits/Δqueries。
   **桌面版增强**：增加 5s 间隔轮询形成时间序列（供实时面板与事后回放），阶段快照差分逻辑保留用于"阶段命中率"。
7. **pod_info**：扁平 `ip:port` 列表（支持 IPv4 / `[IPv6]:port` / 裸 IPv6），PD 分离场景填 P 节点 + 各 DP 域端口；它是**指标采集端点列表**，与压测目标 `host_ip:port` 是两回事——UI 上必须分开呈现，避免用户混淆。
8. **进度感知**：原工具无回调钩子。GUI 需解析 stdout（`[Round n]`、阶段标题、命中率汇总表）+ 增量读结果 CSV/JSONL 来推断进度；数据集生成阶段用 tqdm 百分比。
9. **性能指标来源**：AISBench 日志中的摘要表（TTFT avg/p90、TPOT avg/p90、吞吐、并发、时长），由 `parse_aisbench_log` 正则提取——结果解析器需完整移植。

### 0.2 UCM / vLLM 指标清单（硬编码依据）

- **前缀规则**：`ucm:` 前缀 = UCM connector 指标（仅启用 UCM 时存在，`vllm_connector_prefix: "ucm:"`）；`vllm:` 前缀 = vLLM 引擎原生指标（始终存在）。**面板按"是否发现 `ucm:` 指标"自动切换布局**。
- **Labels**：所有指标带 `model_name`、`engine`、`worker_rank`；无独立"DP 域"label，`engine` 即 DP 域标识。
- **核心指标白名单**（实时面板采用，5s 轮询）：

| 类别 | 指标名 | 类型 | 用途 |
| --- | --- | --- | --- |
| HBM 命中 | `vllm:prefix_cache_queries_total` / `_hits_total` | counter | 命中率分子分母 |
| External 命中 | `vllm:external_prefix_cache_queries_total` / `_hits_total` | counter | 外部缓存命中率 |
| UCM token 流向 | `ucm:total_prefix_query_tokens_total`、`ucm:gpu_hbm_hit_tokens_total`、`ucm:ucm_hit_tokens_total` | counter | 饼图：HBM 命中 / UCM 命中 / Miss |
| 分层命中 | `ucm:cache_lookup_{hit,miss}_blocks_total`、`ucm:posix_lookup_{query,hit}_blocks_total`、`ucm:yuanrong_{local_dram,remote,local_ssd}_load_hits_total`、`ucm:mooncake_load_{hit,miss}_shards_total` | counter | 分层命中率拆解（HBM→Cache→Posix/Mooncake/YuanRong） |
| 调度状态 | `vllm:num_requests_running` / `_waiting` / `_swapped` | gauge | 并发卡片、排队曲线 |
| KV 占用 | `vllm:kv_cache_usage_perc` | gauge | 显存缓存水位 |
| 吞吐 | `vllm:prompt_tokens_total`、`vllm:generation_tokens_total` | counter | 实时吞吐 tok/s |
| 延迟 | `vllm:time_to_first_token_seconds`、`vllm:inter_token_latency_seconds`、`vllm:e2e_request_latency_seconds` | histogram(_sum/_count) | 实时 avg TTFT / TPOT / E2E |
| 容量/健康 | `posix_store_{used,capacity}_bytes`、`{posix,mooncake}_store_health`、`yuanrong_{dram,ssd}_usage_ratio` | gauge | 存储水位与健康（UCM 模式） |

- **采集参数依据**：UCM `log_interval: 5`s、Grafana 面板 refresh 10s、参考部署 scrape 2s → **工具默认 5s 轮询、可调 2–30s**。
- **除零保护**：统一 `max(Δqueries, 1)`；分层数据不可跨单位混算（token/block/shard 各自成比）。

### 0.3 AISBench 与运行环境

- `pip install ais_bench_benchmark`（目标版本 `3.1.20260630`），Python **仅支持 3.10/3.11/3.12** → Sidecar 打包内嵌 Python 3.11。
- GLM 系列模型生成数据集需 `transformers>=5.0`，其他模型 4.x 可用 → **tokenizer 兼容性提示放入环境诊断**。

### 0.4 LobeHub UI Kit

- `@lobehub/ui` 基于 Ant Design + antd-style，ESM-only；**新版 Provider 顺序强制：`ConfigProvider` 包裹 `ThemeProvider`**（不得颠倒）。
- 图表用 `@lobehub/charts`（Lobe Charts）；HTML 报告内嵌 ECharts（离线可看，与 Lobe 视觉一致）。
- 渲染进程用 Vite 构建（ESM 友好）；主进程保持 CJS。

### 0.5 对需求文档的修正点

| # | 需求原文认知 | 调研后修正 |
| --- | --- | --- |
| 1 | "原始工具不支持用随机词表生成数据集" | 已支持 tokenizer 词表随机采样；增强点改为：自定义词表文件、tokenid 精确模式、进度/中断/续传 |
| 2 | "预埋轮"作为独立轮次 | 是每轮内部 phase=warmup，以 phase 字段标记与排除 |
| 3 | "UCM 指标通过 vLLM connector 暴露，默认启用 metrics" | 需运行时探测 `ucm:` 前缀指标是否存在，缺失时降级为 vLLM-only 面板并提示（指标缺失≠0） |
| 4 | "自动区分 P/D 节点" | 原工具 pod_info 为扁平列表；P/D 分组是 UI 便利层，采集端点统一扁平化，UI 按 role 分组展示 |
| 5 | 采集间隔 ≥5s | 采纳 5s 默认；阶段级命中率仍用快照差分（与原工具一致，可对标） |

---

## 1. 总体架构

### 1.1 架构图

```
┌────────────────────────────────────────────────────────────────┐
│ Electron 桌面容器                                                │
│                                                                │
│  ┌────────────────────┐        IPC (contextBridge)             │
│  │  主进程 (Main)      │◄──────────────►┌────────────────────┐  │
│  │  · Sidecar 生命周期 │                │  渲染进程 (Renderer)│  │
│  │    守护/一键重启     │                │  React 18 + Vite    │  │
│  │  · 端口发现/令牌分发 │                │  @lobehub/ui        │  │
│  │  · 原生对话框/窗口   │                │  @lobehub/charts    │  │
│  └─────────┬──────────┘                └─────────┬──────────┘  │
│            │ spawn                                │             │
└────────────┼──────────────────────────────────────┼─────────────┘
             ▼                                      │ HTTP REST + WebSocket
   ┌──────────────────────┐    127.0.0.1:动态端口    │ (仅本机回环 + Bearer 令牌)
   │  Python Sidecar       │◄───────────────────────┘
   │  (PyInstaller onedir) │
   │  FastAPI + Uvicorn    │
   │  · Runner: 子进程托管   │      子进程(自复用)        子进程
   │    ais_bench CLI 执行  │    ┌──────────────┐   ┌──────────────┐
   │  · DatasetGenerator   │    │ ais_bench CLI │   │ curl/探测任务 │
   │  · MetricsCollector   │    └──────┬───────┘   └──────────────┘
   │    (5s 轮询+快照差分)   │           │ HTTP
   │  · Store (SQLite+文件) │           ▼
   │  · Report (xlsx/HTML) │   推理服务 vLLM/UCM
   └──────────────────────┘   http://ip:port (/v1/chat, /metrics)
```

### 1.2 关键机制

| 机制 | 设计 |
| --- | --- |
| **端口发现** | 主进程以 `--port-file <path>` 启动 Sidecar；Sidecar 绑定 `127.0.0.1:0`，把 `{port, token}` 写入端口文件；主进程读取后经 IPC 注入渲染进程 |
| **本机安全** | 仅绑定回环地址；所有请求带启动时生成的随机 Bearer token；目标服务 IP 只由 Sidecar 出站访问，渲染进程不直接对目标服务发请求 |
| **Sidecar 守护** | 主进程监听 exit 事件：异常退出→托盘/页内横幅提示 + 一键重启；正常退出（应用关闭）→ taskkill 进程树，确保无孤儿进程 |
| ** ais_bench 执行** | Sidecar 自复用：`sidecar.exe --child aisbench <args>` 子进程运行 AISBench 主入口（onedir 模式避免 onefile 重复解压），stdout/stderr 管道回收实时转发 |
| **打包** | Sidecar：PyInstaller **onedir**（内嵌 Python 3.11 + fastapi/uvicorn/httpx/transformers/openpyxl/ais_bench_benchmark==3.1.20260630）；Electron：electron-builder NSIS，Sidecar 放 `resources/sidecar/`，首启动完整性自检 |

### 1.3 技术栈版本基线

| 层 | 选型 | 版本基线 |
| --- | --- | --- |
| 桌面容器 | Electron | 33.x（CJS 主进程） |
| 构建 | electron-builder / Vite | latest / 6.x |
| 渲染 | React + TypeScript | 18.x / 5.x |
| UI Kit | @lobehub/ui + antd + antd-style | 最新稳定（注意 ConfigProvider→ThemeProvider 顺序） |
| 图表 | @lobehub/charts（应用内）、ECharts 5（导出报告内嵌） | — |
| Sidecar | Python 3.11 + FastAPI + Uvicorn + httpx + transformers + openpyxl + prometheus-client(解析) | ais_bench_benchmark==3.1.20260630 |
| 打包 | PyInstaller (onedir) | 6.x |

---

## 2. 数据模型与存储

### 2.1 磁盘布局

```
%APPDATA%/AISBenchPrefixTester/
├── app.db                        # SQLite：runs/rounds/tokenizers/settings/presets
├── sidecar.port                  # {port, token}（启动时重写）
├── assets/tokenizers/            # 预置 tokenizer（deepseek-v3 / qwen3 / glm-4）
└── outputs/
    └── {run_id}/                 # run_id = 20260920_114530_a3f2
        ├── config.json           # 本次运行全部参数（含 rounds 计划）
        ├── stdout.log            # AISBench 子进程合并输出（原文）
        ├── stderr.log
        ├── metrics_timeseries.jsonl   # 5s 轮询序列，一行一个采样点
        ├── metrics_phase_snapshots.json  # 各阶段前后快照 + 差分命中率
        ├── results/              # prefix_bench_result.csv/.jsonl + AISBench 原生输出
        ├── report.xlsx           # 按需生成
        └── report.html           # 按需生成（内嵌 ECharts，离线可看）
```

### 2.2 SQLite Schema（核心表）

```sql
-- 测试运行
CREATE TABLE runs (
  run_id      TEXT PRIMARY KEY,          -- 20260920_114530_a3f2
  name        TEXT,                      -- 用户可改显示名
  status      TEXT,                      -- pending|running|completed|failed|cancelled
  created_at  TEXT, finished_at TEXT,
  config_json TEXT,                      -- 完整配置（含服务/前缀/并发/pod/rounds）
  model_name  TEXT, host TEXT,           -- 冗余列，供列表筛选
  is_practice INTEGER DEFAULT 0,         -- 手动标记的"练习/预埋"run，对比默认排除
  notes       TEXT
);

-- 轮 × 阶段结果（对比分析的事实表）
CREATE TABLE rounds (
  id INTEGER PRIMARY KEY,
  run_id TEXT, round_index INTEGER,      -- 第几轮（1 起）
  phase TEXT,                            -- warmup | full
  is_warmup INTEGER DEFAULT 0,           -- 预埋阶段恒为 1，参与排除
  params_json TEXT,                      -- 该轮生效参数（含 override）
  metrics_json TEXT,                     -- ttft/tpot/吞吐/时长/并发…（原样 CSV 行）
  hit_rate_json TEXT                     -- {per_dp:{dp0:{hbm,ext,...}}, aggregated:{...}}
);

-- 词表/数据集
CREATE TABLE datasets (
  id INTEGER PRIMARY KEY, name TEXT, mode TEXT,          -- gsm8k|tokenid
  tokenizer TEXT, vocab_source TEXT,                     -- preset|custom:<path>
  params_json TEXT,                 -- input_len/repeat_rate/prefix_num/seed…
  files_json TEXT, stats_json TEXT, -- 文件路径、行数/实测 token 分布直方图
  created_at TEXT
);

CREATE TABLE tokenizers (name TEXT PRIMARY KEY, path TEXT, source TEXT, version TEXT);
CREATE TABLE presets   (name TEXT PRIMARY KEY, config_json TEXT, updated_at TEXT);
CREATE TABLE settings  (key TEXT PRIMARY KEY, value TEXT);
```

> 时间序列不进 SQLite：`metrics_timeseries.jsonl` 逐行追加（崩溃安全），查询时 Sidecar 流式读取按时间窗过滤；DB 只存轮次级汇总。

### 2.3 指标时间序列行格式（JSONL）

```json
{"ts": 1768945530, "pod": "10.0.0.1:8000", "engine": "0",
 "hbm_q": 5120000, "hbm_h": 4710400, "ext_q": 409600, "ext_h": 356000,
 "ucm_detected": true,
 "extra": {"running": 40, "waiting": 0, "kv_usage": 0.71,
           "ttft_sum": 12.4, "ttft_count": 320, "itl_sum": 88.1, "itl_count": 1200,
           "ucm_hbm_hit_tokens": 98304, "ucm_ucm_hit_tokens": 8192, "ucm_query_tokens": 114688}}
```

派生指标（渲染端计算，Sidecar 只存原始 counter）：`hbm_rate=Δh/hΔq`、`ext_rate=Δext_h/Δext_q`、`综合=ext_rate×(1−hbm_rate)+hbm_rate`（与 UCM Grafana 面板公式一致）。

---

## 3. 功能模块设计

模块编号 M1–M7；每个模块给出：功能点 / 后端接口 / 验收标准。

### M1 测试配置与预设

**功能点**
1. **服务连接**：`host_ip:port` 或完整 `URL`（互斥，URL 优先，Docker 场景提示）；"探测"按钮调用 `/v1/models` 自动回填 model_name，失败给出原因（超时/404/代理拦截）。
2. **前缀参数组**：`input_len / output_len / data_num / prefix_num / repeat_rate / dp / seed`；repeat_rate 支持 `90%` 或 `0.9` 双格式；seed=0 标注"纯随机（不可复现）"。
3. **调度参数组**：`concurrency / request_rate(0=burst) / test_type(stream|text) / enable_think / npu_num`；变长参数组（mean+std 或 min+max，两组互斥、成对校验——移植 `validate_args` 规则）。
4. **采集端点（pod_info）**：多行粘贴编辑器（每行一个 `ip:port`，支持 IPv6 三格式），支持"P 节点 / D 节点"分组录入后扁平化；每行状态徽标（未探测/可达/不可达）。
5. **多轮计划编辑器**：可增删排序的轮次表格，每轮可覆盖 10 个合法键（其余键禁用并解释"全局共享"）；每轮可勾选"仅预埋"。
6. **预设**：命名保存/加载/导出 JSON（与原工具 `--rounds` 文件互导，保证 CLI 用户可迁移）。
7. **参数体检**：提交前静态校验（长度范围、`prefix_num ≤ data_num`、并发 vs data_num 合理性、dp 与 pod 数一致性提醒），警告与错误分级展示。

**接口**：`POST /api/config/validate`、`GET/POST/DELETE /api/presets`
**验收**：同一配置生成的 `--rounds` JSON 可被原工具 `prefix_bench.py --rounds` 直接执行（互操作性验收）。

### M2 数据集生成器（增强）

**功能点**
1. **Tokenizer 选择**：预置列表（首选用户本机 `D:\Models\Qwen3-32B`、`D:\Models\GLM-4.7-Flash`，均已含 tokenizer.json；应用资源目录与按需下载作为兜底）+ 自定义模型目录注册（识别 `tokenizer.json` / `tokenizer_config.json` / `vocab.json` 等）。
2. **两种模式**（**不依赖任何真实数据集**——全部样本由词表纯合成，`gsm8k` 仅是 AISBench 加载器要求的 JSONL 容器格式 `{"question":…,"answer":"none"}`，与真实 GSM8K 数据无关）：
   - `gsm8k（文本）`：沿用原工具逻辑（safe_ids 采样 → decode → re-encode 校准）；
   - `tokenid（精确 token）`：直接以 token id 序列构造前缀/后缀，最后一次 decode 成文本交付 AISBench；生成后 re-encode 校验 token 数，误差 >1% 告警。
3. **自定义词表文件**：用户词表 `vocab.txt`（每行一个词/子词），替代模型词表参与采样。
4. **数据集预览（信任建立关键）**：抽样展示样本，按 **前缀（蓝）/分隔符（灰）/后缀（橙）** 着色分段；展示实测 token 长度直方图 vs 目标 `input_len`；展示理论命中率 `repeat_rate × (1 − 3/input_len)` 供交叉核对。
5. **生成任务**：异步 job，进度回调（行数/总行数），支持取消与断点续传（分块 checkpoint manifest）；生成的数据集入库（哈希去重），可复用（跳过再生）。
6. 生成参数默认跟随当前测试配置，也可独立生成入库。

**接口**：`POST /api/datasets/preview`、`POST /api/datasets/generate`（job）、`GET /api/jobs/{id}`、`GET /api/datasets`
**验收**：repeat_rate=90%、input_len=32768 的数据集，实测样本前缀共享段 ≥ 29400 token（32768×90%−3），直方图峰值对齐 32768±1%。

### M2.5 轮间缓存清理（针对原工具"跨轮残留命中"缺陷）

原工具多轮测试时，上一轮注入/命中的前缀 KV 会残留到下一轮，导致轮间命中率互相污染、对比失真。本工具的对策（`cache_reset` 配置，默认 `each_round`）：

| 策略 | 行为 |
| --- | --- |
| `each_round` | 每一轮的预埋阶段开始前，对全部采集端点调用 vLLM `POST /reset_prefix_cache`（UCM 场景该接口同时触发外部缓存失效；实现按端点逐个调用并记录结果） |
| `first_round_only` | 仅第 1 轮前清理（后续轮保留前一轮缓存，用于观测累积效应——此时轮间对比需知晓前缀一致性） |
| `never` | 不清理（由用户自行重启服务），UI 显著警告"轮间将存在残留命中" |

**残留检测兜底**（清理失败/不支持 reset 的服务也能发现污染）：每轮开始前记录 counter 快照，若该轮开始时 `prefix_cache_queries_total` 已大于 0 且本轮未做过成功 reset，监控页与结果行打 `residual_cache_risk: true` 警告标记，对比页在受影响轮次上标注。reset 调用结果（成功端点数/失败原因）写入 run 事件流与结果行。
**前缀隔离辅助**：多轮计划中可选"每轮 seed 偏移"（round i 使用 seed+i×1000），使各轮前缀互不相同，从数据面消除跨轮命中。

### M3 测试执行与实时监控

**功能点**
1. **执行编排**（Sidecar Runner，移植原工具 `run_single_round` 两阶段流程）：
   每轮 = 预埋阶段（并发=dp、output_len=1、前缀文件）→ 快照 → 全量阶段（目标并发、全量文件）→ 快照 → 差分命中率 → 解析 AISBench 日志 → 写 CSV/JSONL → 下一轮。
2. **run 生命周期**：`pending → running(round i/N, phase) → completed | failed | cancelled`；任何时刻可"停止"（优雅终止子进程树，已采数据保留并标记 cancelled）。
3. **实时推送（WebSocket 事件协议）**：

```jsonc
// WS /ws/runs/{run_id}，服务端推送：
{"type":"status","status":"running","round":1,"total_rounds":3,"phase":"warmup","elapsed":12.4}
{"type":"log","stream":"stdout","line":"[Round 1/3] Phase 1: prefix warmup ..."}
{"type":"progress","stage":"dataset|phase","percent":42.5}
{"type":"metrics","ts":1768945530,"sample":{ /* 2.3 节行格式 */ }}
{"type":"result","round":1,"phase":"full","row":{ /* 结果行 */ }}
{"type":"phase_rate","round":1,"phase":"full","rate":{"dp0":{"hbm":0.923,"ext":0.871},"agg":{...}}}
```

4. **监控面板布局**（详见 §6.3）：状态时间线、指标大数字卡、命中率/并发双图、日志窗、DP 域明细表。
5. **UCM 模式自动探测**：首个采样若含 `ucm:` 指标 → 展示 token 流向饼图与分层命中拆解；否则显示横幅"未检测到 UCM 指标（仅 vLLM 原生可见），可能未启用 UCM 或指标未暴露"。
6. **异常处理**：ais_bench 退出码非 0 → 标记 failed 并保留日志；Sidecar 崩溃 → 主进程横幅 + 一键重启（运行中 run 转为 interrupted，可从轮次边界恢复查看）。

**接口**：`POST /api/runs`、`GET /api/runs/{id}`、`POST /api/runs/{id}/stop`、`WS /ws/runs/{id}`
**验收**：repeat_rate=90% 数据集压测后，全量阶段 HBM 命中率落在 90%±5%（验收窗口）；日志从产生到 UI 渲染延迟 ≤2s。

### M4 运行记录

**功能点**
1. 列表：时间、名称、状态、模型、关键结果列（HBM/Ext 命中率、TTFT avg、吞吐），按状态/模型/时间筛选与搜索。
2. 详情抽屉：参数快照、结果表（轮×阶段）、指标回放（读取 timeseries 复现运行中曲线）、日志查看、DP 域命中率表、导出（xlsx/HTML/CSV/JSONL）。
3. 元数据管理：重命名、备注、**手动标记/取消"练习轮"（is_practice）**、删除（含磁盘清理确认）。
4. 中断恢复查看：interrupted run 的已采集数据完整可查，标注"数据截至中断时刻"。

**接口**：`GET /api/runs`、`PATCH /api/runs/{id}`、`DELETE /api/runs/{id}`、`GET /api/runs/{id}/export?format=`
**验收**：kill -9 Sidecar 后重启，历史 runs 与 timeseries 文件完整可读。

### M5 多轮对比分析

**功能点**
1. **选择器**：勾选 ≥2 个 run（默认排除 `is_warmup` 阶段行与 `is_practice` run，可显式勾回并醒目标注）；轮次配对策略：按 round_index 对齐，缺失轮显示空缺。
2. **对比维度**（需求 2.5.1 落地）：
   - 配置差异表：并排显示，差异键高亮；
   - 指标增量卡：`Δ% = (B−A)/A`，命中率类涨=绿，延迟类涨=红（语义方向感知）；
   - 图表：分组柱状图（各轮次 TTFT/TPOT/吞吐对比）、命中率时序叠加折线（多 run 同图）、雷达图（命中率/TTFT/TPOT/吞吐/稳定性五维归一化评分）；
   - DP 域热力表：run × dp 域命中率矩阵。
3. **导出**：
   - **xlsx**（openpyxl）：Sheet1 汇总对比、Sheet2 指标变化率、Sheet3+ 各 run 原始行、Sheet DP 明细、Sheet 配置差异；
   - **HTML**：单文件内嵌 ECharts，离线可打开，含全部图表 + 结论摘要区（自动生成：命中率变化、最大回退项）。

**接口**：`POST /api/compare {run_ids[], exclude_warmup, round_align:"index"}`、`POST /api/compare/export?format=xlsx|html`
**验收**：相同参数重复两次测试，对比表各指标 Δ% < 2%（稳定性验收）；warmup 行不出现于任何对比统计。

### M6 环境、Tokenizer 与诊断

**功能点**
1. **环境诊断页**：Sidecar 健康、Python 版本、ais_bench 版本与位置、transformers 版本（GLM 模型 >5.0 提示）、curl/网络出站自检、预置 tokenizer 完整性、磁盘空间；一键复制诊断报告。
2. **Tokenizer 注册表**：预置项展示来源与大小；自定义目录注册/卸载；"验证"按钮试加载并显示 vocab 大小与 special tokens 数。
3. **AISBench 工作区**：`work_path / dataset_path / output_dir` 可视化配置与目录检查（替代原 config.py 手改）。

**接口**：`GET /api/diagnosis`、`GET/POST/DELETE /api/tokenizers`、`GET/PUT /api/settings`
**验收**：断网环境下诊断页逐项明确标红原因；错删 tokenizer 文件后诊断可检出并引导重新下载。

### M7 日志查看器（跨页组件）

双栏 stdout/stderr，特性：ERROR/WARN/`ucm:`/时间戳 正则高亮、级别过滤、增量渲染（虚拟滚动，防 10 万行卡死）、关键字搜索、跟随滚动开关、导出当前过滤视图。

---

## 4. 指标采集与计算设计

### 4.1 采集器（Sidecar 内 `MetricsCollector`）

- **轮询**：默认 5s（可配 2–30s），对 pod_info 全部端点并发 GET `http://{pod}/metrics`（httpx，禁用系统代理，超时 3s，失败重试 1 次后跳过本周期并记 `fetch_error` 事件）。
- **解析**：prometheus_client 文本解析；仅提取 §0.2 白名单指标；按 `(pod, engine, worker_rank)` 分组；无 engine label 时归 `engine="0"`。
- **双通道**：
  1. **快照差分**（阶段级，与原工具口径一致）：每阶段前后各存一次快照，`rate = Δhits/Δqueries`，写 `metrics_phase_snapshots.json` 与 rounds 表；
  2. **时间序列**（周期级）：每周期原始 counter 入 JSONL；UI 的"实时命中率"用**滑动窗口差分**（最近 N 个采样点）呈现趋势，"阶段命中率"以快照差分为准——两种口径在 UI 上明确标注，避免误读。
- **存储**：追加 JSONL；run 结束后统计压缩（可选按 30s 降采样生成 `metrics_summary.json` 供对比页快速加载）。

### 4.2 指标计算公式（与 UCM Grafana 口径一致）

```
HBM 命中率    = Δ(vllm:prefix_cache_hits_total)        / max(Δ(vllm:prefix_cache_queries_total), 1)
Ext 命中率    = Δ(external_prefix_cache_hits_total)    / max(Δ(external_prefix_cache_queries_total), 1)
综合命中率    = ext_rate × (1 − hbm_rate) + hbm_rate
UCM 流向占比  = gpu_hbm_hit_tokens / total_prefix_query_tokens, ucm_hit_tokens / …, miss = max(Q−h−u, 0)
分层命中率    = 各层 hits/queries（token、block、shard 分别成比，禁止跨单位）
实时吞吐      = Δ(generation_tokens_total)/Δt；avg TTFT = Δ(ttft_sum)/Δ(ttft_count)
```

### 4.3 UCM 前缀识别与降级

| 探测结果 | 判定 | UI 行为 |
| --- | --- | --- |
| 存在 `ucm:*` 指标 | UCM 已启用 | 完整面板：命中趋势 + token 流向饼图 + 分层拆解 + 存储水位 |
| 仅 `vllm:*` | UCM 未启用/未暴露 | vLLM-only 面板 + 黄色横幅说明"外部缓存指标缺失≠未命中" |
| 两者皆无 | 端点异常 | 红色横幅 + 重试按钮 + 该端点标红 |

---

## 5. Sidecar API 设计（REST + WS）

```
GET  /api/health                  → {status, version, aisbench:{version, path}, pid}
GET  /api/diagnosis               → 诊断项数组 [{item, ok, detail, hint}]
GET/PUT /api/settings             → work_path/dataset_path/output_dir/采集间隔/主题语言偏好
GET  /api/config/validate  POST   → {errors[], warnings[]}
GET/POST/DELETE /api/presets
GET/POST/DELETE /api/tokenizers   POST /api/tokenizers/verify
POST /api/datasets/preview        → {samples[], hist[], est_hit_rate}
POST /api/datasets/generate       → {job_id}；GET /api/jobs/{job_id} → {percent, state}
GET  /api/datasets                POST /api/datasets/{id}/delete
POST /api/runs                    → {run_id}（body=完整配置；可选 dataset_id 复用）
GET  /api/runs?status=&model=&q=  → 列表（分页）
GET  /api/runs/{id}               → 详情（config + rounds + 结果）
PATCH /api/runs/{id}              → {name?, notes?, is_practice?}
POST /api/runs/{id}/stop          DELETE /api/runs/{id}
GET  /api/runs/{id}/logs?stream=&tail=&filter=
GET  /api/runs/{id}/metrics?from=&to=&downsample=
GET  /api/runs/{id}/export?format=xlsx|html|csv|jsonl
POST /api/compare                 → 对比结果（结构见 §M5）
POST /api/compare/export?format=
WS   /ws/runs/{run_id}            → §M3 事件协议
```

鉴权：所有请求头 `Authorization: Bearer {token}`（端口文件分发）；非本机来源直接拒绝（绑定 127.0.0.1 保证）。

---

## 6. UI 设计

### 6.1 设计语言（Lobe 风格）

| Token | 值（暗色） | 说明 |
| --- | --- | --- |
| 背景层次 | `#050505` 页面 / `#161616` 卡片 / `#222` 悬浮 | Lobe 近黑底 + 微弱层次 |
| 描边/分隔 | `rgba(255,255,255,0.08)` | 极细 1px，弱化边框感 |
| 主色 | `#0070f3`（品牌蓝） | 主按钮、聚焦、链接 |
| 语义色 | 成功 `#0ea472` · 警告 `#dhwarn #e5a03c` · 危险 `#e5484d` | 状态点、增量箭头 |
| 命中率用色 | HBM `#4f8bff` · External `#13c2c2` · UCM 命中 `#9254de` · Miss `#595959` | 全应用统一，报告同色 |
| 前缀分段用色 | 前缀蓝 `#4f8bff22` · 分隔灰 · 后缀橙 `#f9022` 系 | 数据集预览 |
| 圆角 | 卡片 12px / 控件 8px | — |
| 字体 | 界面 Inter/系统栈；数字 `tabular-nums`；日志/代码 `JetBrains Mono` 等宽 | 指标卡数字用等宽避免跳动 |
| 间距密度 | 表单紧凑（4px 栅格 ×2），监控页大数字 28–34px | 工具型产品优先信息密度 |
| 主题 | 暗色默认，亮色可切，跟随系统；报告固定随当前主题 | antd-style token 化 |

### 6.2 信息架构与导航

```
┌────────┬──────────────────────────────────────────────┐
│ Logo   │  顶栏：面包屑/页标题      [Sidecar ●] [主题] [设置]│
│────────│──────────────────────────────────────────────│
│ ▶ 新建测试  (TestForm)                                   │
│ ◉ 运行监控  (Monitor)    —— 有运行中的 run 时显示徽标      │
│ ☰ 运行记录  (History)                                    │
│ ⇄ 对比分析  (Compare)                                    │
│ ▤ 数据集    (Datasets)                                   │
│ ⚙ 设置      (Settings)                                   │
│────────│                                              │
│ 底部: AISBench v3.1… ● 就绪                              │
└────────┴──────────────────────────────────────────────┘
```

- 侧栏 220px 可折叠为图标栏；页签右上角徽标（运行中数量）。
- 全局状态条：Sidecar 连接状态（绿点/红点 + 重连倒计时）、AISBench 版本。

### 6.3 页面设计（线框 + 交互）

#### P1 新建测试

```
┌ 侧栏 ┬────────────────────────────────────────────────────────────┐
│      │ 新建测试            预设[DeepSeek-A2-90%重复 ▼] [另存] [管理]  │
│      │ ┌───────────────────────────────────┬────────────────────┐ │
│      │ │ ① 服务连接 ─────────────────────── │ 摘要 · 校验         │ │
│      │ │ 服务地址 [192.168.1.10 ] 端口[8000] │ ┌────────────────┐ │ │
│      │ │ 或完整 URL [ ]（覆盖左侧）           │ │输入 32,768 tok  │ │ │
│      │ │ [探测服务] → ✓ deepseek-v3 · 0.2s   │ │输出    512 tok  │ │ │
│      │ │ 模型名 [自动探测] NPU数 [1]          │ │条数 160×前缀160  │ │ │
│      │ │ 模型目录 [D:\models\ds-v3][浏览…]    │ │重复率    90 %   │ │ │
│      │ │ ② 前缀与数据集 ────────────────────  │ │并发  40 (burst) │ │ │
│      │ │ input_len[32768] output_len[512]    │ │DP 域      1     │ │ │
│      │ │ data_num[160]  prefix_num[160]      │ │采集端点    2 个  │ │ │
│      │ │ repeat_rate[90]%  dp[1]  seed[1]    │ │轮次      1 轮   │ │ │
│      │ │ 词表来源 ◉预置(Qwen3 ▼) ○自定义目录   │ └────────────────┘ │ │
│      │ │  ○词表文件[导入]  ○tokenid 精确模式   │ ⚠ prefix_num(160)  │ │
│      │ │ [生成数据集预览 ▸]                   │   = data_num，各样本│ │
│      │ │ ③ 并发与调度 ▾  ④ 变长分布 ▾         │   前缀互不相同，命中 │ │
│      │ │ ⑤ 采集端点(PD) ▾  ⑥ 多轮计划 ▾       │   率将≈0，确认？    │ │
│      │ └───────────────────────────────────┴────────────────────┘ │
│      │ 底部操作条：            [重置] [保存为预设]   [▶ 开始测试]     │
└──────┴────────────────────────────────────────────────────────────┘
```

交互要点：
- **右栏摘要实时联动**（所有输入即时换算成"人话"摘要），并在改动导致理论命中率异常（如 prefix_num ≥ data_num 且 repeat_rate 高时提示"冷启动命中"）时给出警告级体检项；
- 采集端点编辑器：批量粘贴 → 解析表格（ip/port/协议/role），每行"测试"按钮即时探测 `/metrics` 可达性；
- 多轮计划：表格编辑，非法键置灰 tooltip"由全局配置决定"；
- "开始测试"→ 二次确认弹窗（展示将写入的目标服务与预计时长估算 = data_num×(input+output)/concurrency 粗估）→ 跳转监控页。

#### P2 运行监控（英雄界面）

```
┌ 侧栏 ┬────────────────────────────────────────────────────────────┐
│      │ run_20260920_114530 · deepseek-v3 · 第1/3轮                  │
│      │ ●运行中  阶段: [①预埋 ✓ 0:42] ─ [②全量 ● 12:32] ─ [下一轮…]    │
│      │                                    [暂停跟随] [■ 停止测试]    │
│      │ ┌───────┬───────┬───────┬───────┬───────┐  UCM ●已检测      │
│      │ │HBM命中 │Ext命中 │综合命中 │已完成请求│avg TTFT│              │
│      │ │ 92.3% │ 87.1% │ 99.0% │ 128/160│ 412ms │                │
│      │ └───────┴───────┴───────┴───────┴───────┘                  │
│      │ ┌─────────────────────────────┬──────────────────────────┐ │
│      │ │ 命中率趋势 (%，5s 粒度)        │ 请求状态 / KV 占用          │ │
│      │ │  ┈┄ HBM ─── 92% ↗           │  running ▁▂▅▆▇  waiting   │ │
│      │ │  ┈┄ Ext ─── 87%             │  kv_usage 71% ─────────    │ │
│      │ └─────────────────────────────┴──────────────────────────┘ │
│      │ ┌─────────────────────────────┬──────────────────────────┐ │
│      │ │stdout│stderr│ [过滤▾][搜索… │ Token 流向（UCM）  饼图      │ │
│      │ │ 12:32:01 [Round 1/3] Phase 2 │  ■HBM命中 85.7%           │ │
│      │ │ 12:32:05 Processing batch…   │  ■UCM命中  8.9%           │ │
│      │ │ 12:32:09 WARNING …           │  ■Miss     5.4%           │ │
│      │ │ □ 跟随滚动   [导出日志]        │ 分层命中: Cache/Posix/…    │ │
│      │ └─────────────────────────────┴──────────────────────────┘ │
│      │ DP 域明细（快照差分）                                         │
│      │ │DP域│HBM命中率│HBM hits/queries│Ext命中率│Ext hits/queries│   │
│      │ │dp0 │ 92.3%  │ 4,710,400/5,120,000│ 87.1% │ …            │   │
└──────┴────────────────────────────────────────────────────────────┘
```

- 阶段时间线可点击回看已完成阶段（切换图表时间窗）；"口径"徽标区分实时（滑动窗）与阶段（快照差分）；
- 命中率趋势图同时绘制 HBM/Ext 两条线 + 综合命中率虚线；UCM 未检测时右侧替换为提示卡；
- 停止需确认；failed/cancelled 后页面转为"结果冻结"态并引导至运行记录。

#### P3 运行记录

表格列：状态点｜名称/ID｜时间｜模型｜轮次｜HBM/Ext 命中率｜TTFT｜吞吐｜操作（详情/导出/⋯）。
详情抽屉（右侧 720px）：参数快照 → 轮×阶段结果表 → 指标回放图（复用监控图表，只读）→ 日志 → DP 表；头部操作：重命名、备注、**标记练习轮**、删除、导出。

#### P4 对比分析

```
┌ 侧栏 ┬──────────────┬─────────────────────────────────────────────┐
│      │ 选择运行 (3)   │ 对比仪表盘                                    │
│      │ ☑ run_0919_01 │ ┌─────────────────────────────────────────┐ │
│      │   90%·dp1     │ │Δ卡: HBM +2.1%↑ │ TTFT −8.3%↓绿 │ 吞吐…   │ │
│      │ ☑ run_0920_01 │ └─────────────────────────────────────────┘ │
│      │   90%·dp2     │ ┌ 配置差异 ────────── ┬─ 指标对比表 ─────────┐ │
│      │ ☐ run_0920_w  │ │dp: 1 → 2  (高亮)    │轮次对齐: R1/R2/均值  │ │
│      │ ⚠练习轮(默认排除)│ └────────────────────┴─────────────────────┘ │
│      │ [排除warmup ✓] │ ┌ 分组柱状: TTFT ┐┌ 命中率叠加折线 ┐┌ 雷达 ┐  │
│      │               │ └───────────────┘└──────────────┘└─────┘  │
│      │ [导出 xlsx] [HTML 报告]   DP 域热力表                            │
└──────┴──────────────┴─────────────────────────────────────────────┘
```

- 增量语义方向：命中率/吞吐 ↑绿↓红；TTFT/TPOT/时长 ↓绿↑红；
- 雷达图五维：HBM 命中、Ext 命中、TTFT、TPOT、吞吐（各自 min-max 归一）；
- 轮次不对齐时提示"R2 缺失于 run_A"并在表中留空。

#### P5 数据集

上半部：生成器（tokenizer/模式/参数/词表来源 → 预览 → 生成进度）；下半部：数据集库卡片列表（名称、模式徽标、参数、行数、大小、创建时间；操作：预览/复用到新测试/删除）。预览模态：着色分段样本 + token 长度直方图 + 理论命中率。

#### P6 设置

Tab：**环境**（诊断清单 + AISBench 工作区路径）/ **Tokenizer**（注册表）/ **外观**（主题/语言/图表刷新率）/ **存储**（输出根目录、磁盘占用统计、清理策略）/ **关于**。

### 6.4 关键组件清单

| 组件 | 用途 | Lobe/antd 基础 |
| --- | --- | --- |
| MetricCard | 大数字指标卡（标题+值+趋势箭头+口径徽标） | antd Card + Statistic |
| PhaseTimeline | 预埋→全量 阶段时间线 | antd Steps |
| HitRateChart / SeriesChart | 命中率/并发/吞吐时序（5s 粒度、窗口缩放） | @lobehub/charts + ECharts |
| TokenFlowDonut | UCM token 流向饼图 | ECharts |
| PodEndpointEditor | ip:port 批量粘贴+探测 | antd Table + Input.TextArea |
| RoundsEditor | 多轮覆盖编辑器 | antd EditableProTable |
| LogViewer | 虚拟滚动日志（高亮/过滤/搜索） | 自研 + react-window |
| SegmentedPreview | 前缀/分隔/后缀着色样本 | 自研 |
| DiffTable / DeltaCard | 配置差异与指标增量 | antd Table + 自定义 |
| StatusDot / SidecarBanner | 全局连接状态 | Tag + Alert |

---

## 7. 非功能需求落实

| 需求 | 设计措施 | 验证方式 |
| --- | --- | --- |
| 启动 ≤5s | 渲染层懒加载页面包；Sidecar 异步启动不阻塞窗口 | 计时脚本 |
| Sidecar 冷启动 ≤15s | PyInstaller onedir（非 onefile）；ais_bench 延迟导入（仅执行时） | 打包后实测 |
| 图表延迟 ≤2s | WS 推送直连渲染；图表增量 append 不重绘全量 | 埋点 |
| Sidecar 崩溃恢复 | 主进程 exit 监听 → 横幅 + 一键重启；运行数据已落盘不丢 | 杀进程演练 |
| 测试中断不丢数据 | 日志/时序/结果全部追加式写盘；run 标记 interrupted | 中断演练 |
| 退出清理 | 主进程 `before-quit` taskkill 进程树（含 ais_bench 子进程） | 任务管理器核查 |
| 本机安全 | 127.0.0.1 绑定 + Bearer token + 出站仅 Sidecar 发起 | 端口扫描 |
| Win10 1809+ | Electron 33 基线；NSIS 安装器；无 GPU 加速依赖 | 系统 混测 |

---

## 8. 里程碑规划

| 里程碑 | 周期 | 范围 | 退出标准 |
| --- | --- | --- | --- |
| **M1 骨架贯通** | 4 周 | 三层脚手架、Sidecar 生命周期/端口发现、P1 配置表单+校验、单轮两阶段执行、stdout 日志流、基础结果落库 | 真实 vLLM 服务完成一次端到端两阶段压测，结果 CSV 可读 |
| **M2 指标闭环** | 3 周 | 5s 采集器+快照差分、P2 监控页（卡+图+日志+DP 表）、UCM 探测降级、运行记录列表/详情 | repeat_rate=90% 时 HBM 命中率落 90%±5%；日志延迟 ≤2s |
| **M3 数据集与对比** | 3 周 | 数据集生成器（预置/自定义词表/tokenid/预览/断点续传）、多轮编辑器、P4 对比页、xlsx/HTML 导出 | 互操作性：rounds JSON 可被原 CLI 复用；重复测试 Δ%<2% |
| **M4 产品化** | 2 周 | 环境/Tokenizer 管理+诊断、主题切换、异常恢复打磨、PyInstaller+NSIS 打包、安装器端到端验收 | Win10/11 干净机安装即用；§7 非功能项全绿 |

风险与开放问题：
1. **PyInstaller 内嵌 ais_bench 的 mmengine 配置加载**存在动态 import 风险 → M1 第 1 周先做打包冒烟（spike）；
2. `tokenid` 模式与 AISBench 数据加载器的对接格式需实现阶段核对（当前按"构造 id 序列后 decode 交付"设计，规避格式不确定）；
3. PD 分离下 P/D 节点分别暴露的指标差异需在真实环境核实（当前按"所有配置端点统一抓取"设计）；
4. 预置 tokenizer 版权与体积：首版直接引用用户本机 `D:\Models`（Qwen3-32B / GLM-4.7-Flash），安装包不内置，缺失时按需下载。

### 测试策略（无 GPU 环境）

- **mock vLLM**（`tools/mock_vllm/server.py`）：基于 ClawPerf（`GPT-Zero-main/server.py`）的 OpenAI 兼容 mock（SSE 流式/非流式、/v1/models），扩展三点——① Prometheus `/metrics` 端点，内置**真实模拟的 Prefix Cache**：按请求 prompt 前缀哈希查询内存缓存，命中/未命中驱动 `vllm:prefix_cache_{hits,queries}_total` 与 `external_prefix_cache_*` 计数（warmup 注入 → 全量命中，与真实 vLLM 行为同构）；② 可配置 TTFT/TPOT 延迟模拟；③ `POST /reset_prefix_cache` 支持轮间清理联调。usage 按请求内容估算 token 数而非硬编码。
- **mock aisbench**（`tools/mock_aisbench.py`）：以 AISBench 日志格式输出性能摘要表（TTFT/TPOT/吞吐等）并生成标准 outputs 目录，供 Runner 全链路联调（真实 AISBench 未安装时）。
- Sidecar 的 aisbench 调用命令可配置（默认自动探测 `ais_bench` CLI，可指向 mock），确保测试与生产路径一致。

---

## 9. 附录 A：原工具 CLI 参数 → UI 控件映射

| CLI / config.py | 控件 | 默认 | 校验 |
| --- | --- | --- | --- |
| `--host_ip/--host_port/--url` | 服务地址组（互斥切换） | localhost:8000 | IPv4/IPv6 合法性；URL 覆盖时仍需合法 host |
| `--model_name` | 文本（留空自动探测） | "" | 探测成功回填 |
| `--model_path` | 目录选择器 | — | 必填（tokenizer 依赖） |
| `--input_len/--output_len` | 数字输入 | 3500/1500 | ≥1；input>output 合理提示 |
| `--data_num/--prefix_num` | 数字 | 8192/1 | prefix_num ≤ data_num |
| `--concurrency/--request_rate` | 数字 | 2048/0 | rate=0 标注 burst |
| `--repeat_rate` | 数字+单位切换（%|小数） | 0.5 | (0,1] |
| `--dp` | 数字 | 1 | ≤ pod engine 数提醒 |
| `--seed` | 数字 | 1 | 0→"不可复现"标签 |
| `--test_type/--enable_think` | Segmented / Switch | stream/false | — |
| `--length_mean/std/min/max` | 成对数字（互斥组） | None | 成对必填 + 范围 |
| `--pod_info` | PodEndpointEditor | [] | 逐行 ip:port（IPv6 三格式） |
| `--rounds` | RoundsEditor | 单轮 | 仅 10 个可覆盖键 |
| `--dataset` | 数据集库选择（复用） | 自动生成 | — |
| `--work_path/--dataset_path/--output_dir` | 设置页 | /benchmark 等 | 目录存在性检查 |
| `--npu_num` | 数字 | 1 | ≥1 |

## 附录 B：报告（HTML）页面结构

1. 头部：标题、生成时间、参与 run 概览、结论摘要（自动文案）；
2. 指标增量卡片区；3. 配置差异表；4. 命中率时序叠加图；5. 轮次柱状对比（TTFT/TPOT/吞吐）；6. 雷达评分；7. DP 热力表；8. 附：各 run 完整参数与原始指标表。全部资源内联，双击离线打开。
