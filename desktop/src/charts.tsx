/* SVG chart components — v0.2 重设计版（UX-AUDIT C1/C2/C3、U5.1/U5.3/U5.5、E2、F2）
 *
 * TimeSeriesChart: 十字线 tooltip + 框选缩放/双击复位 + 阶梯线（<8 点不插值）
 *   + 阶段/事件垂直线 + 轮次分隔带 + SLA 阈值线 + 右轴（双轴）+ >1200 点抽稀
 * DualAxisChart : SLA 并发-延迟双轴曲线（命中区绿色填充 + 拐点标注 + 行联动高亮）
 * BarChart      : 分组对柱图（Δ% 标注在柱顶，E2）
 * Donut         : 中心 = 综合命中率（U5.5 修正：不再对构成占比求和）
 */
import React, { useMemo, useRef, useState } from "react";
import { useElemWidth } from "./ui";

// ---------------------------------------------------------------- helpers
const TS_FMT = (t: number) => new Date(t * 1000).toLocaleTimeString("zh-CN", { hour12: false });

function niceMax(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / mag;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return step * mag;
}

/** 抽稀：>limit 点时按等距采样保形（保留首尾） */
function thin<T>(arr: T[], limit = 1200): T[] {
  if (arr.length <= limit) return arr;
  const stride = Math.ceil(arr.length / limit);
  const out: T[] = [];
  for (let i = 0; i < arr.length; i += stride) out.push(arr[i]);
  if (out[out.length - 1] !== arr[arr.length - 1]) out.push(arr[arr.length - 1]);
  return out;
}

export type Pt = { x: number; y: number };
export type TSeries = {
  name: string; color: string; points: Pt[];
  dash?: boolean; area?: boolean; axis?: "left" | "right"; dots?: boolean;
};

// ================================================================ TimeSeriesChart
export function TimeSeriesChart({ series, height = 240, yMin = 0, yMax,
                                  yFmt = (v) => String(Math.round(v)), rightFmt,
                                  events = [], bands = [], thresholds = [],
                                  emptyHint = "等待数据…", ariaLabel }: {
  series: TSeries[]; height?: number;
  yMin?: number; yMax?: number;
  yFmt?: (v: number) => string; rightFmt?: (v: number) => string;
  events?: { x: number; label: string; color?: string }[];
  bands?: { from: number; to: number; label?: string }[];
  thresholds?: { y: number; label: string; color?: string; axis?: "left" | "right" }[];
  emptyHint?: string; ariaLabel?: string;
}) {
  const [ref, w] = useElemWidth<HTMLDivElement>(560);
  const [zoom, setZoom] = useState<[number, number] | null>(null);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [brush, setBrush] = useState<{ x0: number; x1: number } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const hasRight = series.some((s) => s.axis === "right");
  const pad = { l: 46, r: hasRight ? 48 : 12, t: 14, b: 22 };

  const visible = useMemo(() => series.map((s) => ({
    ...s,
    points: thin(s.points.filter((p) =>
      !zoom || (p.x >= zoom[0] - 0.5 && p.x <= zoom[1] + 0.5))),
  })), [series, zoom]);

  const allPts = visible.flatMap((s) => (s.axis === "right" ? [] : s.points));
  const rightPts = visible.flatMap((s) => (s.axis === "right" ? s.points : []));
  const xsAll = visible.flatMap((s) => s.points.map((p) => p.x));
  const x0 = xsAll.length ? Math.min(...xsAll) : 0;
  const x1 = xsAll.length ? Math.max(...xsAll) : 1;
  const dx = x1 > x0 ? x1 - x0 : 1;
  const domain: [number, number] = zoom ?? [x0 - dx * 0.01, x1 + dx * 0.01];

  const leftMax = Math.max(yMax ?? 0, niceMax(Math.max(1e-9, ...allPts.map((p) => p.y), 1)));
  const leftMin = yMin;
  const rMax = rightPts.length ? niceMax(Math.max(1e-9, ...rightPts.map((p) => p.y), 1)) : 1;
  const rMin = 0;
  const rf = rightFmt ?? yFmt;

  const iw = Math.max(10, w - pad.l - pad.r);
  const ih = Math.max(10, height - pad.t - pad.b);
  const X = (x: number) => pad.l + ((x - domain[0]) / Math.max(1e-9, domain[1] - domain[0])) * iw;
  const YL = (y: number) => pad.t + ih - ((y - leftMin) / Math.max(1e-9, leftMax - leftMin)) * ih;
  const YR = (y: number) => pad.t + ih - ((y - rMin) / Math.max(1e-9, rMax - rMin)) * ih;

  const stepMode = Math.max(0, ...visible.map((s) => s.points.length)) < 8;
  const empty = !visible.some((s) => s.points.length);

  const buildPath = (s: TSeries): string => {
    const pts = s.points.filter((p) => Number.isFinite(p.y));
    if (!pts.length) return "";
    const yOf = (v: number) => (s.axis === "right" ? YR : YL)(v);
    if (!stepMode) {
      return pts.map((p, i) => (i ? "L" : "M") + X(p.x).toFixed(1) + "," + yOf(p.y).toFixed(1)).join(" ");
    }
    // 阶梯线（U5.3）：水平延伸到下一点的 x，再垂直跳变——不插值，两个点也画得诚实
    let d = `M${X(pts[0].x).toFixed(1)},${yOf(pts[0].y).toFixed(1)}`;
    for (let i = 1; i < pts.length; i++) {
      d += ` L${X(pts[i].x).toFixed(1)},${yOf(pts[i - 1].y).toFixed(1)}`;
      d += ` L${X(pts[i].x).toFixed(1)},${yOf(pts[i].y).toFixed(1)}`;
    }
    return d;
  };

  const areaPath = (s: TSeries): string | null => {
    const pts = s.points.filter((p) => Number.isFinite(p.y));
    if (pts.length < 2) return null;
    const base = pad.t + ih;
    const d = pts.map((p, i) => {
      const px = X(p.x), py = (s.axis === "right" ? YR : YL)(p.y);
      return (i ? "L" : "M") + px.toFixed(1) + "," + py.toFixed(1);
    }).join(" ");
    return `${d} L${X(pts[pts.length - 1].x).toFixed(1)},${base} L${X(pts[0].x).toFixed(1)},${base} Z`;
  };

  // ---- hover: nearest sample ts across union ----
  const unionX = useMemo(() => {
    const set = new Set<number>();
    visible.forEach((s) => s.points.forEach((p) => set.add(p.x)));
    return [...set].sort((a, b) => a - b);
  }, [visible]);
  const nearest = (x: number) => {
    if (!unionX.length) return null;
    let lo = 0, hi = unionX.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; (unionX[mid] < x ? lo = mid : hi = mid); }
    return Math.abs(unionX[lo] - x) < Math.abs(unionX[hi] - x) ? unionX[lo] : unionX[hi];
  };

  const relX = (e: React.MouseEvent) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return (e.clientX - rect.left) * (w / Math.max(1, rect.width));
  };

  const hoveredSeries = hoverX != null
    ? visible.map((s) => ({ s, p: s.points.find((p) => p.x === hoverX) ?? null })) : [];

  return (
    <div className="chart-body" ref={ref} style={{ height }}
         onMouseLeave={() => { setHoverX(null); setBrush(null); }}>
      {empty ? (
        <div className="chart-empty">{emptyHint}</div>
      ) : (
        <svg ref={svgRef} viewBox={`0 0 ${w} ${height}`} width="100%" height={height}
             role="img" aria-label={ariaLabel ?? "时序图表"}
             style={{ cursor: brush ? "col-resize" : "crosshair", userSelect: "none" }}
             onMouseDown={(e) => { const x = relX(e); setBrush({ x0: x, x1: x }); }}
             onMouseMove={(e) => {
               const x = relX(e);
               if (brush) setBrush({ ...brush, x1: x });
               const t = domain[0] + ((x - pad.l) / iw) * (domain[1] - domain[0]);
               setHoverX(nearest(t));
             }}
             onMouseUp={() => {
               if (brush && Math.abs(brush.x1 - brush.x0) > 10) {
                 const xa = Math.min(brush.x0, brush.x1), xb = Math.max(brush.x0, brush.x1);
                 const ta = domain[0] + ((xa - pad.l) / iw) * (domain[1] - domain[0]);
                 const tb = domain[0] + ((xb - pad.l) / iw) * (domain[1] - domain[0]);
                 if (tb - ta > 0.5) setZoom([ta, tb]);
               }
               setBrush(null);
             }}
             onDoubleClick={() => setZoom(null)}>
          <title>{ariaLabel ?? "时序图表"}</title>

          {/* 轮次分隔带（C3） */}
          {bands.map((b, i) => {
            const bx0 = X(Math.max(domain[0], b.from)), bx1 = X(Math.min(domain[1], b.to));
            if (bx1 <= pad.l || bx0 >= w - pad.r) return null;
            return (
              <g key={`b${i}`}>
                <rect x={Math.max(pad.l, bx0)} y={pad.t} width={Math.max(0, Math.min(w - pad.r, bx1) - Math.max(pad.l, bx0))}
                      height={ih} fill={i % 2 ? "rgba(255,255,255,.028)" : "transparent"} />
                {b.label && bx1 - bx0 > 34 && (
                  <text x={Math.max(pad.l, bx0) + 4} y={pad.t + 10} className="chart-axis"
                        fontSize="9" fill="var(--muted)">{b.label}</text>)}
              </g>);
          })}

          {/* 网格 + 轴标签 */}
          {[0, 1, 2, 3, 4].map((i) => {
            const yy = pad.t + (ih * i) / 4;
            return (
              <g key={`g${i}`}>
                <line x1={pad.l} y1={yy} x2={w - pad.r} y2={yy} className="chart-grid" />
                <text x={pad.l - 6} y={yy + 3} className="chart-axis" fontSize="9" textAnchor="end">
                  {yFmt(leftMax - ((leftMax - leftMin) * i) / 4)}
                </text>
                {hasRight && (
                  <text x={w - pad.r + 6} y={yy + 3} className="chart-axis" fontSize="9" textAnchor="start">
                    {rf(rMax - ((rMax - rMin) * i) / 4)}
                  </text>)}
              </g>);
          })}
          {[0, 1, 2, 3, 4].map((i) => {
            const t = domain[0] + ((domain[1] - domain[0]) * i) / 4;
            return (
              <text key={`x${i}`} x={pad.l + (iw * i) / 4} y={height - 6}
                    className="chart-axis" fontSize="9" textAnchor={i === 0 ? "start" : i === 4 ? "end" : "middle"}>
                {TS_FMT(t)}
              </text>);
          })}

          {/* 阈值线（C4/F2） */}
          {thresholds.map((th, i) => {
            if (th.axis === "right") {
              const yy = YR(th.y);
              return (
                <g key={`th${i}`}>
                  <line x1={pad.l} y1={yy} x2={w - pad.r} y2={yy} stroke={th.color ?? "var(--warn)"}
                        strokeWidth="1" strokeDasharray="6 4" opacity=".85" />
                  <text x={w - pad.r - 4} y={yy - 4} fontSize="9" textAnchor="end"
                        fill={th.color ?? "var(--warn)"}>{th.label}</text>
                </g>);
            }
            const yy = YL(th.y);
            return (
              <g key={`th${i}`}>
                <line x1={pad.l} y1={yy} x2={w - pad.r} y2={yy} stroke={th.color ?? "var(--warn)"}
                      strokeWidth="1" strokeDasharray="6 4" opacity=".85" />
                <text x={w - pad.r - 4} y={yy - 4} fontSize="9" textAnchor="end"
                      fill={th.color ?? "var(--warn)"}>{th.label}</text>
              </g>);
          })}

          {/* 阶段/事件垂直线（C2） */}
          {events.filter((e) => e.x >= domain[0] && e.x <= domain[1]).map((e, i) => (
            <g key={`e${i}`}>
              <line x1={X(e.x)} y1={pad.t} x2={X(e.x)} y2={pad.t + ih}
                    stroke={e.color ?? "var(--border2)"} strokeWidth="1" strokeDasharray="4 4" />
              <text x={X(e.x) + 3} y={pad.t + 9} className="chart-axis" fontSize="8.5" fill="var(--muted)">
                {e.label}
              </text>
            </g>))}

          {/* 序列 */}
          {visible.map((s, si) => (
            <g key={`s${si}`}>
              {s.area && areaPath(s) && <path d={areaPath(s)!} fill={s.color} fillOpacity=".1" />}
              <path d={buildPath(s)} fill="none" stroke={s.color} strokeWidth="1.8"
                    strokeDasharray={s.dash ? "5 4" : undefined} strokeLinejoin="round" />
              {(stepMode || s.dots) && s.points.filter((p) => Number.isFinite(p.y)).map((p, pi) => (
                <circle key={pi} cx={X(p.x)} cy={(s.axis === "right" ? YR : YL)(p.y)} r="2.4" fill={s.color} />
              ))}
            </g>))}

          {/* 框选缩放 */}
          {brush && Math.abs(brush.x1 - brush.x0) > 2 && (
            <rect x={Math.min(brush.x0, brush.x1)} y={pad.t}
                  width={Math.abs(brush.x1 - brush.x0)} height={ih}
                  fill="rgba(59,130,246,.14)" stroke="var(--brand)" strokeWidth="1" />)}

          {/* 十字线 + 悬停点（C1） */}
          {hoverX != null && X(hoverX) >= pad.l && X(hoverX) <= w - pad.r && (
            <g pointerEvents="none">
              <line x1={X(hoverX)} y1={pad.t} x2={X(hoverX)} y2={pad.t + ih}
                    stroke="var(--text2)" strokeWidth="1" strokeDasharray="2 3" opacity=".6" />
              {hoveredSeries.map(({ s, p }, i) => p && Number.isFinite(p.y) && (
                <circle key={i} cx={X(p.x)} cy={(s.axis === "right" ? YR : YL)(p.y)}
                        r="3.6" fill={s.color} stroke="var(--bg0)" strokeWidth="1.5" />
              ))}
            </g>)}
        </svg>
      )}

      {/* tooltip 悬浮卡（C1） */}
      {hoverX != null && !empty && (
        <div className="chart-tip" style={{
          left: Math.min(Math.max(X(hoverX) + 12, 4), Math.max(4, w - 190)),
          top: 10,
        }}>
          <div className="tt">{TS_FMT(hoverX)}</div>
          {hoveredSeries.map(({ s, p }, i) => p && Number.isFinite(p.y) && (
            <div key={i} className="ts" style={{ color: s.color }}>
              <i style={{ display: "inline-block", width: 9, height: 3, background: s.color,
                          marginRight: 6, borderRadius: 2, verticalAlign: "middle" }} />
              {s.name}：{(s.axis === "right" ? rf : yFmt)(p.y)}
            </div>))}
        </div>)}

      {zoom && (
        <button className="btn sm ghost chart-reset" style={{ position: "absolute", right: 4, top: 4, padding: "2px 8px" }}
                onClick={() => setZoom(null)}>⤢ 复位</button>)}
      {!empty && (
        <div className="chart-zoomhint">拖选缩放 · 双击复位</div>)}
    </div>
  );
}

// ================================================================ Donut（U5.5 修正）
export function Donut({ items, center, caption }: {
  items: { v: number; c: string }[];   // v = 构成占比（0-100，和可为 100）
  center: string;                      // 中心显示的综合命中率（如 "88.9%"）
  caption: string;
}) {
  const size = 140, cx = 70, r = 46, c = 2 * Math.PI * r;
  let off = 0;
  const total = items.reduce((a, b) => a + b.v, 0) || 1;
  return (
    <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} role="img"
         aria-label={`命中构成：${caption}，综合命中率 ${center}`}>
      {items.map((it, i) => {
        const len = (c * it.v) / total;
        const el = (
          <circle key={i} cx={cx} cy={cx} r={r} fill="none" stroke={it.c} strokeWidth="13"
                  strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-off}
                  transform={`rotate(-90 ${cx} ${cx})`} />);
        off += len;
        return el;
      })}
      <text x={cx} y={cx - 1} fontSize="19" fontWeight="700" textAnchor="middle"
            style={{ fill: "var(--text)" }}>{center}</text>
      <text x={cx} y={cx + 15} className="chart-axis" fontSize="9.5" textAnchor="middle">{caption}</text>
    </svg>
  );
}

// ================================================================ BarChart（对柱图 + Δ 标注，E2）
export function BarChart({ groups, series, height = 200, labels, fmt, ariaLabel }: {
  groups: string[]; series: { name?: string; data: number[]; color: string }[];
  height?: number; labels?: string[][]; fmt?: (v: number) => string;
  ariaLabel?: string;
}) {
  const [ref, w] = useElemWidth<HTMLDivElement>(430);
  const pad = { l: 42, r: 8, t: 20, b: 24 };
  const all = series.flatMap((s) => s.data).filter((v) => Number(v) >= 0);
  const ymax = niceMax((all.length ? Math.max(...all) : 1) * 1.12);
  const iw = Math.max(10, w - pad.l - pad.r);
  const ih = Math.max(10, height - pad.t - pad.b);
  const gw = iw / Math.max(1, groups.length);
  const f = fmt ?? ((v: number) => String(Math.round(v)));
  return (
    <div ref={ref} style={{ width: "100%" }}>
      <svg viewBox={`0 0 ${w} ${height}`} width="100%" height={height} role="img"
           aria-label={ariaLabel ?? "对比柱状图"} style={{ display: "block" }}>
        <title>{ariaLabel ?? "对比柱状图"}</title>
        {[0, 1, 2, 3].map((i) => {
          const y = pad.t + (ih * i) / 3;
          return (
            <g key={i}>
              <line x1={pad.l} y1={y} x2={w - pad.r} y2={y} className="chart-grid" />
              <text x={pad.l - 5} y={y + 3} className="chart-axis" fontSize="9" textAnchor="end">
                {f(ymax * (1 - i / 3))}
              </text>
            </g>);
        })}
        {groups.map((g, gi) => (
          <g key={gi}>
            {series.map((s, si) => {
              const v = s.data[gi];
              if (v == null || v < 0) return null;
              const bw = Math.min(30, (gw - 18) / series.length - 4);
              const bh = (v / ymax) * ih;
              const x = pad.l + gi * gw + gw / 2 -
                (series.length * bw + (series.length - 1) * 4) / 2 + si * (bw + 4);
              const lab = labels?.[gi]?.[si];
              return (
                <g key={si}>
                  <rect x={x} y={pad.t + ih - bh} width={bw} height={bh} rx="3" fill={s.color} />
                  {lab && (
                    <text x={x + bw / 2} y={pad.t + ih - bh - 5} fontSize="9" textAnchor="middle"
                          fill="var(--text2)">{lab}</text>)}
                </g>);
            })}
            <text x={pad.l + gi * gw + gw / 2} y={height - 6} className="chart-axis"
                  fontSize="9.5" textAnchor="middle">{g}</text>
          </g>))}
      </svg>
    </div>
  );
}

// ================================================================ DualAxisChart（F2：SLA 并发-延迟）
export function DualAxisChart({ cats, left, right, leftMax, rightMax,
                                leftFmt = (v) => String(Math.round(v)),
                                rightFmt = (v) => String(Math.round(v)),
                                thresholds = [], okFlags, inflection, highlight,
                                onHover, height = 260, ariaLabel }: {
  cats: string[];
  left: { name: string; color: string; points: number[]; dash?: boolean }[];
  right: { name: string; color: string; points: number[]; dash?: boolean }[];
  leftMax?: number; rightMax?: number;
  leftFmt?: (v: number) => string; rightFmt?: (v: number) => string;
  thresholds?: { y: number; label: string; color?: string }[];
  okFlags?: boolean[];
  inflection?: { index: number; label: string } | null;
  highlight?: number | null;
  onHover?: (i: number | null) => void;
  height?: number; ariaLabel?: string;
}) {
  const [ref, w] = useElemWidth<HTMLDivElement>(560);
  const pad = { l: 46, r: 48, t: 18, b: 24 };
  const lMax = leftMax ?? niceMax(Math.max(1e-9, ...left.flatMap((s) => s.points.filter(Number.isFinite)), 1) * 1.12);
  const rMax = rightMax ?? niceMax(Math.max(1e-9, ...right.flatMap((s) => s.points.filter(Number.isFinite)), 1) * 1.12);
  const iw = Math.max(10, w - pad.l - pad.r);
  const ih = Math.max(10, height - pad.t - pad.b);
  const n = Math.max(1, cats.length - 1);
  const X = (i: number) => pad.l + (iw * i) / n;
  const YL = (v: number) => pad.t + ih - (v / lMax) * ih;
  const YR = (v: number) => pad.t + ih - (v / rMax) * ih;
  const path = (pts: number[], yf: (v: number) => number) =>
    pts.map((v, i) => (i ? "L" : "M") + X(i).toFixed(1) + "," +
      (Number.isFinite(v) ? yf(v).toFixed(1) : String(pad.t + ih))).join(" ");

  return (
    <div ref={ref} style={{ width: "100%" }}
         onMouseLeave={() => onHover?.(null)}>
      <svg viewBox={`0 0 ${w} ${height}`} width="100%" height={height} role="img"
           aria-label={ariaLabel ?? "并发-延迟双轴曲线"} style={{ display: "block" }}>
        <title>{ariaLabel ?? "并发-延迟双轴曲线"}</title>
        {/* SLA 满足区间绿色填充（F2） */}
        {okFlags && cats.length > 1 && okFlags.some((o) => o) && (
          <rect x={pad.l} y={pad.t} width={iw} height={ih} fill="rgba(16,185,129,.05)" />)}
        {[0, 1, 2, 3, 4].map((i) => {
          const yy = pad.t + (ih * i) / 4;
          return (
            <g key={i}>
              <line x1={pad.l} y1={yy} x2={w - pad.r} y2={yy} className="chart-grid" />
              <text x={pad.l - 6} y={yy + 3} className="chart-axis" fontSize="9" textAnchor="end">
                {leftFmt(lMax - (lMax * i) / 4)}
              </text>
              <text x={w - pad.r + 6} y={yy + 3} className="chart-axis" fontSize="9" textAnchor="start">
                {rightFmt(rMax - (rMax * i) / 4)}
              </text>
            </g>);
        })}
        {cats.map((c, i) => (
          <text key={i} x={X(i)} y={height - 6} className="chart-axis" fontSize="9.5"
                textAnchor="middle">{c}</text>))}
        {/* SLA 阈值横线 */}
        {thresholds.map((th, i) => (
          <g key={i}>
            <line x1={pad.l} y1={YL(th.y)} x2={w - pad.r} y2={YL(th.y)}
                  stroke={th.color ?? "var(--warn)"} strokeWidth="1" strokeDasharray="6 4" opacity=".9" />
            <text x={w - pad.r - 4} y={YL(th.y) - 4} fontSize="9" textAnchor="end"
                  fill={th.color ?? "var(--warn)"}>{th.label}</text>
          </g>))}
        {/* 序列 */}
        {left.map((s, si) => (
          <g key={`l${si}`}>
            <path d={path(s.points, YL)} fill="none" stroke={s.color} strokeWidth="1.9"
                  strokeDasharray={s.dash ? "5 4" : undefined} />
            {s.points.map((v, i) => Number.isFinite(v) && (
              <circle key={i} cx={X(i)} cy={YL(v)} r={highlight === i ? 5 : 3} fill={s.color}
                      stroke="var(--bg1)" strokeWidth="1.5" />))}
          </g>))}
        {right.map((s, si) => (
          <g key={`r${si}`}>
            <path d={path(s.points, YR)} fill="none" stroke={s.color} strokeWidth="1.9"
                  strokeDasharray={s.dash ? "5 4" : undefined} />
            {s.points.map((v, i) => Number.isFinite(v) && (
              <circle key={i} cx={X(i)} cy={YR(v)} r={highlight === i ? 5 : 3} fill={s.color}
                      stroke="var(--bg1)" strokeWidth="1.5" />))}
          </g>))}
        {/* 拐点标注（F2） */}
        {inflection && inflection.index >= 0 && inflection.index < cats.length && (
          <g>
            <line x1={X(inflection.index)} y1={pad.t} x2={X(inflection.index)} y2={pad.t + ih}
                  stroke="var(--green)" strokeWidth="1.4" strokeDasharray="3 3" />
            <text x={X(inflection.index) + 5} y={pad.t + 11} fontSize="10" fontWeight="700"
                  fill="var(--green)">{inflection.label}</text>
          </g>)}
        {/* 行联动 hover 热区 */}
        {cats.map((_, i) => (
          <rect key={`h${i}`} x={X(i) - iw / n / 2} y={pad.t} width={iw / n} height={ih}
                fill="transparent" onMouseEnter={() => onHover?.(i)} />))}
      </svg>
    </div>
  );
}

// ================================================================ LineChart（对比页逐轮曲线，保留）
export function LineChart({ series, height = 200, yMax = 100, yMin = 0, fmt,
                           phaseAt, xLabel, ariaLabel }: {
  series: { name?: string; data: number[]; color: string; dash?: boolean; area?: boolean }[];
  height?: number; yMax?: number; yMin?: number;
  fmt?: (v: number) => string; phaseAt?: number;
  xLabel?: (i: number, n: number) => string; ariaLabel?: string;
}) {
  const [ref, w] = useElemWidth<HTMLDivElement>(560);
  const pad = { l: 40, r: 10, t: 10, b: 22 };
  const iw = Math.max(10, w - pad.l - pad.r);
  const ih = Math.max(10, height - pad.t - pad.b);
  const f = fmt ?? ((v: number) => String(Math.round(v)));
  const n = Math.max(1, ...series.map((s) => s.data.length));
  const lines: React.ReactNode[] = [];
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (ih * i) / 4;
    lines.push(
      <line key={`g${i}`} x1={pad.l} y1={y} x2={w - pad.r} y2={y} className="chart-grid" />,
      <text key={`t${i}`} x={pad.l - 6} y={y + 3} className="chart-axis" fontSize="9" textAnchor="end">
        {f(yMax - ((yMax - yMin) * i) / 4)}
      </text>);
  }
  for (let i = 0; i < 5; i++) {
    const label = xLabel ? xLabel(i, n) : `${Math.round((i * n) / 4)}`;
    lines.push(
      <text key={`x${i}`} x={pad.l + (iw * i) / 4} y={height - 6} className="chart-axis" fontSize="9" textAnchor="middle">
        {label}
      </text>);
  }
  if (phaseAt != null) {
    const x = pad.l + (iw * phaseAt) / Math.max(1, n - 1);
    lines.push(
      <line key="ph" x1={x} y1={pad.t} x2={x} y2={pad.t + ih} className="chart-axis" stroke="var(--border2)" strokeDasharray="3 3" />,
      <text key="pht" x={x + 5} y={pad.t + 11} className="chart-axis" fontSize="9">全量开始</text>);
  }
  series.forEach((s, si) => {
    if (!s.data.length) return;
    const pts = s.data.map((v, i) => [
      pad.l + (iw * i) / Math.max(1, s.data.length - 1),
      pad.t + ih - ((v - yMin) / (yMax - yMin || 1)) * ih,
    ]);
    const d = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");
    lines.push(
      <path key={`s${si}`} d={d} fill="none" stroke={s.color} strokeWidth="1.8"
            strokeDasharray={s.dash ? "4 4" : undefined} strokeLinejoin="round" />);
  });
  return (
    <div ref={ref} style={{ width: "100%" }}>
      <svg viewBox={`0 0 ${w} ${height}`} width="100%" height={height} role="img"
           aria-label={ariaLabel ?? "折线图"} style={{ display: "block" }}>{lines}</svg>
    </div>
  );
}

// ================================================================ Radar（保留）
export function Radar({ axes, series, width = 330, height = 210 }: {
  axes: string[]; series: { data: number[]; color: string }[]; width?: number; height?: number;
}) {
  const cx = width / 2, cy = height / 2 + 6, R = 74, n = axes.length;
  const ring = (ring: number) =>
    axes.map((_, i) => {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
      return `${cx + (R * ring * Math.cos(a)) / 4},${cy + (R * ring * Math.sin(a)) / 4}`;
    }).join(" ");
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img" aria-label="五维评分雷达图">
      {[1, 2, 3, 4].map((r) => (
        <polygon key={r} points={ring(r)} fill="none" className="chart-grid" />
      ))}
      {axes.map((ax, i) => {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
        return (
          <g key={i}>
            <line x1={cx} y1={cy} x2={cx + R * Math.cos(a)} y2={cy + R * Math.sin(a)} className="chart-grid" />
            <text x={cx + (R + 14) * Math.cos(a)} y={cy + (R + 14) * Math.sin(a) + 3}
                  className="chart-axis" fontSize="9.5" textAnchor="middle">{ax}</text>
          </g>
        );
      })}
      {series.map((s, si) => {
        const pts = s.data.map((v, i) => {
          const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
          const r = R * Math.max(0, Math.min(1, v / 100));
          return `${cx + r * Math.cos(a)},${cy + r * Math.sin(a)}`;
        }).join(" ");
        return <polygon key={si} points={pts} fill={s.color} fillOpacity=".13" stroke={s.color} strokeWidth="1.6" />;
      })}
    </svg>
  );
}
