import { useEffect, useMemo, useRef, useState } from "react";
import { api, downloadLink, wsRun, type RoundRow } from "../api";
import { LineChart, Donut } from "../charts";
import { useToast } from "../App";

type Ev = { type: string; ts: number; [k: string]: any };

const HBM = "#4f8bff", EXT = "#13c2c2", UCMC = "#9254de";
const STATUS_TEXT: Record<string, string> = {
  completed: "已完成", running: "运行中", failed: "失败", cancelled: "已停止",
  pending: "排队中", connecting: "连接中", reconnecting: "连接断开",
  not_found: "记录不存在", load_failed: "加载失败",
};

export default function MonitorPage({ route }: { route: string }) {
  const toast = useToast();
  const runId = route.split("/")[1];
  const [events, setEvents] = useState<Ev[]>([]);
  const [logs, setLogs] = useState<{ line: string; err?: boolean; warn?: boolean }[]>([]);
  const [status, setStatus] = useState("connecting");
  const [phase, setPhase] = useState("");
  const [round, setRound] = useState(0);
  const [totalRounds, setTotalRounds] = useState(1);
  const [samples, setSamples] = useState<{ ts: number; flat: Record<string, number> }[]>([]);
  const [phaseRate, setPhaseRate] = useState<{ per_dp: any; per_pod?: any; agg: any; phase: string } | null>(null);
  const [ucm, setUcm] = useState<boolean | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const [filter, setFilter] = useState("all");
  const logRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const wsRef = useRef<WebSocket | null>(null);

  // load past data if the run already exists; WS lifecycle owned by THIS effect
  // (alive flag + wsRef) so switching runs can't leak sockets or mix streams
  useEffect(() => {
    if (!runId) return;
    let alive = true;
    setEvents([]); setLogs([]); setSamples([]); setPhaseRate(null);
    setDetail(null); setUcm(null); setPhase(""); setRound(0);
    setStatus("connecting");
    const toLog = (line: string) => ({
      line, err: line.includes("ERROR") || line.startsWith("[exit"),
      warn: line.includes("WARN"),
    });
    api.get<any>(`/api/runs/${runId}`).then((d) => {
      if (!alive) return;
      setDetail(d);
      setStatus(d.status);
      setTotalRounds((d.config?.rounds ?? [1]).length || 1);
      const rounds: RoundRow[] = d.rounds ?? [];
      const lastFull = [...rounds].reverse().find((r) => r.phase === "full");
      if (lastFull) setPhaseRate({ per_dp: lastFull.hit_rate?.per_dp, agg: lastFull.hit_rate?.aggregated, phase: "full" });
      // backfill the log tail so mid-run monitoring shows history too
      api.get<{ lines: string[] }>(`/api/runs/${runId}/logs?tail=500`).then((r) => {
        if (alive) setLogs((r.lines ?? []).map(toLog));
      }).catch(() => {});
      // completed runs: replay persisted timeseries so charts still render
      api.get<{ samples: any[] }>(`/api/runs/${runId}/metrics`).then((r) => {
        if (!alive) return;
        const gauges = new Set(["running", "waiting", "swapped", "kv_usage"]);
        const flatSamples = (r.samples ?? []).map((s) => {
          const engines: Record<string, Record<string, number>> = s.engines ?? {};
          let flat: Record<string, number> = {};
          for (const counters of Object.values(engines)) {
            for (const [k, v] of Object.entries(counters)) {
              flat[k] = gauges.has(k) ? Math.max(flat[k] ?? 0, Number(v)) : (flat[k] ?? 0) + Number(v);
            }
          }
          return { ts: s.ts as number, flat };
        });
        setSamples(flatSamples);
        if (flatSamples.length && flatSamples[0].flat._ucm_seen) setUcm(true);
      }).catch(() => {});
      if (d.status === "running" || d.status === "pending") {
        const ws = wsRun(runId);
        wsRef.current = ws;
        ws.onmessage = (m) => {
          if (!alive) return;
          const ev: Ev = JSON.parse(m.data);
          setEvents((prev) => [...prev.slice(-4000), ev]);
          if (ev.type === "status") {
            setStatus(ev.status); setPhase(ev.phase ?? ""); setRound(ev.round ?? 0);
            setTotalRounds(ev.total_rounds ?? 1);
          } else if (ev.type === "log") {
            setLogs((prev) => [...prev.slice(-3000), toLog(ev.line as string)]);
          } else if (ev.type === "metrics") {
            setSamples((prev) => [...prev.slice(-600), { ts: ev.ts, flat: ev.sample.flat }]);
            if (ev.sample?.ucm_detected != null) setUcm(ev.sample.ucm_detected);
          } else if (ev.type === "phase_rate") {
            setPhaseRate({ per_dp: ev.rate?.per_dp, agg: ev.rate?.aggregated, phase: ev.phase });
          } else if (ev.type === "warning") {
            toast(ev.message);
          }
        };
        ws.onclose = () => { if (alive && (d.status === "running")) setStatus("reconnecting"); };
      }
    }).catch(() => { if (alive) setStatus("not_found"); });
    return () => {
      alive = false;
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [runId]);

  useEffect(() => {
    if (followRef.current && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  // sliding-window hit rates from consecutive samples
  const trend = useMemo(() => {
    const hbm: number[] = [], ext: number[] = [], comp: number[] = [];
    const run: number[] = [], wait: number[] = [], kv: number[] = [];
    const genRate: number[] = [], promptRate: number[] = [], ttftT: number[] = [];
    let prev = samples[0]?.flat;
    let prevTs = samples[0]?.ts;
    for (const s of samples) {
      const f = s.flat;
      const dt = prev && prevTs != null ? Math.max(0.001, s.ts - prevTs) : 1;
      const dq = prev ? f.hbm_q - prev.hbm_q : 0;
      const deq = prev ? f.ext_q - prev.ext_q : 0;
      const hr = dq > 0 ? (f.hbm_h - prev.hbm_h) / dq : null;
      const er = deq > 0 ? (f.ext_h - prev.ext_h) / deq : null;
      hbm.push(hr == null ? NaN : hr * 100);
      ext.push(er == null ? NaN : er * 100);
      comp.push(hr != null && er != null ? (er * (1 - hr) + hr) * 100 : NaN);
      run.push(f.running ?? 0);
      wait.push(f.waiting ?? 0);
      kv.push((f.kv_usage ?? 0) * 100);
      genRate.push(prev ? Math.max(0, (f.gen_tok - prev.gen_tok) / dt) : 0);
      promptRate.push(prev ? Math.max(0, (f.prompt_tok - prev.prompt_tok) / dt) : 0);
      const dc = prev ? f.ttft_cnt - prev.ttft_cnt : 0;
      ttftT.push(dc > 0 ? ((f.ttft_sum - prev.ttft_sum) / dc) * 1000 : NaN);
      prev = f; prevTs = s.ts;
    }
    const clean = (a: number[]) => a.map((v) => (Number.isFinite(v) ? v : 0));
    return { hbm: clean(hbm), ext: clean(ext), comp: clean(comp),
             run: clean(run), wait: clean(wait), kv: clean(kv),
             genRate: clean(genRate), promptRate: clean(promptRate), ttftT: clean(ttftT) };
  }, [samples]);

  const latest = samples[samples.length - 1]?.flat ?? {};
  const genThr = samples.length > 1 ? genRateOf(samples) : 0;
  function genRateOf(sams: { ts: number; flat: Record<string, number> }[]) {
    if (sams.length < 2) return 0;
    const a = sams[sams.length - 2], b = sams[sams.length - 1];
    const dt = b.ts - a.ts;
    return dt > 0 ? Math.max(0, (b.flat.gen_tok - a.flat.gen_tok) / dt) : 0;
  }
  const agg = phaseRate?.agg ?? {};
  const ttft = latest.ttft_cnt ? (latest.ttft_sum / latest.ttft_cnt) * 1000 : (detail ? (detail.rounds ?? []).filter((r: any) => r.phase === "full").at(-1)?.metrics?.ttft_avg_ms ?? 0 : 0);

  const donutItems = [
    { v: +(latest.ucm_q_tok ? ((latest.ucm_hbm_tok ?? 0) / latest.ucm_q_tok) * 100 : agg.hbm_hit_rate * 100 || 0).toFixed(1), c: HBM },
    { v: +(latest.ucm_q_tok ? ((latest.ucm_hit_tok ?? 0) / latest.ucm_q_tok) * 100 : agg.ext_hit_rate * 100 || 0).toFixed(1), c: UCMC },
  ];
  const missV = Math.max(0, 100 - donutItems[0].v - donutItems[1].v);
  donutItems.push({ v: +missV.toFixed(1), c: "#5a5e66" });

  const shownLogs = logs.filter((l) =>
    filter === "all" ? true : filter === "warn" ? l.warn || l.err : l.err);

  const card = (t: React.ReactNode, v: React.ReactNode, s: string, barColor?: string, pct?: number) => (
    <div className="mcard">
      <div className="t">{t}</div>
      <div className="v">{v}</div>
      <div className="s">{s}</div>
      {barColor && <div className="bar" style={{ background: barColor, width: `${Math.min(100, pct ?? 0)}%` }} />}
    </div>);

  return (
    <>
      {!runId && (
        <div className="alert info" style={{ marginBottom: 14 }}>
          <span>ℹ</span><div>当前没有选中的 run。从「运行记录」打开一个 run，或从「新建测试」发起测试。</div>
        </div>
      )}
      {runId && (
        <>
          {(status === "not_found" || status === "load_failed") && (
            <div className="alert error" style={{ marginBottom: 14 }}>
              <span>✕</span><div>无法加载该运行记录（可能已被删除，或 Sidecar 离线）。</div>
            </div>
          )}
          <div className="run-head">
            <span className="pulse" style={{ background: status === "running" ? undefined : "#6d7078", animation: status === "running" ? undefined : "none" }} />
            <h2>{runId}</h2>
            <span className="tag">{detail?.name}</span>
            <span className="tag" style={{ color: status === "failed" ? "var(--danger)" : undefined }}>
              {STATUS_TEXT[status] ?? status}
            </span>
            {totalRounds > 0 && <span className="tag gray">第 {round || 1} / {totalRounds} 轮</span>}
            {status === "running" && (
              <button className="btn sm danger" style={{ marginLeft: "auto" }}
                onClick={async () => { await api.post(`/api/runs/${runId}/stop`); toast("已请求停止"); }}>
                ■ 停止测试
              </button>
            )}
          </div>
          <div className="phases">
            <div className={`phase ${status !== "running" ? "done" : phase === "warmup" ? "running" : "done"}`}>
              {status !== "running" ? "✓" : phase === "warmup" ? "●" : "✓"} 预埋 warmup（并发 = dp）
            </div>
            <div className="phase-arrow" />
            <div className={`phase ${status === "completed" ? "done" : status === "failed" ? "failed" : phase === "full" && status === "running" ? "running" : ""}`}>
              {status === "failed" ? "✕" : status === "completed" ? "✓" : "•"} 全量 full（并发 = max_concurrency）
            </div>
          </div>

          <div className="metric-cards" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
            {card(<span><i style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: HBM, marginRight: 6 }} />HBM 命中率</span>,
              `${((agg.hbm_hit_rate ?? 0) * 100).toFixed(1)}%`, "阶段快照差分", HBM, (agg.hbm_hit_rate ?? 0) * 100)}
            {card(<span><i style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: EXT, marginRight: 6 }} />Ext 命中率</span>,
              `${((agg.ext_hit_rate ?? 0) * 100).toFixed(1)}%`, "external prefix cache", EXT, (agg.ext_hit_rate ?? 0) * 100)}
            {card(<span><i style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: UCMC, marginRight: 6 }} />综合命中率</span>,
              `${(((agg.ext_hit_rate ?? 0) * (1 - (agg.hbm_hit_rate ?? 0)) + (agg.hbm_hit_rate ?? 0)) * 100).toFixed(1)}%`, "ext×(1−hbm)+hbm", UCMC,
              ((agg.ext_hit_rate ?? 0) * (1 - (agg.hbm_hit_rate ?? 0)) + (agg.hbm_hit_rate ?? 0)) * 100)}
            {card("当前并发 running", `${Math.round(latest.running ?? 0)}`, `waiting ${Math.round(latest.waiting ?? 0)} · swapped ${Math.round(latest.swapped ?? 0)}`)}
            {card("等待队列", `${Math.round(latest.waiting ?? 0)}`, "scheduler queue")}
            {card("KV Cache 利用率", `${((latest.kv_usage ?? 0) * 100).toFixed(0)}%`, "GPU KV 占用", "#e2a336", (latest.kv_usage ?? 0) * 100)}
            {card("avg TTFT", `${ttft.toFixed(0)}ms`, `P90 前缀缓存探测`)}
            {card("输出吞吐", `${genThr.toFixed(0)}`, "tok/s（滑动窗）")}
          </div>

          <div className="monitor-grid">
            <div className="card">
              <div className="chart-head"><b>请求状态 / KV 占用</b>
                <div className="legend">
                  <span><i style={{ background: "#8ab4ff" }} />running</span>
                  <span><i style={{ background: "#f0be63" }} />waiting</span>
                  <span className="dashed" style={{ color: "#13c2c2" }}><i />KV %</span>
                </div>
              </div>
              {samples.length > 1
                ? <LineChart yMax={Math.max(10, ...trend.run, ...trend.wait, ...trend.kv)} height={170}
                    fmt={(v) => String(Math.round(v))}
                    series={[
                      { data: trend.run, color: "#8ab4ff" },
                      { data: trend.wait, color: "#f0be63" },
                      { data: trend.kv, color: "#13c2c2", dash: true }]} />
                : <div className="subnote">等待指标采样…</div>}
            </div>
            <div className="card">
              <div className="chart-head"><b>吞吐 (tok/s，滑动窗)</b>
                <div className="legend">
                  <span><i style={{ background: "#10a37f" }} />输出</span>
                  <span><i style={{ background: "#9254de" }} />输入</span>
                </div>
              </div>
              {samples.length > 1
                ? <LineChart yMax={Math.max(10, ...trend.genRate, ...trend.promptRate)} height={170}
                    fmt={(v) => String(Math.round(v))}
                    series={[
                      { data: trend.genRate, color: "#10a37f", area: true },
                      { data: trend.promptRate, color: "#9254de" }]} />
                : <div className="subnote">等待指标采样…</div>}
            </div>
          </div>

          <div className="monitor-grid">
            <div className="card">
              <div className="chart-head"><b>命中率趋势</b><span className="tag gray" style={{ fontSize: 10 }}>实时 · 滑动窗差分</span>
                <div className="legend">
                  <span><i style={{ background: HBM }} />HBM</span>
                  <span><i style={{ background: EXT }} />External</span>
                  <span className="dashed" style={{ color: "#b89af1" }}><i />综合</span>
                </div>
              </div>
              {samples.length > 1
                ? <LineChart series={[
                    { data: trend.hbm, color: HBM, area: true },
                    { data: trend.ext, color: EXT },
                    { data: trend.comp, color: UCMC, dash: true }]} yMax={100} height={200}
                    fmt={(v) => `${v}%`} xLabel={(i, n) => `${Math.round((i * n))}`} />
                : <div className="subnote">等待指标采样…</div>}
            </div>
            <div className="card">
              <div className="chart-head"><b>Token 流向 / UCM</b>
                {ucm != null && <span className={`tag ${ucm ? "purple" : "warn"}`} style={{ fontSize: 10 }}>{ucm ? "ucm: 已检测" : "未检测到 ucm:"}</span>}
              </div>
              {ucm === false && (
                <div className="alert warn" style={{ marginBottom: 10 }}>
                  <span>⚠</span><div>服务 /metrics 中未发现 ucm: 前缀指标——可能未启用 UCM 或未暴露，仅展示 vLLM 原生指标。</div>
                </div>)}
              <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                <Donut items={donutItems} caption="query 构成" />
                <div style={{ flex: 1 }}>
                  <div className="kv"><span><i style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: HBM, marginRight: 7 }} />HBM 命中 tokens</span><b>{Math.round(latest.ucm_hbm_tok ?? 0).toLocaleString()}</b></div>
                  <div className="kv"><span><i style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: UCMC, marginRight: 7 }} />UCM 命中 tokens</span><b>{Math.round(latest.ucm_hit_tok ?? 0).toLocaleString()}</b></div>
                  <div className="kv"><span><i style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: "#5a5e66", marginRight: 7 }} />查询总量 tokens</span><b>{Math.round(latest.ucm_q_tok ?? 0).toLocaleString()}</b></div>
                </div>
              </div>
            </div>
          </div>

          <div className="monitor-grid2">
            <div className="card">
              <div className="chart-head">
                <div className="seg">
                  {["all", "warn", "err"].map((f) => (
                    <span key={f} className={filter === f ? "on" : ""}
                      onClick={() => setFilter(f)}>{f === "all" ? "全部" : f === "warn" ? "WARN" : "ERROR"}</span>
                  ))}
                </div>
                <label style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center", fontSize: 11.5, color: "var(--muted)" }}>
                  <input type="checkbox" defaultChecked onChange={(e) => (followRef.current = e.target.checked)} />跟随滚动
                </label>
                <a className="btn sm ghost" href={downloadLink(`/api/runs/${runId}/logs/download?stream=stdout`)}>导出日志</a>
              </div>
              <div className="logview" ref={logRef}>
                {shownLogs.length === 0 && <div className="ln muted">暂无日志…</div>}
                {shownLogs.slice(-500).map((l, i) => (
                  <div key={i} className={`ln ${l.err ? "err" : l.warn ? "warn" : ""}`}>{l.line}</div>
                ))}
              </div>
            </div>
            <div className="card">
              <div className="chart-head"><b>DP 域明细</b><span className="tag gray" style={{ fontSize: 10 }}>阶段快照差分</span></div>
              <table className="mini-table">
                <thead><tr><th>端点 / DP 域</th><th>HBM 命中率</th><th>hits / queries</th><th>Ext 命中率</th><th>hits / queries</th></tr></thead>
                <tbody>
                  {Object.entries(phaseRate?.per_pod ?? {}).map(([key, d]: [string, any]) => (
                    <tr key={key}>
                      <td><b className="mono" style={{ fontSize: 11 }}>{key.replace("|", " · ")}</b></td>
                      <td><b style={{ color: HBM }}>{(d.hbm_hit_rate * 100).toFixed(1)}%</b></td>
                      <td className="mono">{d.hbm_hits.toLocaleString()} / {d.hbm_queries.toLocaleString()}</td>
                      <td><b style={{ color: EXT }}>{(d.ext_hit_rate * 100).toFixed(1)}%</b></td>
                      <td className="mono">{d.ext_hits.toLocaleString()} / {d.ext_queries.toLocaleString()}</td>
                    </tr>
                  ))}
                  {!Object.keys(phaseRate?.per_pod ?? {}).length &&
                    Object.entries(phaseRate?.per_dp ?? {}).map(([dp, d]: [string, any]) => (
                      <tr key={dp}>
                        <td><b>{dp}</b></td>
                        <td><b style={{ color: HBM }}>{(d.hbm_hit_rate * 100).toFixed(1)}%</b></td>
                        <td className="mono">{d.hbm_hits.toLocaleString()} / {d.hbm_queries.toLocaleString()}</td>
                        <td><b style={{ color: EXT }}>{(d.ext_hit_rate * 100).toFixed(1)}%</b></td>
                        <td className="mono">{d.ext_hits.toLocaleString()} / {d.ext_queries.toLocaleString()}</td>
                      </tr>))}
                  {!Object.keys(phaseRate?.per_pod ?? {}).length && !Object.keys(phaseRate?.per_dp ?? {}).length && (
                    <tr><td colSpan={5} className="muted">等待阶段完成…</td></tr>)}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </>
  );
}
