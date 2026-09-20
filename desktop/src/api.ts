/* Sidecar REST/WS client. Connection discovery:
 *  - Electron: window.sidecarBridge.getInfo() (IPC, main process owns lifecycle)
 *  - Browser dev: GET /dev-sidecar-info served by the vite plugin
 */
export type Conn = { port: number; token: string };

declare global {
  interface Window {
    sidecarBridge?: {
      getInfo: () => Promise<Conn | null>;
      restart: () => Promise<Conn | null>;
      onExited: (cb: (payload: { code: number }) => void) => void;
    };
  }
}

let conn: Conn | null = null;
let sameOrigin = false; // container deployment: UI served by the sidecar itself
export const connStatus = { connected: false, lastError: "" };

export async function initConnection(): Promise<Conn | null> {
  if (window.sidecarBridge) {
    conn = await window.sidecarBridge.getInfo();
  } else {
    // container deployment: same origin serves both UI and API
    try {
      const r = await fetch("/api/boot");
      if (r.ok) {
        const boot = await r.json();
        conn = { port: 0, token: boot.token };
        sameOrigin = true;
      }
    } catch { /* not container mode */ }
    if (!sameOrigin) {
      try {
        const r = await fetch("/dev-sidecar-info");
        conn = r.ok ? await r.json() : null;
      } catch {
        conn = null;
      }
    }
  }
  connStatus.connected = !!conn;
  return conn;
}

export async function restartSidecar(): Promise<Conn | null> {
  if (window.sidecarBridge) {
    conn = await window.sidecarBridge.restart();
    connStatus.connected = !!conn;
    return conn;
  }
  return initConnection();
}

export function onSidecarExited(cb: (p: { code: number }) => void) {
  window.sidecarBridge?.onExited(cb);
}

export function baseUrl(): string {
  if (sameOrigin) return "";
  return conn ? `http://127.0.0.1:${conn.port}` : "";
}

async function req<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  if (!conn) throw new Error("sidecar 未连接");
  const resp = await fetch(`${baseUrl()}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${conn.token}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!resp.ok) {
    let detail = `HTTP ${resp.status}`;
    try {
      const j = await resp.json();
      detail = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
    } catch { /* non-json error */ }
    throw new Error(detail);
  }
  return (await resp.json()) as T;
}

export const api = {
  get: <T>(p: string) => req<T>(p),
  post: <T>(p: string, body?: unknown) => req<T>(p, "POST", body ?? {}),
  put: <T>(p: string, body: unknown) => req<T>(p, "PUT", body),
  patch: <T>(p: string, body: unknown) => req<T>(p, "PATCH", body),
  del: <T>(p: string) => req<T>(p, "DELETE"),
};

export function wsRun(runId: string): WebSocket {
  if (sameOrigin) {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    return new WebSocket(`${proto}://${location.host}/ws/runs/${runId}?token=${conn?.token}`);
  }
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return new WebSocket(
    `${proto}://127.0.0.1:${conn?.port}/ws/runs/${runId}?token=${conn?.token}`);
}

export function downloadLink(path: string): string {
  const sep = path.includes("?") ? "&" : "?";
  return `${baseUrl()}${path}${sep}token=${conn?.token}`;
}

// ------------------------------------------------------------------- types
export type RunSummary = {
  run_id: string; name: string; status: string; created_at: number;
  is_practice: number; notes: string; model_name: string; host: string;
  summary?: {
    hbm_hit_rate: number; ext_hit_rate: number; ttft_avg_ms: number;
    output_token_throughput: number; rounds_done: number;
  };
};
export type RoundRow = {
  round_index: number; phase: "warmup" | "full"; is_warmup: number;
  params: Record<string, unknown>; metrics: Record<string, number>;
  hit_rate: { per_dp: Record<string, Record<string, number>>;
              aggregated: Record<string, number> };
  warnings: string;
};
export type RunDetail = RunSummary & { config: Record<string, unknown>; rounds: RoundRow[] };
export type CompareResult = {
  runs: string[]; names: Record<string, string>;
  metrics: Record<string, { label: string; higher_is_better: boolean;
    values: Record<string, number>;
    deltas: Record<string, { abs: number; pct: number; good: boolean }> }>;
  config_diff: { key: string; values: unknown[]; diff: boolean }[];
  per_round: Record<string, Record<number, Record<string, number>>>;
  dp_matrix: Record<string, Record<string, Record<string, number>>>;
  missing_rounds: { run: string; round: number }[];
};
