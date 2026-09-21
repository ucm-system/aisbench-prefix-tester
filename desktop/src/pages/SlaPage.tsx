import { useEffect, useRef, useState } from "react";
import { api, useConnected, type RunSummary, type SlaJob } from "../api";
import { BarChart } from "../charts";
import { useToast } from "../App";

type Probe = {
  concurrency: number; ok: boolean; run_id?: string; reason?: string;
  ttft_avg_ms?: number; ttft_p90_ms?: number; tpot_avg_ms?: number;
  tpot_p90_ms?: number; output_token_throughput?: number;
  hbm_hit_rate?: number; ext_hit_rate?: number; state?: string;
};
type Job = SlaJob;

const HBM = "#4f8bff", EXT = "#13c2c2";
const ACTIVE_STATES = ["pending", "running", "ladder", "bisect"];
const STATE_TEXT: Record<string, string> = {
  pending: "排队中", running: "运行中", ladder: "爬坡搜索", bisect: "二分细化",
  done: "已完成", failed: "失败", cancelled: "已取消", interrupted: "已中断",
};

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
  const [history, setHistory] = useState<Job[]>([]);
  const [logRunId, setLogRunId] = useState("");
  const [logLines, setLogLines] = useState<string[]>([]);
  const logBoxRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<number | null>(null);

  const loadHistory = () => {
    api.get<Job[]>("/api/sla/jobs").then((js) =>
      setHistory(js.filter((j) => j.state !== "pending"))).catch(() => {});
  };

  // restore: live in-process job first, else the most recent persisted job —
  // navigating away and back (or an app restart) no longer loses the view.
  // Retries until the sidecar is reachable (UI may open before it is ready).
  const connected = useConnected();
  useEffect(() => {
    if (!connected) return;
    api.get<{ job: Job | null }>("/api/sla/current").then((r) => {
      if (r.job) setJob(r.job);
    }).catch(() => {
      const id = localStorage.getItem("pt-sla-last-job");
      if (id) api.get<Job>(`/api/sla/${id}`).then(setJob).catch(() => {});
    });
    loadHistory();
  }, [connected]);

  useEffect(() => {
    if (!connected) return;
    api.get<{ name: string }[]>("/api/tokenizers").then((t) => {
      setToks(t);
      // remember the tokenizer picked on the config page across pages/sessions
      setForm((f) => ({ ...f, tokenizer: f.tokenizer || localStorage.getItem("pt-tokenizer") || (t[0]?.name ?? "") }));
    }).catch(() => {});
  }, [connected]);

  useEffect(() => {
    if (!job || !ACTIVE_STATES.includes(job.state)) return;
    pollRef.current = window.setInterval(async () => {
      try {
        const j = await api.get<Job>(`/api/sla/${job.job_id}`);
        setJob(j);
        if (j.state === "done" || j.state === "failed") { toast(j.note); loadHistory(); }
      } catch (e: any) {
        // job vanished (sidecar restart) → mark interrupted instead of stuck
        if (/404|not found/i.test(String(e.message))) {
          setJob((p) => p && p.job_id === job.job_id
            ? { ...p, state: "interrupted", note: p.note || "Sidecar 重启导致任务中断" } : p);
          loadHistory();
        }
      }
    }, 2000);
    return () => { if (pollRef.current) window.clearInterval(pollRef.current); };
  }, [job?.job_id, job?.state]);

  const start = async () => {
    const empty = slaRows.filter((r) => !(r.value > 0));
    if (empty.length) { toast("有 SLA 条件未填数值（数值 ≤ 0 的条件不会生效）"); return; }
    if (!Object.keys(slaRows.reduce((a, r) => { a[`${r.metric}_${r.stat}`] = 1; return a; }, {} as Record<string, number>)).length) {
      toast("至少需要一个 SLA 条件"); return;
    }
    if (!form.pods.trim() && !confirm(
      "「采集端点」为空：探针将采集不到命中率指标（恒为 0），涉及「相同命中率」的结论会失真。\n仍要继续吗？（建议先填 ip:port，通常与推理端口相同）")) return;
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
      // pre-flight contradiction checks — refuse to run an unsatisfiable spec
      const seen = new Map<string, number>();
      for (const row of slaRows) {
        if (!(row.value > 0)) {
          toast(`SLA 条件「${row.metric}/${row.stat}」数值必须 > 0`); return;
        }
        const k = `${row.metric}_${row.stat}`;
        if (seen.has(k) && seen.get(k) !== row.value) {
          toast(`SLA 条件矛盾：「${k}」同时设置了 ${seen.get(k)} 与 ${row.value} 两个不同阈值`); return;
        }
        seen.set(k, row.value);
      }
      const slaSpec: Record<string, number> = {};
      for (const row of slaRows) {
        slaSpec[`${row.metric}_${row.stat}`] = row.value;
      }
      const r = await api.post<{ job_id: string }>("/api/sla/start", {
        config: cfg, sla: slaSpec,
        start_concurrency: bounds.start, max_concurrency: bounds.max,
      });
      setJob({ job_id: r.job_id, state: "pending", sla: {}, max_ok: null, probes: [], note: "" });
      localStorage.setItem("pt-sla-last-job", r.job_id);
      toast(`SLA 调优已启动：${r.job_id}`);
    } catch (e: any) { toast(`启动失败：${e.message}`); }
  };

  const cancel = async () => {
    if (!job) return;
    try {
      await api.post(`/api/sla/${job.job_id}/cancel`);
      toast("已请求停止");
    } catch (e: any) { toast(`停止失败：${e.message}`); }
  };

  const showJob = (j: Job) => {
    // live job → pull fresh snapshot; persisted history → use the row as-is
    if (ACTIVE_STATES.includes(j.state)) {
      api.get<Job>(`/api/sla/${j.job_id}`).then(setJob).catch(() => setJob(j));
    } else setJob(j);
  };

  const fmtT = (t?: number) => t ? new Date(t * 1000).toLocaleString("zh-CN", { hour12: false }) : "—";

  // probe log follower: tail the selected (or latest) probe's ais_bench output
  useEffect(() => {
    if (!job) return;
    const active = ACTIVE_STATES.includes(job.state);
    const latest = job.probes.length ? (job.probes[job.probes.length - 1].run_id ?? "") : "";
    const rid = logRunId || latest;
    if (!rid) return;
    let stop = false;
    const fetchLogs = async () => {
      try {
        const r = await api.get<{ lines: string[] }>(`/api/runs/${rid}/logs?tail=120`);
        if (!stop) setLogLines(r.lines ?? []);
      } catch { /* probe run deleted or sidecar offline */ }
    };
    fetchLogs();
    const t = active ? window.setInterval(fetchLogs, 2000) : null;
    return () => { stop = true; if (t) window.clearInterval(t); };
  }, [job?.job_id, job?.state, job?.probes.length, logRunId]);

  useEffect(() => {
    if (logBoxRef.current) logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
  }, [logLines]);

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
            <textarea className="inp mono" rows={2} value={form.pods} placeholder={`例如 ${form.host}:${form.port}（通常与推理端口相同；留空则无命中率指标）`} onChange={(e) => setForm({ ...form, pods: e.target.value })} /></div>
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
                disabled={!!job && ACTIVE_STATES.includes(job.state)}>▶ 开始调优</button></div>
          </div>
          <div className="subnote" style={{ marginTop: 8 }}>
            策略：并发从 {bounds.start} 指数爬升（×2）直至 SLA 被打破，再在相邻好/坏探针间二分细化（≤5 轮）。
            每个探针都是一次真实压测。
          </div>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div className="card">
        <h3>调优结果
          {job && ACTIVE_STATES.includes(job.state) && (
            <button className="btn sm danger" style={{ marginLeft: "auto" }} onClick={cancel}>■ 停止</button>
          )}
        </h3>
        {!job && <div className="subnote">配置目标与 SLA 后点击「开始调优」。每个探针 ≈ 一次真实压测，整个过程约几分钟。</div>}
        {job && (
          <>
            <div className="mcard" style={{ marginBottom: 12 }}>
              <div className="t">SLA 内最大并发</div>
              <div className="v">{job.max_ok != null ? job.max_ok
                : job.state === "done" ? "0"
                : job.state === "interrupted" ? "—" : "搜索中…"}</div>
              <div className="s">{[job.note, STATE_TEXT[job.state] ?? job.state]
                .filter((s, i, arr) => s && arr.indexOf(s) === i).join(" · ")}
                {job.current ? ` · 当前并发 ${job.current}` : ""}
                {job.probes.length ? ` · 已完成探针 ${job.probes.length}` : ""}</div>
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
                <BarChart groups={groups} series={slaLine != null ? [ttftSeries[0], {
                  data: job.probes.map(() => slaLine), color: EXT,
                }] : [ttftSeries[0]]} />
              </div>
            )}
          </>
        )}
      </div>

      {job && (
        <div className="card">
          <h3>探针日志
            <select className="sel" style={{ maxWidth: 240, marginLeft: "auto" }}
              value={logRunId} onChange={(e) => setLogRunId(e.target.value)}>
              <option value="">跟随最新探针</option>
              {job.probes.map((p, i) => (
                <option key={i} value={p.run_id ?? ""}>c{p.concurrency} · {p.run_id}</option>
              ))}
            </select>
          </h3>
          <div className="logview" ref={logBoxRef} style={{ height: 200 }}>
            {logLines.map((l, i) => (
              <div key={i} className={"ln" + (l.includes("ERROR") ? " err" : l.includes("WARN") ? " warn" : "")}>{l}</div>
            ))}
            {!logLines.length && <div className="ln muted">暂无日志 — 探针启动后此处跟随 ais_bench 输出</div>}
          </div>
        </div>
      )}

      <div className="card">
        <h3>历史调优 <span className="sec-tag">独立于「运行记录」· 点击行加载详情</span></h3>
        <table className="mini-table">
          <thead><tr><th>时间</th><th>状态</th><th>SLA 内最大并发</th><th>说明</th></tr></thead>
          <tbody>
            {history.map((h) => (
              <tr key={h.job_id} style={{ cursor: "pointer" }} onClick={() => showJob(h)}>
                <td>{fmtT(h.created_at)}</td>
                <td><span className={`tag ${h.state === "done" ? "blue" : h.state === "failed" ? "gray" : "warn"}`}
                  style={{ padding: "1px 7px" }}>{STATE_TEXT[h.state] ?? h.state}</span></td>
                <td><b>{h.max_ok != null ? h.max_ok : "—"}</b></td>
                <td className="muted" style={{ fontSize: 11 }}>
                  {(h.sla && Object.keys(h.sla).length) ? Object.entries(h.sla).map(([k, v]) => `${k}≤${v}`).join("，") : h.note || "—"}
                </td>
              </tr>
            ))}
            {!history.length && <tr><td colSpan={4} className="muted">暂无历史调优</td></tr>}
          </tbody>
        </table>
      </div>
      </div>
    </div>
  );
}
