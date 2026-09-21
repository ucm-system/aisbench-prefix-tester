import { useEffect, useState } from "react";
import { api, restartSidecar, useConnected } from "../api";
import { useToast } from "../App";
import { ConfirmModal } from "../ui";

type Tab = "general" | "exec" | "tokenizer" | "about";
const TABS: { key: Tab; label: string }[] = [
  { key: "general", label: "通用" },
  { key: "exec", label: "压测执行" },
  { key: "tokenizer", label: "Tokenizer 资产" },
  { key: "about", label: "关于" },
];

export default function SettingsPage() {
  const toast = useToast();
  const connected = useConnected();
  const [tab, setTab] = useState<Tab>("general");
  const [items, setItems] = useState<{ ok: boolean; name: string; detail: string; hint: string }[]>([]);
  const [diagOpen, setDiagOpen] = useState(false);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [theme, setTheme] = useState(localStorage.getItem("pt-theme") || "auto");
  const [regDir, setRegDir] = useState("");
  const [runtime, setRuntime] = useState<"" | "frozen" | "source">("");
  const [home, setHome] = useState("");
  const [tokList, setTokList] = useState<{ name: string; path: string; source: string; version?: string }[]>([]);
  const [verifying, setVerifying] = useState<string | null>(null);
  const [restartOpen, setRestartOpen] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [activeRun, setActiveRun] = useState<{ run_id: string; name: string } | null>(null);

  const load = () => {
    api.get<any>("/api/diagnosis").then((d) => setItems(d.items)).catch(() => setItems([]));
    api.get<Record<string, string>>("/api/settings").then(setSettings).catch(() => {});
    api.get<{ runtime?: string; home?: string }>("/api/health")
      .then((h) => { setRuntime((h.runtime as any) ?? ""); setHome(h.home ?? ""); }).catch(() => {});
    api.get<{ name: string; path: string; source: string; version?: string }[]>("/api/tokenizers")
      .then(setTokList).catch(() => {});
    api.get<{ run: { run_id: string; name: string } | null }>("/api/runs/active")
      .then((r) => setActiveRun(r.run)).catch(() => {});
  };
  useEffect(() => { if (connected) load(); }, [connected]);

  const set = (k: string, v: string) => {
    setSettings((s) => ({ ...s, [k]: v }));
    api.put("/api/settings", { [k]: v })
      .catch((e) => toast({ msg: `保存失败：${e.message}`, kind: "error" }));
  };

  const diagSummary = () => {
    const bad = items.filter((i) => !i.ok);
    const ais = items.find((i) => i.name.includes("AISBench"));
    const disk = items.find((i) => i.name === "磁盘空间");
    const mode = items.find((i) => i.name === "运行模式");
    const selfContained = (mode?.detail ?? "").includes("自包含");
    return `${bad.length === 0 ? "✓" : "⚠"} ${selfContained ? "自包含" : mode?.detail?.split(" — ")[0] ?? ""}` +
      ` · ais_bench ${ais?.ok ? "正常" : "异常"}` +
      (disk ? ` · ${disk.detail.replace(/.*剩余 /, "磁盘剩余 ").replace(/GB.*/, "GB")}` : "");
  };

  return (
    <>
      {/* 环境诊断：折叠为首行摘要（U7/G3：展开才有逐项 + 重新检测 + 重启） */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="diag-summary" onClick={() => setDiagOpen((v) => !v)} role="button"
             tabIndex={0} onKeyDown={(e) => e.key === "Enter" && setDiagOpen((v) => !v)}
             aria-expanded={diagOpen}>
          <span className="ok-line">
            <b style={{ fontSize: 13 }}>{diagSummary()}</b>
          </span>
          <span style={{ marginLeft: "auto", color: "var(--muted)", fontSize: 12 }}>
            {diagOpen ? "收起 ▴" : "展开 ▾"}
          </span>
        </div>
        {diagOpen && (
          <>
            {items.map((it, i) => (
              <div className="diag-item" key={i} style={i === items.length - 1 ? { border: "none" } : undefined}>
                <div className={`ic ${it.ok ? "ok" : "bad"}`}>{it.ok ? "✓" : "✕"}</div>
                <div>
                  <b>{it.name}</b>
                  <p>{it.detail}</p>
                  {it.hint && <p style={{ color: "var(--brand)" }}>{it.hint}</p>}
                </div>
              </div>
            ))}
            {!items.length && <div className="subnote">Sidecar 未连接，无法诊断。</div>}
            <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
              <button className="btn sm" onClick={load}>重新检测</button>
              <button className="btn sm danger" onClick={() => setRestartOpen(true)}>重启 Sidecar</button>
            </div>
          </>
        )}
      </div>

      <div className="settings-grid">
        <div className="settings-tabs" role="tablist">
          {TABS.map((t) => (
            <div key={t.key} className={`st-item${tab === t.key ? " on" : ""}`}
              role="tab" aria-selected={tab === t.key} tabIndex={0}
              onClick={() => setTab(t.key)}
              onKeyDown={(e) => e.key === "Enter" && setTab(t.key)}>{t.label}</div>
          ))}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
          {tab === "general" && (
            <div className="card">
              <h3>通用</h3>
              <div className="kv"><span>主题</span>
                <select className="sel" style={{ maxWidth: 150 }} value={theme}
                  onChange={(e) => {
                    const v = e.target.value;
                    setTheme(v);
                    localStorage.setItem("pt-theme", v);
                    if (v === "auto") document.documentElement.removeAttribute("data-theme");
                    else document.documentElement.dataset.theme = v;
                  }}>
                  <option value="auto">跟随系统</option>
                  <option value="light">浅色</option>
                  <option value="dark">深色</option>
                </select></div>
              <div className="kv"><span>新 run 的默认采集间隔</span>
                <div className="seg">
                  {["2", "5", "10", "30"].map((v) => (
                    <span key={v} className={(settings.collection_interval ?? "5") === v ? "on" : ""}
                      onClick={() => set("collection_interval", v)}>{v}s</span>
                  ))}
                </div></div>
              <div className="subnote" style={{ marginTop: 8 }}>
                此值为新 run 的<b>默认</b>采集间隔；单次 run 可在「新建测试 → 并发与调度」覆盖。
                活动期（有请求在跑）自动提升到 1s，空闲回落到设置值。
              </div>
            </div>
          )}

          {tab === "exec" && (
            <div className="card">
              <h3>压测执行</h3>
              {runtime === "frozen" ? (
                <>
                  <div className="kv"><span>AISBench 运行时</span>
                    <b>{(() => {
                      const c = (settings.aisbench_command ?? "").trim();
                      return c && c !== "ais_bench" && !c.includes("--child-aisbench")
                        ? "⚠ 自定义命令覆盖（未使用内置运行时）"
                        : "内置自包含（Python + ais_bench 随包，无需配置）";
                    })()}</b></div>
                  <div className="field" style={{ margin: "10px 0" }}>
                    <label>aisbench 命令覆盖（留空 = 使用随包内置运行时；仅指向 mock/调试版时填写）</label>
                    <input className="inp mono" value={settings.aisbench_command ?? ""}
                      placeholder="留空 = 内置运行时"
                      onChange={(e) => set("aisbench_command", e.target.value)} />
                  </div>
                  <div className="kv"><span>work_path</span><b>内置模式不需要</b></div>
                  <div className="subnote" style={{ margin: "8px 0" }}>
                    内置运行时通过 --child-aisbench 自引用执行；填入外部命令后，环境诊断会如实标注「已被自定义命令覆盖」。
                  </div>
                </>
              ) : (
                <>
                  <div className="field" style={{ marginBottom: 10 }}>
                    <label>aisbench 命令（默认自动探测 ais_bench CLI；无 GPU 环境可指向 tools/mock_aisbench.py）</label>
                    <input className="inp mono" value={settings.aisbench_command ?? ""}
                      onChange={(e) => set("aisbench_command", e.target.value)} />
                  </div>
                  <div className="field" style={{ marginBottom: 10 }}>
                    <label>AISBench 工作区 work_path（留空=自动探测 site-packages；仅源码/开发模式需要）</label>
                    <input className="inp mono" value={settings.work_path ?? ""}
                      onChange={(e) => set("work_path", e.target.value)} />
                  </div>
                </>
              )}
              <div className="subnote" style={{ marginTop: 8 }}>
                修改命令后新 run 生效；正在运行的 run 不受影响。
              </div>
            </div>
          )}

          {tab === "tokenizer" && (
            <div className="card">
              <h3>Tokenizer 资产</h3>
              <div className="row" style={{ alignItems: "center", marginBottom: 12 }}>
                <div className="subnote" style={{ width: 140 }}>注册自定义模型目录：</div>
                <input className="inp mono" style={{ flex: 1 }} placeholder="D:\path\to\model-dir（含 tokenizer.json）"
                  value={regDir} onChange={(e) => setRegDir(e.target.value)} />
                <button className="btn sm" onClick={async () => {
                  if (!regDir.trim()) { toast("请先填写目录"); return; }
                  try {
                    await api.post("/api/tokenizers", { name: regDir.split(/[\\/]/).pop(), path: regDir });
                    toast({ msg: "已注册", kind: "success" }); setRegDir(""); load();
                  } catch (e: any) { toast({ msg: e.message, kind: "error" }); }
                }}>注册</button>
              </div>
              {/* 已注册列表（G2：来源/路径/删除/测试加载） */}
              {tokList.map((t) => (
                <div className="tok-item" key={t.name}>
                  <div className="grow">
                    <b>{t.name}</b>
                    <span className={`tag ${t.source === "local" ? "cyan" : t.source === "assets" ? "blue" : "gray"}`}
                      style={{ marginLeft: 8, padding: "0 7px" }}>{t.source}</span>
                    <span className="mono">{t.path}</span>
                  </div>
                  <button className="btn sm ghost" disabled={verifying === t.name}
                    onClick={async () => {
                      setVerifying(t.name);
                      try {
                        const r = await api.post<any>("/api/tokenizers/verify", { name_or_path: t.name });
                        toast({ msg: `${t.name}：${r.ok ? "加载成功" + (r.vocab_size ? `（词表 ${r.vocab_size}）` : "") : `加载失败：${r.error}`}`, kind: r.ok ? "success" : "error" });
                      } catch (e: any) { toast({ msg: `校验失败：${e.message}`, kind: "error" }); }
                      finally { setVerifying(null); }
                    }}>{verifying === t.name ? "测试中…" : "测试加载"}</button>
                  <button className="btn sm ghost" title="删除"
                    onClick={async () => {
                      if (!confirm(`删除 tokenizer「${t.name}」？（不删文件，仅从注册表移除）`)) return;
                      try {
                        await api.del(`/api/tokenizers/${encodeURIComponent(t.name)}`);
                        toast("已删除"); load();
                      } catch (e: any) { toast({ msg: `删除失败：${e.message}`, kind: "error" }); }
                    }}>✕</button>
                </div>
              ))}
              {!tokList.length && <div className="subnote">暂无注册项</div>}
              <div className="subnote" style={{ marginTop: 10 }}>
                应用打包目录 assets/model 与本机 D:\Models 下的 tokenizer 会自动注册；
                从 ModelScope 下载新 tokenizer 的方法见 docs/MODELSCOPE_TOKENIZER.md。
              </div>
            </div>
          )}

          {tab === "about" && (
            <div className="card">
              <h3>关于</h3>
              <div className="kv"><span>应用</span><b>AISBench 前缀复用测试器</b></div>
              <div className="kv"><span>版本</span><b>v0.1.0（UX v0.2 重设计）</b></div>
              <div className="kv"><span>数据目录</span>
                <b className="mono" style={{ fontSize: 11 }}>{home || "…"}（app.db / outputs / datasets）</b></div>
              <div className="kv" style={{ borderBottom: "none" }}>
                <span>指标口径</span>
                <b style={{ fontWeight: 400, fontSize: 11.5 }}>Δhits/Δqueries（阶段快照差分）· 综合 = ext×(1−hbm)+hbm</b>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 重启确认（G3：活动 run 警告 + loading + 完成提示） */}
      <ConfirmModal open={restartOpen} title="重启 Sidecar" danger
        message={activeRun
          ? `⚠ 当前有正在运行的测试「${activeRun.name}」，重启将中断该 run（重启后自动对账标记为已中断）。\n确认重启？`
          : "重启 Sidecar 会断开当前连接并重新预热环境（自包含模式约 30-60 秒）。\n确认重启？"}
        confirmText="重启" busy={restarting}
        onCancel={() => setRestartOpen(false)}
        onConfirm={async () => {
          setRestarting(true);
          try {
            await restartSidecar();
            setRestarting(false);
            setRestartOpen(false);
            toast({ msg: "Sidecar 已重启", kind: "success" });
            load();
          } catch (e: any) {
            setRestarting(false);
            toast({ msg: `重启失败：${e.message}`, kind: "error" });
          }
        }} />
    </>
  );
}
