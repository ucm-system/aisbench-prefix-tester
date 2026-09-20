# AISBench 前缀复用测试器

面向大模型推理服务的 **Prefix Cache 性能测试桌面工具**：随机词表数据集纯合成、AISBench 两阶段压测编排、
UCM/vLLM 命中率实时采集、多轮对比报告、SLA 最大并发自动搜索。

<p align="center">
  <img src="docs/screenshots/s07-monitor-real-dark.png" width="880" alt="运行监控">
</p>

## 特性

- **随机词表数据集**：不依赖任何真实数据集，tokenizer 词表纯合成，GSM8K JSONL 容器格式；支持 tokenid 精确模式、自定义词表、进度中断续传
- **两阶段压测**：预埋（并发=dp、output_len=1、前缀注入）→ 全量（目标并发），快照差分命中率（Δhits/Δqueries）
- **UCM/vLLM 指标**：5s 轮询 + 阶段快照双通道；`ucm:` 前缀自动探测，未启用时自动降级 vLLM-only 视图
- **轮间缓存治理**：每轮前 `POST /reset_prefix_cache`（策略可配）；服务不支持时自动回退"每轮 seed 偏移"并在结果行标注残留风险
- **SLA 自动调优**：固定数据集（命中率口径一致）下并发 ×2 爬升 + 二分细化，TTFT/TPOT/E2EL 任意水位（avg/P50/P75/P90/P99/Max）+ 吞吐下限
- **对比与报告**：多 run 对比（自动排除预埋/练习轮，方向感知增量）→ xlsx（5 Sheet）与离线 HTML 报告
- **部署形态**：Windows 免安装便携 exe ／ 服务器 Docker 容器（UI + API 同容器，浏览器直连）

## 截图

| 新建测试 | 运行记录 |
| --- | --- |
| ![新建测试](docs/screenshots/s01-config-dark.png) | ![运行记录](docs/screenshots/s02-history-dark.png) |
| **对比分析** | **SLA 调优** |
| ![对比分析](docs/screenshots/s03-compare-dark.png) | ![SLA 调优](docs/screenshots/s04-sla-dark.png) |
| **运行监控（真实压测）** | **UCM 运行监控** |
| ![运行监控](docs/screenshots/s07-monitor-real-dark.png) | ![UCM](docs/screenshots/s10-monitor-ucm.png) |

更多：[设置诊断](docs/screenshots/s06-settings-dark.png) · [数据集](docs/screenshots/s05-datasets-dark.png) · [Qwen3 实测对比](docs/screenshots/s08-compare-qwen3-real.png) · [SLA 结果](docs/screenshots/s09-sla-result.png)

## 架构

Electron（主进程：sidecar 生命周期守护）+ React 渲染层 + Python FastAPI Sidecar。
Sidecar 仅绑定 `127.0.0.1`，Bearer token + 端口文件发现；目标服务探测/压测/采集全部由 Sidecar 出站完成。

## 快速开始

### 服务器容器（自包含，推荐）

```bash
docker build -t aisbench-prefix-tester .
docker run -d --name pt-server -p 8180:8180 -v /home/$USER/pt-data:/data aisbench-prefix-tester
# 浏览器打开 http://<服务器IP>:8180
```

### Windows 便携 exe（开发构建）

```bash
pip install pyinstaller && cd sidecar && pyinstaller aisbench-sidecar.spec
cd desktop && npm install && npm run build && npx electron-builder --win portable
# 产物 release（或 build.directories.output 指定目录）/AISBenchPrefixTester-Portable.exe
```

### 开发模式

```bash
py -3.11 -m pip install -r sidecar/requirements.txt
py -3.11 tools/tests/test_units.py && py -3.11 tools/tests/test_features.py && py -3.11 tools/tests/test_e2e.py
cd desktop && npm run dev      # http://localhost:5173（vite 自动拉起 sidecar）
```

真实压测需宿主机 `pip install ais_bench_benchmark==3.1.20260630`（Python 3.10–3.12）；
无 GPU 环境用 `tools/mock_aisbench.py` + `tools/mock_vllm/server.py` 全链路联调。

## CLI / Agent 接口

```bash
python tools/pt.py --port-file desktop/.sidecar-dev.json health
python tools/pt.py --port-file ... run --host HOST --port 8101 --wait   tokenizer=Qwen3-0.6B input_len=4096 output_len=32 data_num=32 prefix_num=4   repeat_rate=90 concurrency=8 pod_info=HOST:8101
python tools/pt.py ... sla --host HOST --port 8102 --ttft-p90 3000   input_len=4096 data_num=64 repeat_rate=90 pod_info=HOST:8102
```

Agent 指南：[skills/prefix-tester/SKILL.md](skills/prefix-tester/SKILL.md)

## 测试

| 套件 | 覆盖 |
| --- | --- |
| `tools/tests/test_units.py` | 指标解析、命中率差分、数据集生成（text/tokenid）、日志解析 |
| `tools/tests/test_features.py` | SLA 规格、配置校验、对比引擎、xlsx/HTML 报告、配置注入、事件总线 |
| `tools/tests/test_e2e.py` | mock vLLM + mock aisbench 全链路（多轮、缓存重置、WS、导出） |

## 设计文档

[docs/DESIGN.md](docs/DESIGN.md) — 架构、指标口径、API、里程碑。

## License

内部工具，版权归组织所有。
