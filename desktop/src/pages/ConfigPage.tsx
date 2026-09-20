import { useEffect, useState } from "react";
import { api } from "../api";
import { navigate, useToast } from "../App";

type Tok = { name: string; path: string; source: string };

const DEFAULT_CFG = {
  host_ip: "192.168.1.10", host_port: 8000, url: "",
  model_name: "", model_path: "", npu_num: 1,
  test_name: "", input_len: 32768, output_len: 512, data_num: 160,
  prefix_num: 160, concurrency: 40, request_rate: 0,
  test_type: "stream", enable_think: false,
  repeat_rate: "90%", dp: 1, seed: 42,
  length_mean: null as number | null, length_std: null as number | null,
  length_min: null as number | null, length_max: null as number | null,
  tokenizer: "", vocab_file: null as string | null, dataset_mode: "text",
  dataset_id: null as string | null,
  cache_reset: "each_round", per_round_seed_offset: false,
  api_key: "", summarizer: "default_perf",
  collection_interval: 5,
};

export default function ConfigPage() {
  const toast = useToast();
  const [cfg, setCfg] = useState({ ...DEFAULT_CFG });
  const [tokenizers, setTokenizers] = useState<Tok[]>([]);
  const [podText, setPodText] = useState("192.168.1.10:8000\n192.168.1.10:8001");
  const [rounds, setRounds] = useState<Record<string, any>[]>([{ test_name: "" }]);
  const [roundsMode, setRoundsMode] = useState<"table" | "json">("table");
  const [roundsJson, setRoundsJson] = useState("");
  const [datasets, setDatasets] = useState<{ id: string; name: string; mode: string }[]>([]);
  const [datasetId, setDatasetId] = useState("");
  const [check, setCheck] = useState<{ errors: string[]; warnings: string[] }>({ errors: [], warnings: [] });
  const [preview, setPreview] = useState<any>(null);
  const [probe, setProbe] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<Tok[]>("/api/tokenizers").then((t) => {
      setTokenizers(t);
      setCfg((c) => ({ ...c, tokenizer: c.tokenizer || t[0]?.name || "" }));
    }).catch(() => {});
    api.get<any[]>("/api/datasets").then(setDatasets).catch(() => {});
  }, []);

  const set = (patch: Partial<typeof cfg>) => setCfg((c) => ({ ...c, ...patch }));

  const parsePods = () => podText.split("\n").map((s) => s.trim()).filter(Boolean);

  const buildCfg = () => {
    const rr = String(cfg.repeat_rate).trim();
    const repeatRate = rr.endsWith("%") ? rr : Number(rr) > 1 ? `${rr}%` : rr;
    return { ...cfg, repeat_rate: repeatRate, pod_info: parsePods(), rounds };
  };

  const setRound = (i: number, key: string, value: unknown) =>
    setRounds((rs) => rs.map((x, j) => (j === i ? { ...x, [key]: value } : x)));

  const doProbe = async () => {
    setProbe("探测中…");
    try {
      const r = await api.post<any>("/api/probe", {
        host: cfg.host_ip, port: cfg.host_port, url: cfg.url,
      });
      const model = r.models?.[0];
      const parts = [
        r.models_ok ? `✓ 服务可达` : "✗ /v1/models 不可达",
        r.metrics_ok ? `✓ /metrics 可达${r.ucm_detected ? " · UCM 已检测" : " · 无 ucm: 指标"}` : "✗ /metrics 不可达",
      ];
      if (model) {
        set({ model_name: model });
        parts.push(`模型: ${model}`);
      }
      setProbe(parts.join(" · "));
    } catch (e: any) {
      setProbe(`✗ 探测失败：${e.message}`);
    }
  };

  const doValidate = async () => {
    try {
      const r = await api.post<{ errors: string[]; warnings: string[] }>("/api/config/validate", { config: buildCfg() });
      setCheck(r);
      return r;
    } catch (e: any) {
      setCheck({ errors: [String(e.message || e)], warnings: [] });
      return { errors: ["x"], warnings: [] };
    }
  };

  const doPreview = async () => {
    setBusy(true);
    try {
      const pv = await api.post<any>("/api/datasets/preview", {
        tokenizer: cfg.tokenizer || cfg.model_path, input_len: cfg.input_len,
        repeat_rate: cfg.repeat_rate, prefix_num: 3, seed: cfg.seed,
        mode: cfg.dataset_mode, vocab_file: cfg.vocab_file,
      });
      setPreview(pv);
      toast(`预览完成：实测 ${pv.measured_lengths.join("/")} tok，目标 ${pv.target}`);
    } catch (e: any) {
      toast(`预览失败：${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const doStart = async () => {
    const v = await doValidate();
    if (v.errors.length) {
      toast(`配置有误：${v.errors[0]}`);
      return;
    }
    setBusy(true);
    try {
      const r = await api.post<{ run_id: string }>("/api/runs", {
        config: buildCfg(),
        name: cfg.test_name || `run ${new Date().toLocaleString()}`,
      });
      navigate(`/monitor/${r.run_id}`);
    } catch (e: any) {
      toast(`启动失败：${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const seg = preview?.segment_lengths ?? { prefix: 0, separator: 0, suffix: 0 };
  const sample = preview?.samples?.[0];

  return (
    <div className="grid2">
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div className="card">
          <h3><span className="idx">1</span>服务连接 <span className="sec-tag">目标推理服务（vLLM / UCM）</span></h3>
          <div className="row" style={{ marginBottom: 10 }}>
            <div className="field" style={{ flex: 1.4 }}><label>服务地址 <span className="req">*</span></label>
              <input className="inp mono" value={cfg.host_ip} onChange={(e) => set({ host_ip: e.target.value })} data-t="host_ip" /></div>
            <div className="field" style={{ maxWidth: 110 }}><label>端口 <span className="req">*</span></label>
              <input className="inp mono" value={cfg.host_port} onChange={(e) => set({ host_port: +e.target.value || 0 })} data-t="host_port" /></div>
            <div className="field" style={{ maxWidth: 120 }}><label>&nbsp;</label>
              <button className="btn" style={{ width: "100%" }} onClick={doProbe}>⊙ 探测</button></div>
          </div>
          {probe && <div className="subnote" style={{ marginBottom: 8 }}>{probe}</div>}
          <div className="row" style={{ marginBottom: 10 }}>
            <div className="field"><label>模型名称（留空自动探测）</label>
              <input className="inp" value={cfg.model_name} onChange={(e) => set({ model_name: e.target.value })} data-t="model_name" /></div>
            <div className="field" style={{ maxWidth: 110 }}><label>NPU 数</label>
              <input className="inp mono" value={cfg.npu_num} onChange={(e) => set({ npu_num: +e.target.value || 1 })} /></div>
          </div>
          <div className="row" style={{ marginBottom: 10 }}>
            <div className="field"><label>完整 URL（可选，覆盖地址+端口，Docker 场景）</label>
              <input className="inp mono" data-t="url" value={cfg.url}
                onChange={(e) => set({ url: e.target.value })} placeholder="http://host:port" /></div>
          </div>
          <div className="row" style={{ marginBottom: 10 }}>
            <div className="field"><label>API Key（服务启用鉴权时必填）</label>
              <input className="inp mono" type="password" data-t="api_key" value={cfg.api_key}
                onChange={(e) => set({ api_key: e.target.value })} placeholder="sk-…" /></div>
            <div className="field" style={{ maxWidth: 170 }}><label>Summarizer</label>
              <select className="sel" value={cfg.summarizer} onChange={(e) => set({ summarizer: e.target.value })}>
                <option value="default_perf">default_perf</option>
                <option value="stable_stage">stable_stage</option>
              </select></div>
          </div>
          <div className="row">
            <div className="field" style={{ flex: 2.2 }}><label>模型目录（tokenizer 来源）<span className="req">*</span></label>
              <input className="inp mono" value={cfg.model_path} onChange={(e) => set({ model_path: e.target.value })} data-t="model_path"
                placeholder="D:\Models\Qwen3-32B" /></div>
            <div className="field" style={{ maxWidth: 150 }}><label>或选择预置 tokenizer</label>
              <select className="sel" data-t="tokenizer" value={cfg.tokenizer} onChange={(e) => set({ tokenizer: e.target.value })}>
                <option value="">（用模型目录）</option>
                {tokenizers.map((t) => <option key={t.name} value={t.name}>{t.name}（{t.source}）</option>)}
              </select></div>
          </div>
        </div>

        <div className="card">
          <h3><span className="idx">2</span>前缀与数据集 <span className="sec-tag">随机词表纯合成 · 不依赖真实数据集</span></h3>
          <div className="row" style={{ marginBottom: 10 }}>
            <div className="field"><label>输入长度 input_len <span className="req">*</span></label>
              <div className="unit"><input className="inp mono" value={cfg.input_len} onChange={(e) => set({ input_len: +e.target.value || 0 })} data-t="input_len" /><span className="u">tok</span></div></div>
            <div className="field"><label>输出长度 output_len <span className="req">*</span></label>
              <div className="unit"><input className="inp mono" value={cfg.output_len} onChange={(e) => set({ output_len: +e.target.value || 0 })} data-t="output_len" /><span className="u">tok</span></div></div>
            <div className="field"><label>数据条数 data_num</label>
              <input className="inp mono" value={cfg.data_num} onChange={(e) => set({ data_num: +e.target.value || 0 })} data-t="data_num" /></div>
            <div className="field"><label>前缀种类 prefix_num</label>
              <input className="inp mono" value={cfg.prefix_num} onChange={(e) => set({ prefix_num: +e.target.value || 0 })} data-t="prefix_num" /></div>
          </div>
          <div className="row" style={{ marginBottom: 10 }}>
            <div className="field" style={{ maxWidth: 150 }}><label>重复率 repeat_rate</label>
              <div className="unit"><input className="inp mono" value={String(cfg.repeat_rate)} onChange={(e) => set({ repeat_rate: e.target.value })} data-t="repeat_rate" /><span className="u">%</span></div></div>
            <div className="field" style={{ maxWidth: 110 }}><label>数据并行 dp</label>
              <input className="inp mono" value={cfg.dp} onChange={(e) => set({ dp: +e.target.value || 1 })} data-t="dp" /></div>
            <div className="field" style={{ maxWidth: 110 }}><label>随机种子 seed</label>
              <input className="inp mono" value={cfg.seed} onChange={(e) => set({ seed: +e.target.value || 0 })} data-t="seed" /></div>
            <div className="field" style={{ maxWidth: 170 }}><label>长度分布（可选）</label>
              <select className="sel" onChange={(e) => {
                const v = e.target.value;
                set(v === "gauss" ? { length_mean: 32768, length_std: 2000 }
                  : v === "unif" ? { length_min: 8192, length_max: 65536 }
                  : { length_mean: null, length_std: null, length_min: null, length_max: null });
              }}>
                <option value="">固定长度</option><option value="gauss">高斯 mean±std</option><option value="unif">均匀 min–max</option>
              </select></div>
          </div>
          <div className="row" style={{ alignItems: "center", marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: "var(--text2)", width: 70 }}>词表来源</div>
            <select className="sel" style={{ width: 190 }} value={cfg.dataset_mode}
              onChange={(e) => set({ dataset_mode: e.target.value })}>
              <option value="text">gsm8k 文本（tokenizer 词表）</option>
              <option value="tokenid">tokenid 精确模式</option>
            </select>
            <input className="inp mono" style={{ flex: 1, minWidth: 180 }} data-t="vocab_file"
              placeholder="自定义词表文件 vocab.txt（可选，每行一个词）"
              value={cfg.vocab_file ?? ""} onChange={(e) => set({ vocab_file: e.target.value || null })} />
            <span className="muted" style={{ fontSize: 11.5 }}>
              理论命中率 ≈ {(Number(parseFloat(String(cfg.repeat_rate)) || 0) * (1 - 3 / Math.max(1, cfg.input_len))).toFixed(3)}
            </span>
          </div>
          <div className="row" style={{ marginBottom: 10, alignItems: "center" }}>
            <div style={{ fontSize: 12, color: "var(--text2)", width: 130 }}>复用已入库数据集</div>
            <select className="sel" style={{ flex: 1, maxWidth: 320 }} value={datasetId}
              onChange={(e) => {
                setDatasetId(e.target.value);
                set({ dataset_id: e.target.value || null });
              }}>
              <option value="">（不指定 — 按上方参数自动生成）</option>
              {datasets.map((d) => <option key={d.id} value={d.id}>{d.name}（{d.mode}）</option>)}
            </select>
            {datasetId && <span className="tag blue">将跳过生成，直接复用</span>}
          </div>
          <button className="btn" onClick={doPreview} disabled={busy}>▦ 生成数据集预览</button>
          {preview && (
            <div style={{ marginTop: 12 }}>
              <div className="chart-head"><b>样本预览</b>
                <span className="muted" style={{ fontSize: 11 }}>
                  实测 {preview.measured_lengths.join(" / ")} tok · 目标 {preview.target}
                </span></div>
              <div className="preview-sample">
                <span className="seg-prefix">{(sample?.prefix ?? "").slice(0, 300)}…</span>
                {" "}<span className="seg-sep">{(sample?.separator ?? "").slice(0, 12)}</span>{" "}
                <span className="seg-suffix">{(sample?.suffix ?? "").slice(0, 160)}…</span>
              </div>
              <div className="subnote" style={{ marginTop: 6 }}>
                分段长度：前缀 {seg.prefix} · 分隔 {seg.separator} · 后缀 {seg.suffix} tok
              </div>
            </div>
          )}
        </div>

        <div className="card">
          <h3><span className="idx">3</span>并发与调度 <span className="sec-tag">全量阶段 · 预埋阶段并发 = dp</span></h3>
          <div className="row" style={{ marginBottom: 10 }}>
            <div className="field"><label>最大并发 max_concurrency <span className="req">*</span></label>
              <input className="inp mono" value={cfg.concurrency} onChange={(e) => set({ concurrency: +e.target.value || 1 })} data-t="concurrency" /></div>
            <div className="field"><label>请求频率 request_rate</label>
              <div className="unit"><input className="inp mono" value={cfg.request_rate} onChange={(e) => set({ request_rate: +e.target.value || 0 })} data-t="request_rate" /><span className="u">0=burst</span></div></div>
            <div className="field" style={{ maxWidth: 150 }}><label>API 类型 test_type</label>
              <select className="sel" value={cfg.test_type} onChange={(e) => set({ test_type: e.target.value })}>
                <option value="stream">stream</option><option value="text">text</option>
              </select></div>
            <div className="field" style={{ maxWidth: 170 }}><label>轮间缓存清理 cache_reset</label>
              <select className="sel" value={cfg.cache_reset} onChange={(e) => set({ cache_reset: e.target.value })}>
                <option value="each_round">每轮前清理</option>
                <option value="first_round_only">仅首轮前清理</option>
                <option value="never">不清理</option>
              </select></div>
          </div>
          <div className="subnote">预埋阶段并发固定为 dp、output_len=1；温度 0、ignore_eos=true。开启「每轮 seed 偏移」可让各轮前缀互不相同。</div>
        </div>

        <div className="card">
          <h3><span className="idx">4</span>采集端点（Prometheus /metrics） <span className="sec-tag">每行一个 ip:port，支持 IPv6</span></h3>
          <textarea className="inp mono" rows={3} value={podText} onChange={(e) => setPodText(e.target.value)} data-t="pods" />
          <div className="subnote" style={{ marginTop: 6 }}>共 {parsePods().length} 个端点 · 采集间隔 {cfg.collection_interval}s · PD 分离场景填 P 节点与各 DP 域端口</div>
        </div>

        <div className="card">
          <h3><span className="idx">5</span>多轮计划
            <div className="seg" style={{ marginLeft: "auto" }}>
              <span className={roundsMode === "table" ? "on" : ""} onClick={() => setRoundsMode("table")}>表格</span>
              <span className={roundsMode === "json" ? "on" : ""} onClick={() => setRoundsMode("json")}>JSON</span>
            </div>
          </h3>
          <div className="subnote" style={{ marginBottom: 8 }}>
            可按轮覆盖：<span className="mono">input_len output_len data_num concurrency request_rate prefix_num repeat_rate dp seed test_name</span>（留空 = 继承全局）
          </div>
          {roundsMode === "table" ? (
            <table className="mini-table">
              <thead><tr>
                <th>名称</th><th>input_len</th><th>output_len</th><th>data_num</th><th>concurrency</th>
                <th>request_rate</th><th>prefix_num</th><th>repeat_rate</th><th>dp</th><th>seed</th><th></th>
              </tr></thead>
              <tbody>
                {rounds.map((r, i) => (
                  <tr key={i}>
                    <td><input className="inp" style={{ minWidth: 110 }} value={r.test_name ?? ""}
                      onChange={(e) => setRound(i, "test_name", e.target.value)} /></td>
                    {["input_len", "output_len", "data_num", "concurrency", "request_rate",
                      "prefix_num", "repeat_rate", "dp", "seed"].map((k) => (
                      <td key={k}>
                        <input className="inp mono" style={{ width: 74 }} value={String(r[k] ?? "")}
                          placeholder="继承"
                          onChange={(e) => setRound(i, k, e.target.value === "" ? undefined : e.target.value)} />
                      </td>
                    ))}
                    <td><button className="btn sm ghost" onClick={() => setRounds(rounds.filter((_, j) => j !== i))}>✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div>
              <textarea className="inp mono" rows={5} style={{ width: "100%" }}
                placeholder={'[{"test_name":"R1","concurrency":16,"repeat_rate":"90%"}]'}
                value={roundsJson} onChange={(e) => setRoundsJson(e.target.value)} />
              <div className="row" style={{ marginTop: 8, alignItems: "center" }}>
                <button className="btn sm" onClick={() => {
                  try {
                    const v = JSON.parse(roundsJson);
                    const arr = Array.isArray(v) ? v : [v];
                    setRounds(arr);
                    toast(`已导入 ${arr.length} 轮`);
                  } catch (e: any) { toast(`JSON 解析失败：${e.message}`); }
                }}>导入 JSON</button>
                <button className="btn sm ghost" onClick={() => setRoundsJson(JSON.stringify(rounds, null, 2))}>导出当前</button>
                <span className="subnote">兼容原工具 --rounds 文件，可直接互导。</span>
              </div>
            </div>
          )}
          <button className="btn sm" style={{ marginTop: 8 }} onClick={() => setRounds([...rounds, { test_name: `R${rounds.length + 1}` }])}>＋ 添加轮次</button>
        </div>
      </div>

      <div className="card summary-card">
        <h3>摘要与体检</h3>
        <div className="summary-rows">
          <div className="sr"><span className="muted">目标服务</span><b className="mono" style={{ fontSize: 12 }}>{cfg.host_ip}:{cfg.host_port}</b></div>
          <div className="sr"><span className="muted">输入 / 输出</span><b>{cfg.input_len.toLocaleString()} / {cfg.output_len.toLocaleString()} tok</b></div>
          <div className="sr"><span className="muted">数据量</span><b>{cfg.data_num} 条 × 前缀 {cfg.prefix_num}</b></div>
          <div className="sr"><span className="muted">重复率</span><b>{cfg.repeat_rate}</b></div>
          <div className="sr"><span className="muted">并发（全量 / 预埋）</span><b>{cfg.concurrency} / {cfg.dp}</b></div>
          <div className="sr"><span className="muted">采集端点</span><b>{parsePods().length} 个</b></div>
          <div className="sr" style={{ borderBottom: "none" }}><span className="muted">轮次</span><b>{rounds.length} 轮</b></div>
        </div>
        {check.errors.length > 0 && (
          <div className="alert error" style={{ marginTop: 12 }}>
            <span>✕</span><div>{check.errors.map((e, i) => <div key={i}>{e}</div>)}</div>
          </div>)}
        {check.warnings.length > 0 && (
          <div className="alert warn" style={{ marginTop: 12 }}>
            <span>⚠</span><div>{check.warnings.map((w, i) => <div key={i}>{w}</div>)}</div>
          </div>)}
        <div className="subnote" style={{ marginTop: 14 }}>
          提交后将生成唯一 run_id，日志与指标落盘至 outputs/ 目录，可随时回看与对比。
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", gridColumn: "1 / -1" }}>
        <button className="btn ghost" onClick={() => { setCfg({ ...DEFAULT_CFG }); setCheck({ errors: [], warnings: [] }); }}>重置</button>
        <button className="btn" onClick={doValidate}>校验配置</button>
        <button data-t="start" className="btn primary" onClick={doStart} disabled={busy}>▶ 开始测试</button>
      </div>
    </div>
  );
}
