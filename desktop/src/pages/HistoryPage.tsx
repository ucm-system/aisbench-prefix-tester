import { useEffect, useMemo, useRef, useState } from "react";
import { api, downloadLink, type RunSummary } from "../api";
import { navigate, useToast } from "../App";
import { ConfirmModal, EmptyState, Pagination, StatusBadge } from "../ui";

const KIND_CHIPS = [
  { key: "manual", label: "手动测试" },
  { key: "sla", label: "SLA 探针" },
  { key: "", label: "全部" },
];
const STATUS_FILTERS = [
  { key: "completed", label: "已完成" }, { key: "failed", label: "失败" },
  { key: "cancelled", label: "已停止" }, { key: "interrupted", label: "已中断" },
  { key: "running", label: "运行中" },
];
const PAGE_SIZE = 50;

export default function HistoryPage() {
  const toast = useToast();
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("manual"); // 默认隐藏 SLA 探针 run
  const [statusSel, setStatusSel] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<any>(null);
  const [open, setOpen] = useState(false);
  const [offline, setOffline] = useState(false);
  const [page, setPage] = useState(1);
  const [delModal, setDelModal] = useState<{ ids: string[] } | null>(null);
  const [delBusy, setDelBusy] = useState(false);
  const [practiceBusy, setPracticeBusy] = useState(false);

  const reqId = useRef(0);
  const load = async () => {
    const id = ++reqId.current;
    try {
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      if (kind) params.set("kind", kind);
      const rs = await api.get<RunSummary[]>(`/api/runs?${params.toString()}`);
      if (id !== reqId.current) return;
      setRuns(rs);
      setOffline(false);
      setSel((s) => {
        const alive = new Set(rs.map((r) => r.run_id));
        const next = new Set([...s].filter((x) => alive.has(x)));
        return next.size === s.size ? s : next;
      });
    } catch { setOffline(true); }
  };
  useEffect(() => { load(); const t = setInterval(load, 4000); return () => clearInterval(t); }, [q, kind]);

  /* 抽屉 ESC 关闭（D3） */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const filtered = useMemo(() => {
    if (!statusSel.size) return runs;
    return runs.filter((r) => statusSel.has(r.status));
  }, [runs, statusSel]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRuns = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  useEffect(() => { if (page > pages) setPage(1); }, [pages, page]);

  const openDetail = async (runId: string) => {
    try {
      const d = await api.get<any>(`/api/runs/${runId}`);
      setDetail(d);
      setOpen(true);
    } catch (e: any) { toast({ msg: `无法打开详情：${e.message}`, kind: "error" }); }
  };

  const toggleSel = (id: string) =>
    setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allSel = pageRuns.length > 0 && pageRuns.every((r) => sel.has(r.run_id));

  /* 软删除 + 撤销（D1/§5：toast 内 5-7s 撤销窗口） */
  const doDelete = async (ids: string[]) => {
    setDelBusy(true);
    try {
      const r = await api.trashRuns(ids);
      setSel(new Set());
      setDelModal(null);
      load();
      toast({
        msg: `已删除 ${r.deleted.length} 条记录`,
        kind: "info",
        action: {
          label: "撤销",
          onClick: async () => {
            try {
              await api.restoreRuns(r.deleted);
              load();
              toast({ msg: `已恢复 ${r.deleted.length} 条记录`, kind: "success" });
            } catch (e: any) { toast({ msg: `恢复失败：${e.message}`, kind: "error" }); }
          },
        },
        duration: 7000,
      });
    } catch (e: any) {
      toast({ msg: `删除失败：${e.message}`, kind: "error" });
    } finally { setDelBusy(false); }
  };

  const compareSel = () => {
    if (sel.size < 2) { toast("对比至少选择 2 条记录"); return; }
    sessionStorage.setItem("pt-compare-sel", JSON.stringify([...sel]));
    navigate("/compare");
  };

  const fmtTime = (t: number) => new Date(t * 1000).toLocaleString("zh-CN", { hour12: false });

  return (
    <>
      <div className="toolbar">
        <div className="seg">
          {KIND_CHIPS.map((c) => (
            <span key={c.key} className={kind === c.key ? "on" : ""}
              onClick={() => { setKind(c.key); setSel(new Set()); setPage(1); }}>{c.label}</span>
          ))}
        </div>
        <div className="seg status-filter" aria-label="状态筛选">
          {STATUS_FILTERS.map((s) => (
            <span key={s.key} className={statusSel.has(s.key) ? "on" : ""}
              onClick={() => {
                setStatusSel((p) => {
                  const n = new Set(p);
                  n.has(s.key) ? n.delete(s.key) : n.add(s.key);
                  return n;
                });
                setPage(1);
              }}>{s.label}</span>
          ))}
        </div>
        <input className="inp" placeholder="搜索 run_id / 名称 / 备注…" style={{ maxWidth: 220 }}
          value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        <span className="muted" style={{ marginLeft: "auto" }}>
          共 {filtered.length} 条{statusSel.size ? "（已按状态筛选）" : ""}
        </span>
        <button className="btn sm" disabled={sel.size < 2} onClick={compareSel}>
          ⇄ 对比所选{sel.size >= 2 ? `（${sel.size}）` : ""}
        </button>
        <button className="btn sm danger" disabled={!sel.size} onClick={() => setDelModal({ ids: [...sel] })}>
          删除所选{sel.size ? `（${sel.size}）` : ""}
        </button>
      </div>

      <div className="card" style={{ padding: "6px 4px" }}>
        {pageRuns.length === 0 ? (
          offline ? (
            <EmptyState icon="⚠" title="无法连接 Sidecar" hint="请检查应用与 Sidecar 状态，稍后自动重试。" />
          ) : (
            <EmptyState title="暂无运行记录"
              hint="从「新建测试」发起一次压测，记录将自动出现在这里。"
              action={<button className="btn primary sm" onClick={() => navigate("/config")}>去新建测试</button>} />
          )
        ) : (
          <table>
            <thead><tr>
              <th style={{ width: 30 }}>
                <input type="checkbox" checked={allSel} aria-label="全选本页"
                  onChange={(e) => {
                    setSel((s) => {
                      const n = new Set(s);
                      pageRuns.forEach((r) => e.target.checked ? n.add(r.run_id) : n.delete(r.run_id));
                      return n;
                    });
                  }} />
              </th>
              <th>名称 / run_id</th><th>状态</th><th>时间</th>
              <th>显存命中</th><th>Ext</th><th>TTFT avg</th><th>吞吐</th><th>轮次</th>
              <th style={{ width: 230 }}></th>
            </tr></thead>
            <tbody>
              {pageRuns.map((r) => {
                const isRun = r.status === "running" || r.status === "pending";
                return (
                  <tr key={r.run_id} className={isRun ? "tr-running" : ""}
                    style={{ cursor: "pointer" }} onClick={() => openDetail(r.run_id)}>
                    <td onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={sel.has(r.run_id)} aria-label={`选择 ${r.name}`}
                        onChange={() => toggleSel(r.run_id)} />
                    </td>
                    <td><b>{r.name}</b>
                      {kind === "" && r.kind === "sla" ? <span className="tag blue" style={{ padding: "1px 7px", marginLeft: 6 }}>SLA</span> : null}
                      {r.is_practice ? <span className="tag warn" style={{ padding: "1px 7px", marginLeft: 6 }}>练习轮</span> : null}
                      <br /><span className="muted mono" style={{ fontSize: 11 }}>{r.run_id}</span></td>
                    <td><StatusBadge status={r.status} /></td>
                    <td>{fmtTime(r.created_at)}</td>
                    <td><b>{r.summary ? `${(r.summary.hbm_hit_rate * 100).toFixed(1)}%` : "—"}</b></td>
                    <td><b style={{ color: "var(--ext)" }}>{r.summary ? `${(r.summary.ext_hit_rate * 100).toFixed(1)}%` : "—"}</b></td>
                    <td>{r.summary && r.summary.ttft_avg_ms > 0 ? `${r.summary.ttft_avg_ms.toFixed(0)}ms` : "—"}</td>
                    <td>{r.summary && r.summary.output_token_throughput > 0 ? `${r.summary.output_token_throughput.toFixed(0)} tok/s` : "—"}</td>
                    <td>{r.summary?.rounds_done ?? 0} 阶段</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <div className="row-actions">
                        <button className={`btn sm ${isRun ? "primary" : ""}`}
                          onClick={() => navigate(`/monitor/${r.run_id}`)}>{isRun ? "● 监控" : "监控"}</button>
                        <button className="btn sm" onClick={() => openDetail(r.run_id)}>详情</button>
                        <a className="btn sm ghost" href={downloadLink(`/api/runs/${r.run_id}/export?format=xlsx`)}>xlsx</a>
                        <button className="btn sm danger" onClick={() => setDelModal({ ids: [r.run_id] })}>删除</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <Pagination page={page} pages={pages} onPage={setPage} />
      </div>

      {/* 右侧 480px 抽屉 + 遮罩（D3：不覆盖顶栏，ESC/点遮罩关闭） */}
      <div className={`drawer-mask ${open ? "show" : ""}`} onClick={() => setOpen(false)} />
      <div id="drawer" className={open ? "open" : ""} role="dialog" aria-label="运行详情">
        <div className="drawer-head">
          <div style={{ minWidth: 0 }}>
            <b style={{ fontSize: 14 }}>{detail?.name}</b>
            <div className="muted mono" style={{ fontSize: 11, marginTop: 2 }}>
              {detail?.run_id} · <StatusBadge status={detail?.status ?? ""} /> · {detail?.rounds?.length ?? 0} 阶段
            </div>
          </div>
          <div style={{ marginLeft: "auto", display: "flex", gap: 7, flexWrap: "wrap" }}>
            <button className="btn sm ghost" onClick={() => setOpen(false)}>✕</button>
            <a className="btn sm" href={detail ? downloadLink(`/api/runs/${detail.run_id}/export?format=xlsx`) : "#"}>xlsx</a>
            <a className="btn sm" href={detail ? downloadLink(`/api/runs/${detail.run_id}/export?format=html`) : "#"}>HTML 报告</a>
            <button className="btn sm" disabled={sel.size < 2} onClick={() => { setOpen(false); compareSel(); }}>
              ⇄ 对比所选{sel.size >= 2 ? `（${sel.size}）` : ""}
            </button>
            <button className="btn sm primary" disabled={practiceBusy} onClick={async () => {
              if (!detail.is_practice && !confirm("标记为练习轮后，对比分析默认会排除该记录。确认标记？")) return;
              setPracticeBusy(true);
              try {
                await api.patch(`/api/runs/${detail.run_id}`, { is_practice: !detail.is_practice });
                toast(detail.is_practice ? "已取消练习轮标记" : "已标记为练习轮（对比默认排除）");
                const d = await api.get<any>(`/api/runs/${detail.run_id}`);
                setDetail(d); load();
              } catch (e: any) { toast({ msg: `操作失败：${e.message}`, kind: "error" }); }
              finally { setPracticeBusy(false); }
            }}>{detail?.is_practice ? "取消练习标记" : "标记练习轮"}</button>
          </div>
        </div>
        <div className="drawer-body">
          {(detail?.rounds ?? []).some((r: any) => r.warnings) && (
            <div className="alert warn">
              <span>⚠</span>
              <div>本次运行存在警告（例如轮间前缀缓存清理失败，多轮结果可能被残留缓存污染）。逐轮警告见下方结果表「警告」列。</div>
            </div>
          )}
          <div className="card" style={{ padding: 12 }}>
            <div className="chart-head" style={{ marginBottom: 4 }}><b style={{ fontSize: 12 }}>轮 × 阶段结果</b></div>
            <table className="mini-table">
              <thead><tr><th>轮</th><th>阶段</th><th>输入/输出</th><th>并发</th><th>显存命中</th><th>Ext</th><th>TTFT avg</th><th>吞吐</th><th>时长</th><th>警告</th></tr></thead>
              <tbody>
                {(detail?.rounds ?? []).map((r: any, i: number) => (
                  <tr key={i}>
                    <td>R{r.round_index}</td>
                    <td><span className={`tag ${r.phase === "full" ? "blue" : "gray"}`} style={{ padding: "1px 7px" }}>{r.phase}</span></td>
                    <td className="mono" style={{ fontSize: 11 }}>{r.params?.input_len ?? "—"}/{r.params?.output_len ?? "—"}</td>
                    <td>{r.params?.concurrency ?? "—"}</td>
                    <td><b>{((r.hit_rate?.aggregated?.hbm_hit_rate ?? 0) * 100).toFixed(1)}%</b></td>
                    <td style={{ color: "var(--ext)" }}>{((r.hit_rate?.aggregated?.ext_hit_rate ?? 0) * 100).toFixed(1)}%</td>
                    <td>{r.metrics?.ttft_avg_ms > 0 ? `${r.metrics.ttft_avg_ms.toFixed(0)}ms` : "—"}</td>
                    <td>{r.metrics?.output_token_throughput > 0 ? r.metrics.output_token_throughput.toFixed(0) : "—"}</td>
                    <td>{r.metrics?.benchmark_duration_s > 0 ? `${r.metrics.benchmark_duration_s.toFixed(0)}s` : "—"}</td>
                    <td className="muted" style={{ fontSize: 11 }}>{r.warnings || "—"}</td>
                  </tr>
                ))}
                {!(detail?.rounds ?? []).length && <tr><td colSpan={10} className="muted">暂无阶段数据</td></tr>}
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

      {/* 删除确认弹层（D1：红色主按钮 + 数量） */}
      <ConfirmModal open={!!delModal} title="删除运行记录" danger
        message={`确认删除 ${delModal?.ids.length ?? 0} 条记录？\n删除后 7 秒内可在提示条中「撤销」，逾期数据将被清理。`}
        confirmText={`删除（${delModal?.ids.length ?? 0}）`}
        busy={delBusy}
        onCancel={() => setDelModal(null)}
        onConfirm={() => doDelete(delModal!.ids)} />
    </>
  );
}
