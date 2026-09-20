import { useEffect, useState } from "react";
import { api, restartSidecar } from "../api";
import { useToast } from "../App";

export default function SettingsPage() {
  const toast = useToast();
  const [items, setItems] = useState<{ ok: boolean; name: string; detail: string; hint: string }[]>([]);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [theme, setTheme] = useState(localStorage.getItem("pt-theme") || "auto");
  const [regDir, setRegDir] = useState("");

  const load = () => {
    api.get<any>("/api/diagnosis").then((d) => setItems(d.items)).catch(() => setItems([]));
    api.get<Record<string, string>>("/api/settings").then(setSettings).catch(() => {});
  };
  useEffect(load, []);

  const set = (k: string, v: string) => {
    setSettings((s) => ({ ...s, [k]: v }));
    api.put("/api/settings", { [k]: v })
      .catch((e) => toast(`保存失败：${e.message}`));
  };

  return (
    <div className="grid2">
      <div className="card">
        <h3>环境诊断
          <button className="btn sm ghost" style={{ marginLeft: "auto" }} onClick={load}>重新检测</button>
        </h3>
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
        <div style={{ borderTop: "1px solid var(--border)", margin: "12px 0" }} />
        <button className="btn sm" onClick={async () => {
          await restartSidecar(); toast("Sidecar 已重启"); load();
        }}>重启 Sidecar</button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="card">
          <h3>压测执行</h3>
          <div className="field" style={{ marginBottom: 10 }}>
            <label>aisbench 命令（默认自动探测 ais_bench CLI；无 GPU 环境可指向 tools/mock_aisbench.py）</label>
            <input className="inp mono" value={settings.aisbench_command ?? ""}
              onChange={(e) => set("aisbench_command", e.target.value)} />
          </div>
          <div className="field" style={{ marginBottom: 10 }}>
            <label>AISBench 工作区 work_path（留空=自动探测 site-packages）</label>
            <input className="inp mono" value={settings.work_path ?? ""}
              onChange={(e) => set("work_path", e.target.value)} />
          </div>
          <div className="kv"><span>指标轮询间隔（秒）</span>
            <div className="seg">
              {["2", "5", "10", "30"].map((v) => (
                <span key={v} className={(settings.collection_interval ?? "5") === v ? "on" : ""}
                  onClick={() => set("collection_interval", v)}>{v}s</span>))}
            </div></div>
          <div className="kv" style={{ borderBottom: "none" }}>
            <span>新测试默认在「新建测试」页配置</span><span />
          </div>
        </div>
        <div className="card">
          <h3>外观</h3>
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
          <div className="kv" style={{ borderBottom: "none" }}><span>即时生效，重启后保持；浅色主题已全面适配对比度</span><span /></div>
        </div>
        <div className="card">
          <h3>Tokenizer 资产</h3>
          <div className="row" style={{ alignItems: "center" }}>
            <div className="subnote" style={{ width: 140 }}>注册自定义模型目录：</div>
            <input className="inp mono" style={{ flex: 1 }} placeholder="D:\path\to\model-dir（含 tokenizer.json）"
              value={regDir} onChange={(e) => setRegDir(e.target.value)} />
            <button className="btn sm" onClick={async () => {
              if (!regDir.trim()) { toast("请先填写目录"); return; }
              try {
                await api.post("/api/tokenizers", { name: regDir.split(/[\\/]/).pop(), path: regDir });
                toast("已注册"); setRegDir(""); load();
              } catch (e: any) { toast(e.message); }
            }}>注册</button>
          </div>
          <div className="subnote" style={{ marginTop: 8 }}>
            应用打包目录 assets/model 与本机 D:\Models 下的 tokenizer 会自动注册，无需手工添加；
            从 ModelScope 下载新 tokenizer 的方法见 docs/MODELSCOPE_TOKENIZER.md。
          </div>
        </div>
        <div className="card">
          <h3>关于</h3>
          <div className="kv"><span>应用</span><b>AISBench 前缀复用测试器</b></div>
          <div className="kv"><span>版本</span><b>v0.1.0</b></div>
          <div className="kv" style={{ borderBottom: "none" }}>
            <span>数据目录</span><b className="mono" style={{ fontSize: 11 }}>%APPDATA%/AISBenchPrefixTester</b>
          </div>
        </div>
      </div>
    </div>
  );
}
