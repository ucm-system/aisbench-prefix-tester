"""Mock vLLM server for end-to-end testing without a real inference service.

Based on ClawPerf's mock API server (GPT-Zero-main/server.py — OpenAI-compatible
SSE chat completions), extended with what a Prefix-Cache tester actually needs:

  1. A real simulated prefix cache: prompts are chunked into blocks; a query
     counts a HBM hit when its leading blocks are resident (LRU, bounded),
     and an external (UCM-style) hit when remaining blocks exist in the
     unbounded external store.  These drive the *actual* counter names.
  2. Prometheus /metrics with vllm:*/ucm:* families (labels model_name/engine).
  3. TTFT / inter-token latency simulation.
  4. POST /reset_prefix_cache for cache-reset (round isolation) testing.

Env knobs: MOCK_PORT(8090) MOCK_TTFT_MS(150) MOCK_ITL_MS(5) MOCK_MAX_TOKENS(128)
           MOCK_HBM_TOKENS(2000000) MOCK_BLOCK_TOKENS(16) MOCK_ENGINES(1)

Run: python server.py [--port 8090]
"""
from __future__ import annotations

import argparse
import asyncio
import collections
import hashlib
import json
import os
import time

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, PlainTextResponse, StreamingResponse
import uvicorn

PORT = int(os.environ.get("MOCK_PORT", "8090"))
TTFT_S = float(os.environ.get("MOCK_TTFT_MS", "150")) / 1000.0
ITL_S = float(os.environ.get("MOCK_ITL_MS", "5")) / 1000.0
MAX_TOKENS = int(os.environ.get("MOCK_MAX_TOKENS", "128"))
HBM_BLOCK_CAPACITY = int(int(os.environ.get("MOCK_HBM_TOKENS", "2000000"))
                         / int(os.environ.get("MOCK_BLOCK_TOKENS", "16")))
BLOCK_TOKENS = int(os.environ.get("MOCK_BLOCK_TOKENS", "16"))
BLOCK_CHARS = BLOCK_TOKENS * 4  # approx: one token ≈ 4 chars of synthetic text
MODELS = ["deepseek-ai/DeepSeek-V3.2", "qwen3-32b", "gpt-3.5-turbo"]

app = FastAPI()

# ------------------------------------------------------------------ cache state
class CacheState:
    def __init__(self) -> None:
        self.hbm: "collections.OrderedDict[str, bool]" = collections.OrderedDict()
        self.external: dict[str, bool] = {}
        # counters (per engine)
        self.c = {
            "hbm_q": 0.0, "hbm_h": 0.0, "ext_q": 0.0, "ext_h": 0.0,
            "prompt_tok": 0.0, "gen_tok": 0.0, "success": 0.0,
            "ttft_sum": 0.0, "ttft_cnt": 0.0,
            "itl_sum": 0.0, "itl_cnt": 0.0,
            "e2e_sum": 0.0, "e2e_cnt": 0.0,
            "ucm_q_tok": 0.0, "ucm_hbm_tok": 0.0, "ucm_hit_tok": 0.0,
        }
        self.running = 0
        self.waiting = 0

    def blocks(self, text: str) -> list[str]:
        return [text[i:i + BLOCK_CHARS] for i in range(0, len(text), BLOCK_CHARS)]

    def lookup(self, prompt: str) -> None:
        blocks = self.blocks(prompt)
        # longest leading run resident in HBM
        hbm_matched = 0
        for b in blocks:
            if b in self.hbm:
                hbm_matched += 1
            else:
                break
        self.c["hbm_q"] += 1
        if hbm_matched > 0:
            self.c["hbm_h"] += 1
        # external lookup for the portion missing from HBM
        if hbm_matched < len(blocks):
            self.c["ext_q"] += 1
            ext_matched = 0
            for b in blocks[hbm_matched:]:
                if b in self.external:
                    ext_matched += 1
            if ext_matched > 0:
                self.c["ext_h"] += 1
            self.c["ucm_hit_tok"] += ext_matched * BLOCK_TOKENS
        # R1.4: query tokens must cover the WHOLE prompt (HBM-hit portion
        # included) — vllm+UCM semantics are hbm_hit + ucm_hit + miss = query.
        # Counting only the HBM-missed portion made hbm_hit > query (180%+).
        self.c["ucm_q_tok"] += len(blocks) * BLOCK_TOKENS
        self.c["ucm_hbm_tok"] += hbm_matched * BLOCK_TOKENS
        # admit into stores (HBM LRU with capacity; external unbounded)
        for b in blocks:
            self.external[b] = True
            if b in self.hbm:
                self.hbm.move_to_end(b)
            else:
                self.hbm[b] = True
                while len(self.hbm) > HBM_BLOCK_CAPACITY:
                    self.hbm.popitem(last=False)

    def reset(self) -> None:
        self.hbm.clear()
        self.external.clear()


STATE = CacheState()
RESET_EVENTS = 0


def est_tokens(text: str) -> int:
    return max(1, (len(text) + 3) // 4)


def extract_prompt(body: dict) -> str:
    parts = []
    for msg in body.get("messages", []):
        content = msg.get("content", "")
        if isinstance(content, str):
            parts.append(content)
        elif isinstance(content, list):
            for c in content:
                if isinstance(c, dict) and c.get("text"):
                    parts.append(str(c["text"]))
    return "".join(parts)


# ------------------------------------------------------------------ endpoints
@app.get("/health")
async def health():
    return {"status": "ok", "mock": True}


@app.get("/v1/models")
async def models():
    return {"object": "list", "data": [{"id": m, "object": "model"} for m in MODELS]}


@app.post("/v1/chat/completions")
async def chat(request: Request):
    body = await request.json()
    prompt = extract_prompt(body)
    model = body.get("model", "mock-model")
    want_stream = bool(body.get("stream"))
    max_tokens = min(int(body.get("max_tokens", MAX_TOKENS) or MAX_TOKENS), MAX_TOKENS)

    prompt_tok = est_tokens(prompt)
    STATE.c["prompt_tok"] += prompt_tok
    STATE.lookup(prompt)

    STATE.waiting += 1
    t0 = time.perf_counter()
    await asyncio.sleep(TTFT_S)
    STATE.waiting -= 1
    STATE.running += 1
    STATE.c["ttft_sum"] += time.perf_counter() - t0
    STATE.c["ttft_cnt"] += 1

    # deterministic pseudo-reply seeded by the prompt tail
    seed = hashlib.sha1(prompt[-64:].encode()).digest()
    reply = "".join(
        chr(97 + (seed[i % len(seed)] + i * 7) % 26) + " "
        for i in range(max_tokens))
    chunks = [reply[i:i + 12] for i in range(0, len(reply), 12)]

    def finish():
        STATE.running -= 1
        STATE.c["gen_tok"] += max_tokens
        STATE.c["success"] += 1
        STATE.c["e2e_sum"] += time.perf_counter() - t0
        STATE.c["e2e_cnt"] += 1

    def chunk_payload(delta_content, finish_reason):
        return {"id": "cmpl-mock", "object": "chat.completion.chunk", "model": model,
                "choices": [{"index": 0, "delta": {"content": delta_content} if delta_content else {},
                             "finish_reason": finish_reason}]}

    if want_stream:
        async def emit():
            try:
                for chunk in chunks:
                    t1 = time.perf_counter()
                    await asyncio.sleep(ITL_S)
                    STATE.c["itl_sum"] += time.perf_counter() - t1
                    STATE.c["itl_cnt"] += 1
                    yield f"data: {json.dumps(chunk_payload(chunk, None))}\n\n"
                yield f"data: {json.dumps(chunk_payload('', 'stop'))}\n\n"
                yield "data: [DONE]\n\n"
            finally:
                finish()
        return StreamingResponse(emit(), media_type="text/event-stream")

    try:
        for chunk in chunks:
            t1 = time.perf_counter()
            await asyncio.sleep(ITL_S)
            STATE.c["itl_sum"] += time.perf_counter() - t1
            STATE.c["itl_cnt"] += 1
    finally:
        finish()
    return JSONResponse(
        {"id": "cmpl-mock", "object": "chat.completion", "model": model,
         "choices": [{"index": 0, "message": {"role": "assistant", "content": reply},
                      "finish_reason": "stop"}],
         "usage": {"prompt_tokens": int(prompt_tok), "completion_tokens": max_tokens,
                   "total_tokens": int(prompt_tok + max_tokens)}})


@app.post("/reset_prefix_cache")
async def reset_cache():
    global RESET_EVENTS
    STATE.reset()
    RESET_EVENTS += 1
    return {"success": True}


@app.get("/stats")
async def stats():
    return {"counters": STATE.c, "hbm_blocks": len(STATE.hbm),
            "ext_blocks": len(STATE.external), "reset_events": RESET_EVENTS}


@app.get("/metrics")
async def metrics_ep():
    c = STATE.c
    labels = '{model_name="mock-model",engine="0",worker_rank="0"}'
    kv_usage = min(1.0, len(STATE.hbm) / max(1, HBM_BLOCK_CAPACITY))
    lines = [
        "# HELP mock Mock vLLM prefix-cache simulator",
        f"vllm:prefix_cache_queries_total{labels} {c['hbm_q']:.0f}",
        f"vllm:prefix_cache_hits_total{labels} {c['hbm_h']:.0f}",
        f"vllm:external_prefix_cache_queries_total{labels} {c['ext_q']:.0f}",
        f"vllm:external_prefix_cache_hits_total{labels} {c['ext_h']:.0f}",
        f"vllm:prompt_tokens_total{labels} {c['prompt_tok']:.0f}",
        f"vllm:generation_tokens_total{labels} {c['gen_tok']:.0f}",
        f"vllm:request_success_total{{model_name=\"mock-model\",engine=\"0\",finished_reason=\"stop\"}} {c['success']:.0f}",
        f"vllm:num_requests_running{labels} {STATE.running:.0f}",
        f"vllm:num_requests_waiting{labels} {STATE.waiting:.0f}",
        f"vllm:kv_cache_usage_perc{labels} {kv_usage:.4f}",
        f"vllm:time_to_first_token_seconds_sum{labels} {c['ttft_sum']:.6f}",
        f"vllm:time_to_first_token_seconds_count{labels} {c['ttft_cnt']:.0f}",
        f"vllm:inter_token_latency_seconds_sum{labels} {c['itl_sum']:.6f}",
        f"vllm:inter_token_latency_seconds_count{labels} {c['itl_cnt']:.0f}",
        f"vllm:e2e_request_latency_seconds_sum{labels} {c['e2e_sum']:.6f}",
        f"vllm:e2e_request_latency_seconds_count{labels} {c['e2e_cnt']:.0f}",
        f"ucm:total_prefix_query_tokens_total{labels} {c['ucm_q_tok']:.0f}",
        f"ucm:gpu_hbm_hit_tokens_total{labels} {c['ucm_hbm_tok']:.0f}",
        f"ucm:ucm_hit_tokens_total{labels} {c['ucm_hit_tok']:.0f}",
    ]
    return PlainTextResponse("\n".join(lines) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", "-p", type=int, default=PORT)
    parser.add_argument("--host", type=str, default="127.0.0.1")
    args = parser.parse_args()
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
