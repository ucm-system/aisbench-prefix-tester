import { useEffect, useState } from "react";
import { api, downloadLink, type RunSummary } from "../api";
import { navigate, useToast } from "../App";

const STATUS_COLOR: Record<string, string> = {
  completed: "var(--green)", running: "var(--brand)", failed: "var(--danger)",
  cancelled: "var(--muted)", pending: "var(--warn)",
};
const STATUS_TEXT: Record<string, string> = {
  completed: "已完成", running: "运行中", failed: "失败", cancelled: "已停止", pending: "排队中",
};

export default function HistoryPage() {
  const toast = useToast();
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [q, setQ] = useState("");
  const [detail, setDetail] = useState<any>(null);
  const [open, setOpen] = useState(false);

  const load = async () => {
    try {
      setRuns(await api.get<RunSummary[]>(`/api/runs${q ? `?q=${encodeURIComponent(q)}` : ""}`));
    } catch { /* sidecar offline */ }
  };
  useEffect(() => { load(); const t = setInterval(load, 4000); return () => clearInterval(t); }, [q]);

  const openDetail = async (runId: string) => {
    const d = await api.get<any>(`/api/runs/${runId}`);
    setDetail(d);
    setOpen(true);
  };

  const fmtTime = (t: number) => new Date(t * 1000).toLocaleString("zh-CN", { hour12: false });

  return (
    <>
      <div className="toolbar">
        <input className="inp" placeholder="搜索 run_id / 名称 / 备注…" style={{ maxWidth: 260 }}
          value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="muted" style={{ marginLeft: "auto" }}>共 {runs.length} 条记录</span>
      </div>
      <div className="card" style={{ padding: "6px 4px" }}>
        <table>
          <thead><tr>
            <th style={{ width: 34 }}></th><th>名称 / run_id</th><th>时间</th>
            <th>HBM</th><th>Ext</th><th>TTFT avg</th><th>吞吐</th><th>轮次</th><th style={{ width: 210 }}></th>
          </tr></thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.run_id} style={{ cursor: "pointer" }} onClick={() => openDetail(r.run_id)}>
                <td><span className="status-p"><i style={{ background: STATUS_COLOR[r.status] ?? "var(--muted)" }} /></span></td>
                <td><b>{r.name}{r.is_practice ? " " : ""}</b>
                  {r.is_practice ? <span className="tag warn" style={{ padding: "1px 7px" }}>练习轮</span> : null}
                  <br /><span className="muted mono" style={{ fontSize: 11 }}>{r.run_id}</span></td>
                <td>{fmtTime(r.created_at)}</td>
                <td><b>{r.summary ? `${(r.summary.hbm_hit_rate * 100).toFixed(1)}%` : "—"}</b></td>
                <td><b style={{ color: "var(--ext)" }}>{r.summary ? `${(r.summary.ext_hit_rate * 100).toFixed(1)}%` : "—"}</b></td>
                <td>{r.summary && r.summary.ttft_avg_ms > 0 ? `${r.summary.ttft_avg_ms.toFixed(0)}ms` : "—"}</td>
                <td>{r.summary && r.summary.output_token_throughput > 0 ? `${r.summary.output_token_throughput.toFixed(0)} tok/s` : "—"}</td>
                <td>{r.summary?.rounds_done ?? 0} 阶段</td>
                <td onClick={(e) => e.stopPropagation()}>
                  <button className="btn sm" onClick={() => navigate(`/monitor/${r.run_id}`)}>监控</button>
                  <button className="btn sm" onClick={() => openDetail(r.run_id)}>详情</button>
                  <a className="btn sm ghost" href={downloadLink(`/api/runs/${r.run_id}/export?format=xlsx`)}>xlsx</a>
                  <button className="btn sm danger" onClick={async () => {
                    if (!confirm(`删除 ${r.run_id} 及其全部数据？`)) return;
                    await api.del(`/api/runs/${r.run_id}`);
                    toast("已删除");
                    load();
                  }}>删除</button>
                </td>
              </tr>
            ))}
            {!runs.length && <tr><td colSpan={9} className="muted">暂无运行记录 — 从「新建测试」开始</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="drawer-mask" style={{ display: open ? "block" : "none" }} onClick={() => setOpen(false)} />
      <div id="drawer" className={open ? "open" : ""}>
        <div className="drawer-head">
          <div>
            <b style={{ fontSize: 14 }}>{detail?.name}</b>
            <div className="muted mono" style={{ fontSize: 11, marginTop: 2 }}>
              {detail?.run_id} · {detail?.status} · {detail?.rounds?.length ?? 0} 阶段
            </div>
          </div>
          <div style={{ marginLeft: "auto", display: "flex", gap: 7 }}>
            <a className="btn sm" href={detail ? downloadLink(`/api/runs/${detail.run_id}/export?format=xlsx`) : "#"}>xlsx</a>
            <a className="btn sm" href={detail ? downloadLink(`/api/runs/${detail.run_id}/export?format=html`) : "#"}>HTML 报告</a>
            <button className="btn sm primary" onClick={async () => {
              await api.patch(`/api/runs/${detail.run_id}`, { is_practice: !detail.is_practice });
              toast(detail.is_practice ? "已取消练习轮标记" : "已标记为练习轮（对比默认排除）");
              const d = await api.get<any>(`/api/runs/${detail.run_id}`);
              setDetail(d); load();
            }}>{detail?.is_practice ? "取消练习标记" : "标记练习轮"}</button>
            <button className="btn sm ghost" onClick={() => setOpen(false)}>✕</button>
          </div>
        </div>
        <div className="drawer-body">
          <div className="card" style={{ padding: 12, marginBottom: 12 }}>
            <div className="chart-head" style={{ marginBottom: 4 }}><b style={{ fontSize: 12 }}>轮 × 阶段结果</b></div>
            <table className="mini-table">
              <thead><tr><th>轮</th><th>阶段</th><th>HBM</th><th>Ext</th><th>TTFT avg</th><th>吞吐</th><th>时长</th><th>警告</th></tr></thead>
              <tbody>
                {(detail?.rounds ?? []).map((r: any, i: number) => (
                  <tr key={i}>
                    <td>R{r.round_index}</td>
                    <td><span className={`tag ${r.phase === "full" ? "blue" : "gray"}`} style={{ padding: "1px 7px" }}>{r.phase}</span></td>
                    <td><b>{((r.hit_rate?.aggregated?.hbm_hit_rate ?? 0) * 100).toFixed(1)}%</b></td>
                    <td style={{ color: "var(--ext)" }}>{((r.hit_rate?.aggregated?.ext_hit_rate ?? 0) * 100).toFixed(1)}%</td>
                    <td>{r.metrics?.ttft_avg_ms > 0 ? `${r.metrics.ttft_avg_ms.toFixed(0)}ms` : "—"}</td>
                    <td>{r.metrics?.output_token_throughput > 0 ? r.metrics.output_token_throughput.toFixed(0) : "—"}</td>
                    <td>{r.metrics?.benchmark_duration_s > 0 ? `${r.metrics.benchmark_duration_s.toFixed(0)}s` : "—"}</td>
                    <td className="muted" style={{ fontSize: 11 }}>{r.warnings || "—"}</td>
                  </tr>
                ))}
                {!(detail?.rounds ?? []).length && <tr><td colSpan={8} className="muted">暂无阶段数据</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="card" style={{ padding: 12 }}>
            <div className="chart-head"><b style={{ fontSize: 12 }}>运行配置</b></div>
            <pre className="subnote" style={{ whiteSpace: "pre-wrap", fontFamily: "var(--mono)" }}>
              {detail ? JSON.stringify(detail.config, null, 2) : ""}
            </pre>
          </div>
        </div>
      </div>
    </>
  );
}
