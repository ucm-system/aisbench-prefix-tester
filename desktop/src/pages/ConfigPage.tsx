import { useEffect, useMemo, useRef, useState } from "react";
import { api, track, useConnected } from "../api";
import { navigate, useToast } from "../App";
import { ConfirmModal, InfoTip, Modal, pickDefaultTokenizer, theoreticalHitRate, useLocalState } from "../ui";

type Tok = { name: string; path: string; source: string };

/* 温和默认值（B3：新手不压垮服务；预置模板另可一键切换） */
const DEFAULT_CFG = {
  host_ip: "192.168.1.10", host_port: 8000, url: "",
  model_name: "", model_path: "", npu_num: 1,
  test_name: "", input_len: 2048, output_len: 32, data_num: 16,
  prefix_num: 4, concurrency: 8, request_rate: 0,
  test_type: "stream", enable_think: false,
  repeat_rate: "90%", dp: 1, seed: 42,
  length_mean: null as number | null, length_std: null as number | null,
  length_min: null as number | null, length_max: null as number | null,
  tokenizer: "", vocab_file: null as string | null, dataset_mode: "text",
  dataset_id: null as string | null,
  cache_reset: "each_round", per_round_seed_offset: false,
  api_key: "", summarizer: "default_perf",
  collection_interval: 5,
};
type Cfg = typeof DEFAULT_CFG;

/* 内置预设（B3） */
const BUILTIN_PRESETS: { name: string; label: string; cfg: Partial<Cfg> }[] = [
  { name: "builtin-smoke", label: "快速冒烟",
    cfg: { input_len: 2048, output_len: 32, data_num: 16, prefix_num: 4, concurrency: 8, repeat_rate: "90%" } },
  { name: "builtin-standard", label: "标准测试",
    cfg: { input_len: 8192, output_len: 256, data_num: 64, prefix_num: 16, concurrency: 32, repeat_rate: "90%" } },
];

function parsePodAddr(p: string): { host: string; port: number } | null {
  const m = p.trim().match(/^\[?([^\]]*)\]?:(\d+)$/);
  return m ? { host: m[1], port: +m[2] } : null;
}
function urlHostPort(url: string): { host: string; port: number } | null {
  try {
    const u = new URL(url);
    return u.hostname && u.port ? { host: u.hostname, port: +u.port } : null;
  } catch { return null; }
}

export default function ConfigPage() {
  const toast = useToast();
  const [cfg, setCfg] = useState<Cfg>(() => {
    try {
      const d = localStorage.getItem("pt-cfg-draft");
      if (d) return { ...DEFAULT_CFG, ...JSON.parse(d).cfg };
    } catch { /* corrupted draft */ }
    return { ...DEFAULT_CFG };
  });
  const [rounds, setRounds] = useState<Record<string, any>[]>(() => {
    try {
      const d = localStorage.getItem("pt-cfg-draft");
      if (d) { const r = JSON.parse(d).rounds; if (Array.isArray(r) && r.length) return r; }
    } catch { /* ignore */ }
    return [{ test_name: "" }];
  });
  const [tokenizers, setTokenizers] = useState<Tok[]>([]);
  const [tokLocalPath, setTokLocalPath] = useState(() => {
    try {
      const d = localStorage.getItem("pt-cfg-draft");
      if (d) return JSON.parse(d).tokLocalPath ?? "";
    } catch { /* ignore */ }
    return "";
  });
  /* 采集端点：未手动编辑时实时跟随 服务地址:端口 / URL（U3） */
  const [podText, setPodText] = useState<string>(() => {
    try {
      const d = localStorage.getItem("pt-cfg-draft");
      if (d) return JSON.parse(d).podText ?? "";
    } catch { /* ignore */ }
    return "";
  });
  const [podsTouched, setPodsTouched] = useState(() => {
    try {
      const d = localStorage.getItem("pt-cfg-draft");
      if (d) return !!JSON.parse(d).podsTouched;
    } catch { /* ignore */ }
    return false;
  });
  const [podReach, setPodReach] = useState<Record<string, "ok" | "bad" | "loading">>({});
  const [roundsMode, setRoundsMode] = useState<"table" | "json">("table");
  const [roundsJson, setRoundsJson] = useState("");
  const [check, setCheck] = useState<{ errors: string[]; warnings: string[] }>({ errors: [], warnings: [] });
  const [validated, setValidated] = useState<"none" | "ok" | "bad">("none");
  const [probe, setProbe] = useState<any>(null);
  const [probing, setProbing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fieldErr, setFieldErr] = useState<Record<string, string>>({});
  const [presets, setPresets] = useState<{ name: string; config: Record<string, unknown> }[]>([]);
  const [presetName, setPresetName] = useState("");
  const [savePresetOpen, setSavePresetOpen] = useState(false);
  const [distOpen, setDistOpen] = useState(false);
  const [confirmModal, setConfirmModal] = useState<{ title: string; message: string; onOk: () => void } | null>(null);
  const draftTimer = useRef<number | null>(null);

  const connected = useConnected();
  useEffect(() => {
    if (!connected) return;
    api.get<Tok[]>("/api/tokenizers").then((t) => {
      setTokenizers(t);
      setCfg((c) => (c.tokenizer
        ? c
        : { ...c, tokenizer: pickDefaultTokenizer(t, localStorage.getItem("pt-tokenizer")) }));
    }).catch(() => {});
    api.get<any[]>("/api/presets").then(setPresets).catch(() => {});
  }, [connected]);

  /* 草稿自动保存（B3，去抖 600ms） */
  useEffect(() => {
    if (draftTimer.current) window.clearTimeout(draftTimer.current);
    draftTimer.current = window.setTimeout(() => {
      try {
        localStorage.setItem("pt-cfg-draft", JSON.stringify(
          { cfg, rounds, podText, podsTouched, tokLocalPath }));
      } catch { /* quota */ }
    }, 600);
    return () => { if (draftTimer.current) window.clearTimeout(draftTimer.current); };
  }, [cfg, rounds, podText, podsTouched, tokLocalPath]);

  const set = (patch: Partial<Cfg>) => { setCfg((c) => ({ ...c, ...patch })); setValidated("none"); };

  /* ---------- 采集端点（U3/B6） ---------- */
  const urlParsed = useMemo(() => (cfg.url.trim() ? urlHostPort(cfg.url.trim()) : null), [cfg.url]);
  const effectivePods = useMemo(() => {
    if (podsTouched) return podText.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
    if (urlParsed) return [`${urlParsed.host}:${urlParsed.port}`];
    return cfg.host_ip && cfg.host_port ? [`${cfg.host_ip}:${cfg.host_port}`] : [];
  }, [podsTouched, podText, urlParsed, cfg.host_ip, cfg.host_port]);

  /* 逐端点 /metrics 可达性（去抖，复用 /api/probe） */
  useEffect(() => {
    if (!connected || !effectivePods.length) { setPodReach({}); return; }
    const t = window.setTimeout(async () => {
      const next: Record<string, "ok" | "bad" | "loading"> = {};
      effectivePods.forEach((p) => { next[p] = "loading"; });
      setPodReach(next);
      await Promise.all(effectivePods.map(async (p) => {
        const addr = parsePodAddr(p);
        if (!addr) { setPodReach((s) => ({ ...s, [p]: "bad" })); return; }
        try {
          const r = await api.post<any>("/api/probe", { host: addr.host, port: addr.port });
          setPodReach((s) => ({ ...s, [p]: r.metrics_ok ? "ok" : "bad" }));
        } catch { setPodReach((s) => ({ ...s, [p]: "bad" })); }
      }));
    }, 900);
    return () => window.clearTimeout(t);
  }, [effectivePods.join("|"), connected]);

  const addPods = (raw: string) => {
    const items = raw.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
    if (!items.length) return;
    setPodsTouched(true);
    setPodText((t) => [...new Set([...t.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean), ...items])].join("\n"));
  };

  /* ---------- 探测（B5：服务信息卡 + 联动） ---------- */
  const doProbe = async () => {
    setProbing(true);
    setProbe(null);
    try {
      const r = await api.post<any>("/api/probe", { host: cfg.host_ip, port: cfg.host_port, url: cfg.url });
      setProbe(r);
      if (r.models?.[0]) set({ model_name: r.models[0] });
      /* 自动匹配同名预置 tokenizer（U1.③） */
      if (r.served_names?.length) {
        const hit = tokenizers.find((t) =>
          r.served_names.some((n: string) =>
            t.name.toLowerCase().includes(String(n).toLowerCase())
            || String(n).toLowerCase().includes(t.name.toLowerCase().split("-")[0])));
        if (hit) {
          if (cfg.tokenizer !== hit.name) {
            set({ tokenizer: hit.name });
            localStorage.setItem("pt-tokenizer", hit.name);
            toast({ msg: `已自动匹配预置 tokenizer：${hit.name}（${hit.source}）`, kind: "success" });
          }
        } else if (!cfg.tokenizer && !tokLocalPath) {
          toast({ msg: "未匹配到同名预置 tokenizer，请在「Tokenizer 来源」选择或填写本地目录", kind: "info" });
        }
      }
      if (r.error && !r.models_ok && !r.metrics_ok) {
        toast({ msg: `探测失败：${r.error}`, kind: "error" });
      }
    } catch (e: any) {
      toast({ msg: `探测失败：${e.message}`, kind: "error" });
    } finally { setProbing(false); }
  };

  const maxLen: number | null = probe?.max_model_len ?? null;

  /* ---------- 失焦即时校验（B4/B7） ---------- */
  const validateField = (key: string) => {
    const errs: Record<string, string> = {};
    const input = +cfg.input_len || 0, output = +cfg.output_len || 0;
    if (key === "input_len" || key === "output_len") {
      if (input < 1 || output < 1) errs[key] = "长度必须 ≥ 1";
      else if (maxLen != null && input + output > maxLen) {
        errs[key] = `input+output ${input + output} > 服务 max_model_len ${maxLen.toLocaleString()}，建议 input ≤ ${(maxLen - output).toLocaleString()}`;
      }
    }
    if (key === "concurrency" && (+cfg.concurrency || 0) < 1) errs.concurrency = "并发必须 ≥ 1";
    if (key === "data_num" && (+cfg.data_num || 0) < 1) errs.data_num = "数据条数必须 ≥ 1";
    if (key === "length_mean" || key === "length_std") {
      if ((cfg.length_mean == null) !== (cfg.length_std == null)) errs.length_mean = "高斯分布 mean/std 必须成对填写";
    }
    if (key === "length_min" || key === "length_max") {
      if ((cfg.length_min == null) !== (cfg.length_max == null)) errs.length_min = "均匀分布 min/max 必须成对填写";
      else if (cfg.length_min != null && cfg.length_max != null && +cfg.length_min >= +cfg.length_max) {
        errs.length_min = "min 必须小于 max";
      }
    }
    setFieldErr((f) => {
      const n = { ...f };
      if (errs[key]) n[key] = errs[key];
      else delete n[key];
      // 关联字段成对校验
      if (key === "length_mean" && !errs[key]) delete n.length_std;
      if (key === "length_min" && !errs[key]) delete n.length_max;
      return n;
    });
  };

  const buildCfg = () => {
    const rr = String(cfg.repeat_rate).trim();
    const repeatRate = rr.endsWith("%") ? rr : Number(rr) > 1 ? `${rr}%` : rr;
    return {
      ...cfg, repeat_rate: repeatRate,
      model_path: cfg.tokenizer ? "" : tokLocalPath,
      pod_info: effectivePods, rounds,
    };
  };

  /* ---------- 全量校验（B1：反馈体系） ---------- */
  const scrollToField = (key: string) => {
    const el = document.querySelector(`[data-t="${key}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    (el as HTMLElement)?.focus?.();
  };
  const ERR_FIELD_MAP: [RegExp, string][] = [
    [/模型目录|tokenizer/i, "tokenizer"],
    [/服务地址/i, "host_ip"],
    [/input_len/i, "input_len"],
    [/output_len/i, "output_len"],
    [/repeat_rate/i, "repeat_rate"],
    [/length_mean|length_std/i, "length_mean"],
    [/length_min|length_max/i, "length_min"],
    [/并发|concurrency/i, "concurrency"],
    [/data_num/i, "data_num"],
  ];
  const doValidate = async (feedback = false) => {
    /* 前置：本地字段错误直接展示 */
    Object.keys(fieldErr).forEach(validateField);
    let errs = { ...fieldErr };
    if (!cfg.tokenizer && !tokLocalPath.trim()) {
      errs.tokenizer = "请选择预置 tokenizer 或填写本地模型目录";
    }
    try {
      const r = await api.post<{ errors: string[]; warnings: string[] }>(
        "/api/config/validate", { config: buildCfg() });
      setCheck(r);
      const all = { ...errs };
      r.errors.forEach((e) => {
        const hit = ERR_FIELD_MAP.find(([re]) => re.test(e));
        if (hit && !all[hit[1]]) all[hit[1]] = e;
      });
      setFieldErr(all);
      const ok = r.errors.length === 0 && Object.keys(all).length === 0;
      setValidated(ok ? "ok" : "bad");
      track("config_validate_result", { ok, error_fields: Object.keys(all) });
      if (feedback) {
        if (!ok) toast({ msg: `配置有误：${r.errors[0] ?? Object.values(all)[0]}`, kind: "error" });
        else if (r.warnings.length) toast({ msg: `✓ 校验通过，${r.warnings.length} 条警告（见摘要卡）`, kind: "success", duration: 6000 });
        else toast({ msg: "✓ 配置可用，可开始测试", kind: "success" });
      }
      return { errors: [...r.errors, ...Object.values(all)], warnings: r.warnings };
    } catch (e: any) {
      setCheck({ errors: [String(e.message || e)], warnings: [] });
      setValidated("bad");
      return { errors: [String(e.message || e)], warnings: [] };
    }
  };

  const doStart = async () => {
    if (maxLen != null && +cfg.input_len + +cfg.output_len > maxLen) {
      toast({ msg: `无法开始：input ${cfg.input_len.toLocaleString()} + output ${cfg.output_len.toLocaleString()} 超过服务 max_model_len ${maxLen.toLocaleString()}（vLLM 将逐请求 400）`, kind: "error" });
      return;
    }
    const v = await doValidate();
    if (v.errors.length) {
      toast({ msg: `配置有误：${v.errors[0]}`, kind: "error" });
      return;
    }
    setBusy(true);
    try {
      const r = await api.post<{ run_id: string }>("/api/runs", {
        config: buildCfg(),
        name: rounds[0]?.test_name || cfg.test_name || `run ${new Date().toLocaleString()}`,
      });
      track("run_submit", { run_id: r.run_id, rounds: rounds.length, preset: "custom" });
      navigate(`/monitor/${r.run_id}`);
    } catch (e: any) {
      toast({ msg: `启动失败：${e.message}`, kind: "error" });
    } finally { setBusy(false); }
  };

  /* ---------- 预设（B3） ---------- */
  const applyPreset = async (name: string) => {
    if (!name) return;
    const builtin = BUILTIN_PRESETS.find((p) => p.name === name);
    const next: Partial<Cfg> = builtin
      ? builtin.cfg
      : (presets.find((p) => p.name === name)?.config as Partial<Cfg>) ?? {};
    /* 切换 diff 确认（§5：列出将改变的 N 项） */
    const keys = [...new Set([...Object.keys(next), ...Object.keys(DEFAULT_CFG)])]
      .filter((k) => k !== "test_name" && (cfg as any)[k] !== (next as any)[k]);
    const apply = () => {
      setCfg({ ...DEFAULT_CFG, ...next } as Cfg);
      setValidated("none");
      toast({ msg: `已应用预设「${builtin?.label ?? name}」`, kind: "success" });
    };
    if (keys.length) {
      setConfirmModal({
        title: `切换到预设「${builtin?.label ?? name}」`,
        message: `将覆盖当前 ${Math.min(keys.length, 12)} 项参数：\n${keys.slice(0, 12).join("、")}${keys.length > 12 ? " …" : ""}\n确认应用？`,
        onOk: apply,
      });
    } else apply();
  };

  const savePreset = async () => {
    const name = presetName.trim();
    if (!name) { toast("请填写预设名称"); return; }
    try {
      await api.post("/api/presets", { name, config: buildCfg() });
      setPresets(await api.get<any[]>("/api/presets"));
      setSavePresetOpen(false); setPresetName("");
      toast({ msg: `预设「${name}」已保存`, kind: "success" });
    } catch (e: any) { toast({ msg: `保存失败：${e.message}`, kind: "error" }); }
  };

  /* ---------- 轮次（B8） ---------- */
  const setRound = (i: number, key: string, value: unknown) => {
    setRounds((rs) => rs.map((x, j) => (j === i ? { ...x, [key]: value } : x)));
    setValidated("none");
  };
  const ROUND_KEYS = ["input_len", "output_len", "data_num", "concurrency", "request_rate",
    "prefix_num", "repeat_rate", "dp", "seed"] as const;
  const roundHasOverride = (r: Record<string, any>) => ROUND_KEYS.some((k) => r[k] != null && r[k] !== "");

  const runName = rounds[0]?.test_name ?? "";
  const setRunName = (v: string) => {
    setRounds((rs) => (rs.length
      ? rs.map((x, j) => (j === 0 ? { ...x, test_name: v } : x))
      : [{ test_name: v }]));
  };

  const theoretical = theoreticalHitRate(cfg.repeat_rate, +cfg.input_len || 1);
  const reachOk = effectivePods.filter((p) => podReach[p] === "ok").length;
  const activeTok = cfg.tokenizer
    ? tokenizers.find((t) => t.name === cfg.tokenizer)
    : null;

  const fld = (key: keyof Cfg, label: string, extra?: {
    unit?: string; req?: boolean; width?: number; num?: boolean;
  }) => (
    <div className="field" style={extra?.width ? { maxWidth: extra.width } : undefined}>
      <label>{label}{extra?.req && <span className="req"> *</span>}</label>
      <div className="unit">
        <input className={`inp ${extra?.num ? "mono" : ""} ${fieldErr[key] ? "err" : ""}`}
          data-t={key}
          value={String((cfg as any)[key] ?? "")}
          onChange={(e) => set({ [key]: extra?.num ? (+e.target.value || 0) : e.target.value } as any)}
          onBlur={() => extra?.num && validateField(key)} />
        {extra?.unit && <span className="u">{extra.unit}</span>}
      </div>
      {fieldErr[key] && <div className="err-msg" role="alert">{fieldErr[key]}</div>}
    </div>
  );

  return (
    <>
      {/* 首行：运行名称 + 预设（§6.1，B2/B3） */}
      <div className="cfg-toprow">
        <div className="field" style={{ flex: "1 1 280px", maxWidth: 420 }}>
          <label>运行名称 <span style={{ color: "var(--muted)", fontWeight: 400 }}>（显示在运行记录 / 对比 / 导出报告中）</span></label>
          <input className="inp" data-t="run_name" value={runName}
            placeholder="留空自动命名：run + 时间（示例：qwen3-8101-90%重复-c4）"
            onChange={(e) => setRunName(e.target.value)} />
        </div>
        <div className="preset-row">
          <div className="field" style={{ width: 170 }}>
            <label>预设</label>
            <select className="sel" data-t="preset" value="" onChange={(e) => { applyPreset(e.target.value); e.target.value = ""; }}>
              <option value="">选择预设…</option>
              {BUILTIN_PRESETS.map((p) => <option key={p.name} value={p.name}>{p.label}（内置）</option>)}
              {presets.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
            </select>
          </div>
          <button className="btn ghost" style={{ alignSelf: "flex-end" }} onClick={() => setSavePresetOpen(true)}>保存为预设</button>
        </div>
      </div>

      <div className="cfg-grid">
        <div className="cfg-form">
          {/* ① 服务连接 */}
          <div className="card">
            <h3><span className="idx">1</span>服务连接 <span className="sec-tag">目标推理服务（vLLM / UCM）</span></h3>
            <div className="row" style={{ marginBottom: 10 }}>
              {urlParsed ? (
                <>
                  <div className="field" style={{ flex: 2 }}>
                    <label>完整 URL <InfoTip text="当前由 URL 直连目标服务，地址/端口字段已折叠为解析摘要；点「清除 URL」可恢复分别填写。" /></label>
                    <input className="inp mono" data-t="url" value={cfg.url}
                      onChange={(e) => set({ url: e.target.value })} placeholder="http://host:port" />
                  </div>
                  <button className="btn ghost" style={{ alignSelf: "flex-end" }}
                    onClick={() => set({ url: "" })}>清除 URL</button>
                </>
              ) : (
                <>
                  <div className="field" style={{ flex: 2 }}><label>服务地址 <span className="req">*</span></label>
                    <input className="inp mono" value={cfg.host_ip} data-t="host_ip"
                      onChange={(e) => set({ host_ip: e.target.value })} /></div>
                  <div className="field" style={{ maxWidth: 110 }}><label>端口 <span className="req">*</span></label>
                    <input className="inp mono" value={cfg.host_port} data-t="host_port"
                      onChange={(e) => set({ host_port: +e.target.value || 0 })} /></div>
                  <div className="field" style={{ maxWidth: 240 }}>
                    <label>完整 URL <InfoTip text="可选。Docker 场景填 http://host:port，将覆盖地址+端口两个字段。" /></label>
                    <input className="inp mono" data-t="url" value={cfg.url}
                      onChange={(e) => set({ url: e.target.value })} placeholder="http://host:port" />
                  </div>
                </>
              )}
              <div className="field" style={{ maxWidth: 110 }}>
                <label>&nbsp;</label>
                <button className="btn" style={{ width: "100%" }} onClick={doProbe} disabled={probing}>
                  {probing ? "探测中…" : "⊙ 探测"}
                </button>
              </div>
            </div>

            {/* 服务信息卡（B5） */}
            {probe && (
              <div className="alert info" style={{ marginBottom: 10 }}>
                <span>ℹ</span>
                <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
                  <span>{probe.models_ok ? "✓ /v1/models 可达" : "✗ /v1/models 不可达"}</span>
                  <span>{probe.metrics_ok ? "✓ /metrics 可达" : "✗ /metrics 不可达"}</span>
                  {probe.models?.length ? <span>模型：<b>{probe.models.join("、")}</b></span> : null}
                  {maxLen ? <span>上下文上限 <b>{maxLen.toLocaleString()}</b> tok</span> : null}
                  <span className={`tag ${probe.ucm_detected ? "purple" : "gray"}`}>
                    {probe.ucm_detected ? "UCM 已检测" : "无 ucm: 指标"}</span>
                </div>
              </div>
            )}

            <div className="row" style={{ marginBottom: 10 }}>
              <div className="field"><label>模型名称（留空自动探测）</label>
                <input className="inp" value={cfg.model_name} data-t="model_name"
                  onChange={(e) => set({ model_name: e.target.value })} /></div>
              <div className="field" style={{ maxWidth: 110 }}><label>NPU 数</label>
                <input className="inp mono" value={cfg.npu_num}
                  onChange={(e) => set({ npu_num: +e.target.value || 1 })} /></div>
              <div className="field" style={{ maxWidth: 200 }}><label>API Key（鉴权时必填）</label>
                <input className="inp mono" type="password" data-t="api_key" value={cfg.api_key}
                  onChange={(e) => set({ api_key: e.target.value })} placeholder="sk-…" /></div>
              <div className="field" style={{ maxWidth: 180 }}><label>Summarizer</label>
                <select className="sel" value={cfg.summarizer} onChange={(e) => set({ summarizer: e.target.value })}>
                  <option value="default_perf">default_perf</option>
                  <option value="stable_stage">stable_stage</option>
                </select></div>
            </div>

            {/* Tokenizer 来源：单一选择器，互斥（U1） */}
            <div className="row" style={{ marginBottom: 4 }}>
              <div className="field" style={{ flex: 2, maxWidth: 420 }}>
                <label>Tokenizer 来源 <span className="req">*</span>
                  <InfoTip text="预置 = 打包/本机扫描到的 tokenizer；本地目录 = 自填模型目录路径。二者互斥，实际生效者用于数据生成与 token 换算。" />
                </label>
                <select className="sel" data-t="tokenizer" value={cfg.tokenizer}
                  onChange={(e) => {
                    set({ tokenizer: e.target.value });
                    localStorage.setItem("pt-tokenizer", e.target.value);
                  }}>
                  {tokenizers.map((t) => <option key={t.name} value={t.name}>预置：{t.name}（{t.source}）</option>)}
                  <option value="">本地目录…</option>
                </select>
              </div>
              {!cfg.tokenizer && (
                <div className="field" style={{ flex: 2 }}>
                  <label>本地模型目录（含 tokenizer.json）<span className="req"> *</span></label>
                  <input className={`inp mono ${fieldErr.tokenizer ? "err" : ""}`} data-t="model_path"
                    value={tokLocalPath} placeholder="D:\Models\Qwen3-32B"
                    onChange={(e) => { setTokLocalPath(e.target.value); setValidated("none"); }} />
                </div>
              )}
            </div>
            <div className="subnote">
              当前生效：{cfg.tokenizer
                ? <b style={{ color: "var(--text)" }}>{activeTok?.name ?? cfg.tokenizer}</b>
                : tokLocalPath
                  ? <b style={{ color: "var(--text)" }} className="mono">{tokLocalPath}</b>
                  : <span style={{ color: "var(--danger)" }}>未选择</span>}
              {cfg.tokenizer && activeTok && `（来源 ${activeTok.source}）`}
              {fieldErr.tokenizer && <span style={{ color: "var(--danger)" }}> — {fieldErr.tokenizer}</span>}
            </div>
          </div>

          {/* ② 前缀与数据集 */}
          <div className="card">
            <h3><span className="idx">2</span>前缀与数据集 <span className="sec-tag">随机词表纯合成 · 按参数自动生成</span></h3>
            <div className="row" style={{ marginBottom: 10 }}>
              {fld("input_len", "输入长度 input_len", { unit: "tok", req: true, num: true })}
              {fld("output_len", "输出长度 output_len", { unit: "tok", req: true, num: true })}
              {fld("data_num", "数据条数 data_num", { num: true })}
              {fld("prefix_num", "前缀种类 prefix_num", { num: true })}
            </div>
            <div className="row" style={{ marginBottom: 12 }}>
              <div className="field" style={{ maxWidth: 150 }}><label>重复率 repeat_rate</label>
                <div className="unit">
                  <input className={`inp mono ${fieldErr.repeat_rate ? "err" : ""}`} data-t="repeat_rate"
                    value={String(cfg.repeat_rate)} onChange={(e) => set({ repeat_rate: e.target.value })} />
                  <span className="u">%</span>
                </div>
                {fieldErr.repeat_rate && <div className="err-msg">{fieldErr.repeat_rate}</div>}
              </div>
              <div className="field" style={{ maxWidth: 110 }}><label>数据并行 dp</label>
                <input className="inp mono" value={cfg.dp} data-t="dp"
                  onChange={(e) => set({ dp: +e.target.value || 1 })} /></div>
              <div className="field" style={{ maxWidth: 110 }}><label>随机种子 seed</label>
                <input className="inp mono" value={cfg.seed} data-t="seed"
                  onChange={(e) => set({ seed: +e.target.value || 0 })} /></div>
              <div className="field" style={{ maxWidth: 170 }}><label>长度分布（可选）</label>
                <select className="sel" value={
                  cfg.length_mean != null ? "gauss" : cfg.length_min != null ? "unif" : ""}
                  onChange={(e) => {
                    const v = e.target.value;
                    setDistOpen(!!v);
                    set(v === "gauss" ? { length_mean: 2048, length_std: 256, length_min: null, length_max: null }
                      : v === "unif" ? { length_min: 1024, length_max: 4096, length_mean: null, length_std: null }
                      : { length_mean: null, length_std: null, length_min: null, length_max: null });
                  }}>
                  <option value="">固定长度</option>
                  <option value="gauss">高斯 mean±std</option>
                  <option value="unif">均匀 min–max</option>
                </select></div>
              {(cfg.length_mean != null || cfg.length_min != null || distOpen) && (
                <>
                  {cfg.length_mean != null && (
                    <>
                      <div className="field" style={{ maxWidth: 130 }}>
                        <label>mean <span className="req">*</span></label>
                        <input className={`inp mono ${fieldErr.length_mean ? "err" : ""}`} data-t="length_mean"
                          value={cfg.length_mean ?? ""}
                          onChange={(e) => set({ length_mean: +e.target.value || null })}
                          onBlur={() => validateField("length_mean")} />
                      </div>
                      <div className="field" style={{ maxWidth: 130 }}>
                        <label>std <span className="req">*</span></label>
                        <input className="inp mono" value={cfg.length_std ?? ""}
                          onChange={(e) => set({ length_std: +e.target.value || null })}
                          onBlur={() => validateField("length_mean")} />
                      </div>
                    </>
                  )}
                  {cfg.length_min != null && (
                    <>
                      <div className="field" style={{ maxWidth: 130 }}>
                        <label>min <span className="req">*</span></label>
                        <input className={`inp mono ${fieldErr.length_min ? "err" : ""}`} data-t="length_min"
                          value={cfg.length_min ?? ""}
                          onChange={(e) => set({ length_min: +e.target.value || null })}
                          onBlur={() => validateField("length_min")} />
                      </div>
                      <div className="field" style={{ maxWidth: 130 }}>
                        <label>max <span className="req">*</span></label>
                        <input className="inp mono" value={cfg.length_max ?? ""}
                          onChange={(e) => set({ length_max: +e.target.value || null })}
                          onBlur={() => validateField("length_min")} />
                      </div>
                    </>
                  )}
                </>
              )}
            </div>

            {/* 词表来源：单选卡（U2） */}
            <div className="radio-cards" style={{ marginBottom: 12 }}>
              <div className={`radio-card ${cfg.dataset_mode === "text" ? "on" : ""}`}
                onClick={() => set({ dataset_mode: "text", vocab_file: null })} role="radio"
                aria-checked={cfg.dataset_mode === "text"} tabIndex={0}
                onKeyDown={(e) => e.key === "Enter" && set({ dataset_mode: "text", vocab_file: null })}>
                <b>{cfg.dataset_mode === "text" ? "◉" : "◎"} gsm8k 文本</b>
                <div className="rc-sub">用 tokenizer 词表拼自然语言片段——贴近真实语料，长度有少量抖动</div>
              </div>
              <div className={`radio-card ${cfg.dataset_mode === "tokenid" ? "on" : ""}`}
                onClick={() => set({ dataset_mode: "tokenid" })} role="radio"
                aria-checked={cfg.dataset_mode === "tokenid"} tabIndex={0}
                onKeyDown={(e) => e.key === "Enter" && set({ dataset_mode: "tokenid" })}>
                <b>{cfg.dataset_mode === "tokenid" ? "◉" : "◎"} tokenid 精确</b>
                <div className="rc-sub">词表 = token id 区间——每条样本编码后长度与 input_len 严格一致</div>
                {cfg.dataset_mode === "tokenid" && (
                  <div className="rc-body">
                    <input className="inp mono" data-t="vocab_file" placeholder="自定义词表文件 vocab.txt（可选，每行一个词或 起-止 id）"
                      value={cfg.vocab_file ?? ""}
                      onChange={(e) => set({ vocab_file: e.target.value || null })} />
                  </div>
                )}
              </div>
            </div>

            {/* 数据集入口裁撤后的说明行（A2 产品决策） */}
            <div className="subnote">
              数据集按当前参数自动生成，随 run 落盘（outputs/&lt;run_id&gt;/）可追溯 — 无需预建或复用数据集库。
            </div>
          </div>

          {/* ③ 并发与调度 */}
          <div className="card">
            <h3><span className="idx">3</span>并发与调度 <span className="sec-tag">全量阶段 · 预埋阶段并发 = dp</span></h3>
            <div className="row" style={{ marginBottom: 10 }}>
              {fld("concurrency", "最大并发 max_concurrency", { req: true, num: true })}
              <div className="field"><label>请求频率 request_rate</label>
                <div className="unit">
                  <input className="inp mono" data-t="request_rate" value={cfg.request_rate}
                    onChange={(e) => set({ request_rate: +e.target.value || 0 })} />
                  <span className="u">0=burst</span>
                </div></div>
              <div className="field" style={{ maxWidth: 150 }}><label>API 类型</label>
                <select className="sel" value={cfg.test_type} onChange={(e) => set({ test_type: e.target.value })}>
                  <option value="stream">stream</option><option value="text">text</option>
                </select></div>
              <div className="field" style={{ maxWidth: 170 }}><label>轮间缓存清理</label>
                <select className="sel" value={cfg.cache_reset} onChange={(e) => set({ cache_reset: e.target.value })}>
                  <option value="each_round">每轮前清理</option>
                  <option value="first_round_only">仅首轮前清理</option>
                  <option value="never">不清理</option>
                </select></div>
              <div className="field" style={{ maxWidth: 150 }}><label>采集间隔（秒）</label>
                <input className="inp mono" data-t="collection_interval" value={cfg.collection_interval}
                  title="默认取设置页；活动期自动提升到 1s（U5.3）"
                  onChange={(e) => set({ collection_interval: +e.target.value || 5 })} /></div>
            </div>
            <div className="subnote">
              预埋阶段并发固定为 dp、output_len=1；温度 0、ignore_eos=true。开启「每轮 seed 偏移」可让各轮前缀互不相同。
              <label style={{ display: "inline-flex", gap: 6, alignItems: "center", marginLeft: 12, cursor: "pointer" }}>
                <input type="checkbox" checked={cfg.per_round_seed_offset}
                  onChange={(e) => set({ per_round_seed_offset: e.target.checked })} />每轮 seed 偏移
              </label>
            </div>
          </div>

          {/* ④ 采集端点（chip 化 + 逐行可达性，U3/B6） */}
          <div className="card">
            <h3><span className="idx">4</span>采集端点（Prometheus /metrics）
              <span className="sec-tag">通常与推理端口相同 · PD 分离场景填 P 节点与各 DP 域端口</span></h3>
            <div className="pod-chips">
              {effectivePods.map((p) => (
                <span className="pod-chip" key={p}>
                  <span className={`rdot ${podReach[p] ?? ""}`}
                    title={podReach[p] === "ok" ? "/metrics 可达" : podReach[p] === "bad" ? "不可达" : "检测中"} />
                  {p}
                  <button aria-label={`移除 ${p}`} onClick={() => {
                    setPodsTouched(true);
                    setPodText(effectivePods.filter((x) => x !== p).join("\n"));
                  }}>✕</button>
                </span>
              ))}
              <input className="pod-add" placeholder="输入 ip:port 后回车添加（支持粘贴多行）"
                onKeyDown={(e) => {
                  if (e.key === "Enter") { addPods((e.target as HTMLInputElement).value); (e.target as HTMLInputElement).value = ""; }
                }}
                onPaste={(e) => {
                  const text = e.clipboardData.getData("text");
                  if (/[\n,;]/.test(text)) {
                    e.preventDefault();
                    addPods(text);
                  }
                }} />
            </div>
            <div className="pod-follow" style={{ marginTop: 8 }}>
              {podsTouched ? (
                <>
                  已手动覆盖 {effectivePods.length} 个端点
                  <button className="btn sm ghost" onClick={() => { setPodsTouched(false); setPodText(""); }}>
                    ✕ 恢复联动
                  </button>
                </>
              ) : (
                <>自动跟随服务地址：<span className="mono">{urlParsed
                  ? `${urlParsed.host}:${urlParsed.port}（取自 URL）`
                  : `${cfg.host_ip}:${cfg.host_port}`}</span>
                  （编辑上方输入即转为手动覆盖）</>
              )}
              <span style={{ marginLeft: "auto" }}>
                可达 {reachOk}/{effectivePods.length}
                {effectivePods.length > reachOk && (
                  <span className="tag warn" style={{ marginLeft: 8 }} title="不可达端点的指标将采集不到，图表恒 0">⚠ 有端点不可达</span>
                )}
              </span>
            </div>
          </div>

          {/* ⑤ 多轮计划（B8） */}
          <div className="card">
            <h3><span className="idx">5</span>多轮计划
              <div className="seg" style={{ marginLeft: "auto" }}>
                <span className={roundsMode === "table" ? "on" : ""} onClick={() => setRoundsMode("table")}>表格</span>
                <span className={roundsMode === "json" ? "on" : ""} onClick={() => setRoundsMode("json")}>JSON</span>
              </div>
            </h3>
            <div className="subnote" style={{ marginBottom: 8 }}>
              可按轮覆盖：<span className="mono">input_len output_len data_num concurrency request_rate prefix_num repeat_rate dp seed test_name</span>（留空 = 继承全局）
            </div>
            {roundsMode === "table" ? (
              <div className="table-scroll">
                <table className="mini-table rounds-table">
                  <thead><tr>
                    <th>名称</th><th>input_len</th><th>output_len</th><th>data_num</th><th>concurrency</th>
                    <th>request_rate</th><th>prefix_num</th><th>repeat_rate</th><th>dp</th><th>seed</th><th></th>
                  </tr></thead>
                  <tbody>
                    {rounds.map((r, i) => (
                      <tr key={i} className="rounds-tr">
                        <td><input className="inp" style={{ minWidth: 90 }} value={r.test_name ?? ""}
                          placeholder={`R${i + 1}`}
                          onChange={(e) => setRound(i, "test_name", e.target.value)} /></td>
                        {ROUND_KEYS.map((k) => (
                          <td key={k}>
                            <input className="inp mono inherit"
                              style={{ width: 66 }} value={String(r[k] ?? "")} placeholder="继承"
                              onChange={(e) => setRound(i, k, e.target.value === "" ? undefined : e.target.value)} />
                          </td>
                        ))}
                        <td>
                          <div style={{ display: "flex", gap: 4 }}>
                            <button className="btn sm ghost" title="复制上一轮"
                              disabled={i === 0}
                              onClick={() => setRounds((rs) => {
                                const next = [...rs];
                                next[i] = { ...next[i - 1] };
                                return next;
                              })}>⧉</button>
                            {roundHasOverride(r) && (
                              <button className="btn sm ghost" title="清空覆盖，恢复继承全局"
                                onClick={() => setRounds((rs) => rs.map((x, j) =>
                                  j === i ? { test_name: x.test_name } : x))}>⟲</button>
                            )}
                            <button className="btn sm ghost" title="删除本轮"
                              onClick={() => setConfirmModal({
                                title: "删除轮次",
                                message: `确认删除第 ${i + 1} 轮（${r.test_name || `R${i + 1}`}）？`,
                                onOk: () => setRounds((rs) => rs.filter((_, j) => j !== i)),
                              })}>✕</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div>
                <textarea className="inp mono" rows={5} style={{ width: "100%" }}
                  placeholder={'[{"test_name":"R1","concurrency":16,"repeat_rate":"90%"}]'}
                  value={roundsJson} onChange={(e) => setRoundsJson(e.target.value)} />
                <div className="rounds-op">
                  <button className="btn sm" onClick={() => {
                    try {
                      const v = JSON.parse(roundsJson);
                      const arr = Array.isArray(v) ? v : [v];
                      arr.forEach((r) => {
                        if (typeof r !== "object" || Array.isArray(r)) throw new Error("每轮必须是对象");
                      });
                      setRounds(arr);
                      toast({ msg: `已导入 ${arr.length} 轮`, kind: "success" });
                    } catch (e: any) { toast({ msg: `JSON 解析失败：${e.message}`, kind: "error" }); }
                  }}>导入 JSON</button>
                  <button className="btn sm ghost" onClick={() => setRoundsJson(JSON.stringify(rounds, null, 2))}>导出当前</button>
                  <span className="subnote">兼容原工具 --rounds 文件，可直接互导。导入前先在前端校验 JSON 结构。</span>
                </div>
              </div>
            )}
            <button className="btn sm" style={{ marginTop: 8 }}
              onClick={() => setRounds([...rounds, { test_name: `R${rounds.length + 1}` }])}>＋ 添加轮次</button>
          </div>
        </div>

        {/* 右栏：sticky 摘要 + 吸底操作（U4/§6.1） */}
        <div className="card summary-card">
          <h3>摘要与体检</h3>
          <div className="summary-rows">
            <div className="sr"><span>目标服务</span>
              <b className="mono" style={{ fontSize: 11.5 }}>
                {urlParsed ? `${urlParsed.host}:${urlParsed.port}` : `${cfg.host_ip}:${cfg.host_port}`}</b></div>
            {maxLen != null && <div className="sr"><span>服务上下文上限</span><b className="mono">{maxLen.toLocaleString()} tok</b></div>}
            <div className="sr"><span>输入 / 输出</span><b>{(+cfg.input_len || 0).toLocaleString()} / {(+cfg.output_len || 0).toLocaleString()} tok</b></div>
            <div className="sr"><span>理论命中率</span>
              <b>{(theoretical * 100).toFixed(2)}%
                <InfoTip text="≈ repeat_rate × (1 − 3/input_len)：3 token 为前缀分隔符开销。实际命中率还受服务端缓存逐出影响。" />
              </b></div>
            <div className="sr"><span>数据量</span><b>{cfg.data_num} 条 × 前缀 {cfg.prefix_num}</b></div>
            <div className="sr"><span>重复率</span><b>{String(cfg.repeat_rate)}</b></div>
            <div className="sr"><span>并发（全量 / 预埋）</span><b>{cfg.concurrency} / {cfg.dp}</b></div>
            <div className="sr"><span>采集端点</span>
              <b>{effectivePods.length} 个{effectivePods.length ? ` · ${reachOk} 可达` : ""}
                {effectivePods.length > 0 && reachOk === 0 && " ⚠"}</b></div>
            <div className="sr"><span>Tokenizer</span>
              <b style={{ fontSize: 11 }}>{cfg.tokenizer || (tokLocalPath ? "本地目录" : "—")}</b></div>
            <div className="sr" style={{ borderBottom: "none" }}><span>轮次</span><b>{rounds.length} 轮</b></div>
          </div>

          {maxLen != null && +cfg.input_len + +cfg.output_len > maxLen && (
            <div className="alert error" style={{ marginTop: 12 }}>
              <span>✕</span><div>input {cfg.input_len.toLocaleString()} + output {cfg.output_len.toLocaleString()} 超过服务 max_model_len {maxLen.toLocaleString()}，服务将对每个请求返回 400。</div>
            </div>)}
          {check.errors.length > 0 && (
            <div className="alert error" style={{ marginTop: 12 }}>
              <span>✕</span>
              <div>
                {check.errors.map((e, i) => {
                  const hit = ERR_FIELD_MAP.find(([re]) => re.test(e));
                  return (
                    <div key={i} style={{ cursor: hit ? "pointer" : "default", textDecoration: hit ? "underline dotted" : undefined }}
                      onClick={() => hit && scrollToField(hit[1])}>{e}</div>
                  );
                })}
              </div>
            </div>)}
          {check.warnings.length > 0 && (
            <div className="alert warn" style={{ marginTop: 12 }}>
              <span>⚠</span><div>{check.warnings.map((w, i) => <div key={i}>{w}</div>)}</div>
            </div>)}
          {Object.keys(fieldErr).length > 0 && (
            <div className="alert error" style={{ marginTop: 12 }}>
              <span>✕</span>
              <div>
                {Object.entries(fieldErr).map(([k, e]) => (
                  <div key={k} style={{ cursor: "pointer", textDecoration: "underline dotted" }}
                    onClick={() => scrollToField(k)}>{e}</div>
                ))}
              </div>
            </div>)}
          {validated === "ok" && (
            <div className="alert success" style={{ marginTop: 12 }}>
              <span>✓</span><div>配置可用，可开始测试。</div>
            </div>)}

          <div className="sticky-actions">
            <button className="btn" onClick={() => doValidate(true)}>校验配置</button>
            <button data-t="start" className="btn primary" onClick={doStart} disabled={busy}>
              {busy ? "启动中…" : "▶ 开始测试"}
            </button>
            <button className="btn ghost sm" onClick={() => {
              setConfirmModal({
                title: "重置配置",
                message: "将恢复默认值并清除草稿（运行名称/多轮计划一并重置）。确认？",
                onOk: () => {
                  setCfg({ ...DEFAULT_CFG });
                  setRounds([{ test_name: "" }]);
                  setTokLocalPath(""); setPodText(""); setPodsTouched(false);
                  setCheck({ errors: [], warnings: [] }); setFieldErr({}); setValidated("none");
                  localStorage.removeItem("pt-cfg-draft");
                  toast("已重置为默认配置");
                },
              });
            }}>重置</button>
          </div>
        </div>
      </div>

      {/* 弹层们 */}
      <ConfirmModal open={!!confirmModal} title={confirmModal?.title ?? ""}
        message={confirmModal?.message ?? ""} danger
        confirmText="确认" onCancel={() => setConfirmModal(null)}
        onConfirm={() => { confirmModal?.onOk(); setConfirmModal(null); }} />
      <Modal open={savePresetOpen} title="保存为预设" onClose={() => setSavePresetOpen(false)}
        footer={<>
          <button className="btn ghost" onClick={() => setSavePresetOpen(false)}>取消</button>
          <button className="btn primary" onClick={savePreset}>保存</button>
        </>}>
        将当前全部参数（含多轮计划）保存为预设，之后可从「预设」下拉一键恢复。
        <div className="field" style={{ marginTop: 12 }}>
          <label>预设名称</label>
          <input className="inp" value={presetName} onChange={(e) => setPresetName(e.target.value)}
            placeholder="如：qwen3-8101-冒烟" autoFocus />
        </div>
      </Modal>
    </>
  );
}
