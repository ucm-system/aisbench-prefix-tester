# AISBench 前缀复用测试器 — 交割文档（2026-09-20）

> 交接人备注：本文档为完整交割。接手人请先读「当前状态」与「未解决问题 TOP2」。

## 1. 项目概览

- 定位：LLM Prefix Cache 性能测试桌面工具（针对昇腾 NPU / vLLM-Ascend / UCM 分级缓存），AISBench benchmark 的图形化封装。
- 架构：Electron + React (Vite) 前端 + Python FastAPI sidecar（内嵌 ais_bench 调用）+ 打包分发（PyInstaller onedir + electron-builder portable）。
- 仓库：https://github.com/ucm-system/aisbench-prefix-tester（私有）
- 本地路径：`D:\Vibe_Workspace\AISBench_PrefixTest_Tools`
  - `sidecar/` — FastAPI 服务（app/runner.py 编排、app/metrics.py 指标采集、app/aisbench_env.py 配置注入、run_sidecar.py 冻结入口、aisbench-sidecar.spec 打包）
  - `desktop/` — React UI（src/pages/：Config/Monitor/History/Compare/Dataset/Settings/SLA）
  - `tools/` — `pt.py` CLI（给 agent 用）+ SKILL.md + tests/test_features.py（单测，全部通过）
  - `docs/` — DESIGN.md、HANDOFF.md（本文）、screenshots/
- 原参考项目：rayn-zzz/aisbench_auto_tools_prefix（口径对齐：命中率=Δhits/Δqueries 快照差分）

## 2. 当前状态（交割时点）

- 功能 v0.1.0 全部完成：api_key、轮次编辑器（表格+JSON，10 个键可按轮覆盖）、SLA 弹性统计（ttft/tpot/e2el × avg/p50..p99/max）、亮暗主题、轻量化打包（783MB→305MB，带 torch 约 1.2GB）、README+截图已推 GitHub。
- 单实例端到端验证：✅ 完成（源码模式，真实服务器，见 §3）。
- **exe 子模式端到端：✅ 已修复并用真实服务器验收通过（2026-09-20 晚，根因链与验收见 §5）**。
- PD 分离（3P1D）：服务端启动失败根因已查明、正确姿势已调研清楚（§6）；工具侧 pod 维度代码已就绪未实测。
- 服务器：PD 容器已删、8 卡已释放；dxlong-pt-base 容器内 Qwen3-0.6B 单实例服务**正在运行**（203.0.113.10:8101，davinci4），可直接复用或用脚本停掉。

## 3. 单实例验证结论（已完成，可复现）

- 服务：容器 `dxlong-pt-base`，镜像 `quay.io/ascend/vllm-ascend:nightly-releases-v0.26.0rc`（vllm 0.26.0，vllm_ascend 0.19.1rc2.dev1373，mooncake-transfer-engine-npu 0.3.11.post1），模型 `/mnt/model/Qwen3-0.6B`，端口 8101，`--enable-prefix-caching --gpu-memory-utilization 0.35 --max-model-len 8192 --served-model-name qwen3`。
- 工具配置（UI 实测通过）：host=203.0.113.10:8101，model qwen3，tokenizer 预置 Qwen3-0.6B（本地 `D:\Models\Qwen3-0.6B`），input 4096 / output 32 / data 32 / prefix 4 / repeat 90% / conc 8 / dp 1，采集端点 `203.0.113.10:8101`。
- 已验证：轮次循环（warmup+full）、命中率达预期（repeat 90% → HBM 命中率≈理论值）、UCM 对比（`dxlong-pt-ucm` 容器 8102，UCMConnector+Posix，ucm:* 指标被识别）、Monitor 实时图 + 完成后时序回放、报告导出。历史 run 在 `%APPDATA%\AISBenchPrefixTester\outputs\`，真实服务器完成 run 共 12 个（如 20260920_160945_075e）。

## 4. 如何运行

- 开发：`cd desktop && npm run dev`（vite 自启 sidecar，写 `.sidecar-dev.json`；UI http://localhost:5173 或 5174）。Python 必须 `py -3.11`（系统 `python` 是无 pip 的 venv）。npm 需 `ELECTRON_MIRROR`（已配 npmmirror）。
- 设置项（存于 SQLite `app.db` 的 settings 表，**不是 settings.json**）：`aisbench_command`（见 §5 的关键区别）、`work_path`（pip 安装的 ais_bench 的 site-packages 根，本机 `C:\Users\user\AppData\Local\Programs\Python\Python311\Lib\site-packages`）。
- 打包：PyInstaller spec = `sidecar/aisbench-sidecar.spec`；electron-builder 输出 `D:\pt-release`（避免 EPERM）。
- 单测：`py -3.11 tools/tests/test_features.py`（当前全绿）。

## 5. 已解决：冻结 exe 子模式真实压测必挂（2026-09-20 晚修复并验收）

最终发现是 **四个叠加的 bug + 两个可靠性缺陷**，逐层暴露、逐层修复：

1. **task 子进程重入**（原始根因）：ais_bench 以 `<sys.executable> <task>.py <cfg>.py` 拉起 task，冻结 exe 的 sys.executable 是自己 → 重入入口无 `--child-aisbench` → 误入 server → `Path(None)` 崩。
   **修复**：`run_sidecar.py` 增加脚本模式分发——`argv[1]` 是存在的 `.py` 文件时（`freeze_support()` 之后）`runpy.run_path(argv[1], run_name="__main__")`。
2. **纯模块打进了 PYZ**：`__file__` 是归档内虚拟路径，脚本模式前提不成立。
   **修复**：spec 设 `module_collection_mode={'ais_bench': 'py'}`（PyInstaller 6.19 支持），ais_bench 全部以真实 .py 落盘 `_internal/ais_bench/`。
3. **configs 整树缺失**：mmengine 动态加载的 `ais_bench/benchmark/configs`（summarizer/dataset/model 配置）从不被 import → 不进模块图 → 产物里 0 个文件 → CLI 加载 summarizer 直接 `KeyError: 'summarizer'`。
   **修复**：spec 把该树整体作为 datas 打包（`copy_summarizer` 的 find_spec 定位与 CLI 名称解析都依赖它）。
4. **child 模式数据集路径潜在 bug**：`GSM8KDataset.load` 把 `path` 当**目录**拼 `train.jsonl/test.jsonl`，而 `write_dataset_config` 塞的是 test.jsonl **文件**路径（旧包在此前一层就崩，从未暴露）。
   **修复**：`aisbench_env.write_dataset_config` 改为指向链接文件的父目录。

可靠性硬化（直接对应本文档最初警告的「mock 假阳性」）：

- `runner._run_phase` 检测到子进程输出含 `PYI-…ERROR` 即强制该阶段失败（旧版即使崩了也可能 exit 0 混过去）。
- 修复既有 bug：full 阶段失败 `_status(failed)` 后 `break`，会被循环收尾的 `_status(completed)` **覆盖**——这正是 run 20260920_204723_0a04（v28）4 条 PYI 崩溃却标 completed 的真正机制。

**验收**（脚本 `tools/verify_exe_child.py`：自动起 exe sidecar → 设 `aisbench_command` → 跑一轮 → 断言 status/no-PYI/明细文件/命中率）：

- mock（127.0.0.1:8091）：run 20260920_233152_d132 PASS，warmup+full 两阶段 `results/<ts>/performances/vllm-api-stream-chat/gsm8k_details.jsonl` 均真实产生。
- 真实服务器 8101（input 4096 / output 32 / data 32 / prefix 4 / repeat 90% / conc 8）：run 20260920_233255_0e0b **PASS**，HBM 命中率 **0.8888**（≈理论 0.9，与源码模式参照一致），stdout.log 无 PYI。
- 复跑命令：`py -3.11 tools/verify_exe_child.py --exe sidecar\dist\aisbench-sidecar\aisbench-sidecar.exe --target-host 203.0.113.10 --target-port 8101 --model qwen3 --min-hit 0.3`
- 产物体积：含 torch + ais_bench 源码/配置落盘，约 955MB（onedir）。

<details><summary>原始现象与分析（修复前留档）</summary>

- 现象：`aisbench_command = <dist>\aisbench-sidecar.exe --child-aisbench` 时，真实 run 失败，stdout.log 出现 `PYI-xxxxx ERROR ... app\main.py:720 TypeError: expected str, bytes or os.PathLike object, not NoneType`，随后 `SUMM-FILE-001 can't find detail perf data file`，`AISBench exited with code 1`。
- 根因定位：ais_bench debug/normal 均由 `tasks/openicl_api_infer.py get_command()` 构造 `command = f"{sys.executable} {__file__} {params.py}"`（runners/local.py `get_command_template`，shell=True）。冻结 exe 内 sys.executable 即 exe 本身 → task 进程重入 `run_sidecar.py` 入口，argv 无 `--child-aisbench` → 误入 `_run_server()` → 无 `--home` → `Path(None)` 崩 → task 没跑 → summarizer 无明细 → exit 1。
- 源码模式（aisbench_command 指向真实 python ais_bench）不受影响。

</details>

## 6. PD 分离（3P1D）调研结论（服务端未跑通，但根因与正确姿势已明确）

- 已试：容器 `dxlong-pt-pd`（davinci1/2/3/5）4 个 vllm serve：P0/P1/P2（kv_producer，8111/8112/8113，kv_port 30000-30002，engine_id p0/p1/p2）+ D（kv_consumer，8102，kv_port 30100，engine_id d0，`--no-enable-prefix-caching`），连接器 MooncakeHybridConnector，extra_config 写了全局布局 `prefill:{dp:3,tp:1}`。脚本：`D:\Vibe_Workspace\ucm-server-ops\dxlong_pd3p1d_container.sh` + `dxlong_pd3p1d_inner.sh`。
- 结果：3 个 P 全挂：`Value error, KV transfer 'prefill' config has a conflicting data parallel size. Expected 1, but got 3.`；D 正常启动。
- 根因（容器内源码核实 `/vllm-workspace/vllm-ascend/vllm_ascend/utils.py check_kv_extra_config`）：**producer 的 extra_config.prefill.dp_size 必须等于本进程自己的 `--data-parallel-size`；consumer 的 decode.dp_size 必须等于自己的**。即该字段描述「本实例所在侧的并行规模」，单进程 dp=1 时必须写 1。
- 正确姿势 A（单机多进程 N P + M D，推荐，出自镜像内文档 `docs/source/tutorials/features/pd_disaggregation_mooncake_single_node.md`）：连接器用 **MooncakeConnectorV1**，每个实例 extra_config 的 prefill/decode 均写 `dp_size:1,tp_size:1`；每个 P 用不同 `ASCEND_RT_VISIBLE_DEVICES`+不同 API 端口+唯一 kv_port（"For 2P1D, set ASCEND_RT_VISIBLE_DEVICES and port to different values for each P process"）；前置代理 `examples/disaggregated_prefill_v1/load_balance_proxy_server_example.py --prefiller-hosts X X X --prefiller-ports 8111 8112 8113 --decoder-hosts X --decoder-ports 8102`；**客户端请求发代理端口**。
- 正确姿势 B（DeepSeek-V4-Flash 教程 §5.2 多机全局 DP，镜像内 `docs/source/tutorials/models/DeepSeek-V4-Flash.md`）：MooncakeHybridConnector + `launch_online_dp.py --dp-size <全局> --dp-size-local <本机> --dp-rank-start --dp-address --dp-rpc-port`；每 P 唯一 kv_port+engine_id（0 起自增）；代理见 `features/pd_disaggregation_mooncake_multi_node.md`；请求发 prefill 主节点的代理端口。
- 工具侧已就绪待验：metrics 采样键升级为 `(pod, engine, worker)`，`compute_hit_rate` 产出 `per_pod`（`endpoint|dpN`）与 `per_dp`，Monitor「DP 域明细」表按端点分行；时序 JSONL 与前端回放兼容。PD 实测时配置：host_port=代理端口，pod_info=[P0 API, P1 API, P2 API, D API]。

## 7. 服务器与凭据

- 203.0.113.10，root / REDACTED-INTERNAL-CREDENTIAL，工作目录 `/home/dxlong`，运维脚本 `/home/dxlong/ops/`（本地镜像 `D:\Vibe_Workspace\ucm-server-ops\`）。
- SSH：`py -3.11 C:\Users\user\.claude\skills\ssh-skill\scripts\ssh_execute.py [--timeout N] 203.0.113.10 '<cmd>'`。
- **命令内禁双引号**（PowerShell 原生参数拆分会吃掉）；复杂命令写本地 .sh → LF 归一化（CRLF 会搞挂服务器脚本）→ base64 → `echo <b64> | base64 -d > x.sh && bash x.sh`。
- 容器现况：`dxlong-pt-base` UP（8101 服务运行中）；`dxlong-pt-ucm` UP（服务未启动）；`dxlong-pt-pd` 已删除。
- 重启单实例：`docker exec dxlong-pt-base bash /opt/q3_inner_base.sh`（脚本已在容器内；容器重建用 `dxlong_pt_launch.sh` + `dxlong_pt_q3_inner_base.sh`/`..._ucm.sh`）。
- 服务器踩坑：`/reset_prefix_cache` 在该 nightly 上 404（轮间隔离走 per_round_seed_offset 兜底）；Qwen3.5 Mamba 混合模型命中率恒 0（1024 token 对齐），测前缀请用 Qwen3-0.6B。

## 8. 本机环境坑（速查）

- `python` 是无 pip 的 venv，一律 `py -3.11`；vite v6 只绑 ::1 → 用 localhost；系统代理 127.0.0.1:7892 会劫持压测流量 → sidecar 采集已 `trust_env=False`，curl 记得 `--noproxy '*'`；git push 需 `git -c http.proxy=http://127.0.0.1:7892 push`。
- 本机 sidecar 输出/设置目录：`%APPDATA%\AISBenchPrefixTester\`（outputs、settings.json）。
- mock vllm：本机 8091 仍在跑（PID 见 netstat），仅用于 UI 冒烟。

## 9. 接手人待办（建议顺序）

1. ~~修 §5 exe 子模式 bug~~ ✅ 已完成（2026-09-20 晚，见 §5）。剩余跟进：用 electron-builder 重新打 portable 包（`D:\pt-release` 里仍是旧 sidecar），并验证首启动完整性自检。
2. 按 §6 姿势 A 重写 3P1D 内层脚本（MooncakeConnectorV1 + dp1/tp1 + 代理），跑通后用工具实测 pod 维度（per_pod 命中率表、多端口采集时序）。
3. 可选：UWM/横向扩展、报告模板美化、README 更新 PD 章节。

## 10. UX 优化记录（2026-09-20 深夜，5 项体验反馈已落地）

1. **SLA 页状态不再丢失**：SLA job 落库（`sla_jobs` 表，含 probes 快照），新增 `GET /api/sla/current`（优先返回存活 job，否则最近一条持久化记录，中断的标 `interrupted`）与 `GET /api/sla/jobs`；SLA 页挂载时自动恢复，另有「历史调优」列表（点击加载详情）与「停止」按钮。附带修复：job snapshot 此前不含 `current` 字段导致 UI 永远不显示当前并发。
2. **SLA 记录与运行记录分离**：runs 表新增 `kind` 列（`manual`/`sla`，迁移自动回填历史 `SLA c=*` 记录）；SLA 探针 run 以 `kind='sla'` 创建。
3. **运行记录管理**：新增 `DELETE /api/runs/{id}`（运行中的先 stop）与 `POST /api/runs/delete-batch`，删除时同步清理 `outputs/<run_id>`；History 支持多选批量删除 + 「对比所选」直通对比页（sessionStorage 预选），对比页选择列表不再混入 SLA 探针。
4. **History 默认只看手动测试**，seg 切换「手动测试 / SLA 探针 / 全部」（SLA 行在全部分类下带蓝色标签）。
5. **主题修复**：设置页主题下拉原为非受控 `defaultValue`，永远显示「跟随系统」→ 改受控并即时应用；浅色主题全面修复对比度——约 20 处硬编码深色值（表格行线/悬停、logview 配色、tag/alert/phase、seg/tabs/导航高亮文字、滚动条、actionbar、toast、`color-scheme:dark` 强制）改为 CSS 变量并补浅色映射。

验证：`tools/tests/test_features.py` 新增 store kinds/delete/sla-jobs 用例，全绿；API 层冒烟（kind 过滤、单条/批量删除、SLA 路由）通过；`npm run build` 通过。

### 第三轮（4 子代理试用审查 + 测试加固，同日深夜）

4 个子代理分别完成：API 全流程实操（真实跑 4 run + 3 SLA job + 导出/删除/异常路径）、前端 UX 审查（18 条）、后端健壮性审查（P0×1+P1×6+P2×10）、测试缺口分析（24 项方案）。

**已修复**（本轮）：
- runner 源码模式 P0 回归（`aisbench_args` 未绑定，config-dir 重构遗留）——API 测试套件抓到。
- `parse_aisbench_log`/metrics NaN 值污染采样与时序 JSONL（`math.isfinite` 过滤）。
- MonitorPage WS 生命周期（cleanup 曾注册在 `.then` 里永不执行 → 连接泄漏+跨 run 数据污染）、状态中文化、日志尾部回填（`/logs?tail=500`）、not_found 提示、failed 相位标红。
- SlaPage 轮询 404 防护（sidecar 重启后幽灵 job 卡死）、SLA 条件空值启动校验、图表 0 基线、取消/恢复文案。
- HistoryPage 轮询竞态（reqId 版本号）、选中集 prune、批量删除真实计数、离线空态区分、详情打开容错。
- 导出口径：`exclude_practice` 贯通 GET /api/compare/export 与 report.export_*。
- `POST /api/runs/{id}/stop` 不再把 completed/failed 历史改写成 cancelled；删除重复注册的旧 DELETE 路由。
- `sla_start` 非法键/缺字段 → 400（原 500/假成功）；`parse_sla_spec` 兼容 `_ms` 后缀（pt.py 键名失配修复的另一半）；SLA 探针 run 名不再悬挂「·」。
- `finished_at` 落库（原永远 null）；`get_rounds` 按插入序（原 full 排在 warmup 前）。
- 子进程强制 `PYTHONIOENCODING=utf-8`（修 GBK 日志 8456 个 U+FFFD 乱码）+ 剥离 ANSI 转义。
- `_run_phase` try/finally：异常路径杀子进程树+关句柄（原会泄漏孤儿压测进程）；`RunHandle.finished` + 删除 run 前等待线程收尾。
- events 队列满改丢最旧（原丢最新，可能丢终态 status）。
- 安全：`/api/boot` 仅容器模式（PT_UI_DIR）暴露；settings 键白名单；logs 接口 stream 白名单+run_id 存在性校验（路径遍历）；`/api/runs/active` 轻端点（顶栏芯片轮询不再全量拉 runs）。
- validate_config 类型异常 500→400；导出/预览/verify 等重活 `asyncio.to_thread`（不再冻结事件循环）。
- pt.py：UTF-8 控制台（GBK 崩溃修复）、sla 键名、export 落盘 `RUN_ID.<fmt>`、wait/sla-wait 位置 TIMEOUT、health JSON。
- 测试：新增 `tools/tests/test_api.py`（14 用例 TestClient 回归，含 stub 命令驱动 run 成功/失败全生命周期）+ `test_features.py` 扩至 18 用例（metrics 差分、真实日志解析、SLA 判定矩阵、真实 tokenizer 数据集生成、CSV 表头合并等）；`tools/tests/stub_aisbench.py` 桩命令。

### 第四轮（自包含运行时，同日）

**架构决策：打包 exe 即唯一运行时，不再依赖外部 Python/pip 环境。**

- `runner.resolve_command(cmd, frozen)`：冻结模式默认（未设置 / 遗留值 `ais_bench` / 任意 `--child-aisbench` 形态）一律自引用 `exe --child-aisbench`（config-dir 流程），彻底摆脱外部 ais_bench 与 work_path；显式自定义命令（如 mock）仍被尊重。源码/开发模式保持外部 CLI。
- `/api/diagnosis` 重写为**就绪检测**：打包模式报告「自包含打包模式 + 内置 AISBench/Python」，不再探测外部 CLI/pip；work_path 项仅开发模式出现。
- `/api/health` 增加 `runtime: frozen|source`；设置页据此切换——打包模式隐藏 aisbench_command/work_path 配置（显示「内置自包含」），开发模式保留。
- 用户旧库中的遗留 `aisbench_command="ais_bench"` 设置在打包模式下会被自动归一到自引用，无需迁移。
- 打包产物：`assets/model` tokenizer + ais_bench 源码/配置 + 全部 Python 依赖随包（spec 已覆盖），干净机器开箱即用；`sidecar` 仅监听 127.0.0.1 + token，不对外暴露。

### 第五轮（真实环境 UCM 多轮对比实验，Qwen3.5-0.8B @ 203.0.113.10）

服务：夜间 v0.26.0rc 双容器（davinci2/6），`--dtype bfloat16`（**910B3 上 GDN 算子无 FP16 kernel**，用户模板的 float16 会挂）、`--enable-prefix-caching --no-disable-hybrid-kv-cache-manager`；UCM 侧 `UCMConnector + UcmPipelineStore(Cache|Posix, /tmp/ucm_cache, buffer 8GB)`。镜像不带 ucm 包——从旧 dxlong-pt-ucm 容器 `docker cp` 出 `ucm/ + ucm_patch.pth + wrapt` 挂载 + `pip install --no-deps` 内置 wheel（/root/.cache/ucm_wheels/uc_manager-0.6.0-cp312）解决；`/tmp/ucm_cache` 需预先 mkdir；`cache_buffer_capacity_gb ≥ 5` 否则 Cache 管线拒绝启动。实验脚本在 `/home/dxlong/ops/q35_*.sh` 与本地 `D:\Vibe_Workspace\ucm-server-ops\`，服务日志 `/home/dxlong/logs/q35_*.log`。

实验（工具自包含 exe 驱动，数据集 16×1024tok/repeat90% 全程复用；`/reset_prefix_cache` 在该 nightly 仍 404，故以「容器重启」清空 HBM）：

| 场景 | 阶段 | HBM 命中 | Ext 命中 | TTFT avg | 吞吐 |
|---|---|---|---|---|---|
| UCM 冷启动 | full R1 | 0% | 0% | 3883ms | 54 tok/s |
| 基线冷启动 | full R1 | 0% | 0% | 3946ms | 55 tok/s |
| **UCM 重启后**（HBM 清空） | full | 0% | **92.1%** | **468ms** | **328 tok/s** |
| UCM 多轮 R1（回载后） | full | 92.1% | 0% | 379ms | 376 tok/s |
| UCM 多轮 R2/R3 | full | 92.1% | 0% | 360-446ms | 327-382 tok/s |

结论：① UCM 写入无感知开销（两服务冷启动同价）；② 容器重启后 UCM 从磁盘复活 92% 前缀 KV，TTFT **-88%**、吞吐 **6×**；③ 多轮同数据下回载进 HBM 后稳定 92% 命中、TTFT 360-450ms 平稳。工具侧 `ucm:* 指标`、ext 命中差分、多轮时序全部正常工作。
顺带修复：`/api/datasets/generate` 传字符串 repeat_rate 崩溃（generate_dataset 内补 parse_prefix_ratio 归一）。

### 第六轮（SLA 强化 + 真实服务最优值探测）

- **矛盾/非法阈值拒绝**：`parse_sla_spec` 拒绝 ≤0 值与非数字（400 + 中文说明）；UI 在启动前拦截「同一指标同一分位设置两个不同阈值」的矛盾组合（dict 会静默去重，必须在 rows 层检查）。
- **预检快失败**：`SlaTuner._preflight` 在阶梯前先打一个 c=1 探针（延迟类 SLA 的最易点）——并发=1 都不满足时直接 `done + max_ok=0 + 预检失败说明（附实测值）`，不再烧完整个阶梯+二分；预检探针带 `preflight: true` 标记。
- **过程可观测**：探针记录 `elapsed_s`；快照带探针数；SlaPage 新增「探针日志」卡片——跟随最新（或下拉选择）探针的 ais_bench 输出（`/logs?tail=120` 每 2s），活动期自动滚动；结果卡显示「已完成探针 N」。
- **真实服务探测**（Qwen3.5-0.8B+UCM@8201，SLA：ttft_p90≤2000ms 且 tpot_avg≤30ms，c: 4→64）：预检 c=1 通过（239ms），阶梯 4/8/16/32/64 全部满足（ttft_p90 峰值 553ms、tpot ≤15.1ms）→ **max_ok=64（触探测上限）**；吞吐在 c=32 达峰 594 tok/s、c=64 回落 455 → 若以吞吐为目标 32 是最优工作点；要找真正的并发上限需提高 max_concurrency（服务 max-num-seqs=32，c>32 为排队）。测试中一次 WinError 10054 瞬断由驱动重试吸收。

**遗留 backlog**（按优先级，均已有修复方案在审查报告中）：① `/api/boot`+CORS 完整加固（已做容器门控，CORS `*` 与 `?token=` 留痕待 ticket 化）；② 源码模式共享 workspace 并发串写（模块互斥锁或全模式 config-dir 统一，需真跑 ais_bench 验证）；③ export/compare/logs 大文件同步读改 to_thread/流式；④ metrics 字段语义（`total_input_tokens` 实为均值、-1 哨兵改 null、max_concurrency 类型）；⑤ warmup 退出码忽略导致脏指标入库；⑥ store 异常回滚统一化；⑦ datasets/outputs 保留策略；⑧ compare missing_rounds 用 len 而非最大轮号的口径；⑨ 键盘可达性/aria。

### 第七轮（端到端验证矩阵 + 便携版重建与测试）

- **新增 `tools/tests/test_e2e_battery.py`**：对**打包 sidecar exe**（冻结模式）+ mock vllm 的 21 项端到端矩阵——冻结诊断/内置 tokenizer verify/3 轮多轮时序/取消/双导出/对比+导出/SLA 全链路（含 kind=sla 入库与 run_id 溯源）/跨重启持久化/批量清理。结果 **21/21 PASS**。
- **便携版重建**：`npx electron-builder --win portable`（D:\pt-release\AISBenchPrefixTester-Portable.exe，345MB）——extraResources 自动打入最新 sidecar onedir（自包含 ais_bench）。注意：重打包前必须杀掉残留的便携实例（旧进程锁住输出文件会导致 builder 无限等待）。
- **便携版端到端测试 `tools/tests/test_portable.py`**（7/7 PASS）：启动便携 exe → 等待 `%USERPROFILE%\AISBenchPrefixTester\sidecar.port` → 验证 runtime=frozen、自包含声明、内置 AISBench/tokenizer 资产 → 经便携内嵌 sidecar 真实跑 mock 压测（内置 ais_bench 子进程全流程）completed。
- 结论：`D:\pt-release\AISBenchPrefixTester-Portable.exe` 即当前可分发版本（自包含，目标机器无需任何 Python 环境）。

### 第八轮（秒开页面 + 便携版 10 轮实测）

- **UI-first 启动**：main.cjs 打包分支改为立即 `loadFile(resources/ui/index.html)`（vite base 已是 `./`，file:// 可加载），不再等 sidecar；`sidecar-info` IPC 改非阻塞（未就绪返回 null）；api.ts 在 Electron 模式轮询直到环境就绪；App 渲染「正在启动运行环境…」启动屏。窗口秒开，环境后台预热，就绪后自动进入。
- **便携版 10 轮实测**（经便携版自身 sidecar，数据落 `%USERPROFILE%\AISBenchPrefixTester`）：10 轮全部 completed、20 个阶段行、每轮 HBM 94.5%、0 传输错误、记录出现在便携版历史（此前"看不到记录"是因驱动用了隔离的临时 home）。
- 启动耗时构成：便携目标每次启动需解压 345MB→1GB（约 20-40s，electron-builder portable 机制）+ sidecar 预热（splash 覆盖）；**日常高频使用建议直接运行 `D:\pt-release\win-unpacked\AISBenchPrefixTester.exe`（免解压、秒级启动）**，或改用 NSIS 安装器一次性安装。

**遗留 backlog**（按优先级，均已有修复方案在审查报告中）：

### 第二轮（导航重构，同日）

6. **运行监控不再是独立页签**：侧栏移除「运行监控」「数据集」两项；监控改为跳转式进入——新建测试点「开始测试」后自动跳 `/monitor/<run_id>`（原有逻辑），运行记录每行有「监控」按钮；另在顶栏加全局「● 运行中 <名称>」芯片（5s 轮询，有存活 run 才显示），点击回到实时监控，切走后不会找不到正在跑的任务。默认落地页从 monitor 改为 config；旧 `#/datasets` hash 自动重定向到 `/config`。
7. **数据集页删除**：生成/预览/复用本来就内嵌在「新建测试」流程；仅有的两个独有功能已迁移——注册自定义 tokenizer 目录 → 设置页「Tokenizer 资产」卡片；删除已入库数据集 → 配置页「复用已入库数据集」旁的删除按钮。`DatasetsPage.tsx` 已删除。

### 第九轮（真实用户走查 13 项体验问题：僵尸 run 对账 + 超限守卫 + 状态列/命名）

以真实用户视角完整走查 `D:\pt-release\win-unpacked`（连真实服务、发测试、盯监控、看记录/对比/SLA/设置），暴露 13 个问题并按优先级修复：

- **僵尸 run 对账**：应用中途被杀后 run 永远「运行中」，顶栏挂「有正在运行的测试」而 SLA 页显示「已中断」，互相矛盾。`store.reconcile_orphans()` 在 sidecar 启动时把 `pending/running` 的 runs 与活动态 sla_jobs 一次性落库为 `interrupted`（补 finished_at），startup 打 warning 日志；test_api 新增 `test_reconcile_orphans`（含幂等性断言）。
- **input_len 超限守卫（根除「手动跑全是 Bad Request」）**：`/api/probe` 返回 `max_model_len`（/v1/models 各模型最小值）与 `served_names`；ConfigPage 探测后显示「上下文上限 N tok」，input+output 超限时拒绝开始（toast + 摘要卡红色预警），连接目标变更时自动失效。此前默认 input_len=32768 > 8101 服务的 max-model-len 8192，vLLM 逐请求 400。
- **运行记录**：新增「状态」列（已完成/运行中/失败/已停止/已中断/排队中，着色）；底部新增显眼「运行名称」输入框（绑定第一轮 test_name，重置一并清空）；详情抽屉状态中文化。
- **抽屉交互**：✕ 移到首位防误触「标记练习轮」；练习轮标记加 confirm；抽屉头部新增「⇄ 对比所选」——开着抽屉也能对比（此前按钮被抽屉完全拦截）；抽屉体顶部聚合警告横幅，轮间缓存清理失败等关键警告不再只挤在表格单元格。
- **设置页自洽**：诊断「运行模式」如实区分「内置自包含」与「已被自定义命令覆盖」；frozen 卡片显示 aisbench_command 覆盖输入框（可清空回内置）；「关于→数据目录」改显示真实 home（/api/health.home），不再写死 %APPDATA%。
- **SLA 页默认值**：采集端点加 placeholder + 留空启动二次确认（命中率恒 0 风险）；tokenizer 预置与新建测试页互通（localStorage `pt-tokenizer`）。
- **细节**：favicon 内联 SVG（消除控制台 404）；「校验配置」按钮反馈 toast（通过/警告/错误）。
- 测试：test_api 16/16、test_features 17/17、test_e2e_battery 21/21（新 sidecar exe）全绿；PyInstaller + electron-builder 重建（portable + NSIS）。
- **走查遗留（按需排期）**：日志流重复刷屏/tqdm 污染过滤；监控页完成后卡片衰减归零 + 结构化逐轮结果区；运行记录分页；默认参数温和化；发布流程「打包前对齐 main」约束。

### 第十轮（UX v0.2 全量重设计落地：AUDIT 24 项 + U1–U8 一次性整改）

依据 `docs/UX-AUDIT.md`（A1–G3 + U1–U8）与 `docs/UX-REDESIGN.md` v0.2，不分期一次改完。产品硬约束遵守：无监控常驻页签（仅开始测试跳转 + 记录页运行中行两个入口）、无数据集页（复用下拉/预览按钮移除，按参数自动生成随 run 落盘）。

- **Sidecar 配合（不动编排与命中率口径）**：`metrics.Collector` 活动期自适应 1s 采样（gauge>0 或计数器在动即收紧，空闲回落，样本带 `active` 标记，U5.3）；`runner._record_event` 事件日志 `events.jsonl`（status/cache_reset/warning 带 ts 落盘，回放画阶段边界，C2）；`GET /api/runs/{id}/events` 回放端点；软删除 API（`/api/runs/trash|restore|purge` + runs.deleted_at 列，list 过滤，D1 撤销窗口；delete-batch 保持硬删兼容 CLI/测试）；sla 快照带 `bisect=[lo,hi]`；`POST /api/telemetry` 本地埋点（§9：config_validate_result/run_submit/run_finish/chart_export/compare_run/sla_job_finish/error_surface → home/telemetry.jsonl）。
- **修复既有容器模式 bug**：静态 UI 挂载代码原位于 `if __name__=="__main__"` 之后，`python -m app.main` 启动时永不执行（UI 404）；移至 main() 定义前，两种启动方式均生效。
- **前端重构（六页全部重写）**：新增 `ui.tsx`（StatusBadge 形状+颜色双编码/Modal/ConfirmModal/空载错三态/Breadcrumb/Pagination/InfoTip/CSV 下载/useLocalState/useElemWidth）与 `charts.tsx`（TimeSeriesChart：十字线 tooltip+框选缩放/双击复位+<8 点阶梯线+事件垂直线+轮次分隔带+右轴+抽稀；DualAxisChart：SLA 双轴曲线+命中区填充+拐点标注+行联动；Donut 中心=综合命中率；BarChart Δ% 柱顶标注）。theme.css 重写为 §7 视觉 token（8pt/字号/8 色图表色板/浅色同构）。
- **新建测试页**：运行名称+预设首行（内置冒烟/标准 + /api/presets + diff 确认）；草稿自动保存（localStorage 去抖 600ms）；温和默认值（2048/32/16/c8）；tokenizer 单一选择器互斥+生效行+探测自动匹配；词表来源单选卡；采集端点 chip 化+空时联动 host:port/URL+逐端点 /metrics 可达点+「恢复联动」；URL 填写时地址/端口折叠为解析摘要；失焦即时校验+字段级红字；校验成功绿条/错误条点击滚动到字段；轮次表复制上一轮/恢复继承/删除确认/JSON 预校验；sticky 摘要卡+吸底操作区；<1180px 单列+摘要条化+操作吸底；全栅格 minmax(0,1fr)。
- **监控页**：run 头部参数 chips+耗时+导出；KPI 6 等宽卡（理论命中率+偏差副行、无数据「—」不显假 0、口径 InfoTip）；12 列栅格等宽 280px 图表（队列深度+KV 合并双轴卡/吞吐/延迟/命中率趋势）；统一实时=回放 flatten（gauge 取 max、counter 求和，U5.4 根治）；阶段边界垂直线+轮次分隔带+轮次聚焦筛选；每图 CSV 导出；断线黄横幅+重连补拉；停止确认弹层；日志区全宽 240–600px 拖拽（记忆高度）+关键字搜索+折叠进度行+stdout/stderr 双 tab+双导出；饼图中心=综合命中率、非 UCM 收起带宽图与横幅进「指标说明」；端点不可达灰态；中断 run 显示中断时间点。
- **记录页**：状态多选筛选+分页（50/页）；行 hover 浮出操作、运行中行整行高亮+呼吸点徽标+监控主按钮常驻；软删除+7s 撤销 toast+purge 硬删；抽屉 480px 固定右侧+遮罩从顶栏下开始+ESC/点遮罩关闭。
- **对比页**：顶部粘性操作条（已选 chips 可移除+排除选项+常驻开始对比）；结果 tab 化（指标总览对柱图+Δ% 柱顶标注/逐轮对比/DP 矩阵/配置差异/导出）；练习轮半透明+已排除徽标+计数；空状态图示引导。
- **SLA 页**：上下结构；进度条+阶段文案（爬升 c=N/二分 [lo,hi]）+停止调优；并发-延迟双轴曲线（SLA 阈值线+绿色满足区+拐点「SLA 内最大并发=N」+探针表 hover 联动高亮）；中断任务结果卡显示状态徽标+已探明参考值；历史表列宽固定+说明列 ellipsis+悬停全文+选中高亮+「查看：<时间>」+返回最新。
- **设置页**：左侧 4 tab（通用/压测执行/Tokenizer 资产/关于）；环境诊断折叠为一行摘要（展开才逐项+重新检测+重启 Sidecar 确认弹层含活动 run 警告+loading）；Tokenizer 列表管理（来源/路径/测试加载/删除）；采集间隔改「新 run 默认」+两处互相标注。
- **全局**：favicon+侧栏 logo（层叠块+命中闪电 SVG）；术语中文化（前缀缓存查询构成等）+口径 InfoTip；焦点环 focus-visible；图表 aria-label/<title>；图例线型区分（实/虚/点）；断连黄条；监控路由顶栏面包屑「← 运行记录」+侧栏高亮归并；活动 run 顶栏提示保留到查看过为止。
- **验收**：`npx tsc --noEmit` 0 错误；`npm run build` 成功；test_features/test_api 全绿；新增 `tools/tests/test_ux_flow.py`（mock 8091 源码模式全流程 22/22：发起→WS 事件→回放 events/metrics→软删/恢复/清除→对比导出）；新增 `tools/tests/ux_dom_check.py`（CDP headless Edge 40/40：6 页×2 视口无横向溢出 + 28 项结构断言）与 `tools/tests/ux_screens.py`（1440/1024 截图 12 张 → docs/screenshots/ux2-*.png 供人工复核；本会话模型无图片输入，几何/结构断言程序化替代目检）。
- **遗留**：打包产物重建（portable/NSIS）待下轮与发布流程一起做；日志去重（同一行重复刷屏）未在本轮范围。
