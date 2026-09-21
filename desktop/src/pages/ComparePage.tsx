import { useEffect, useMemo, useState } from "react";
import { api, downloadLink, track, useConnected, type CompareResult, type RunSummary } from "../api";
import { BarChart, LineChart, Radar } from "../charts";
import { useToast } from "../App";
import { EmptyState, InfoTip } from "../ui";

const COLORS = ["var(--chart-1)", "var(--chart-6)", "var(--chart-5)", "var(--chart-3)", "var(--chart-2)", "var(--chart-4)"];
type Tab = "overview" | "rounds" | "dp" | "diff";

export default function ComparePage() {
  const toast = useToast();
  const connected = useConnected();
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [sel, setSel] = useState<string[]>([]);
  const [excludeWarmup, setExcludeWarmup] = useState(true);
  const [excludePractice, setExcludePractice] = useState(true);
  const [result, setResult] = useState<CompareResult | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [comparing, setComparing] = useState(false);

  useEffect(() => {
    if (!connected) return;
    api.get<RunSummary[]>("/api/runs").then((rs) => {
      // SLA probe runs live on the SLA page; 0-round corpses (warmup-crashed
      // legacy rows) have nothing to compare — keep the picker clean (R2.5)
      const manual = rs.filter((r) => r.kind !== "sla"
        && (r.summary?.rounds_done ?? 0) > 0);
      setRuns(manual);
      const pre = sessionStorage.getItem("pt-compare-sel");
      if (pre) {
        sessionStorage.removeItem("pt-compare-sel");
        try {
          const ids = (JSON.parse(pre) as string[]).filter((id) => manual.some((r) => r.run_id === id));
          if (ids.length) { setSel(ids); return; }
        } catch { /* corrupted preselect */ }
      }
      setSel((prev) => prev.length ? prev : manual.filter((r) => r.status === "completed").slice(0, 2).map((r) => r.run_id));
    }).catch(() => {});
  }, [connected]);

  useEffect(() => {
    if (sel.length) sessionStorage.setItem("pt-compare-sel", JSON.stringify(sel));
  }, [sel]);

  const doCompare = async () => {
    if (sel.length < 1) { toast("请至少选择 1 个 run"); return; }
    setComparing(true);
    try {
      setResult(await api.post<CompareResult>("/api/compare", {
        run_ids: sel, exclude_warmup: excludeWarmup, exclude_practice: excludePractice,
      }));
      track("compare_run", { run_ids: sel, exclude_warmup: excludeWarmup, exclude_practice: excludePractice });
      setTab("overview");
    } catch (e: any) { toast({ msg: `对比失败：${e.message}`, kind: "error" }); }
    finally { setComparing(false); }
  };

  const excludedCount = excludePractice ? runs.filter((r) => r.is_practice && sel.includes(r.run_id)).length : 0;

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

  const toggle = (id: string) =>
    setSel((s) => s.includes(id) ? s.filter((x) => x !== id) : [...s, id]);

  /* 对柱图数据（E2）：run 为组，Δ% 标注在柱顶（相对第一个 run） */
  const barSpecs = [
    { key: "hbm_hit_rate", label: "显存命中率（HBM %）", pct: true, better: "up" },
    { key: "ext_hit_rate", label: "外部缓存命中（Ext %）", pct: true, better: "up" },
    { key: "ttft_avg_ms", label: "TTFT avg（ms）", pct: false, better: "down" },
    { key: "output_token_throughput", label: "输出吞吐（tok/s）", pct: false, better: "up" },
  ] as const;

  const shortName = (rid: string) => result?.names?.[rid] ?? rid.slice(-6);

  return (
    <>
      {/* 顶部粘性操作条（U6：常驻可点，不再沉底） */}
      <div className="cmp-sticky">
        <div className="sel-chips">
          {sel.length === 0 && <span className="muted" style={{ fontSize: 12 }}>尚未选择 run</span>}
          {sel.map((id) => {
            const r = runs.find((x) => x.run_id === id);
            return (
              <span className="sel-chip" key={id}>
                <b title={r?.name ?? id}>{r?.name ?? id}</b>
                <button aria-label={`移除 ${r?.name ?? id}`} onClick={() => toggle(id)}>✕</button>
              </span>
            );
          })}
        </div>
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, cursor: "pointer" }}>
          <input type="checkbox" checked={excludeWarmup} onChange={(e) => setExcludeWarmup(e.target.checked)} />
          排除预埋（warmup）<InfoTip text="warmup 阶段并发=dp、输出 1 token，仅用于预热缓存——对比通常应排除。" />
        </label>
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, cursor: "pointer" }}>
          <input type="checkbox" checked={excludePractice} onChange={(e) => setExcludePractice(e.target.checked)} />
          排除练习轮{excludedCount > 0 && <span className="tag warn" style={{ padding: "0 6px" }}>已排除 {excludedCount} 个</span>}
        </label>
        <button className="btn primary" style={{ marginLeft: "auto" }} onClick={doCompare} disabled={comparing || !sel.length}>
          {comparing ? "对比中…" : "▶ 开始对比"}
        </button>
      </div>

      <div className="compare-grid" style={{ display: "grid", gridTemplateColumns: "240px minmax(0,1fr)", gap: 16, alignItems: "start" }}>
        {/* 左：run 选择列表（E3：练习轮半透明 + 徽标 + 悬停原因） */}
        <div className="card" style={{ position: "sticky", top: 0 }}>
          <h3>选择运行 <span className="sec-tag">已选 {sel.length}</span></h3>
          {runs.map((r) => {
            const excluded = excludePractice && !!r.is_practice;
            const on = sel.includes(r.run_id);
            return (
              <div key={r.run_id}
                className={`check-run${on && !excluded ? " sel" : ""}${excluded ? " excluded" : ""}`}
                title={excluded ? "练习轮：勾选「排除练习轮」时不参与对比" : undefined}
                onClick={() => { if (!excluded) toggle(r.run_id); }}>
                <div className={`checkbox${on && !excluded ? " on" : ""}`} />
                <div style={{ minWidth: 0 }}>
                  <b style={{ fontSize: 12.5 }}>{r.name}</b>
                  {r.is_practice ? <span className="tag warn" style={{ padding: "1px 6px", marginLeft: 6 }}>练习轮</span> : null}
                  {excluded && on ? <span className="tag gray" style={{ padding: "1px 6px", marginLeft: 6 }}>已排除</span> : null}
                  <div className="muted" style={{ fontSize: 11 }}>{r.run_id}</div>
                </div>
              </div>
            );
          })}
          {!runs.length && <div className="subnote">暂无可对比的 run</div>}
        </div>

        {/* 右：结果区（E1：tabs 结构化；空状态引导） */}
        <div>
          {!result ? (
            <div className="card">
              <EmptyState icon="⇄" title="选择 run 后点击「开始对比」"
                hint="对比将展示指标总览（对柱图 + Δ 标注）、逐轮矩阵、DP 域命中率与配置差异；练习轮与预埋阶段默认排除。"
                action={<button className="btn sm" onClick={() => location.hash = "/history"}>去运行记录选择</button>} />
            </div>
          ) : (
            <>
              <div className="tabs2" role="tablist">
                <span className={tab === "overview" ? "on" : ""} onClick={() => setTab("overview")} role="tab">指标总览</span>
                <span className={tab === "rounds" ? "on" : ""} onClick={() => setTab("rounds")} role="tab">逐轮对比</span>
                <span className={tab === "dp" ? "on" : ""} onClick={() => setTab("dp")} role="tab">DP 矩阵</span>
                <span className={tab === "diff" ? "on" : ""} onClick={() => setTab("diff")} role="tab">配置差异</span>
                <div className="tab-right">
                  <a className="btn sm" href={sel.length ? downloadLink(`/api/compare/export?format=xlsx&run_ids=${sel.join(",")}&exclude_warmup=${excludeWarmup}&exclude_practice=${excludePractice}`) : "#"}>
                    ⇒ xlsx
                  </a>
                  <a className="btn sm" href={sel.length ? downloadLink(`/api/compare/export?format=html&run_ids=${sel.join(",")}&exclude_warmup=${excludeWarmup}&exclude_practice=${excludePractice}`) : "#"} target="_blank" rel="noreferrer">
                    ⇱ HTML
                  </a>
                </div>
              </div>

              {result.missing_rounds.length > 0 && (
                <div className="alert warn" style={{ marginBottom: 12 }}>
                  <span>⚠</span><div>轮次不对齐：{result.missing_rounds.map((x) => `${x.run.slice(-6)} 缺 R${x.round}`).join("；")}</div>
                </div>
              )}

              {tab === "overview" && (
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

                  {/* 对柱图（E2）：Δ% 标注柱顶 */}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 16 }}>
                    {barSpecs.map((spec) => {
                      const m = result.metrics[spec.key];
                      if (!m) return null;
                      const fmt = (v: number) => spec.pct ? `${(v * 100).toFixed(1)}` : v > 0 ? v.toFixed(0) : "—";
                      return (
                        <div className="card" key={spec.key}>
                          <div className="chart-head"><b>{spec.label}</b>
                            <div className="legend">
                              {result.runs.map((rid, i) => (
                                <span className="l-solid" key={rid}><i style={{ background: COLORS[i % COLORS.length] }} />{shortName(rid)}</span>
                              ))}
                            </div>
                          </div>
                          {/* 对柱图（E2）：每个 run 一根柱，Δ% 相对首 run 标注在柱顶；
                              R2.5：单组图 x 轴不留重复指标名，pct 图固定 0–100 轴 */}
                          <BarChart
                            groups={[""]}
                            yMax={spec.pct ? 100 : undefined}
                            series={result.runs.map((rid, i) => ({
                              name: shortName(rid),
                              data: [(() => {
                                const v = m.values[rid];
                                return v == null || v < 0 ? -1 : spec.pct ? v * 100 : v;
                              })()],
                              color: COLORS[i % COLORS.length],
                            }))}
                            labels={[result.runs.map((rid) => {
                              if (rid === result.runs[0]) return fmt(m.values[rid]);
                              const d = m.deltas[rid];
                              return d ? `${d.pct >= 0 ? "+" : ""}${d.pct.toFixed(1)}%` : "";
                            })]}
                            height={185}
                            ariaLabel={`${spec.label}对比柱状图`} />
                        </div>
                      );
                    })}
                  </div>

                  <div className="card" style={{ marginTop: 16 }}>
                    <div className="chart-head"><b>五维评分</b><span className="muted" style={{ fontSize: 10.5 }}>min–max 归一</span></div>
                    <Radar axes={["HBM命中", "Ext命中", "TTFT", "TPOT", "吞吐"]} series={radarSeries} />
                  </div>
                </>
              )}

              {tab === "rounds" && (
                <>
                  <div className="card" style={{ marginBottom: 16 }}>
                    <div className="chart-head"><b>各轮次显存命中率（%）</b>
                      <div className="legend">
                        {result.runs.map((rid, i) => (
                          <span className="l-solid" key={rid}><i style={{ background: COLORS[i % COLORS.length] }} />{shortName(rid)}</span>
                        ))}
                      </div>
                    </div>
                    <LineChart yMax={100} height={200} fmt={(v) => `${v}%`}
                      series={result.runs.map((rid, i) => ({
                        data: groups.map((_, gi) => ((result.per_round[rid]?.[gi + 1]?.hbm_hit_rate ?? 0) * 100)),
                        color: COLORS[i % COLORS.length],
                      }))} ariaLabel="各轮次命中率对比图" />
                  </div>
                  <div className="card">
                    <div className="chart-head"><b>各轮次 TTFT avg（ms）</b></div>
                    <BarChart groups={groups} height={185}
                      series={result.runs.map((rid, i) => ({
                        data: groups.map((_, gi) => (result.per_round[rid]?.[gi + 1]?.ttft_avg_ms ?? -1)),
                        color: COLORS[i % COLORS.length],
                      }))} ariaLabel="各轮次TTFT对比柱状图" />
                  </div>
                </>
              )}

              {tab === "dp" && (
                <div className="card">
                  <div className="chart-head"><b>DP 域命中率矩阵</b><span className="muted" style={{ fontSize: 10.5 }}>末轮 · 全量阶段</span></div>
                  <table className="mini-table">
                    <thead><tr><th>run</th><th>DP 域</th><th>显存命中</th><th>Ext</th></tr></thead>
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
              )}

              {tab === "diff" && (
                <div className="card">
                  <div className="chart-head"><b>配置差异</b><span className="muted" style={{ fontSize: 10.5 }}>* 为存在差异的参数</span></div>
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
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
