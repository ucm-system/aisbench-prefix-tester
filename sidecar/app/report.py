"""Report export: xlsx (openpyxl) and standalone offline HTML (inline SVG charts)."""
from __future__ import annotations

import html
import io
import math
import time
from pathlib import Path
from typing import Any

from . import compare as compare_mod
from . import config, store

# --------------------------------------------------------------------------- xlsx
def export_xlsx(run_ids: list[str], exclude_warmup: bool = True) -> str:
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter

    result = compare_mod.compare(run_ids, exclude_warmup=exclude_warmup)
    wb = Workbook()
    header_fill = PatternFill("solid", fgColor="1F3864")
    header_font = Font(color="FFFFFF", bold=True)

    def style_header(ws):
        for cell in ws[1]:
            cell.fill = header_fill
            cell.font = header_font
            cell.alignment = Alignment(vertical="center")

    def auto_width(ws):
        for col in ws.columns:
            width = max((len(str(c.value or "")) for c in col), default=8)
            ws.column_dimensions[get_column_letter(col[0].column)].width = min(42, width + 4)

    # Sheet 1: 汇总对比
    ws = wb.active
    ws.title = "汇总对比"
    keys = list(compare_mod.METRICS.keys())
    ws.append(["指标"] + [result["names"][rid] for rid in result["runs"]])
    for key in keys:
        meta = compare_mod.METRICS[key]
        ws.append([meta[0]] + [round(result["metrics"][key]["values"][rid], 6)
                               for rid in result["runs"]])
    style_header(ws)
    auto_width(ws)

    # Sheet 2: 指标变化率（相对第一个 run）
    ws2 = wb.create_sheet("指标变化率")
    ws2.append(["指标", "基准 run"] + [f"{result['names'][rid]} Δ%" for rid in result["runs"][1:]])
    for key in keys:
        meta = compare_mod.METRICS[key]
        deltas = result["metrics"][key]["deltas"]
        ws2.append([meta[0], result["names"][result["runs"][0]]]
                   + [deltas.get(rid, {}).get("pct", "") for rid in result["runs"][1:]])
    style_header(ws2)
    auto_width(ws2)

    # Sheet 3+: 各 run 原始行（轮 × 阶段）
    for rid in result["runs"]:
        ws3 = wb.create_sheet(f"原始_{rid}"[:28])
        rounds = store.get_rounds(rid)
        if not rounds:
            ws3.append(["(无数据)"])
            continue
        headers = list(rounds[0].get("metrics", {}).keys())
        ws3.append(["round", "phase", "is_warmup", "warnings"] + headers)
        for r in rounds:
            m = r.get("metrics", {})
            ws3.append([r["round_index"], r["phase"], r["is_warmup"], r.get("warnings", "")]
                       + [m.get(h, "") for h in headers])
        style_header(ws3)
        auto_width(ws3)

    # Sheet 4: DP 命中率明细
    ws4 = wb.create_sheet("DP命中率明细")
    ws4.append(["run", "轮", "DP域", "HBM命中率", "HBM hits/queries", "Ext命中率", "Ext hits/queries"])
    for rid in result["runs"]:
        for r in store.get_rounds(rid):
            if r["phase"] != "full":
                continue
            per_dp = (r.get("hit_rate") or {}).get("per_dp", {})
            for dp_key, d in per_dp.items():
                ws4.append([result["names"][rid], r["round_index"], dp_key,
                            d.get("hbm_hit_rate", 0), f"{d.get('hbm_hits',0)}/{d.get('hbm_queries',0)}",
                            d.get("ext_hit_rate", 0), f"{d.get('ext_hits',0)}/{d.get('ext_queries',0)}"])
    style_header(ws4)
    auto_width(ws4)

    # Sheet 5: 配置差异
    ws5 = wb.create_sheet("配置差异")
    ws5.append(["参数"] + [result["names"][rid] for rid in result["runs"]])
    for row in result["config_diff"]:
        ws5.append([row["key"] + (" *" if row["diff"] else "")] + [str(v) for v in row["values"]])
    style_header(ws5)
    auto_width(ws5)

    out = config.outputs_dir() / f"compare_{time.strftime('%Y%m%d_%H%M%S')}.xlsx"
    wb.save(str(out))
    return str(out)


# --------------------------------------------------------------------------- HTML
COLORS = ["#4f8bff", "#13c2c2", "#9254de", "#e2a336", "#10a37f", "#e5484d"]


def _svg_line(series: list[dict], labels: list[str], y_max: float, w=560, h=190) -> str:
    pad = {"l": 40, "r": 10, "t": 10, "b": 22}
    iw, ih = w - pad["l"] - pad["r"], h - pad["t"] - pad["b"]
    parts = [f'<svg viewBox="0 0 {w} {h}" width="100%" height="{h}" xmlns="http://www.w3.org/2000/svg">']
    for i in range(5):
        y = pad["t"] + ih * i / 4
        val = y_max - y_max * i / 4
        parts.append(f'<line x1="{pad["l"]}" y1="{y}" x2="{w-pad["r"]}" y2="{y}" stroke="rgba(255,255,255,.08)"/>')
        parts.append(f'<text x="{pad["l"]-6}" y="{y+3}" fill="#8a8d94" font-size="9" text-anchor="end">{val:.4g}</text>')
    n = max((len(s["data"]) for s in series), default=1)
    for i in range(0, len(labels), max(1, len(labels) // 5)):
        parts.append(f'<text x="{pad["l"]+iw*i/max(1,len(labels)-1)}" y="{h-6}" fill="#8a8d94" font-size="9">{labels[i]}</text>')
    for idx, s in enumerate(series):
        color = s.get("color", COLORS[idx % len(COLORS)])
        pts = []
        for i, v in enumerate(s["data"]):
            x = pad["l"] + iw * i / max(1, n - 1)
            y = pad["t"] + ih - (v / y_max if y_max else 0) * ih
            pts.append(f"{x:.1f},{y:.1f}")
        dash = ' stroke-dasharray="4 4"' if s.get("dash") else ""
        parts.append(f'<polyline points="{" ".join(pts)}" fill="none" stroke="{color}" stroke-width="1.8"{dash}/>')
    parts.append("</svg>")
    return "".join(parts)


def _svg_bars(groups: list[str], series: list[dict], w=430, h=185) -> str:
    pad = {"l": 40, "r": 10, "t": 10, "b": 22}
    iw, ih = w - pad["l"] - pad["r"], h - pad["t"] - pad["b"]
    ymax = max((v for s in series for v in s["data"] if v is not None and v >= 0), default=1) * 1.15
    gw = iw / max(1, len(groups))
    parts = [f'<svg viewBox="0 0 {w} {h}" width="100%" height="{h}" xmlns="http://www.w3.org/2000/svg">']
    for i in range(4):
        y = pad["t"] + ih * i / 3
        parts.append(f'<line x1="{pad["l"]}" y1="{y}" x2="{w-pad["r"]}" y2="{y}" stroke="rgba(255,255,255,.08)"/>')
        parts.append(f'<text x="{pad["l"]-6}" y="{y+3}" fill="#8a8d94" font-size="9" text-anchor="end">{ymax*(1-i/3):.4g}</text>')
    for gi, g in enumerate(groups):
        n = len(series)
        bw = min(26, (gw - 20) / n - 4)
        for si, s in enumerate(series):
            v = s["data"][gi] if si < len(s["data"]) and gi < len(s["data"]) else None
            if v is None or v < 0:
                continue
            bh = v / ymax * ih
            x = pad["l"] + gi * gw + gw / 2 - (n * bw + (n - 1) * 4) / 2 + si * (bw + 4)
            parts.append(f'<rect x="{x:.1f}" y="{pad["t"]+ih-bh:.1f}" width="{bw:.1f}" height="{bh:.1f}" rx="3" fill="{COLORS[si%len(COLORS)]}"/>')
        parts.append(f'<text x="{pad["l"]+gi*gw+gw/2:.0f}" y="{h-6}" fill="#8a8d94" font-size="9" text-anchor="middle">{html.escape(g)}</text>')
    parts.append("</svg>")
    return "".join(parts)


def _svg_radar(axes: list[str], series: list[dict], w=330, h=210) -> str:
    cx, cy, R = w / 2, h / 2 + 6, 74
    n = len(axes)
    parts = [f'<svg viewBox="0 0 {w} {h}" width="100%" height="{h}" xmlns="http://www.w3.org/2000/svg">']
    for ring in range(1, 5):
        pts = [f"{cx + R*ring/4*math.cos(-math.pi/2 + i*2*math.pi/n):.1f},"
               f"{cy + R*ring/4*math.sin(-math.pi/2 + i*2*math.pi/n):.1f}" for i in range(n)]
        parts.append(f'<polygon points="{" ".join(pts)}" fill="none" stroke="rgba(255,255,255,.08)"/>')
    for i, ax in enumerate(axes):
        a = -math.pi / 2 + i * 2 * math.pi / n
        parts.append(f'<line x1="{cx}" y1="{cy}" x2="{cx+R*math.cos(a):.1f}" y2="{cy+R*math.sin(a):.1f}" stroke="rgba(255,255,255,.08)"/>')
        parts.append(f'<text x="{cx+(R+14)*math.cos(a):.1f}" y="{cy+(R+14)*math.sin(a)+3:.1f}" fill="#8a8d94" font-size="9.5" text-anchor="middle">{html.escape(ax)}</text>')
    for si, s in enumerate(series):
        color = COLORS[si % len(COLORS)]
        pts = []
        for i, v in enumerate(s["data"]):
            a = -math.pi / 2 + i * 2 * math.pi / n
            r = R * max(0.0, min(1.0, v / 100))
            pts.append(f"{cx + r*math.cos(a):.1f},{cy + r*math.sin(a):.1f}")
        parts.append(f'<polygon points="{" ".join(pts)}" fill="{color}" fill-opacity=".13" stroke="{color}" stroke-width="1.6"/>')
    parts.append("</svg>")
    return "".join(parts)


def export_html(run_ids: list[str], exclude_warmup: bool = True) -> str:
    result = compare_mod.compare(run_ids, exclude_warmup=exclude_warmup)
    ids = result["runs"]
    names = result["names"]

    delta_cards = ""
    for key in ("hbm_hit_rate", "ext_hit_rate", "ttft_avg_ms", "output_token_throughput"):
        meta = result["metrics"][key]
        base = meta["values"].get(ids[0], -1)
        d = meta["deltas"].get(ids[1]) if len(ids) > 1 else None
        arrow = ""
        if d:
            arrow = f'<span style="color:{"#10a37f" if d["good"] else "#e5484d"}">{"▲" if d["pct"] >= 0 else "▼"} {d["pct"]:+.1f}%</span>'
        delta_cards += (f'<div class="card"><div class="t">{html.escape(meta["label"])}</div>'
                        f'<div class="v">{base if base >= 0 else "—"}</div><div class="d">{arrow}</div></div>')

    diff_rows = "".join(
        f'<tr><td class="{"diff" if r["diff"] else "muted"}">{html.escape(str(r["key"]))}</td>'
        + "".join(f"<td>{html.escape(str(v))}</td>" for v in r["values"]) + "</tr>"
        for r in result["config_diff"])

    # per-round TTFT bars + hit-rate lines
    max_round = max((max(result["per_round"][rid].keys(), default=0) for rid in ids), default=0)
    groups = [f"R{i}" for i in range(1, max_round + 1)] or ["R1"]
    bar_series = []
    line_series = []
    radar_series = []
    for si, rid in enumerate(ids):
        ttft = [result["per_round"][rid].get(i, {}).get("ttft_avg_ms", 0) or 0 for i in range(1, max_round + 1)]
        hbm = [result["per_round"][rid].get(i, {}).get("hbm_hit_rate", 0) * 100 or 0 for i in range(1, max_round + 1)]
        ext = [result["per_round"][rid].get(i, {}).get("ext_hit_rate", 0) * 100 or 0 for i in range(1, max_round + 1)]
        bar_series.append({"data": ttft})
        line_series.append({"data": hbm})
        line_series.append({"data": ext, "dash": True})
        m = result["metrics"]
        def norm(key, invert=False):
            vals = [m[key]["values"].get(r, -1) for r in ids]
            v = m[key]["values"].get(rid, -1)
            lo, hi = min(vals), max(vals)
            if hi <= lo:
                return 75.0
            pct = (v - lo) / (hi - lo) * 100
            return 100 - pct if invert else pct
        radar_series.append({"data": [norm("hbm_hit_rate"), norm("ext_hit_rate"),
                                      norm("ttft_avg_ms", invert=True), norm("tpot_avg_ms", invert=True),
                                      norm("output_token_throughput")]})

    chart_hit = _svg_line(line_series, [f"R{i}" for i in range(1, max_round + 1)], 100)
    chart_bars = _svg_bars(groups, bar_series)
    chart_radar = _svg_radar(["HBM命中", "Ext命中", "TTFT", "TPOT", "吞吐"], radar_series)

    legend = "".join(f'<span><i style="background:{COLORS[i%len(COLORS)]}"></i>{html.escape(names[rid])}</span>'
                     for i, rid in enumerate(ids))

    dp_rows = ""
    for rid in ids:
        for dp_key, d in sorted(result["dp_matrix"].get(rid, {}).items()):
            dp_rows += (f'<tr><td>{html.escape(names[rid])}</td><td>{dp_key}</td>'
                        f'<td>{d.get("hbm_hit_rate",0)*100:.1f}%</td><td>{d.get("ext_hit_rate",0)*100:.1f}%</td></tr>')

    summary = f"共对比 {len(ids)} 个 run"
    if result["missing_rounds"]:
        summary += f"；{len(result['missing_rounds'])} 个轮次缺失（对齐留空）"

    page = _HTML_TEMPLATE.format(
        title="对比分析报告", generated=time.strftime("%Y-%m-%d %H:%M:%S"),
        summary=summary, delta_cards=delta_cards, legend=legend,
        chart_hit=chart_hit, chart_bars=chart_bars, chart_radar=chart_radar,
        diff_rows=dp_rows and f'<table><tr><th>run</th><th>DP域</th><th>HBM</th><th>Ext</th></tr>{dp_rows}</table>',
        config_rows=f'<table><tr><th>参数</th>{"".join(f"<th>{html.escape(names[r])}</th>" for r in ids)}</tr>{diff_rows}</table>',
    )
    out = config.outputs_dir() / f"compare_{time.strftime('%Y%m%d_%H%M%S')}.html"
    out.write_text(page, encoding="utf-8")
    return str(out)


_HTML_TEMPLATE = """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>{title}</title>
<style>
body{{background:#050506;color:#e9eaec;font-family:Inter,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;font-size:13px;margin:0;padding:28px}}
h1{{font-size:18px}} h2{{font-size:14px;margin:26px 0 12px;color:#a2a5ab;font-weight:600}}
.sub{{color:#6d7078;font-size:12px}}
.card{{background:#111214;border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:14px 16px}}
.grid{{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:16px 0}}
.d2{{display:grid;grid-template-columns:1.3fr 1fr;gap:12px}}
.t{{color:#a2a5ab;font-size:11.5px}} .v{{font-size:22px;font-weight:700;margin-top:4px}} .d{{font-size:12px;margin-top:3px}}
table{{border-collapse:collapse;width:100%;margin:8px 0;font-size:12px}}
th{{color:#6d7078;text-align:left;font-weight:500;padding:7px 10px;border-bottom:1px solid rgba(255,255,255,.1)}}
td{{padding:7px 10px;border-bottom:1px solid rgba(255,255,255,.05)}}
td.diff{{color:#f0be63}} .muted{{color:#6d7078}}
.legend{{display:flex;gap:14px;font-size:11px;color:#a2a5ab;margin:6px 0}}
.legend i{{display:inline-block;width:9px;height:3px;border-radius:2px;margin-right:5px;vertical-align:middle}}
</style></head><body>
<h1>{title} <span class="sub">· 生成于 {generated}</span></h1>
<p class="sub">{summary} · 预埋（warmup）阶段与练习轮已排除</p>
<div class="grid">{delta_cards}</div>
<h2>命中率对比（%）</h2><div class="legend">{legend}</div><div class="card">{chart_hit}</div>
<div class="d2">
<div><h2>各轮次 TTFT avg (ms)</h2><div class="card">{chart_bars}</div></div>
<div><h2>五维评分（归一）</h2><div class="card">{chart_radar}</div></div>
</div>
<h2>DP 域命中率</h2><div class="card">{diff_rows}</div>
<h2>配置差异（* 为差异项）</h2><div class="card">{config_rows}</div>
</body></html>"""
