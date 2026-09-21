/* v0.2 共享 UI 组件（UX-REDESIGN §7：状态徽标双编码、空/载/错三态、弹层、toast payload） */
import React, { useCallback, useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------- run status
export const STATUS_TEXT: Record<string, string> = {
  completed: "已完成", running: "运行中", failed: "失败", cancelled: "已停止",
  pending: "排队中", interrupted: "已中断", connecting: "连接中",
  reconnecting: "连接断开", not_found: "记录不存在", load_failed: "加载失败",
};
export const STATUS_CLASS: Record<string, string> = {
  completed: "done", running: "run", failed: "fail", cancelled: "stop",
  pending: "pending", interrupted: "interrupt",
};

export function StatusBadge({ status, title }: { status: string; title?: string }) {
  return (
    <span className={`badge ${STATUS_CLASS[status] ?? "pending"}`} title={title}>
      {STATUS_TEXT[status] ?? status}
    </span>
  );
}

// ---------------------------------------------------------------- toast payload
export type ToastPayload = {
  msg: string;
  kind?: "info" | "success" | "error";
  action?: { label: string; onClick: () => void };
  duration?: number; // ms; 0 = 常驻（错误默认常驻）
};
export type ToastFn = (msg: string | ToastPayload) => void;

// ---------------------------------------------------------------- modal
export function Modal({ open, title, onClose, children, footer, width }: {
  open: boolean; title: React.ReactNode; onClose: () => void;
  children?: React.ReactNode; footer?: React.ReactNode; width?: number;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="modal-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={width ? { width } : undefined} role="dialog" aria-label={typeof title === "string" ? title : "对话框"}>
        <h4>{title}</h4>
        {children && <div className="msg">{children}</div>}
        <div className="foot">{footer}</div>
      </div>
    </div>
  );
}

export function ConfirmModal({ open, title, message, confirmText = "确认", danger, busy,
                               onConfirm, onCancel }: {
  open: boolean; title: string; message: React.ReactNode; confirmText?: string;
  danger?: boolean; busy?: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <Modal open={open} title={<>{danger ? <span style={{ color: "var(--danger)" }}>⚠</span> : <span>ℹ</span>}{title}</>}
      onClose={onCancel}
      footer={<>
        <button className="btn ghost" onClick={onCancel}>取消</button>
        <button className={`btn ${danger ? "danger primary" : "primary"}`} disabled={busy}
          onClick={onConfirm}>{busy ? "处理中…" : confirmText}</button>
      </>}>
      {message}
    </Modal>
  );
}

// ---------------------------------------------------------------- tri-state
export function EmptyState({ icon = "◍", title, hint, action }: {
  icon?: React.ReactNode; title: string; hint?: string; action?: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="ico">{icon}</div>
      <b>{title}</b>
      {hint && <div className="subnote">{hint}</div>}
      {action}
    </div>
  );
}

export function ErrorState({ msg, onRetry }: { msg: string; onRetry?: () => void }) {
  return (
    <div className="error-state">
      <span>✕ {msg}</span>
      {onRetry && <button className="btn sm" onClick={onRetry}>重试</button>}
    </div>
  );
}

export function Skeleton({ h = 120 }: { h?: number }) {
  return <div className="skeleton" style={{ height: h }} aria-label="加载中" />;
}

// ---------------------------------------------------------------- misc
export function Breadcrumb({ items }: { items: { label: string; onClick?: () => void }[] }) {
  return (
    <div className="breadcrumb">
      {items.map((it, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span className="sep">/</span>}
          {it.onClick
            ? <a onClick={it.onClick} role="link" tabIndex={0}
                 onKeyDown={(e) => e.key === "Enter" && it.onClick!()}>← {it.label}</a>
            : <span style={{ color: "var(--text2)" }}>{it.label}</span>}
        </React.Fragment>
      ))}
    </div>
  );
}

export function Pagination({ page, pages, onPage }: {
  page: number; pages: number; onPage: (p: number) => void;
}) {
  if (pages <= 1) return null;
  const nums: number[] = [];
  for (let p = Math.max(1, page - 2); p <= Math.min(pages, page + 2); p++) nums.push(p);
  return (
    <div className="pagination">
      <span>第 {page} / {pages} 页</span>
      <button disabled={page <= 1} onClick={() => onPage(page - 1)}>‹ 上一页</button>
      {nums.map((p) => (
        <button key={p} className={p === page ? "cur" : ""} onClick={() => onPage(p)}>{p}</button>
      ))}
      <button disabled={page >= pages} onClick={() => onPage(page + 1)}>下一页 ›</button>
    </div>
  );
}

/** 口径提示图标（A5：指标卡/图例 hover 显示公式与来源） */
export function InfoTip({ text }: { text: string }) {
  return <span className="tip" data-tip={text} tabIndex={0} aria-label={text}>ⓘ</span>;
}

export function downloadTextFile(name: string, text: string, mime = "text/csv;charset=utf-8") {
  const blob = new Blob(["\uFEFF" + text], { type: mime }); // BOM: Excel 中文友好
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function toCsv(headers: string[], rows: (string | number)[][]) {
  const esc = (v: string | number) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.map(esc).join(","), ...rows.map((r) => r.map(esc).join(","))].join("\n");
}

/** localStorage-backed state（草稿/日志高度/主题偏好等） */
export function useLocalState<T>(key: string, initial: T) {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw != null ? (JSON.parse(raw) as T) : initial;
    } catch { return initial; }
  });
  const set = useCallback((nv: T | ((p: T) => T)) => {
    setV((prev) => {
      const next = typeof nv === "function" ? (nv as (p: T) => T)(prev) : nv;
      try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* quota */ }
      return next;
    });
  }, [key]);
  return [v, set] as const;
}

/** 元素宽度（ResizeObserver）——自绘 SVG 图表自适应容器 */
export function useElemWidth<T extends HTMLElement>(fallback = 560) {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    if (!ref.current) return;
    const el = ref.current;
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0]?.contentRect.width;
      if (cw && cw > 20) setW(cw);
    });
    ro.observe(el);
    setW(el.getBoundingClientRect().width || fallback);
    return () => ro.disconnect();
  }, [fallback]);
  return [ref, w] as const;
}

export const fmtDur = (s: number) => {
  if (!Number.isFinite(s) || s <= 0) return "—";
  const m = Math.floor(s / 60), sec = Math.round(s % 60);
  return m > 0 ? `${m}m${sec.toString().padStart(2, "0")}s` : `${sec}s`;
};
