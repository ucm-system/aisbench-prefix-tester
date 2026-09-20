import { useEffect, useRef, useState } from "react";
import { api, type RunSummary } from "../api";
import { BarChart } from "../charts";
import { useToast } from "../App";

type Probe = {
  concurrency: number; ok: boolean; run_id?: string; reason?: string;
  ttft_avg_ms?: number; ttft_p90_ms?: number; tpot_avg_ms?: number;
  tpot_p90_ms?: number; output_token_throughput?: number;
  hbm_hit_rate?: number; ext_hit_rate?: number; state?: string;
};
type Job = {
  job_id: string; state: string; sla: Record<string, number>;
  max_ok: number | null; probes: Probe[]; note: string; current?: number;
};

const HBM = "#4f8bff", EXT = "#13c2c2";

export default function SlaPage() {
  const toast = useToast();
  const [toks, setToks] = useState<{ name: string }[]>([]);
  const [form, setForm] = useState({
    host: "203.0.113.10", port: 8101, model_name: "qwen3", tokenizer: "",
    input_len: 4096, output_len: 32, data_num: 64, prefix_num: 4,
    repeat_rate: "90", dp: 1, seed: 42, pods: "",
  });
  const [slaRows, setSlaRows] = useState<{ metric: string; stat: string; value: number }[]>([
    { metric: "ttft", stat: "p90", value: 3000 },
    { metric: "tpot", stat: "avg", value: 50 },
  ]);
  const [bounds, setBounds] = useState({ start: 8, max: 128 });
  const [job, setJob] = useState<Job | null>(null);
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    api.get<{ name: string }[]>("/api/tokenizers").then((t) => {
      setToks(t);
      setForm((f) => ({ ...f, tokenizer: t[0]?.name ?? "" }));
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!job || job.state === "done" || job.state === "failed" || job.state === "cancelled") return;
    pollRef.current = window.setInterval(async () => {
      const j = await api.get<Job>(`/api/sla/${job.job_id}`);
      setJob(j);
      if (j.state === "done" || j.state === "failed") toast(j.note);
    }, 2000);
    return () => { if (pollRef.current) window.clearInterval(pollRef.current); };
  }, [job?.job_id, job?.state]);

  const start = async () => {
    try {
      const cfg = {
        host_ip: form.host, host_port: form.port, model_name: form.model_name,
        model_path: "", tokenizer: form.tokenizer,
        input_len: form.input_len, output_len: form.output_len,
        data_num: form.data_num, prefix_num: form.prefix_num,
        concurrency: bounds.start, request_rate: 0, dp: form.dp, seed: form.seed,
        repeat_rate: `${form.repeat_rate}%`, test_name: "sla-search",
        pod_info: form.pods.split("\n").map((s) => s.trim()).filter(Boolean),
      };
      const slaSpec: Record<string, number> = {};
      for (const row of slaRows) {
        if (row.value > 0) slaSpec[`${row.metric}_${row.stat}`] = row.value;
      }
      const r = await api.post<{ job_id: string }>("/api/sla/start", {
        config: cfg, sla: slaSpec,
        start_concurrency: bounds.start, max_concurrency: bounds.max,
      });
      setJob({ job_id: r.job_id, state: "pending", sla: {}, max_ok: null, probes: [], note: "" });
      toast(`SLA 调优已启动：${r.job_id}`);
    } catch (e: any) { toast(`启动失败：${e.message}`); }
  };

  const groups = job?.probes.map((p) => `c${p.concurrency}`) ?? [];
  const ttftSeries = [{ data: job?.probes.map((p) => p.ttft_p90_ms ?? 0) ?? [], color: HBM }];
  const slaLine = job?.sla?.ttft_p90_ms;

  return (
    <div className="grid2">
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div className="card">
          <h3>压测目标 <span className="sec-tag">所有探针复用同一数据集 → 命中率口径一致</span></h3>
          <div className="row" style={{ marginBottom: 10 }}>
            <div className="field" style={{ flex: 1.4 }}><label>服务地址</label>
              <input className="inp mono" value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} /></div>
            <div className="field" style={{ maxWidth: 100 }}><label>端口</label>
              <input className="inp mono" value={form.port} onChange={(e) => setForm({ ...form, port: +e.target.value || 0 })} /></div>
            <div className="field"><label>模型名（served）</label>
              <input className="inp" value={form.model_name} onChange={(e) => setForm({ ...form, model_name: e.target.value })} /></div>
            <div className="field"><label>Tokenizer</label>
              <select className="sel" value={form.tokenizer} onChange={(e) => setForm({ ...form, tokenizer: e.target.value })}>
                {toks.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
              </select></div>
          </div>
          <div className="row" style={{ marginBottom: 10 }}>
            <div className="field"><label>input_len</label>
              <input className="inp mono" value={form.input_len} onChange={(e) => setForm({ ...form, input_len: +e.target.value || 0 })} /></div>
            <div className="field"><label>output_len</label>
              <input className="inp mono" value={form.output_len} onChange={(e) => setForm({ ...form, output_len: +e.target.value || 0 })} /></div>
            <div className="field"><label>data_num</label>
              <input className="inp mono" value={form.data_num} onChange={(e) => setForm({ ...form, data_num: +e.target.value || 0 })} /></div>
            <div className="field"><label>prefix_num</label>
              <input className="inp mono" value={form.prefix_num} onChange={(e) => setForm({ ...form, prefix_num: +e.target.value || 0 })} /></div>
            <div className="field"><label>repeat_rate %</label>
              <input className="inp mono" value={form.repeat_rate} onChange={(e) => setForm({ ...form, repeat_rate: e.target.value })} /></div>
          </div>
          <div className="field"><label>采集端点（每行 ip:port，与压测端口一致）</label>
            <textarea className="inp mono" rows={2} value={form.pods} onChange={(e) => setForm({ ...form, pods: e.target.value })} /></div>
        </div>

        <div className="card">
          <h3>SLA 目标 <span className="sec-tag">水位可选：avg/P50/P75/P90/P99/Max</span></h3>
          {slaRows.map((row, i) => (
            <div className="row" key={i} style={{ marginBottom: 8, alignItems: "center" }}>
              <select className="sel" style={{ maxWidth: 110 }} value={row.metric}
                onChange={(e) => setSlaRows((rs) => rs.map((x, j) => j === i ? { ...x, metric: e.target.value } : x))}>
                <option value="ttft">TTFT</option><option value="tpot">TPOT</option><option value="e2el">E2EL</option>
              </select>
              <select className="sel" style={{ maxWidth: 110 }} value={row.stat}
                onChange={(e) => setSlaRows((rs) => rs.map((x, j) => j === i ? { ...x, stat: e.target.value } : x))}>
                {["avg", "p50", "p75", "p90", "p99", "max"].map((s) => <option key={s} value={s}>{s.toUpperCase()}</option>)}
              </select>
              <span className="muted">≤</span>
              <div className="unit" style={{ flex: 1 }}>
                <input className="inp mono" value={row.value} onChange={(e) => setSlaRows((rs) => rs.map((x, j) => j === i ? { ...x, value: +e.target.value || 0 } : x))} />
                <span className="u">ms</span>
              </div>
              {slaRows.length > 1 && (
                <button className="btn sm ghost" onClick={() => setSlaRows((rs) => rs.filter((_, j) => j !== i))}>✕</button>)}
            </div>
          ))}
          <button className="btn sm" style={{ marginBottom: 10 }}
            onClick={() => setSlaRows((rs) => [...rs, { metric: "ttft", stat: "p99", value: 5000 }])}>＋ 添加条件</button>
          <div className="row">
            <div className="field"><label>起始并发</label>
              <input className="inp mono" value={bounds.start} onChange={(e) => setBounds({ ...bounds, start: +e.target.value || 1 })} /></div>
            <div className="field"><label>并发上限</label>
              <input className="inp mono" value={bounds.max} onChange={(e) => setBounds({ ...bounds, max: +e.target.value || 1 })} /></div>
            <div className="field" style={{ maxWidth: 130, alignSelf: "flex-end" }}>
              <button className="btn primary" style={{ width: "100%" }} onClick={start}
                disabled={!!job && ["pending", "ladder", "bisect", "running"].includes(job.state)}>▶ 开始调优</button></div>
          </div>
          <div className="subnote" style={{ marginTop: 8 }}>
            策略：并发从 {bounds.start} 指数爬升（×2）直至 SLA 被打破，再在相邻好/坏探针间二分细化（≤5 轮）。
            每个探针都是一次真实压测。
          </div>
        </div>
      </div>

      <div className="card summary-card">
        <h3>调优结果</h3>
        {!job && <div className="subnote">配置目标与 SLA 后点击「开始调优」。每个探针 ≈ 一次真实压测，整个过程约几分钟。</div>}
        {job && (
          <>
            <div className="mcard" style={{ marginBottom: 12 }}>
              <div className="t">SLA 内最大并发</div>
              <div className="v">{job.max_ok != null ? job.max_ok : job.state === "done" ? "0" : "搜索中…"}</div>
              <div className="s">{job.note} · 阶段 {job.state}{job.current ? ` · 当前并发 ${job.current}` : ""}</div>
            </div>
            <table className="mini-table">
              <thead><tr><th>并发</th><th>TTFT P90</th><th>TPOT avg</th><th>吞吐</th><th>SLA</th></tr></thead>
              <tbody>
                {job.probes.map((p, i) => {
                  const ttft = p.ttft_p90_ms ?? -1, tpot = p.tpot_avg_ms ?? -1, thr = p.output_token_throughput ?? -1;
                  return (
                  <tr key={i}>
                    <td><b>{p.concurrency}</b></td>
                    <td>{ttft > 0 ? `${ttft.toFixed(0)}ms` : "—"}</td>
                    <td>{tpot > 0 ? `${tpot.toFixed(1)}ms` : "—"}</td>
                    <td>{thr > 0 ? thr.toFixed(0) : "—"}</td>
                    <td className={p.ok ? "up" : "down"}>{p.ok ? "✓ 满足" : `✕ ${p.reason ?? ""}`}</td>
                  </tr>
                  );
                })}
                {!job.probes.length && <tr><td colSpan={5} className="muted">暂无探针</td></tr>}
              </tbody>
            </table>
            {job.probes.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div className="chart-head"><b>TTFT P90 随并发变化 (ms)</b>
                  <div className="legend">
                    <span><i style={{ background: HBM }} />实测</span>
                    {slaLine ? <span><i style={{ background: EXT }} />SLA 上限 {slaLine}ms</span> : null}
                  </div>
                </div>
                <BarChart groups={groups} series={[ttftSeries[0], {
                  data: job.probes.map(() => slaLine ?? 0), color: EXT,
                }]} />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
