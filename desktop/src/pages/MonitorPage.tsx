import { useEffect, useMemo, useRef, useState } from "react";
import { api, downloadLink, track, useConnected, wsRun, type RoundRow } from "../api";
import { Donut, TimeSeriesChart } from "../charts";
import { useToast } from "../App";
import { ConfirmModal, InfoTip, StatusBadge, downloadTextFile, theoreticalHitRate, toCsv, useLocalState, fmtDur } from "../ui";

type Ev = { type: string; ts: number; [k: string]: any };
type Sample = { ts: number; engines: Record<string, Record<string, number>>; ucm?: boolean; active?: boolean };

const HBM = "var(--hbm)", EXT = "var(--ext)", UCMC = "var(--ucm)", MISS = "var(--miss)";
const Q_RUN = "var(--run-q)", Q_WAIT = "var(--wait-q)", Q_SWAP = "var(--swap-q)";
const T_GREEN = "var(--green)", T_PURPLE = "var(--chart-5)", T_ORANGE = "var(--warn)";

/* 统一 gauge/counter 口径（U5.4：实时与回放走同一 flatten） */
const GAUGE_KEYS = new Set(["running", "waiting", "swapped", "kv_usage"]);
function flatten(engines: Record<string, Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const counters of Object.values(engines ?? {})) {
    for (const [k, v] of Object.entries(counters)) {
      const n = Number(v) || 0;
      out[k] = GAUGE_KEYS.has(k) ? Math.max(out[k] ?? 0, n) : (out[k] ?? 0) + n;
    }
  }
  return out;
}

/* 进度行折叠正则（C5） */
const PROGRESS_RE = /Progress:|POST=|Calculating performance|\d{1,3}%\s*\||it\/s\]|^\s*$/;

export default function MonitorPage({ route }: { route: string }) {
  const toast = useToast();
  const runId = route.split("/")[1];
  const [events, setEvents] = useState<Ev[]>([]);
  const [logs, setLogs] = useState<{ line: string; err?: boolean; warn?: boolean }[]>([]);
  const [status, setStatus] = useState("connecting");
  const [phase, setPhase] = useState("");
  const [round, setRound] = useState(0);
  const [totalRounds, setTotalRounds] = useState(1);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [phaseRate, setPhaseRate] = useState<{ per_dp: any; per_pod?: any; agg: any; phase: string } | null>(null);
  const [ucm, setUcm] = useState<boolean | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const [filter, setFilter] = useState("all");
  const [logTab, setLogTab] = useState<"stdout" | "stderr">("stdout");
  const [search, setSearch] = useState("");
  const [collapseProg, setCollapseProg] = useLocalState("pt-collapse-prog", true);
  const [logH, setLogH] = useLocalState("pt-log-h", 360);
  const [roundFilter, setRoundFilter] = useState<number | "all">("all");
  const [now, setNow] = useState(Math.floor(Date.now() / 1000));
  const [stopOpen, setStopOpen] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const wsRef = useRef<WebSocket | null>(null);
  const resizeRef = useRef<{ startY: number; startH: number } | null>(null);

  useEffect(() => {
    if (status === "running") {
      const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
      return () => clearInterval(t);
    }
  }, [status]);

  /* run_finish 埋点（REDESIGN §9）：终态一次性上报 */
  const finishTracked = useRef("");
  useEffect(() => {
    if (!runId || !detail) return;
    if (["completed", "failed", "cancelled", "interrupted"].includes(status)
        && finishTracked.current !== runId) {
      finishTracked.current = runId;
      track("run_finish", {
        run_id: runId, status,
        duration_s: Math.round(((detail.finished_at ?? Date.now() / 1000) - detail.created_at) || 0),
      });
    }
  }, [status, runId, detail]);

  /* ---------------- data lifecycle（WS 拥有；回放与实时同一份 samples） ----------------
   * 连接门控：冷启动深链（file:// 或容器直开 #/monitor/<id>）时 initConnection
   * 可能尚未就绪——不门控会在竞态中把 run 误标 not_found 且永不重试 */
  const connected = useConnected();
  useEffect(() => {
    if (!runId || !connected) return;
    let alive = true;
    let closed = false;
    setEvents([]); setLogs([]); setSamples([]); setPhaseRate(null);
    setDetail(null); setUcm(null); setPhase(""); setRound(0); setRoundFilter("all");
    setStatus("connecting");
    const toLog = (line: string) => ({
      line, err: line.includes("ERROR") || line.startsWith("[exit"),
      warn: line.includes("WARN"),
    });

    const loadSamples = () =>
      api.get<{ samples: Sample[] }>(`/api/runs/${runId}/metrics`).then((r) => {
        if (!alive) return;
        setSamples((prev) => {
          const seen = new Set(prev.map((s) => s.ts));
          const add = (r.samples ?? []).filter((s) => !seen.has(s.ts));
          return add.length ? [...prev, ...add].sort((a, b) => a.ts - b.ts).slice(-6000) : prev;
        });
        const first = (r.samples ?? [])[0];
        if (first?.engines && Object.values(first.engines).some((c) => c._ucm_seen)) setUcm(true);
      }).catch(() => {});

    api.get<any>(`/api/runs/${runId}`).then((d) => {
      if (!alive) return;
      setDetail(d);
      setStatus(d.status);
      setTotalRounds((d.config?.rounds ?? [1]).length || 1);
      const rounds: RoundRow[] = d.rounds ?? [];
      const lastRow = rounds[rounds.length - 1];
      if (lastRow) setRound(lastRow.round_index);
      const lastFull = [...rounds].reverse().find((r) => r.phase === "full");
      if (lastFull) setPhaseRate({ per_dp: lastFull.hit_rate?.per_dp, agg: lastFull.hit_rate?.aggregated, phase: "full" });
      api.get<{ lines: string[] }>(`/api/runs/${runId}/logs?tail=500`).then((r) => {
        if (alive) setLogs((r.lines ?? []).map(toLog));
      }).catch(() => {});
      loadSamples();
      /* 回放阶段边界：读持久化事件日志（C2，与实时一致） */
      api.get<{ events: Ev[] }>(`/api/runs/${runId}/events`).then((r) => {
        if (alive && r.events?.length) setEvents(r.events);
      }).catch(() => {});
      if (d.status === "running" || d.status === "pending") {
        const connectWs = () => {
          if (!alive || closed) return;
          const ws = wsRun(runId);
          wsRef.current = ws;
          ws.onopen = () => {
            if (!alive) return;
            setStatus((s) => (s === "reconnecting" ? "running" : s));
            loadSamples(); // 断线恢复后补拉缺失时序（C6）
            api.get<{ events: Ev[] }>(`/api/runs/${runId}/events`).then((r) => {
              if (alive && r.events?.length) setEvents(r.events);
            }).catch(() => {});
          };
          ws.onmessage = (m) => {
            if (!alive) return;
            const ev: Ev = JSON.parse(m.data);
            if (ev.type !== "log" && ev.type !== "metrics") setEvents((prev) => [...prev.slice(-4000), ev]);
            if (ev.type === "status") {
              setStatus(ev.status); setPhase(ev.phase ?? ""); setRound(ev.round ?? 0);
              setTotalRounds(ev.total_rounds ?? 1);
            } else if (ev.type === "log") {
              setLogs((prev) => [...prev.slice(-3000), toLog(ev.line as string)]);
            } else if (ev.type === "metrics") {
              setSamples((prev) => [...prev.slice(-6000),
                { ts: ev.ts, engines: ev.sample?.engines ?? {},
                  ucm: ev.sample?.ucm_detected, active: ev.sample?.active }]);
              if (ev.sample?.ucm_detected != null) setUcm(ev.sample.ucm_detected);
            } else if (ev.type === "phase_rate") {
              setPhaseRate({ per_dp: ev.rate?.per_dp, agg: ev.rate?.aggregated, phase: ev.phase });
            } else if (ev.type === "warning") {
              toast({ msg: ev.message, kind: "error", duration: 8000 });
            }
          };
          ws.onclose = () => {
            if (!alive || closed) return;
            setStatus((s) => (s === "running" || s === "pending" ? "reconnecting" : s));
            window.setTimeout(async () => {
              if (!alive || closed) return;
              try {
                const d2 = await api.get<any>(`/api/runs/${runId}`);
                if (!alive) return;
                if (d2.status !== "running" && d2.status !== "pending") {
                  setStatus(d2.status);
                  loadSamples();
                  return;
                }
                connectWs();
              } catch {
                window.setTimeout(connectWs, 3000);
              }
            }, 3000);
          };
        };
        connectWs();
      }
    }).catch(() => { if (alive) setStatus("not_found"); });
    return () => {
      alive = false;
      closed = true;
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [runId, connected]);

  /* stderr tab：轮询 stderr.log（C5） */
  const [stderrLines, setStderrLines] = useState<string[]>([]);
  useEffect(() => {
    if (logTab !== "stderr" || !runId) return;
    let stop = false;
    const fetchIt = () => api.get<{ lines: string[] }>(`/api/runs/${runId}/logs?stream=stderr&tail=400`)
      .then((r) => { if (!stop) setStderrLines(r.lines ?? []); }).catch(() => {});
    fetchIt();
    const t = setInterval(fetchIt, 3000);
    return () => { stop = true; clearInterval(t); };
  }, [logTab, runId, status]);

  useEffect(() => {
    if (followRef.current && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs, stderrLines, logTab]);

  /* 日志高度拖拽（U5.6） */
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!resizeRef.current) return;
      const dh = resizeRef.current.startY - e.clientY;
      setLogH(Math.max(240, Math.min(600, resizeRef.current.startH + dh)));
    };
    const onUp = () => { resizeRef.current = null; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [setLogH]);

  /* ---------------- 统一派生（flatten + 滑动窗差分，实时=回放） ---------------- */
  const flats = useMemo(() => samples.map((s) => ({ ts: s.ts, f: flatten(s.engines) })), [samples]);

  const roundsBounds = useMemo(() => {
    const marks = events.filter((e) => e.type === "status" && e.phase && e.round);
    const byRound = new Map<number, { warmup?: number; full?: number }>();
    marks.forEach((m) => {
      const slot = byRound.get(m.round) ?? {};
      if (m.phase === "warmup" && slot.warmup == null) slot.warmup = m.ts;
      if (m.phase === "full" && slot.full == null) slot.full = m.ts;
      byRound.set(m.round, slot);
    });
    return [...byRound.entries()].sort((a, b) => a[0] - b[0]).map(([r, m]) => ({
      round: r, start: m.warmup ?? m.full ?? 0,
    }));
  }, [events]);

  const scope = useMemo(() => {
    if (roundFilter === "all") return null;
    const idx = roundsBounds.findIndex((r) => r.round === roundFilter);
    if (idx < 0) return null;
    const from = roundsBounds[idx].start;
    const to = idx + 1 < roundsBounds.length ? roundsBounds[idx + 1].start : Infinity;
    return { from, to };
  }, [roundFilter, roundsBounds]);

  const scopedFlats = useMemo(() =>
    scope ? flats.filter((s) => s.ts >= scope.from - 1 && s.ts <= scope.to) : flats, [flats, scope]);

  const trend = useMemo(() => {
    const out = {
      hbm: [] as number[], ext: [] as number[], comp: [] as number[],
      run: [] as number[], wait: [] as number[], swap: [] as number[], kv: [] as number[],
      genRate: [] as number[], promptRate: [] as number[],
      ttftT: [] as number[], tpotT: [] as number[],
      ucmLoadBw: [] as number[], ucmDumpBw: [] as number[], posixRate: [] as number[],
      ts: [] as number[],
    };
    let prev: Record<string, number> | null = null;
    let prevTs: number | null = null;
    for (const { ts, f } of scopedFlats) {
      const dt = prev && prevTs != null ? Math.max(0.001, ts - prevTs) : 1;
      const dq = prev ? (f.hbm_q ?? 0) - (prev.hbm_q ?? 0) : 0;
      const deq = prev ? (f.ext_q ?? 0) - (prev.ext_q ?? 0) : 0;
      const hr = dq > 0 && prev ? ((f.hbm_h ?? 0) - (prev.hbm_h ?? 0)) / dq : null;
      const er = deq > 0 && prev ? ((f.ext_h ?? 0) - (prev.ext_h ?? 0)) / deq : null;
      out.ts.push(ts);
      out.hbm.push(hr == null ? NaN : hr * 100);
      out.ext.push(er == null ? NaN : er * 100);
      out.comp.push(hr != null && er != null ? (er * (1 - hr) + hr) * 100 : NaN);
      out.run.push(f.running ?? 0);
      out.wait.push(f.waiting ?? 0);
      out.swap.push(f.swapped ?? 0);
      out.kv.push((f.kv_usage ?? 0) * 100);
      out.genRate.push(prev ? Math.max(0, ((f.gen_tok ?? 0) - (prev.gen_tok ?? 0)) / dt) : 0);
      out.promptRate.push(prev ? Math.max(0, ((f.prompt_tok ?? 0) - (prev.prompt_tok ?? 0)) / dt) : 0);
      const dc = prev ? (f.ttft_cnt ?? 0) - (prev.ttft_cnt ?? 0) : 0;
      out.ttftT.push(dc > 0 && prev ? (((f.ttft_sum ?? 0) - (prev.ttft_sum ?? 0)) / dc) * 1000 : NaN);
      const di = prev ? (f.itl_cnt ?? 0) - (prev.itl_cnt ?? 0) : 0;
      out.tpotT.push(di > 0 && prev ? (((f.itl_sum ?? 0) - (prev.itl_sum ?? 0)) / di) * 1000 : NaN);
      out.ucmLoadBw.push(prev ? Math.max(0, ((f.ucm_cache_load ?? 0) - (prev.ucm_cache_load ?? 0)) / dt / 1e9) : 0);
      out.ucmDumpBw.push(prev ? Math.max(0, ((f.ucm_cache_dump ?? 0) - (prev.ucm_cache_dump ?? 0)) / dt / 1e9) : 0);
      const dpq = prev ? (f.posix_q_blk ?? 0) - (prev.posix_q_blk ?? 0) : 0;
      const dph = prev ? (f.posix_hit_blk ?? 0) - (prev.posix_hit_blk ?? 0) : 0;
      out.posixRate.push(dpq > 0 ? (dph / dpq) * 100 : NaN);
      prev = f; prevTs = ts;
    }
    return out;
  }, [scopedFlats]);

  const latest = flats[flats.length - 1]?.f ?? {};
  const agg = phaseRate?.agg ?? {};

  /* 诚实降级（R2.3b 复审建议②）：有流量但所有采样时刻 gauge 均为 0 ——
   * 请求脉冲短于采样间隔，曲线不代表峰值，明示而非画平 0 误导 */
  const trafficMoved = flats.length > 1 && (() => {
    const a = flats[0].f, b = flats[flats.length - 1].f;
    return (b.prompt_tok ?? 0) > (a.prompt_tok ?? 0)
      || (b.gen_tok ?? 0) > (a.gen_tok ?? 0)
      || (b.success ?? 0) > (a.success ?? 0)
      || (b.hbm_q ?? 0) > (a.hbm_q ?? 0);
  })();
  const maxQueue = Math.max(0, ...trend.run, ...trend.wait, ...trend.swap);
  const gaugeMissed = trafficMoved && maxQueue === 0;
  const hasAgg = phaseRate != null && (agg.hbm_queries > 0 || agg.ext_queries > 0 || agg.hbm_hits > 0);
  const ttft = latest.ttft_cnt
    ? (latest.ttft_sum / latest.ttft_cnt) * 1000
    : (detail ? (detail.rounds ?? []).filter((r: any) => r.phase === "full").at(-1)?.metrics?.ttft_avg_ms : 0) ?? 0;
  const genThr = flats.length > 1
    ? (() => {
      const a = flats[flats.length - 2], b = flats[flats.length - 1];
      const dt = b.ts - a.ts;
      return dt > 0 ? Math.max(0, ((b.f.gen_tok ?? 0) - (a.f.gen_tok ?? 0)) / dt) : 0;
    })() : 0;

  /* 理论命中率（C4 参照基准；R2.1：repeat_rate 归一为小数，不再二次 ×100） */
  const cfgEff = detail?.config?.rounds?.[0] ?? detail?.config ?? {};
  const theoretical = theoreticalHitRate(cfgEff.repeat_rate, +(cfgEff.input_len ?? 2048));
  const hbmPct = (agg.hbm_hit_rate ?? 0) * 100;
  const extPct = (agg.ext_hit_rate ?? 0) * 100;
  const compPct = (extPct / 100 * (1 - hbmPct / 100) + hbmPct / 100) * 100;

  /* 阶段边界事件（C2）+ reset 打点 */
  const boundaryEvents = useMemo(() => {
    if (scope) {
      return events.filter((e) => e.ts >= scope.from && e.ts <= scope.to).flatMap((e) => {
        if (e.type === "status" && e.phase && e.round) {
          return [{ x: e.ts, label: `R${e.round}·${e.phase === "warmup" ? "预埋" : "全量"}` }];
        }
        if (e.type === "cache_reset") return [{ x: e.ts, label: "⟳", color: "var(--warn)" }];
        return [];
      });
    }
    const seen = new Set<string>();
    return events.flatMap((e) => {
      if (e.type === "status" && e.phase && e.round) {
        const k = `${e.round}-${e.phase}`;
        if (seen.has(k)) return [];
        seen.add(k);
        return [{ x: e.ts, label: `R${e.round}·${e.phase === "warmup" ? "预埋" : "全量"}` }];
      }
      if (e.type === "cache_reset") return [{ x: e.ts, label: "⟳", color: "var(--warn)" }];
      return [];
    });
  }, [events, scope]);

  const roundBands = useMemo(() => {
    if (!roundsBounds.length) return [];
    return roundsBounds.map((r, i) => ({
      from: r.start, to: i + 1 < roundsBounds.length ? roundsBounds[i + 1].start : Infinity,
      label: `R${r.round}`,
    })).filter((b) => Number.isFinite(b.from));
  }, [roundsBounds]);

  /* Breakdown（U5.5：中心 = 综合命中率；R1.4：UCM 口径防御——mock/异常服务的
   * hit>query 会让 (h+u)/q 超过 100%，clamp 并打「指标不自洽」标注） */
  const qTok = latest.ucm_q_tok ?? 0;
  const hTok = latest.ucm_hbm_tok ?? 0;
  const uTok = latest.ucm_hit_tok ?? 0;
  const ucmTokens = ucm === true && qTok > 0;
  const ucmConsistent = qTok > 0 && hTok >= 0 && uTok >= 0
    && hTok + uTok <= qTok * 1.001 && hTok <= qTok && uTok <= qTok;
  const donutReady = ucmTokens ? true : hasAgg;
  const donutCenter = ucmTokens
    ? `${Math.min(100, (hTok + uTok) / qTok * 100).toFixed(1)}%`
    : hasAgg ? `${compPct.toFixed(1)}%` : "—";
  const donutItems = ucmTokens
    ? [
        { v: +(Math.max(0, hTok / qTok * 100)).toFixed(1), c: HBM },
        { v: +(Math.max(0, uTok / qTok * 100)).toFixed(1), c: UCMC },
        { v: +(Math.max(0, (qTok - hTok - uTok) / qTok * 100)).toFixed(1), c: MISS },
      ]
    : [
        { v: +hbmPct.toFixed(1), c: HBM },
        { v: +extPct.toFixed(1), c: EXT },
        { v: +Math.max(0, 100 - hbmPct - extPct).toFixed(1), c: MISS },
      ];

  /* 日志视图（C5：过滤 + 搜索 + 折叠进度行） */
  const shownLogs = useMemo(() => {
    let arr = logTab === "stderr"
      ? stderrLines.map((l) => ({ line: l, err: /ERROR|PYI-/.test(l), warn: l.includes("WARN") }))
      : logs;
    if (filter === "warn") arr = arr.filter((l) => l.warn || l.err);
    if (filter === "err") arr = arr.filter((l) => l.err);
    if (search.trim()) {
      const re = new RegExp(search.trim(), "i");
      arr = arr.filter((l) => re.test(l.line));
    }
    if (collapseProg && logTab === "stdout") {
      arr = arr.filter((l) => !PROGRESS_RE.test(l.line));
    }
    return arr;
  }, [logs, stderrLines, logTab, filter, search, collapseProg]);
  const collapsedCount = useMemo(
    () => (collapseProg && logTab === "stdout" ? logs.filter((l) => PROGRESS_RE.test(l.line)).length : 0),
    [logs, collapseProg, logTab]);

  /* 指标端点不可达灰态（§8） */
  const noData = flats.length === 0;
  const running = status === "running" || status === "pending";
  const endpointOffline = noData && running && detail &&
    (now - (detail.created_at ?? now)) > 20;

  const duration = detail ? ((detail.finished_at ?? now) - detail.created_at) : 0;
  const interruptedNote = status === "interrupted"
    ? detail?.finished_at ? `中断于 ${new Date(detail.finished_at * 1000).toLocaleTimeString("zh-CN", { hour12: false })}（应用重启对账标记）` : "应用中途中断"
    : "";

  const exportCsv = (name: string, headers: string[], rows: (string | number)[][]) => {
    downloadTextFile(`${runId}_${name}.csv`, toCsv(headers, rows));
    track("chart_export", { run_id: runId, chart: name });
  };

  const csvOf = (name: string, series: { key: string; label: string }[]) => {
    const headers = ["time", ...series.map((s) => s.label)];
    const rows = scopedFlats.map((s) => [
      new Date(s.ts * 1000).toLocaleTimeString("zh-CN", { hour12: false }),
      ...series.map((x) => {
        const v = (trend as any)[x.key]?.[scopedFlats.indexOf(s)] ?? (s.f as any)[x.key];
        return Number.isFinite(v) ? Math.round(v * 100) / 100 : "";
      }),
    ]);
    exportCsv(name, headers, rows);
    toast({ msg: `已导出 ${name} 时序 CSV`, kind: "success" });
  };

  const card = (t: React.ReactNode, v: React.ReactNode, s: React.ReactNode, barColor?: string, pct?: number) => (
    <div className="mcard">
      <div className="t">{t}</div>
      <div className="v">{v}</div>
      <div className="s">{s}</div>
      {barColor && <div className="bar" style={{ background: barColor, width: `${Math.min(100, pct ?? 0)}%` }} />}
    </div>);

  const roundChips = [{ r: "all" as const, label: "全部轮次" }, ...roundsBounds.map((b) => ({ r: b.round, label: `R${b.round}` }))];

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
          {status === "reconnecting" && (
            <div className="banner warn" style={{ marginBottom: 12 }}>
              ⚠ 实时连接中断，正在重连…（恢复后将自动补拉缺失时序）
            </div>
          )}
          {status === "interrupted" && (
            <div className="banner warn" style={{ marginBottom: 12 }}>
              ◼ 该运行被中断：{interruptedNote}。已采集数据完整保留于下方图表与导出中。
            </div>
          )}

          {/* run 头部（C8：名称/状态/耗时/参数 chips/导出） */}
          <div className="run-head">
            <StatusBadge status={status} />
            <h2>{detail?.name ?? runId}</h2>
            <span className="muted mono" style={{ fontSize: 12 }}>{runId}</span>
            {totalRounds > 0 && <span className="tag gray">第 {round || 1} / {totalRounds} 轮</span>}
            <span className="tag gray">{fmtDur(duration)}</span>
            <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              {status === "running" && (
                <button className="btn sm danger" onClick={() => setStopOpen(true)}>■ 停止测试</button>
              )}
              <a className="btn sm ghost" href={downloadLink(`/api/runs/${runId}/export?format=xlsx`)}>⇓ xlsx</a>
              <a className="btn sm ghost" href={downloadLink(`/api/runs/${runId}/export?format=html`)} target="_blank" rel="noreferrer">⇱ HTML 报告</a>
            </div>
          </div>
          <div className="run-sub">
            <div className="param-chips">
              {cfgEff.model_name && <span className="tag blue">{cfgEff.model_name}</span>}
              <span className="tag">输入 {Number(cfgEff.input_len ?? 0).toLocaleString()}</span>
              <span className="tag">输出 {Number(cfgEff.output_len ?? 0).toLocaleString()}</span>
              <span className="tag">并发 {cfgEff.concurrency ?? "—"}</span>
              <span className="tag">重复率 {String(cfgEff.repeat_rate ?? "—")}</span>
              <span className="tag">dp {cfgEff.dp ?? 1}</span>
              <span className="tag">数据 {cfgEff.data_num ?? "—"} 条</span>
            </div>
            {/* 轮次聚焦（C3） */}
            {roundsBounds.length > 1 && (
              <div className="seg" role="tablist" aria-label="轮次筛选">
                {roundChips.map((c) => (
                  <span key={String(c.r)} className={roundFilter === c.r ? "on" : ""}
                    onClick={() => setRoundFilter(c.r)}>{c.label}</span>
                ))}
              </div>
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

          {/* KPI 行（§6.2：6 等宽卡；副行给理论值参照 C4；无数据不显假 0） */}
          <div className="kpi-grid">
            {card(<span>显存命中（HBM）<InfoTip text="口径：Δhits/Δqueries（阶段快照差分，与原 CLI 工具一致）。指标源 vllm:prefix_cache_hits_total / queries_total。" /></span>,
              hasAgg ? `${hbmPct.toFixed(1)}%` : "—",
              hasAgg ? `理论 ≈${(theoretical * 100).toFixed(1)}% · 偏差 ${(hbmPct - theoretical * 100).toFixed(1)}pt` : "等待阶段完成",
              HBM, hbmPct)}
            {card(<span>外部缓存命中（Ext）<InfoTip text="口径：Δhits/Δqueries（阶段快照差分）。指标源 vllm:external_prefix_cache_hits_total / queries_total（UCM 场景）。" /></span>,
              hasAgg ? `${extPct.toFixed(1)}%` : "—",
              hasAgg ? "external prefix cache" : "等待阶段完成", EXT, extPct)}
            {card(<span>综合命中率<InfoTip text="口径：ext×(1−hbm)+hbm —— 外部缓存承接 HBM 未命中的部分。" /></span>,
              hasAgg ? `${compPct.toFixed(1)}%` : "—",
              hasAgg ? "ext×(1−hbm)+hbm" : "等待阶段完成", UCMC, compPct)}
            {card("KV Cache 利用率",
              latest.kv_usage != null ? `${(latest.kv_usage * 100).toFixed(0)}%` : "—",
              "GPU KV 占用（gauge）", T_ORANGE, (latest.kv_usage ?? 0) * 100)}
            {card(<span>avg TTFT<InfoTip text="口径：滑动窗 Δsum/Δcount（vllm:time_to_first_token_seconds）。" /></span>,
              ttft > 0 ? `${ttft.toFixed(0)}ms` : "—", "首 token 平均延迟")}
            {card("输出吞吐",
              genThr > 0 ? genThr.toFixed(0) : "—",
              "tok/s（滑动窗）", T_GREEN, Math.min(100, genThr / 10))}
          </div>

          {/* 图表区：12 列栅格（U5.1 等宽等高 280px；阶段边界 + 轮次分隔带） */}
          <div className="grid12">
            <div className="card chart-card g6">
              <div className="chart-head"><b>队列深度 & KV 利用率</b>
                <span className="head-note">{samples.some((s) => s.active) ? "阶段期 0.3s 自适应采样" : "空闲期按设置间隔"}</span>
                <div className="legend">
                  <span className="l-solid"><i style={{ background: Q_RUN }} />running</span>
                  <span className="l-dash"><i style={{ background: Q_WAIT }} />waiting</span>
                  <span className="l-dot"><i style={{ background: Q_SWAP }} />swapped</span>
                  <span className="l-dash"><i style={{ background: T_ORANGE }} />KV%</span>
                </div>
                <button className="btn sm ghost" onClick={() => csvOf("queue_kv",
                  [{ key: "run", label: "running" }, { key: "wait", label: "waiting" },
                   { key: "swap", label: "swapped" }, { key: "kv", label: "kv_usage%" }])}>⇓ CSV</button>
              </div>
              {gaugeMissed && (
                <div className="alert warn" style={{ marginBottom: 8 }}>
                  <span>⚠</span>
                  <div>本 run 有请求流量，但所有采样时刻队列深度均为 0 —— 请求脉冲可能短于采样间隔，曲线不代表峰值。如需捕获峰值，请在「新建测试 → 并发与调度」调低采集间隔。</div>
                </div>
              )}
              {endpointOffline ? (
                <div className="chart-empty offline">指标端点不可达 — 请检查采集端点（/metrics）</div>
              ) : (
                <TimeSeriesChart height={280} yMax={undefined}
                  rightFmt={(v) => (Math.abs(v) >= 10 || Number.isInteger(v)
                    ? `${Math.round(v)}%` : `${Math.round(v * 10) / 10}%`)}
                  events={boundaryEvents} bands={roundBands} emptyHint="等待指标采样…"
                  ariaLabel="队列深度与KV利用率时序图"
                  series={[
                    { name: "running", color: Q_RUN, points: trend.run.map((y, i) => ({ x: trend.ts[i], y })) },
                    { name: "waiting", color: Q_WAIT, points: trend.wait.map((y, i) => ({ x: trend.ts[i], y })), dash: true },
                    { name: "swapped", color: Q_SWAP, points: trend.swap.map((y, i) => ({ x: trend.ts[i], y })), dots: true },
                    { name: "KV%", color: T_ORANGE, axis: "right", dash: true, points: trend.kv.map((y, i) => ({ x: trend.ts[i], y })) },
                  ]} />
              )}
            </div>

            <div className="card chart-card g6">
              <div className="chart-head"><b>吞吐（tok/s）</b>
                <div className="legend">
                  <span className="l-solid"><i style={{ background: T_GREEN }} />输出</span>
                  <span className="l-dash"><i style={{ background: T_PURPLE }} />输入</span>
                </div>
                <button className="btn sm ghost" onClick={() => csvOf("throughput",
                  [{ key: "genRate", label: "output_tok_s" }, { key: "promptRate", label: "input_tok_s" }])}>⇓ CSV</button>
              </div>
              {endpointOffline ? (
                <div className="chart-empty offline">指标端点不可达</div>
              ) : (
                <TimeSeriesChart height={280} emptyHint="等待指标采样…"
                  events={boundaryEvents} bands={roundBands} ariaLabel="吞吐时序图"
                  series={[
                    { name: "输出", color: T_GREEN, area: true, points: trend.genRate.map((y, i) => ({ x: trend.ts[i], y })) },
                    { name: "输入", color: T_PURPLE, points: trend.promptRate.map((y, i) => ({ x: trend.ts[i], y })), dash: true },
                  ]} />
              )}
            </div>

            <div className="card chart-card g6">
              <div className="chart-head"><b>延迟趋势（ms，滑动窗均值）</b>
                <div className="legend">
                  <span className="l-solid"><i style={{ background: T_ORANGE }} />TTFT avg</span>
                  <span className="l-dash"><i style={{ background: T_PURPLE }} />TPOT avg</span>
                </div>
                <button className="btn sm ghost" onClick={() => csvOf("latency",
                  [{ key: "ttftT", label: "ttft_avg_ms" }, { key: "tpotT", label: "tpot_avg_ms" }])}>⇓ CSV</button>
              </div>
              {endpointOffline ? (
                <div className="chart-empty offline">指标端点不可达</div>
              ) : (
                <TimeSeriesChart height={280} emptyHint="等待指标采样…"
                  events={boundaryEvents} bands={roundBands} ariaLabel="延迟趋势图"
                  series={[
                    { name: "TTFT avg", color: T_ORANGE, points: trend.ttftT.map((y, i) => ({ x: trend.ts[i], y })) },
                    { name: "TPOT avg", color: T_PURPLE, dash: true, points: trend.tpotT.map((y, i) => ({ x: trend.ts[i], y })) },
                  ]} />
              )}
            </div>

            <div className="card chart-card g6">
              <div className="chart-head"><b>命中率趋势（滑动窗差分）</b>
                <div className="legend">
                  <span className="l-solid"><i style={{ background: HBM }} />HBM</span>
                  <span className="l-dash"><i style={{ background: EXT }} />Ext</span>
                  <span className="l-dot"><i style={{ background: "var(--chart-2)" }} />posix 块命中</span>
                  <span className="l-dash"><i style={{ background: UCMC }} />综合</span>
                </div>
                <button className="btn sm ghost" onClick={() => csvOf("hit_rate",
                  [{ key: "hbm", label: "hbm%" }, { key: "ext", label: "ext%" },
                   { key: "posixRate", label: "posix_block%" }, { key: "comp", label: "composite%" }])}>⇓ CSV</button>
              </div>
              {endpointOffline ? (
                <div className="chart-empty offline">指标端点不可达</div>
              ) : (
                <TimeSeriesChart height={280} yMax={100} yMin={0} yFmt={(v) => `${Math.round(v)}%`}
                  emptyHint="等待指标采样…" events={boundaryEvents} bands={roundBands} ariaLabel="命中率趋势图"
                  series={[
                    { name: "HBM", color: HBM, points: trend.hbm.map((y, i) => ({ x: trend.ts[i], y })) },
                    { name: "Ext", color: EXT, points: trend.ext.map((y, i) => ({ x: trend.ts[i], y })), dash: true },
                    { name: "posix", color: "var(--chart-2)", dots: true, points: trend.posixRate.map((y, i) => ({ x: trend.ts[i], y })) },
                    { name: "综合", color: UCMC, dash: true, points: trend.comp.map((y, i) => ({ x: trend.ts[i], y })) },
                  ]} />
              )}
            </div>

            {/* Breakdown（§6.2：4 列；中心=综合命中率 U5.5；非 UCM 收起带宽图与横幅） */}
            <div className="card chart-card g4">
              <div className="chart-head"><b>前缀缓存查询构成</b>
                <span className={`tag ${ucm ? "purple" : "gray"}`} style={{ fontSize: 10 }}>
                  {ucm ? "ucm: 已检测" : "无 ucm: 指标"}</span>
                {ucmTokens && !ucmConsistent && (
                  <span className="tag warn" style={{ fontSize: 10 }}
                    title="命中 tokens 之和超过查询 tokens——服务的 UCM 计数器口径不自洽（或为 mock 数据），构成与中心值已按上限截断">⚠ 指标不自洽</span>
                )}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
                {donutReady ? (
                  <Donut items={donutItems} center={donutCenter} caption="命中构成" />
                ) : (
                  <div className="subnote" style={{ width: 140, textAlign: "center" }}>等待阶段<br />完成…</div>
                )}
                <div style={{ flex: 1, minWidth: 150 }}>
                  {ucmTokens ? (
                    <>
                      <div className="kv"><span><i style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: HBM, marginRight: 7 }} />HBM 命中 tokens</span><b>{Math.round(hTok).toLocaleString()}</b></div>
                      <div className="kv"><span><i style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: UCMC, marginRight: 7 }} />UCM 命中 tokens</span><b>{Math.round(uTok).toLocaleString()}</b></div>
                      <div className="kv"><span><i style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: MISS, marginRight: 7 }} />Miss tokens</span><b>{Math.round(Math.max(0, qTok - hTok - uTok)).toLocaleString()}</b></div>
                      <div className="kv"><span>查询总量 tokens</span><b>{Math.round(qTok).toLocaleString()}</b></div>
                    </>
                  ) : hasAgg ? (
                    <>
                      <div className="kv"><span>HBM 命中率（阶段快照）</span><b>{hbmPct.toFixed(1)}%</b></div>
                      <div className="kv"><span>Ext 命中率（阶段快照）</span><b>{extPct.toFixed(1)}%</b></div>
                    </>
                  ) : <div className="subnote">暂无构成数据</div>}
                  {latest.posix_cap ? (
                    <div className="kv"><span>Posix 存储占用</span>
                      <b>{((latest.posix_used ?? 0) / latest.posix_cap * 100).toFixed(1)}%</b></div>
                  ) : null}
                </div>
              </div>
              <details style={{ marginTop: 10 }}>
                <summary className="subnote" style={{ cursor: "pointer" }}>指标说明</summary>
                <div className="subnote" style={{ marginTop: 6 }}>
                  {ucm
                    ? "构成口径 = ucm: token 级查询（gpu_hbm_hit / ucm_hit / miss）；带宽图见右侧。"
                    : "服务 /metrics 未发现 ucm: 前缀指标（可能未启用 UCM 或未暴露）。仅展示 vLLM 原生指标；UCM 存储带宽图已隐藏。"}
                </div>
              </details>
            </div>

            {/* UCM 存储带宽（仅 UCM 时展示，§6.2） */}
            {ucm === true && (
              <div className="card chart-card g4">
                <div className="chart-head"><b>UCM 存储带宽（GB/s）</b>
                  <div className="legend">
                    <span className="l-solid"><i style={{ background: T_GREEN }} />写入 dump</span>
                    <span className="l-dash"><i style={{ background: EXT }} />读取 load</span>
                  </div>
                </div>
                <TimeSeriesChart height={190} yFmt={(v) => v.toFixed(1)} emptyHint="等待指标采样…"
                  events={boundaryEvents} bands={roundBands} ariaLabel="UCM存储带宽图"
                  series={[
                    { name: "dump", color: T_GREEN, area: true, points: trend.ucmDumpBw.map((y, i) => ({ x: trend.ts[i], y })) },
                    { name: "load", color: EXT, points: trend.ucmLoadBw.map((y, i) => ({ x: trend.ts[i], y })) },
                  ]} />
              </div>
            )}

            {/* DP 域明细 */}
            <div className={`card chart-card ${ucm === true ? "g4" : "g8"}`}>
              <div className="chart-head"><b>DP 域 / 端点明细</b>
                <span className="head-note">阶段快照差分口径</span></div>
              <table className="mini-table">
                <thead><tr><th>端点 / DP 域</th><th>HBM 命中率</th><th>hits / queries</th><th>Ext 命中率</th></tr></thead>
                <tbody>
                  {Object.entries(phaseRate?.per_pod ?? {}).map(([key, d]: [string, any]) => (
                    <tr key={key}>
                      <td><b className="mono" style={{ fontSize: 11 }}>{key.replace("|", " · ")}</b></td>
                      <td><b style={{ color: "var(--hbm)" }}>{(d.hbm_hit_rate * 100).toFixed(1)}%</b></td>
                      <td className="mono">{d.hbm_hits.toLocaleString()} / {d.hbm_queries.toLocaleString()}</td>
                      <td><b style={{ color: "var(--ext)" }}>{(d.ext_hit_rate * 100).toFixed(1)}%</b></td>
                    </tr>
                  ))}
                  {!Object.keys(phaseRate?.per_pod ?? {}).length &&
                    Object.entries(phaseRate?.per_dp ?? {}).map(([dp, d]: [string, any]) => (
                      <tr key={dp}>
                        <td><b>{dp}</b></td>
                        <td><b style={{ color: "var(--hbm)" }}>{(d.hbm_hit_rate * 100).toFixed(1)}%</b></td>
                        <td className="mono">{d.hbm_hits.toLocaleString()} / {d.hbm_queries.toLocaleString()}</td>
                        <td><b style={{ color: "var(--ext)" }}>{(d.ext_hit_rate * 100).toFixed(1)}%</b></td>
                      </tr>))}
                  {!Object.keys(phaseRate?.per_pod ?? {}).length && !Object.keys(phaseRate?.per_dp ?? {}).length && (
                    <tr><td colSpan={4} className="muted">等待阶段完成…</td></tr>)}
                </tbody>
              </table>
            </div>

            {/* 日志区（U5.6：全宽、可拖拽、搜索、折叠进度行、stderr） */}
            <div className="card logwrap g12">
              <div className="log-toolbar">
                <div className="seg">
                  {["all", "warn", "err"].map((f) => (
                    <span key={f} className={filter === f ? "on" : ""}
                      onClick={() => setFilter(f)}>{f === "all" ? "全部" : f === "warn" ? "WARN" : "ERROR"}</span>
                  ))}
                </div>
                <div className="seg">
                  <span className={logTab === "stdout" ? "on" : ""} onClick={() => setLogTab("stdout")}>stdout</span>
                  <span className={logTab === "stderr" ? "on" : ""} onClick={() => setLogTab("stderr")}>stderr</span>
                </div>
                <input className="inp" placeholder="搜索关键字…" value={search}
                  onChange={(e) => setSearch(e.target.value)} aria-label="日志搜索" />
                <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 11.5, color: "var(--muted)", cursor: "pointer" }}
                  title={collapsedCount ? `已折叠 ${collapsedCount} 行进度输出` : undefined}>
                  <input type="checkbox" checked={collapseProg}
                    onChange={(e) => setCollapseProg(e.target.checked)} />折叠进度行
                </label>
                <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 11.5, color: "var(--muted)", cursor: "pointer" }}>
                  <input type="checkbox" defaultChecked onChange={(e) => (followRef.current = e.target.checked)} />跟随滚动
                </label>
                <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                  <a className="btn sm ghost" href={downloadLink(`/api/runs/${runId}/logs/download?stream=stdout`)}>导出 stdout</a>
                  <a className="btn sm ghost" href={downloadLink(`/api/runs/${runId}/logs/download?stream=stderr`)}>导出 stderr</a>
                </div>
              </div>
              <div className="log-resize" role="separator" aria-orientation="horizontal" aria-label="拖拽调整日志区高度"
                onMouseDown={(e) => { resizeRef.current = { startY: e.clientY, startH: logH }; }}
                title="拖拽调整高度（240–600px）" />
              <div className="logview" ref={logRef} style={{ height: logH - 46 }}>
                {shownLogs.length === 0 && <div className="ln muted">暂无日志…</div>}
                {shownLogs.slice(-800).map((l, i) => (
                  <div key={i} className={`ln ${l.err ? "err" : l.warn ? "warn" : ""}`}>{l.line}</div>
                ))}
                {collapseProg && logTab === "stdout" && collapsedCount > 0 && (
                  <div className="ln collapse-bar">已折叠 {collapsedCount} 行进度输出（tqdm / Calculating / POST=…）— 取消勾选「折叠进度行」可展开</div>
                )}
              </div>
            </div>
          </div>
        </>
      )}

      {/* 停止确认（C7） */}
      <ConfirmModal open={stopOpen} title="停止测试" danger
        message="停止将丢弃未完成的轮次，已完成轮次的数据保留。确认停止？"
        confirmText="停止测试"
        onCancel={() => setStopOpen(false)}
        onConfirm={async () => {
          setStopOpen(false);
          try {
            await api.post(`/api/runs/${runId}/stop`);
            toast("已请求停止");
          } catch (e: any) { toast({ msg: `停止失败：${e.message}`, kind: "error" }); }
        }} />
    </>
  );
}
