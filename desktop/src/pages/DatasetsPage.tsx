import { useEffect, useState } from "react";
import { api } from "../api";
import { useToast } from "../App";

type Tok = { name: string; path: string; source: string };
type Ds = { id: string; name: string; mode: string; tokenizer: string;
  params: any; files: any; stats: any; created_at: number };

export default function DatasetsPage() {
  const toast = useToast();
  const [toks, setToks] = useState<Tok[]>([]);
  const [dss, setDss] = useState<Ds[]>([]);
  const [form, setForm] = useState({ tokenizer: "", mode: "text", input_len: 32768,
    data_num: 160, repeat_rate: "90", prefix_num: 160, dp: 1, seed: 42 });
  const [job, setJob] = useState<{ job_id: string; state: string; percent: number } | null>(null);
  const [regDir, setRegDir] = useState("");

  const load = () => {
    api.get<Tok[]>("/api/tokenizers").then((t) => {
      setToks(t);
      setForm((f) => ({ ...f, tokenizer: f.tokenizer || t[0]?.name || "" }));
    }).catch(() => {});
    api.get<Ds[]>("/api/datasets").then(setDss).catch(() => {});
  };
  useEffect(load, []);

  useEffect(() => {
    if (!job || job.state === "completed" || job.state === "failed" || job.state === "cancelled") return;
    const t = setInterval(async () => {
      const j = await api.get<any>(`/api/jobs/${job.job_id}`);
      setJob(j);
      if (j.state === "completed" || j.state === "failed") { load(); }
    }, 800);
    return () => clearInterval(t);
  }, [job?.job_id, job?.state]);

  const generate = async () => {
    try {
      const r = await api.post<{ job_id: string }>("/api/datasets/generate", {
        tokenizer: form.tokenizer, mode: form.mode, input_len: form.input_len,
        data_num: form.data_num, repeat_rate: `${form.repeat_rate}%`,
        prefix_num: form.prefix_num, dp: form.dp, seed: form.seed,
        name: `${form.mode}·${form.input_len}·${form.repeat_rate}%`,
      });
      setJob({ job_id: r.job_id, state: "pending", percent: 0 });
    } catch (e: any) { toast(`生成失败：${e.message}`); }
  };

  const preview = async (ds: Ds) => {
    try {
      const pv = await api.post<any>("/api/datasets/preview", {
        tokenizer: ds.tokenizer, input_len: ds.params.input_len,
        repeat_rate: ds.params.repeat_rate, mode: ds.mode, seed: ds.params.seed,
      });
      toast(`预览：实测 ${pv.measured_lengths.join("/")} tok（目标 ${pv.target}）· 预估命中 ${(pv.est_hit_rate * 100).toFixed(1)}%`);
    } catch (e: any) { toast(e.message); }
  };

  return (
    <>
      <div className="card" style={{ marginBottom: 14 }}>
        <h3>快速生成 <span className="sec-tag">纯随机词表合成 · GSM8K JSONL 容器 · 不依赖真实数据集</span></h3>
        <div className="row" style={{ marginBottom: 12 }}>
          <div className="field"><label>Tokenizer</label>
            <select className="sel" value={form.tokenizer}
              onChange={(e) => setForm({ ...form, tokenizer: e.target.value })}>
              {toks.map((t) => <option key={t.name} value={t.name}>{t.name}（{t.source}）</option>)}
            </select></div>
          <div className="field" style={{ maxWidth: 160 }}><label>模式</label>
            <select className="sel" value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}>
              <option value="text">gsm8k 文本</option><option value="tokenid">tokenid 精确</option>
            </select></div>
          <div className="field"><label>input_len</label>
            <input className="inp mono" value={form.input_len} onChange={(e) => setForm({ ...form, input_len: +e.target.value || 0 })} /></div>
          <div className="field"><label>data_num</label>
            <input className="inp mono" value={form.data_num} onChange={(e) => setForm({ ...form, data_num: +e.target.value || 0 })} /></div>
          <div className="field"><label>repeat_rate %</label>
            <input className="inp mono" value={form.repeat_rate} onChange={(e) => setForm({ ...form, repeat_rate: e.target.value })} /></div>
          <div className="field"><label>prefix_num</label>
            <input className="inp mono" value={form.prefix_num} onChange={(e) => setForm({ ...form, prefix_num: +e.target.value || 0 })} /></div>
          <div className="field" style={{ maxWidth: 110 }}><label>&nbsp;</label>
            <button className="btn primary" style={{ width: "100%" }} onClick={generate}
              disabled={!!job && !["completed", "failed", "cancelled"].includes(job.state)}>生成</button></div>
        </div>
        {job && (
          <div className="row" style={{ alignItems: "center" }}>
            <div style={{ flex: 1 }}><div className="progress"><i style={{ width: `${job.percent}%` }} /></div></div>
            <span className="muted" style={{ fontSize: 11.5 }}>
              {job.state === "completed" ? "✓ 已入库" : job.state === "failed" ? "✗ 失败" : `生成中 ${job.percent}%`}
            </span>
          </div>)}
        <div style={{ borderTop: "1px solid var(--border)", margin: "12px 0" }} />
        <div className="row" style={{ alignItems: "center" }}>
          <div className="subnote" style={{ width: 150 }}>注册自定义模型目录：</div>
          <input className="inp mono" style={{ flex: 1 }} placeholder="D:\path\to\model-dir（含 tokenizer.json）"
            value={regDir} onChange={(e) => setRegDir(e.target.value)} />
          <button className="btn sm" onClick={async () => {
            try {
              await api.post("/api/tokenizers", { name: regDir.split(/[\\/]/).pop(), path: regDir });
              toast("已注册"); setRegDir(""); load();
            } catch (e: any) { toast(e.message); }
          }}>注册</button>
        </div>
      </div>

      <div className="ds-grid">
        {dss.map((ds) => (
          <div className="card" key={ds.id}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <b style={{ fontSize: 13 }}>{ds.name}</b>
              <span className={`tag ${ds.mode === "tokenid" ? "purple" : "blue"}`}>{ds.mode}</span>
            </div>
            <div className="subnote" style={{ margin: "8px 0 12px" }}>
              {ds.tokenizer} · {ds.stats?.rows} 行<br />
              repeat {ds.params?.repeat_rate} · prefix {ds.params?.prefix_num} · seed {ds.params?.seed}
            </div>
            <div className="row" style={{ marginTop: "auto" }}>
              <button className="btn sm" onClick={() => preview(ds)}>预览</button>
              <button className="btn sm danger" onClick={async () => {
                if (!confirm(`删除数据集 ${ds.name}？（不删文件）`)) return;
                await api.del(`/api/datasets/${ds.id}`); load();
              }}>删除</button>
            </div>
          </div>
        ))}
        {!dss.length && (
          <div className="card subnote" style={{ gridColumn: "1 / -1", textAlign: "center", padding: 30 }}>
            暂无数据集 — 在测试配置里会自动生成，或使用上方快速生成入库复用
          </div>
        )}
      </div>
    </>
  );
}
