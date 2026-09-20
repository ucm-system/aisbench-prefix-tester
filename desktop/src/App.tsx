import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { api, connStatus, initConnection, onSidecarExited, restartSidecar } from "./api";
import ConfigPage from "./pages/ConfigPage";
import MonitorPage from "./pages/MonitorPage";
import HistoryPage from "./pages/HistoryPage";
import ComparePage from "./pages/ComparePage";
import SettingsPage from "./pages/SettingsPage";
import SlaPage from "./pages/SlaPage";

type Toast = (msg: string) => void;
const ToastCtx = createContext<Toast>(() => {});
export const useToast = () => useContext(ToastCtx);

export function navigate(hash: string) {
  location.hash = hash;
}

const TITLES: Record<string, [string, string]> = {
  config: ["新建测试", "配置 · 预设 · 数据集 · 多轮计划"],
  monitor: ["运行监控", "实时指标 · 日志流 · 阶段进度"],
  history: ["运行记录", "详情 / 导出 / 标记"],
  compare: ["对比分析", "排除预埋与练习轮"],
  settings: ["设置", "环境诊断 · 采集 · 关于"],
  sla: ["SLA 调优", "相同命中率下搜索最大可用并发"],
};

export default function App() {
  const [route, setRoute] = useState(location.hash.replace(/^#\/?/, "") || "config");
  const [toastMsg, setToastMsg] = useState("");
  const [sidecarDown, setSidecarDown] = useState(false);
  const [ready, setReady] = useState(false);
  const [activeRun, setActiveRun] = useState<{ run_id: string; name: string } | null>(null);

  useEffect(() => {
    const onHash = () => setRoute(location.hash.replace(/^#\/?/, "") || "config");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // monitor/datasets are no longer nav tabs: monitor is reached via jumps,
  // datasets management moved into config/settings — redirect stale hashes
  useEffect(() => {
    if (route.split("/")[0] === "datasets") navigate("/config");
  }, [route]);

  useEffect(() => {
    const saved = localStorage.getItem("pt-theme") || "auto";
    if (saved === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.dataset.theme = saved;
  }, []);
  useEffect(() => {
    (async () => {
      await initConnection();
      setReady(true);
    })();
    onSidecarExited(() => setSidecarDown(true));
  }, []);

  // global "a run is active" indicator → jump back into the live monitor view
  useEffect(() => {
    if (!ready) return;
    const tick = async () => {
      try {
        const rs = await api.get<{ run_id: string; status: string; name: string }[]>("/api/runs");
        const act = rs.find((r) => r.status === "running" || r.status === "pending");
        setActiveRun(act ? { run_id: act.run_id, name: act.name || act.run_id } : null);
      } catch { /* sidecar offline */ }
    };
    tick();
    const t = setInterval(tick, 5000);
    return () => clearInterval(t);
  }, [ready]);

  const toastTimer = useRef<number | null>(null);
  const toast = useCallback<Toast>((msg) => {
    setToastMsg(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastMsg(""), 2600);
  }, []);

  const pageKey = route.split("/")[0];
  const [title, crumb] = TITLES[pageKey] ?? TITLES.monitor;

  const nav = (key: string, label: string, icon: React.ReactNode, badge?: number) => (
    <div key={key} className={`nav-item${pageKey === key ? " active" : ""}`}
      onClick={() => navigate(`/${key}`)}>
      {icon}
      {label}
      {badge ? <span className="nav-badge">{badge}</span> : null}
    </div>
  );
  const i = (d: string) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d={d} /></svg>
  );

  return (
    <ToastCtx.Provider value={toast}>
      <aside id="sidebar">
        <div className="logo">
          <div className="logo-mark">PC</div>
          <div><b>前缀复用测试器</b><span>AISBench Prefix Tester</span></div>
        </div>
        <nav className="nav">
          {nav("config", "新建测试", i("M12 5v14M5 12h14"))}
          {nav("history", "运行记录", i("M3 12a9 9 0 1 0 9-9 9 9 0 0 0-7.6 4.2M3 3v5h5"))}
          {nav("compare", "对比分析", i("M8 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3M16 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-3M12 1v22"))}
          {nav("settings", "设置", i("M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5h.1a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"))}
          {nav("sla", "SLA 调优", i("M3 3v18h18M8 17V9m5 8V5m5 12v-6"))}
        </nav>
        <div className="side-foot">
          Sidecar{" "}
          <span className={connStatus.connected ? "ok" : ""}>
            {connStatus.connected ? "● 已连接" : "○ 未连接"}
          </span>
          <br />
          前缀复用测试器 v0.1.0
        </div>
      </aside>

      <div id="main">
        <header id="topbar">
          <h1>{title}</h1>
          <span className="crumb">{crumb}</span>
          <div className="top-right">
            {activeRun && (
              <span className="chip" style={{ cursor: "pointer", borderColor: "var(--brand)", color: "var(--text)" }}
                title="有正在运行的测试，点击打开运行监控"
                onClick={() => navigate(`/monitor/${activeRun.run_id}`)}>
                <span className="dot pulse" /> {activeRun.name}
              </span>
            )}
            <span className="chip">
              <span className="dot" style={{ background: connStatus.connected ? undefined : "#e5484d" }} />
              {connStatus.connected ? "Sidecar 就绪" : "Sidecar 离线"}
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
          {ready && (
            <>
              {pageKey === "config" && <ConfigPage />}
              {pageKey === "monitor" && <MonitorPage route={route} />}
              {pageKey === "history" && <HistoryPage />}
              {pageKey === "compare" && <ComparePage />}
              {pageKey === "settings" && <SettingsPage />}
              {pageKey === "sla" && <SlaPage />}
            </>
          )}
        </div>
      </div>
      <div id="toast" style={{
        position: "fixed", bottom: 26, left: "50%", transform: `translateX(-50%) translateY(${toastMsg ? 0 : 80}px)`,
        background: "var(--bg3)", border: "1px solid var(--border2)", color: "var(--text)",
        padding: "10px 18px", borderRadius: 10, fontSize: 12.5, zIndex: 99, transition: ".25s",
        boxShadow: "0 10px 30px rgba(0,0,0,.5)",
      }}>{toastMsg}</div>
    </ToastCtx.Provider>
  );
}
