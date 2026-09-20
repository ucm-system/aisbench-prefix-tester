import { useEffect, useMemo, useState } from "react";
import { api, downloadLink, type CompareResult, type RunSummary } from "../api";
import { BarChart, LineChart, Radar } from "../charts";
import { useToast } from "../App";

const COLORS = ["#4f8bff", "#13c2c2", "#9254de", "#e2a336", "#10a37f", "#e5484d"];

export default function ComparePage() {
  const toast = useToast();
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [sel, setSel] = useState<string[]>([]);
  const [excludeWarmup, setExcludeWarmup] = useState(true);
  const [excludePractice, setExcludePractice] = useState(true);
  const [result, setResult] = useState<CompareResult | null>(null);

  useEffect(() => {
    api.get<RunSummary[]>("/api/runs").then((rs) => {
      // SLA probe runs live on the SLA page; keep the compare picker manual-only
      const manual = rs.filter((r) => r.kind !== "sla");
      setRuns(manual);
      const pre = sessionStorage.getItem("pt-compare-sel");
      if (pre) {
        sessionStorage.removeItem("pt-compare-sel");
        try {
          const ids = JSON.parse(pre) as string[];
          if (Array.isArray(ids) && ids.length) { setSel(ids); return; }
        } catch { /* corrupted preselect */ }
      }
      setSel((prev) => prev.length ? prev : manual.filter((r) => r.status === "completed").slice(0, 2).map((r) => r.run_id));
    }).catch(() => {});
  }, []);

  const doCompare = async () => {
    if (sel.length < 1) { toast("请至少选择 1 个 run"); return; }
    try {
      setResult(await api.post<CompareResult>("/api/compare", {
        run_ids: sel, exclude_warmup: excludeWarmup, exclude_practice: excludePractice,
      }));
    } catch (e: any) { toast(`对比失败：${e.message}`); }
  };

  const radarSeries = useMemo(() => {
    if (!result) return [];
    const m = result.metrics;
    return result.runs.map((rid, i) => {
      const norm = (key: string, invert = false) => {
        const vals = result.runs.map((r) => m[key]?.values[r] ?? -1);
        const v = m[key]?.values[rid] ?? -1;
        const lo = Math.min(...vals), hi = Math.max(...vals);
        if (hi <= lo) return 75;
        const p = ((v - lo) / (hi - lo)) * 100;
        return invert ? 100 - p : p;
      };
      return { data: [norm("hbm_hit_rate"), norm("ext_hit_rate"), norm("ttft_avg_ms", true),
        norm("tpot_avg_ms", true), norm("output_token_throughput")], color: COLORS[i % COLORS.length] };
    });
  }, [result]);

  const maxRound = result ? Math.max(1, ...result.runs.map((r) => Math.max(0, ...Object.keys(result.per_round[r] ?? {}).map(Number)))) : 1;
  const groups = Array.from({ length: maxRound }, (_, i) => `R${i + 1}`);

  return (
    <div className="compare-grid">
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="card">
          <h3>选择运行 <span className="sec-tag">已选 {sel.length}</span></h3>
          {runs.map((r) => {
            const excluded = excludePractice && !!r.is_practice;
            const on = sel.includes(r.run_id);
            return (
              <div key={r.run_id}
                className={`check-run${on && !excluded ? " sel" : ""}`}
                style={{ opacity: excluded ? 0.45 : 1 }}
                onClick={() => {
                  if (excluded) return;
                  setSel((s) => on ? s.filter((x) => x !== r.run_id) : [...s, r.run_id]);
                }}>
                <div className={`checkbox${on && !excluded ? " on" : ""}`} />
                <div>
                  <b style={{ fontSize: 12.5 }}>{r.name}</b>
                  {r.is_practice ? <span className="tag warn" style={{ padding: "1px 6px", marginLeft: 6 }}>练习轮</span> : null}
                  <div className="muted" style={{ fontSize: 11 }}>{r.run_id}</div>
                </div>
              </div>
            );
          })}
          {!runs.length && <div className="subnote">暂无 run</div>}
          <div style={{ borderTop: "1px solid var(--border)", margin: "10px 0" }} />
          <label style={{ display: "flex", alignItems: "center", gap: 9, padding: "4px 8px", fontSize: 12 }}>
            <input type="checkbox" checked={excludeWarmup} onChange={(e) => setExcludeWarmup(e.target.checked)} />
            排除预埋（warmup 阶段）
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 9, padding: "4px 8px", fontSize: 12 }}>
            <input type="checkbox" checked={excludePractice} onChange={(e) => setExcludePractice(e.target.checked)} />
            排除练习轮
          </label>
          <button className="btn primary" style={{ width: "100%", marginTop: 10 }} onClick={doCompare}>⇄ 开始对比</button>
        </div>
        <div className="card">
          <h3>导出</h3>
          <a className="btn" style={{ width: "100%", marginBottom: 8, justifyContent: "center", display: "flex" }}
            href={sel.length ? downloadLink(`/api/compare/export?format=xlsx&run_ids=${sel.join(",")}&exclude_warmup=${excludeWarmup}`) : "#"}>
            ⇒ 导出 xlsx（5 个 Sheet）
          </a>
          <a className="btn" style={{ width: "100%", justifyContent: "center", display: "flex" }}
            href={sel.length ? downloadLink(`/api/compare/export?format=html&run_ids=${sel.join(",")}&exclude_warmup=${excludeWarmup}`) : "#"} target="_blank" rel="noreferrer">
            ⇱ 离线 HTML 报告
          </a>
        </div>
      </div>

      <div>
        {!result && <div className="alert info"><span>ℹ</span><div>在左侧选择 2 个以上 run（练习轮默认排除），点击「开始对比」。</div></div>}
        {result && (
          <>
            <div className="delta-cards">
              {(["hbm_hit_rate", "ext_hit_rate", "ttft_avg_ms", "output_token_throughput"] as const).map((k) => {
                const m = result.metrics[k];
                const base = m.values[result.runs[0]];
                const d = result.runs[1] ? m.deltas[result.runs[1]] : undefined;
                return (
                  <div className="dcard" key={k}>
                    <div className="t">{m.label}</div>
                    <div className="v">
                      {k.includes("hit_rate") ? `${(base * 100).toFixed(1)}%` : base > 0 ? base.toFixed(0) : "—"}
                      {d && <span style={{ fontSize: 12, color: "var(--muted)" }}> vs {k.includes("hit_rate") ? `${(m.values[result.runs[1]] * 100).toFixed(1)}%` : m.values[result.runs[1]]?.toFixed(0)}</span>}
                    </div>
                    <div className="d" style={{ color: d ? (d.good ? "var(--green)" : "var(--danger)") : undefined }}>
                      {d ? `${d.pct >= 0 ? "▲" : "▼"} ${d.pct.toFixed(1)}%${d.good ? "（更优）" : ""}` : "—"}
                    </div>
                  </div>
                );
              })}
            </div>

            {result.missing_rounds.length > 0 && (
              <div className="alert warn" style={{ marginBottom: 12 }}>
                <span>⚠</span><div>轮次不对齐：{result.missing_rounds.map((x) => `${x.run} 缺 R${x.round}`).join("；")}</div>
              </div>)}

            <div className="card" style={{ marginBottom: 12 }}>
              <div className="chart-head"><b>命中率对比（%）</b>
                <div className="legend">
                  {result.runs.map((rid, i) => (
                    <span key={rid}>
                      <i style={{ background: COLORS[i % COLORS.length] }} />{result.names[rid]}·HBM
                    </span>))}
                </div>
              </div>
              <LineChart yMax={100} height={200} fmt={(v) => `${v}%`}
                series={result.runs.map((rid, i) => ({
                  data: groups.map((_, gi) => ((result.per_round[rid]?.[gi + 1]?.hbm_hit_rate ?? 0) * 100)),
                  color: COLORS[i % COLORS.length],
                }))} />
            </div>

            <div className="row" style={{ marginBottom: 12 }}>
              <div className="card" style={{ flex: 1.2 }}>
                <div className="chart-head"><b>各轮次 TTFT avg (ms)</b></div>
                <BarChart groups={groups} series={result.runs.map((rid, i) => ({
                  data: groups.map((_, gi) => (result.per_round[rid]?.[gi + 1]?.ttft_avg_ms ?? -1)),
                  color: COLORS[i % COLORS.length],
                }))} />
              </div>
              <div className="card" style={{ flex: 1 }}>
                <div className="chart-head"><b>五维评分</b><span className="muted" style={{ fontSize: 10.5 }}>min–max 归一</span></div>
                <Radar axes={["HBM命中", "Ext命中", "TTFT", "TPOT", "吞吐"]} series={radarSeries} />
              </div>
            </div>

            <div className="row">
              <div className="card" style={{ flex: 1 }}>
                <div className="chart-head"><b>配置差异</b></div>
                <table className="mini-table">
                  <thead><tr><th>参数</th>{result.runs.map((rid) => <th key={rid}>{result.names[rid]}</th>)}</tr></thead>
                  <tbody>
                    {result.config_diff.map((row) => (
                      <tr key={row.key}>
                        <td className={row.diff ? "diff-key" : "muted"}>{row.key}{row.diff ? " *" : ""}</td>
                        {row.values.map((v, i) => <td key={i}>{String(v ?? "—")}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="card" style={{ flex: 1.3 }}>
                <div className="chart-head"><b>DP 域命中率矩阵</b><span className="muted" style={{ fontSize: 10.5 }}>末轮 · 全量阶段</span></div>
                <table className="mini-table">
                  <thead><tr><th>run</th><th>DP 域</th><th>HBM</th><th>Ext</th></tr></thead>
                  <tbody>
                    {result.runs.flatMap((rid) =>
                      Object.entries(result.dp_matrix[rid] ?? {}).map(([dp, d]) => (
                        <tr key={`${rid}${dp}`}>
                          <td>{result.names[rid]}</td><td>{dp}</td>
                          <td style={{ background: `rgba(79,139,255,${d.hbm_hit_rate ?? 0})` }}>{((d.hbm_hit_rate ?? 0) * 100).toFixed(1)}%</td>
                          <td style={{ background: `rgba(19,194,194,${d.ext_hit_rate ?? 0})` }}>{((d.ext_hit_rate ?? 0) * 100).toFixed(1)}%</td>
                        </tr>)))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
