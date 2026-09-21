import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { api, initConnection, onSidecarExited, restartSidecar, track, useConnected } from "./api";
import { STATUS_TEXT, type ToastPayload } from "./ui";
import ConfigPage from "./pages/ConfigPage";
import MonitorPage from "./pages/MonitorPage";
import HistoryPage from "./pages/HistoryPage";
import ComparePage from "./pages/ComparePage";
import SettingsPage from "./pages/SettingsPage";
import SlaPage from "./pages/SlaPage";

type ToastFn = (msg: string | ToastPayload) => void;
const ToastCtx = createContext<ToastFn>(() => {});
export const useToast = () => useContext(ToastCtx);

export function navigate(hash: string) {
  location.hash = hash;
}

/** 应用图标（经典 PC 徽标：135° 渐变圆角块 + 白色粗体 PC，与任务栏/开始菜单/exe 图标同构） */
export function AppIcon({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="pc-icon-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2b7fff" />
          <stop offset="1" stopColor="#13c2c2" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#pc-icon-grad)" />
      <text x="16" y="21.5" textAnchor="middle" fontSize="13" fontWeight="800"
            fill="#fff" fontFamily="Inter, 'Segoe UI', sans-serif">PC</text>
    </svg>
  );
}

const TITLES: Record<string, [string, string]> = {
  config: ["新建测试", "连接服务 · 配置参数 · 多轮计划"],
  monitor: ["运行监控", "实时指标 · 日志流 · 阶段进度"],
  history: ["运行记录", "详情 / 导出 / 标记"],
  compare: ["对比分析", "排除预埋与练习轮"],
  settings: ["设置", "通用 · 压测执行 · 诊断"],
  sla: ["SLA 调优", "相同命中率下搜索最大可用并发"],
};

export default function App() {
  const [route, setRoute] = useState(location.hash.replace(/^#\/?/, "") || "config");
  const [toasts, setToasts] = useState<(ToastPayload & { id: number })[]>([]);
  const [sidecarDown, setSidecarDown] = useState(false);
  const [activeRun, setActiveRun] = useState<{ run_id: string; name: string } | null>(null);
  const [viewedRun, setViewedRun] = useState(localStorage.getItem("pt-viewed-run") || "");
  const connected = useConnected();

  useEffect(() => {
    const onHash = () => setRoute(location.hash.replace(/^#\/?/, "") || "config");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // 数据集页已裁撤（产品决策）：旧 hash 重定向到配置页
  useEffect(() => {
    if (route.split("/")[0] === "datasets") navigate("/config");
  }, [route]);

  // 记录「已查看」的运行中 run：顶栏提示保留到被查看过为止（A1）
  useEffect(() => {
    if (route.startsWith("monitor/") && viewedRun !== route.split("/")[1]) {
      const id = route.split("/")[1];
      setViewedRun(id);
      localStorage.setItem("pt-viewed-run", id);
    }
  }, [route, viewedRun]);

  useEffect(() => {
    const saved = localStorage.getItem("pt-theme") || "auto";
    if (saved === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.dataset.theme = saved;
  }, []);
  useEffect(() => {
    initConnection();
    onSidecarExited(() => setSidecarDown(true));
  }, []);

  useEffect(() => {
    if (!connected) return;
    const tick = async () => {
      try {
        const r = await api.get<{ run: { run_id: string; name: string } | null }>("/api/runs/active");
        setActiveRun(r.run);
      } catch { /* sidecar offline */ }
    };
    tick();
    const t = setInterval(tick, 5000);
    return () => clearInterval(t);
  }, [connected]);

  // toast 队列：错误常驻（手动关闭），其余自动消失（§5）
  const toastId = useRef(0);
  const toast = useCallback<ToastFn>((msgOrPayload) => {
    const p: ToastPayload = typeof msgOrPayload === "string"
      ? { msg: msgOrPayload } : msgOrPayload;
    const id = ++toastId.current;
    setToasts((ts) => [...ts.slice(-2), { ...p, id }]);
    if (p.kind === "error") {
      track("error_surface", { code: p.msg.slice(0, 200), page: location.hash.slice(2) || "config" });
    }
    const dur = p.duration ?? (p.kind === "error" ? 0 : p.action ? 7000 : 5000);
    if (dur > 0) {
      window.setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), dur);
    }
  }, []);
  const closeToast = (id: number) => setToasts((ts) => ts.filter((t) => t.id !== id));

  const pageKey = route.split("/")[0];
  const [title, crumb] = TITLES[pageKey] ?? TITLES.monitor;
  const monitorId = pageKey === "monitor" ? route.split("/")[1] : "";
  const showActive = activeRun && activeRun.run_id !== viewedRun;

  const nav = (key: string, label: string, icon: React.ReactNode) => (
    <div key={key}
      className={`nav-item${(pageKey === key) || (key === "history" && pageKey === "monitor") ? " active" : ""}`}
      onClick={() => navigate(`/${key}`)}
      role="link" tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && navigate(`/${key}`)}>
      {icon}
      {label}
    </div>
  );
  const i = (d: string) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d={d} /></svg>
  );

  return (
    <ToastCtx.Provider value={toast}>
      <aside id="sidebar">
        <div className="logo">
          <div className="logo-mark"><AppIcon size={30} /></div>
          <div><b>前缀复用测试器</b><span>AISBench Prefix Tester</span></div>
        </div>
        <nav className="nav">
          {nav("config", "新建测试", i("M12 5v14M5 12h14"))}
          {nav("history", "运行记录", i("M3 12a9 9 0 1 0 9-9 9 9 0 0 0-7.6 4.2M3 3v5h5"))}
          {nav("compare", "对比分析", i("M8 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3M16 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-3M12 1v22"))}
          {nav("sla", "SLA 调优", i("M3 3v18h18M8 17V9m5 8V5m5 12v-6"))}
          {nav("settings", "设置", i("M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5h.1a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"))}
        </nav>
        <div className="side-foot">
          Sidecar{" "}
          <span className={connected ? "ok" : ""}>
            {connected ? "● 已连接" : "○ 连接中"}
          </span>
          <br />
          前缀复用测试器 v0.2.1
        </div>
      </aside>

      <div id="main">
        <header id="topbar">
          {pageKey === "monitor" && monitorId ? (
            <>
              <h1>{title}</h1>
              <span className="crumb">
                <a onClick={() => navigate("/history")} style={{ cursor: "pointer" }}>← 运行记录</a>
                {" / "}
                <span className="mono">{monitorId}</span>
              </span>
            </>
          ) : (
            <>
              <h1>{title}</h1>
              <span className="crumb">{crumb}</span>
            </>
          )}
          <div className="top-right">
            {showActive && (
              <span className="chip" style={{ cursor: "pointer", borderColor: "var(--brand)", color: "var(--text)" }}
                title="有正在运行的测试，点击打开运行监控"
                onClick={() => navigate(`/monitor/${activeRun!.run_id}`)}>
                <span className="dot pulse" /> {activeRun!.name}
              </span>
            )}
            <span className="chip">
              <span className="dot" style={{ background: connected ? undefined : "#e5484d" }} />
              {connected ? "Sidecar 就绪" : "Sidecar 连接中"}
            </span>
          </div>
        </header>
        <div id="content">
          {sidecarDown && (
            <div className="banner">
              ⚠ Sidecar 进程异常退出，运行数据已落盘。
              <button className="btn sm primary" style={{ marginLeft: "auto" }}
                onClick={async () => {
                  await restartSidecar();
                  setSidecarDown(false);
                  toast("Sidecar 已重启");
                }}>
                一键重启
              </button>
            </div>
          )}
          {!connected && !sidecarDown && (
            <div className="banner warn">
              ⚠ 服务未连接，重连中…（自包含环境预热约 30–60 秒，页面可先浏览，数据就绪后自动加载）
            </div>
          )}
          <div className="page">
            {pageKey === "config" && <ConfigPage />}
            {pageKey === "monitor" && <MonitorPage route={route} />}
            {pageKey === "history" && <HistoryPage />}
            {pageKey === "compare" && <ComparePage />}
            {pageKey === "settings" && <SettingsPage />}
            {pageKey === "sla" && <SlaPage />}
          </div>
        </div>
      </div>

      <div id="toast">
        {toasts.map((t) => (
          <div key={t.id} className={`toast-item ${t.kind ?? ""}`} role="status">
            <span>{t.kind === "success" ? "✓ " : t.kind === "error" ? "✕ " : ""}{t.msg}</span>
            {t.action && (
              <button className="t-act" onClick={() => { t.action!.onClick(); closeToast(t.id); }}>
                {t.action.label}
              </button>)}
            <button className="t-x" aria-label="关闭提示" onClick={() => closeToast(t.id)}>✕</button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export { STATUS_TEXT };
