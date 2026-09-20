---
name: prefix-tester
description: 操作 AISBench 前缀复用测试器（本地 sidecar / 服务器容器）对 vLLM 服务做 Prefix Cache 压测、对比与 SLA 并发调优
---

# Prefix Tester 使用指南（Agent 版）

对 LLM 推理服务做 Prefix Cache 压测：数据集纯随机词表合成（不依赖真实数据集）、两阶段执行（预埋 warmup→全量 full）、命中率采集（快照差分）、多轮对比、SLA 最大并发搜索。

## 前置

- sidecar 已运行（本机 dev：`desktop` 下 vite 自动拉起；服务器容器：`docker run -p 8180:8180`）。
- CLI 客户端：`tools/pt.py`（依赖 httpx）。

## 连接

```bash
PT="python tools/pt.py --port-file desktop/.sidecar-dev.json"   # 本机 dev
PT="python tools/pt.py --host http://SERVER:8180 --token TOKEN" # 服务器容器（TOKEN 取自 /data/sidecar.port 或直接 GET /api/boot）
$PT health
```

## 标准流程

1. **探测服务**：`$PT probe HOST PORT` → 确认 `/v1/models`、`/metrics` 可达、`ucm_detected`。
2. **发压测**（tokenizer 为本地注册名，需含 tokenizer.json）：

```bash
$PT run --host 203.0.113.10 --port 8101 --name baseline --wait \
  tokenizer=Qwen3-0.6B model_name=qwen3 input_len=8192 output_len=32 \
  data_num=32 prefix_num=4 repeat_rate=90 concurrency=8 dp=1 seed=42 \
  pod_info=203.0.113.10:8101 cache_reset=never per_round_seed_offset=True
```

3. **看结果**：`$PT wait RUN_ID` 或 `$PT show RUN_ID`（rounds 内 `hit_rate.aggregated` 为 HBM/Ext/综合命中率）。
4. **对比**：`$PT compare RUN_A RUN_B`（自动排除预埋与练习轮；方向感知增量）。
5. **SLA 调优**（同数据集下搜最大可用并发）：

```bash
$PT sla --host HOST --port 8102 --ttft-p90 3000 --tpot-avg 50 --start 8 --max 128 \
  tokenizer=Qwen3-0.6B input_len=4096 output_len=32 data_num=64 prefix_num=4 \
  repeat_rate=90 seed=42 pod_info=HOST:8102
```

## 关键语义（易错）

- **命中率口径**：阶段快照差分 Δhits/Δqueries（tokens 计数），与原 CLI 工具一致；实时曲线为滑动窗差分。
- **预埋（warmup）阶段**：并发=dp、output_len=1、只发前缀——目的是注入前缀；对比/SLA 默认排除。
- **块大小陷阱**：Mamba 混合模型（如 Qwen3.5）align 模式下块=1024 token，input_len 必须 ≫1024；普通 GQA 模型（Qwen3 系列）块=16 token 无此限制。
- **轮间残留**：vllm-ascend 多数 build 无 `/reset_prefix_cache`；用 `per_round_seed_offset=True` 让各轮前缀不同来隔离。
- **UCM 判定**：/metrics 出现 `ucm:` 前缀 = UCM 已启用；ext 命中来自 external cache。

## API 速查（等价 REST）

```
POST /api/runs {config, name}          GET /api/runs/{id}       POST /api/runs/{id}/stop
POST /api/probe {host, port}           GET  /api/runs/{id}/metrics
POST /api/compare {run_ids[]}          POST /api/compare/export?format=html&run_ids=...&token=
POST /api/sla/start {config, sla, start_concurrency, max_concurrency}   GET /api/sla/{job}
WS   /ws/runs/{run_id}?token=          事件: status/log/metrics/phase_rate/result/warning
```
