import { useEffect, useRef, useState } from "react";
import { api, track, useConnected, type SlaJob, type SlaProbe } from "../api";
import { DualAxisChart } from "../charts";
import { useToast } from "../App";
import { EmptyState, StatusBadge, InfoTip, fmtDur, pickDefaultTokenizer } from "../ui";

const HBM = "var(--hbm)", EXT = "var(--ext)", T_GREEN = "var(--green)";
const ACTIVE_STATES = ["pending", "running", "ladder", "bisect"];
const STATE_TEXT: Record<string, string> = {
  pending: "排队中", running: "运行中", ladder: "爬坡搜索", bisect: "二分细化",
  done: "已完成", failed: "失败", cancelled: "已取消", interrupted: "已中断",
};

type Job = SlaJob;

export default function SlaPage() {
  const toast = useToast();
  const [toks, setToks] = useState<{ name: string }[]>([]);
  const [form, setForm] = useState({
    host: "192.168.1.10", port: 8000, model_name: "qwen3", tokenizer: "",
    input_len: 4096, output_len: 32, data_num: 64, prefix_num: 4,
    repeat_rate: "90", dp: 1, seed: 42, pods: "",
  });
  const [slaRows, setSlaRows] = useState<{ metric: string; stat: string; value: number }[]>([
    { metric: "ttft", stat: "p90", value: 3000 },
    { metric: "tpot", stat: "avg", value: 50 },
  ]);
  const [bounds, setBounds] = useState({ start: 8, max: 128 });
  const [job, setJob] = useState<Job | null>(null);
  const [viewingHistoryId, setViewingHistoryId] = useState<string | null>(null);
  const [history, setHistory] = useState<Job[]>([]);
  const [logRunId, setLogRunId] = useState("");
  const [logLines, setLogLines] = useState<string[]>([]);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const logBoxRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<number | null>(null);

  const loadHistory = () => {
    api.get<Job[]>("/api/sla/jobs").then((js) =>
      setHistory(js.filter((j) => j.state !== "pending"))).catch(() => {});
  };

  const connected = useConnected();
  const loadCurrent = () => {
    api.get<{ job: Job | null }>("/api/sla/current").then((r) => {
      if (r.job) { setJob(r.job); setViewingHistoryId(null); }
    }).catch(() => {
      const id = localStorage.getItem("pt-sla-last-job");
      if (id) api.get<Job>(`/api/sla/${id}`).then((j) => { setJob(j); setViewingHistoryId(j.job_id); }).catch(() => {});
    });
  };
  useEffect(() => {
    if (!connected) return;
    loadCurrent();
    loadHistory();
  }, [connected]);

  useEffect(() => {
    if (!connected) return;
    api.get<{ name: string }[]>("/api/tokenizers").then((t) => {
      setToks(t);
      setForm((f) => ({ ...f, tokenizer: f.tokenizer || pickDefaultTokenizer(t, localStorage.getItem("pt-tokenizer")) }));
    }).catch(() => {});
  }, [connected]);

  /* 活动任务轮询 */
  useEffect(() => {
    if (!job || !ACTIVE_STATES.includes(job.state)) return;
    pollRef.current = window.setInterval(async () => {
      try {
        const j = await api.get<Job>(`/api/sla/${job.job_id}`);
        setJob(j);
        if (!viewingHistoryId) setViewingHistoryId(null);
        if (j.state === "done" || j.state === "failed") {
          toast({ msg: j.note, kind: j.state === "done" ? "success" : "error" });
          track("sla_job_finish", { job_id: j.job_id, max_ok: j.max_ok, probes: j.probes.length, state: j.state });
          loadHistory();
        }
      } catch (e: any) {
        if (/404|not found/i.test(String(e.message))) {
          setJob((p) => p && p.job_id === job.job_id
            ? { ...p, state: "interrupted", note: p.note || "Sidecar 重启导致任务中断" } : p);
          loadHistory();
        }
      }
    }, 2000);
    return () => { if (pollRef.current) window.clearInterval(pollRef.current); };
  }, [job?.job_id, job?.state, viewingHistoryId]);

  const start = async () => {
    const empty = slaRows.filter((r) => !(r.value > 0));
    if (empty.length) { toast("有 SLA 条件未填数值（数值 ≤ 0 的条件不会生效）"); return; }
    if (!form.pods.trim() && !confirm(
      "「采集端点」为空：探针将采集不到命中率指标（恒为 0），涉及「相同命中率」的结论会失真。\n仍要继续吗？（建议先填 ip:port，通常与推理端口相同）")) return;
    const seen = new Map<string, number>();
    for (const row of slaRows) {
      if (!(row.value > 0)) { toast(`SLA 条件「${row.metric}/${row.stat}」数值必须 > 0`); return; }
      const k = `${row.metric}_${row.stat}`;
      if (seen.has(k) && seen.get(k) !== row.value) {
        toast(`SLA 条件矛盾：「${k}」同时设置了 ${seen.get(k)} 与 ${row.value} 两个不同阈值`); return;
      }
      seen.set(k, row.value);
    }
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
      for (const row of slaRows) slaSpec[`${row.metric}_${row.stat}`] = row.value;
      const r = await api.post<{ job_id: string }>("/api/sla/start", {
        config: cfg, sla: slaSpec,
        start_concurrency: bounds.start, max_concurrency: bounds.max,
      });
      setJob({ job_id: r.job_id, state: "pending", sla: slaSpec, max_ok: null, probes: [], note: "" });
      setViewingHistoryId(null);
      localStorage.setItem("pt-sla-last-job", r.job_id);
      toast({ msg: `SLA 调优已启动：${r.job_id}`, kind: "success" });
    } catch (e: any) { toast({ msg: `启动失败：${e.message}`, kind: "error" }); }
  };

  const cancel = async () => {
    if (!job) return;
    try {
      await api.post(`/api/sla/${job.job_id}/cancel`);
      toast("已请求停止调优");
    } catch (e: any) { toast({ msg: `停止失败：${e.message}`, kind: "error" }); }
  };

  const showJob = (j: Job) => {
    if (ACTIVE_STATES.includes(j.state)) {
      api.get<Job>(`/api/sla/${j.job_id}`).then((fetched) => {
        setJob(fetched);
        setViewingHistoryId(null); // 活动任务 = 最新视图
      }).catch(() => setJob(j));
    } else {
      setJob(j);
      setViewingHistoryId(j.job_id);
      setLogRunId("");
    }
  };
  const backToLatest = () => {
    setViewingHistoryId(null);
    loadCurrent();
  };

  const fmtT = (t?: number) => t ? new Date(t * 1000).toLocaleString("zh-CN", { hour12: false }) : "—";

  /* 探针日志跟随 */
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
      } catch { /* probe run deleted */ }
    };
    fetchLogs();
    const t = active ? window.setInterval(fetchLogs, 2000) : null;
    return () => { stop = true; if (t) window.clearInterval(t); };
  }, [job?.job_id, job?.state, job?.probes.length, logRunId]);

  useEffect(() => {
    if (logBoxRef.current) logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
  }, [logLines]);

  /* 进度估计（F1）：阶梯 log2(max/start) + 预检 + 二分 ≤5 */
  const active = !!job && ACTIVE_STATES.includes(job.state);
  const estTotal = Math.max(1, Math.ceil(Math.log2(Math.max(2, bounds.max) / Math.max(1, bounds.start))) + 1 + 5);
  const progressPct = job
    ? (active ? Math.min(96, Math.round((job.probes.length / estTotal) * 100))
      : job.state === "done" ? 100 : 0)
    : 0;
  const stageText = job?.state === "ladder" ? `爬升中 c=${job.current ?? "…"}`
    : job?.state === "bisect" ? `二分 [${job.bisect?.[0] ?? "?"}, ${job.bisect?.[1] ?? "?"}] · 当前 c=${job.current ?? "…"}`
    : job?.state === "running" ? "准备数据集…"
    : job?.state === "pending" ? "排队中…"
    : job ? STATE_TEXT[job.state] : "";

  /* 中断任务：从已完成探针推导「已探明」参考值（U8：不再裸 —） */
  const lastOkC = job ? job.probes.filter((p) => p.ok).reduce<number | null>((acc, p) => Math.max(acc ?? 0, p.concurrency), null) : null;

  const cats = (job?.probes ?? []).map((p) => `c${p.concurrency}`);
  const leftSeries = [
    { name: "TTFT P90", color: HBM, points: (job?.probes ?? []).map((p) => p.ttft_p90_ms ?? NaN), dash: false },
    { name: "TPOT avg", color: EXT, points: (job?.probes ?? []).map((p) => p.tpot_avg_ms ?? NaN), dash: true },
  ];
  const rightSeries = [
    { name: "吞吐", color: T_GREEN, points: (job?.probes ?? []).map((p) => p.output_token_throughput ?? NaN), dash: false },
  ];
  const thresholds = Object.entries(job?.sla ?? {})
    .filter(([k]) => k.startsWith("ttft") || k.startsWith("tpot") || k.startsWith("e2el"))
    .map(([k, v]) => ({
      y: v as number,
      label: `${k.includes("ttft") ? "TTFT" : k.includes("tpot") ? "TPOT" : "E2EL"} SLA ≤ ${v}ms`,
      color: "var(--warn)",
    }));
  const inflectionIdx = job?.max_ok != null
    ? (job?.probes ?? []).findIndex((p) => p.concurrency === job.max_ok) : -1;
  const inflection = inflectionIdx >= 0 && job?.max_ok != null
    ? { index: inflectionIdx, label: `SLA 内最大并发 = ${job.max_ok}` } : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {/* 上：配置卡（全宽，§6.5） */}
      <div className="card">
        <h3>压测目标 <span className="sec-tag">所有探针复用同一数据集 → 命中率口径一致</span></h3>
        <div className="row" style={{ marginBottom: 10 }}>
          <div className="field" style={{ flex: 1.3 }}><label>服务地址</label>
            <input className="inp mono" value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} /></div>
          <div className="field" style={{ maxWidth: 100 }}><label>端口</label>
            <input className="inp mono" value={form.port} onChange={(e) => setForm({ ...form, port: +e.target.value || 0 })} /></div>
          <div className="field"><label>模型名（served）</label>
            <input className="inp" value={form.model_name} onChange={(e) => setForm({ ...form, model_name: e.target.value })} /></div>
          <div className="field"><label>Tokenizer</label>
            <select className="sel" value={form.tokenizer} onChange={(e) => setForm({ ...form, tokenizer: e.target.value })}>
              {toks.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
            </select></div>
          <div className="field" style={{ maxWidth: 120 }}><label>input_len</label>
            <input className="inp mono" value={form.input_len} onChange={(e) => setForm({ ...form, input_len: +e.target.value || 0 })} /></div>
          <div className="field" style={{ maxWidth: 120 }}><label>output_len</label>
            <input className="inp mono" value={form.output_len} onChange={(e) => setForm({ ...form, output_len: +e.target.value || 0 })} /></div>
        </div>
        <div className="row" style={{ marginBottom: 10 }}>
          <div className="field" style={{ maxWidth: 110 }}><label>data_num</label>
            <input className="inp mono" value={form.data_num} onChange={(e) => setForm({ ...form, data_num: +e.target.value || 0 })} /></div>
          <div className="field" style={{ maxWidth: 110 }}><label>prefix_num</label>
            <input className="inp mono" value={form.prefix_num} onChange={(e) => setForm({ ...form, prefix_num: +e.target.value || 0 })} /></div>
          <div className="field" style={{ maxWidth: 110 }}><label>repeat_rate %</label>
            <input className="inp mono" value={form.repeat_rate} onChange={(e) => setForm({ ...form, repeat_rate: e.target.value })} /></div>
          <div className="field" style={{ maxWidth: 90 }}><label>dp</label>
            <input className="inp mono" value={form.dp} onChange={(e) => setForm({ ...form, dp: +e.target.value || 1 })} /></div>
          <div className="field" style={{ maxWidth: 100 }}><label>seed</label>
            <input className="inp mono" value={form.seed} onChange={(e) => setForm({ ...form, seed: +e.target.value || 0 })} /></div>
          <div className="field" style={{ flex: 2 }}><label>采集端点（每行 ip:port，与压测端口一致）</label>
            <input className="inp mono" placeholder={`${form.host}:${form.port}（通常与推理端口相同）`}
              value={form.pods} onChange={(e) => setForm({ ...form, pods: e.target.value })} /></div>
        </div>

        <div style={{ borderTop: "1px solid var(--border)", margin: "4px 0 14px" }} />
        <h3 style={{ marginBottom: 10 }}>SLA 目标
          <span className="sec-tag">水位可选：avg / P50 / P75 / P90 / P99 / Max · ms</span>
        </h3>
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
            <div className="unit" style={{ flex: 1, maxWidth: 200 }}>
              <input className="inp mono" value={row.value}
                onChange={(e) => setSlaRows((rs) => rs.map((x, j) => j === i ? { ...x, value: +e.target.value || 0 } : x))} />
              <span className="u">ms</span>
            </div>
            {slaRows.length > 1 && (
              <button className="btn sm ghost" aria-label="删除条件"
                onClick={() => setSlaRows((rs) => rs.filter((_, j) => j !== i))}>✕</button>)}
          </div>
        ))}
        <button className="btn sm" style={{ marginBottom: 12 }}
          onClick={() => setSlaRows((rs) => [...rs, { metric: "ttft", stat: "p99", value: 5000 }])}>＋ 添加条件</button>

        <div className="row" style={{ alignItems: "flex-end" }}>
          <div className="field" style={{ maxWidth: 130 }}><label>起始并发</label>
            <input className="inp mono" value={bounds.start} onChange={(e) => setBounds({ ...bounds, start: +e.target.value || 1 })} /></div>
          <div className="field" style={{ maxWidth: 130 }}><label>并发上限</label>
            <input className="inp mono" value={bounds.max} onChange={(e) => setBounds({ ...bounds, max: +e.target.value || 1 })} /></div>
          <button className="btn primary" onClick={start} disabled={active}>▶ 开始调优</button>
          <span className="subnote" style={{ flex: 1, minWidth: 200 }}>
            策略：并发从 {bounds.start} 指数爬升（×2）直至 SLA 被打破，再二分细化（≤5 轮）。每个探针 ≈ 一次真实压测。
          </span>
        </div>
      </div>

      {/* 下：结果区（全宽） */}
      <div className="card">
        <h3>调优结果
          {viewingHistoryId && (
            <span className="tag blue" style={{ marginLeft: 4 }}>查看：{fmtT(job?.created_at)}</span>
          )}
          {viewingHistoryId && (
            <button className="btn sm ghost" style={{ marginLeft: 6 }} onClick={backToLatest}>返回最新</button>
          )}
          <span className="sec-tag">{job ? `已完成探针 ${job.probes.length}` : ""}</span>
        </h3>

        {!job && (
          <EmptyState icon="◎" title="配置目标与 SLA 后点击「开始调优」"
            hint="每个探针 ≈ 一次真实压测，整个过程约几分钟；结果将给出 SLA 约束内的最大可用并发与拐点曲线。" />
        )}

        {job && (
          <>
            {/* 进度条 + 阶段文案 + 停止（F1） */}
            {(active || job.state === "done") && (
              <div className="sla-progress">
                <span className="stage-text">{active ? stageText : STATE_TEXT[job.state]}</span>
                <div className="progress" role="progressbar" aria-valuenow={progressPct}>
                  <i className={active && progressPct === 0 ? "indet" : ""}
                     style={active && progressPct === 0 ? undefined : { width: `${progressPct}%` }} />
                </div>
                {active && (
                  <button className="btn sm danger" onClick={cancel}>■ 停止调优</button>
                )}
                {job.probes.length > 0 && (
                  <span className="muted" style={{ fontSize: 11.5 }}>
                    总耗时 ≈ {fmtDur(job.probes.reduce((a, p) => a + (p.elapsed_s ?? 0), 0))}
                  </span>
                )}
              </div>
            )}

            {/* 结果卡（U8：中断态给状态徽标+原因，不裸 —） */}
            <div className="sla-result-grid" style={{ marginBottom: 16 }}>
              <div className="mcard">
                <div className="t">SLA 内最大并发</div>
                <div className="v">{job.max_ok != null ? job.max_ok
                  : job.state === "done" ? "0"
                  : job.state === "interrupted" ? (lastOkC != null ? `${lastOkC} *` : "—")
                  : active ? "搜索中…" : "—"}</div>
                <div className="s">
                  {job.state === "interrupted"
                    ? `任务中断（${job.note || "Sidecar 重启/应用退出"}）${lastOkC != null ? `，中断前已探明满足 SLA 的最大并发 = ${lastOkC}` : "，尚无完整探针"}`
                    : [job.note, STATE_TEXT[job.state] ?? job.state]
                      .filter((s, i, arr) => s && arr.indexOf(s) === i).join(" · ")}
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div className="kv"><span>状态</span><span><StatusBadge status={job.state} /></span></div>
                <div className="kv"><span>SLA 条件</span>
                  <b>{Object.keys(job.sla ?? {}).length
                    ? Object.entries(job.sla).map(([k, v]) => `${k}≤${v}`).join("，")
                    : "—"}</b></div>
                <div className="kv" style={{ borderBottom: "none" }}>
                  <span>当前并发 / 二分区间</span>
                  <b>{job.current ?? "—"}{job.bisect ? ` / [${job.bisect[0]}, ${job.bisect[1]}]` : ""}</b></div>
              </div>
            </div>

            {/* 并发-延迟双轴曲线（F2）：SLA 线 + 命中区 + 拐点标注 + 行联动 */}
            {job.probes.length > 0 ? (
              <div style={{ marginBottom: 16 }}>
                <div className="chart-head"><b>并发-延迟曲线</b>
                  <span className="head-note">左轴：TTFT P90 / TPOT avg（ms）· 右轴：吞吐（tok/s）</span>
                  <div className="legend">
                    <span className="l-solid"><i style={{ background: HBM }} />TTFT P90</span>
                    <span className="l-dash"><i style={{ background: EXT }} />TPOT avg</span>
                    <span className="l-solid"><i style={{ background: T_GREEN }} />吞吐（右轴）</span>
                  </div>
                  <InfoTip text="绿色底色 = SLA 满足区间；虚线 = SLA 阈值；拐点竖线 = SLA 内最大并发。悬停探针表行可高亮对应点。" />
                </div>
                <DualAxisChart
                  cats={cats} left={leftSeries} right={rightSeries}
                  leftFmt={(v) => String(Math.round(v))} rightFmt={(v) => String(Math.round(v))}
                  thresholds={thresholds}
                  okFlags={(job.probes ?? []).map((p) => !!p.ok)}
                  inflection={inflection}
                  highlight={hoverIdx}
                  onHover={setHoverIdx}
                  height={260}
                  ariaLabel="并发-延迟双轴曲线" />
              </div>
            ) : active ? (
              <div className="subnote" style={{ marginBottom: 16 }}>首个探针执行中…</div>
            ) : null}

            {/* 探针表（F1：当前行高亮；F2：hover 联动曲线） */}
            <table className="mini-table" style={{ marginBottom: 16 }}>
              <thead><tr><th>并发</th><th>TTFT P90</th><th>TPOT avg</th><th>吞吐</th><th>显存命中</th><th>耗时</th><th>SLA</th></tr></thead>
              <tbody>
                {job.probes.map((p, i) => {
                  const isCur = active && i === job.probes.length - 1;
                  const ttft = p.ttft_p90_ms ?? -1, tpot = p.tpot_avg_ms ?? -1, thr = p.output_token_throughput ?? -1;
                  return (
                  <tr key={i} className={isCur ? "probe-row cur" : "probe-row"}
                      onMouseEnter={() => setHoverIdx(i)} onMouseLeave={() => setHoverIdx(null)}
                      style={{ cursor: "default" }}>
                    <td><b>{p.concurrency}</b>{isCur && <span className="tag blue" style={{ padding: "0 6px", marginLeft: 6 }}>当前</span>}</td>
                    <td>{ttft > 0 ? `${ttft.toFixed(0)}ms` : "—"}</td>
                    <td>{tpot > 0 ? `${tpot.toFixed(1)}ms` : "—"}</td>
                    <td>{thr > 0 ? thr.toFixed(0) : "—"}</td>
                    <td>{p.hbm_hit_rate != null && p.hbm_hit_rate > 0 ? `${(p.hbm_hit_rate * 100).toFixed(1)}%` : "—"}</td>
                    <td>{p.elapsed_s ? `${p.elapsed_s.toFixed(0)}s` : "—"}</td>
                    <td className={p.ok ? "up" : "down"}>{p.ok ? "✓ 满足" : `✕ ${p.reason ?? ""}`}</td>
                  </tr>
                  );
                })}
                {!job.probes.length && <tr><td colSpan={7} className="muted">暂无探针</td></tr>}
              </tbody>
            </table>
          </>
        )}
      </div>

      {job && (
        <div className="card">
          <h3>探针日志
            <select className="sel" style={{ maxWidth: 240, marginLeft: "auto" }}
              value={logRunId} onChange={(e) => setLogRunId(e.target.value)}>
              <option value="">跟随最新探针</option>
              {job.probes.map((p: SlaProbe, i: number) => (
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

      {/* 历史调优（U8：列宽固定 + ellipsis + 悬停全文 + 选中高亮） */}
      <div className="card">
        <h3>历史调优 <span className="sec-tag">独立于「运行记录」· 点击行加载详情</span></h3>
        <table className="mini-table hist-table">
          <thead><tr>
            <th className="time">时间</th><th className="st">状态</th>
            <th className="maxok">SLA 内最大并发</th><th style={{ width: "100%" }}>说明</th>
          </tr></thead>
          <tbody>
            {history.map((h) => {
              const note = (h.sla && Object.keys(h.sla).length)
                ? Object.entries(h.sla).map(([k, v]) => `${k}≤${v}`).join("，")
                : h.note || "—";
              return (
                <tr key={h.job_id} style={{ cursor: "pointer" }}
                  className={viewingHistoryId === h.job_id ? "probe-row cur" : ""}
                  onClick={() => showJob(h)}>
                  <td>{fmtT(h.created_at)}</td>
                  <td><StatusBadge status={h.state} /></td>
                  <td><b>{h.max_ok != null ? h.max_ok : "—"}</b></td>
                  <td className="cell-ellipsis" title={note}>{note}</td>
                </tr>
              );
            })}
            {!history.length && <tr><td colSpan={4} className="muted">暂无历史调优</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
