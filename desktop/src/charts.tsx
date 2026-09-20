// SVG chart components — ported from the approved design prototype so the
// production app renders identically (no chart lib dependency).
import React from "react";

export type Series = { data: number[]; color: string; dash?: boolean; area?: boolean };

export function LineChart({ series, height = 200, yMax = 100, yMin = 0, fmt,
                            phaseAt, xLabel }: {
  series: Series[]; height?: number; yMax?: number; yMin?: number;
  fmt?: (v: number) => string; phaseAt?: number; xLabel?: (i: number, n: number) => string;
}) {
  const w = 560, pad = { l: 40, r: 10, t: 10, b: 22 };
  const iw = w - pad.l - pad.r, ih = height - pad.t - pad.b;
  const f = fmt ?? ((v: number) => String(Math.round(v)));
  const n = Math.max(1, ...series.map((s) => s.data.length));
  const lines = [];
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
  return <svg viewBox={`0 0 ${w} ${height}`} width="100%" height={height} style={{ display: "block" }}>{lines}</svg>;
}

export function Donut({ items, caption }: { items: { v: number; c: string }[]; caption: string }) {
  const size = 132, r = 48, c = 2 * Math.PI * r;
  let off = 0;
  return (
    <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
      {items.map((it, i) => {
        const len = (c * it.v) / 100;
        const el = (
          <circle key={i} cx={66} cy={66} r={r} fill="none" stroke={it.c} strokeWidth="16"
            strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-off}
            transform="rotate(-90 66 66)" />);
        off += len;
        return el;
      })}
      <text x="66" y="62" className="chart-axis" fontSize="17" fontWeight="700" textAnchor="middle" style={{ fill: "var(--text)" }}>
        {items.reduce((a, b) => a + b.v, 0).toFixed(1)}%
      </text>
      <text x="66" y="78" className="chart-axis" fontSize="9" textAnchor="middle">{caption}</text>
    </svg>
  );
}

export function BarChart({ groups, series, height = 185 }: {
  groups: string[]; series: { data: number[]; color: string }[]; height?: number;
}) {
  const w = 430, pad = { l: 38, r: 8, t: 8, b: 24 };
  const iw = w - pad.l - pad.r, ih = height - pad.t - pad.b;
  const all = series.flatMap((s) => s.data).filter((v) => Number(v) >= 0);
  const ymax = (all.length ? Math.max(...all) : 1) * 1.15 || 1;
  const gw = iw / Math.max(1, groups.length);
  return (
    <svg viewBox={`0 0 ${w} ${height}`} width="100%" height={height} style={{ display: "block" }}>
      {[0, 1, 2, 3].map((i) => {
        const y = pad.t + (ih * i) / 3;
        return (
          <g key={i}>
            <line x1={pad.l} y1={y} x2={w - pad.r} y2={y} className="chart-grid" />
            <text x={pad.l - 5} y={y + 3} className="chart-axis" fontSize="9" textAnchor="end">
              {Math.round(ymax * (1 - i / 3))}
            </text>
          </g>);
      })}
      {groups.map((g, gi) => (
        <g key={gi}>
          {series.map((s, si) => {
            const v = s.data[gi];
            if (v == null || v < 0) return null;
            const bw = Math.min(26, (gw - 20) / series.length - 4);
            const bh = (v / ymax) * ih;
            const x = pad.l + gi * gw + gw / 2 -
              (series.length * bw + (series.length - 1) * 4) / 2 + si * (bw + 4);
            return <rect key={si} x={x} y={pad.t + ih - bh} width={bw} height={bh} rx="3" fill={s.color} />;
          })}
          <text x={pad.l + gi * gw + gw / 2} y={height - 6} className="chart-axis" fontSize="9.5" textAnchor="middle">{g}</text>
        </g>
      ))}
    </svg>
  );
}

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
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height}>
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
          </g>);
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
