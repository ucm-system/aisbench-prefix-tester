/* Electron main process: window + Python sidecar lifecycle.
 *
 * Sidecar resolution:
 *  - packaged:  resources/sidecar/aisbench-sidecar.exe  (PyInstaller onedir)
 *  - dev:       PYTHON (default: py) -3.11 -m app.main   from ../sidecar
 * The sidecar binds 127.0.0.1:<ephemeral> and writes {port, token} to a port
 * file; the renderer receives both over IPC (contextIsolation bridge).
 */
const { app, BrowserWindow, ipcMain } = require("electron");
const { spawn, execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

let win = null;
let sidecar = null;
let sidecarInfo = null; // {port, token}
let quitting = false;

const isDev = !!process.env.ELECTRON_START_URL;
// data dir: --data-dir <path> argument wins, else %USERPROFILE%/AISBenchPrefixTester
let dataDirOverride = null;
const ddIdx = process.argv.indexOf("--data-dir");
if (ddIdx !== -1 && process.argv[ddIdx + 1]) dataDirOverride = process.argv[ddIdx + 1];
const dataDir = () => dataDirOverride
  ? path.resolve(dataDirOverride)
  : path.join(app.getPath("home"), "AISBenchPrefixTester");
const userData = dataDir;
const portFile = () => path.join(dataDir(), "sidecar.port");

function findPython() {
  const candidates = [];
  if (process.env.PYTHON) candidates.push(process.env.PYTHON);
  candidates.push("C:\\Windows\\py.exe");
  const local = path.join(process.env.LOCALAPPDATA || "", "Programs", "Python");
  for (const v of ["Python312", "Python311", "Python310"]) {
    candidates.push(path.join(local, v, "python.exe"));
  }
  // scan PATH as a last resort
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    candidates.push(path.join(dir, "py.exe"));
    candidates.push(path.join(dir, "python.exe"));
  }
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch {}
  }
  return "python.exe";
}

function sidecarCommand() {
  if (isDev) {
    const args = ["-m", "app.main", "--port-file", portFile()];
    const py = findPython();
    if (path.basename(py).toLowerCase() === "py.exe") {
      return {
        file: py,
        args: ["-3.11", ...args],
        cwd: path.join(__dirname, "..", "..", "sidecar"),
      };
    }
    return { file: py, args, cwd: path.join(__dirname, "..", "..", "sidecar") };
  }
    if (!fs.existsSync(dataDir())) fs.mkdirSync(dataDir(), { recursive: true });
  const exe = process.resourcesPath
    ? path.join(process.resourcesPath, "sidecar", "aisbench-sidecar.exe")
    : path.join(__dirname, "..", "resources", "sidecar", "aisbench-sidecar.exe");
  return {
    file: exe,
    args: ["--port-file", portFile(), "--home", dataDir()],
    cwd: path.dirname(exe),
    env: { PT_UI_DIR: path.join(process.resourcesPath, "ui") },
  };
}

function sidecarLog(line) {
  try {
    fs.appendFileSync(path.join(userData(), "sidecar.log"),
      `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

function startSidecar() {
  stopSidecar();
  const cmd = sidecarCommand();
  try {
    if (fs.existsSync(portFile())) fs.unlinkSync(portFile());
  } catch {}
  sidecarLog(`spawn: ${cmd.file} ${cmd.args.join(" ")} (cwd=${cmd.cwd})`);
  sidecar = spawn(cmd.file, cmd.args, {
    cwd: cmd.cwd,
    env: { ...process.env, PYTHONUNBUFFERED: "1", ...(cmd.env || {}) },
    stdio: "ignore",
    windowsHide: true,
  });
  sidecar.on("error", (err) => {
    sidecarLog(`spawn error: ${err.message}`);
  });
  sidecar.on("exit", (code) => {
    sidecarLog(`sidecar exit code=${code}`);
    sidecar = null;
    sidecarInfo = null;
    if (!quitting && win && !win.isDestroyed()) {
      win.webContents.send("sidecar-exited", { code });
    }
  });
}

function stopSidecar() {
  if (!sidecar) return;
  const pid = sidecar.pid;
  try {
    if (process.platform === "win32") {
      execFile("taskkill", ["/F", "/T", "/PID", String(pid)], () => {});
    } else {
      sidecar.kill("SIGTERM");
    }
  } catch {}
  sidecar = null;
}

function waitForPortFile(retries = 200) {
  return new Promise((resolve) => {
    const tick = (left) => {
      try {
        if (fs.existsSync(portFile())) {
          resolve(JSON.parse(fs.readFileSync(portFile(), "utf-8")));
          return;
        }
      } catch {}
      if (left <= 0) return resolve(null);
      setTimeout(() => tick(left - 1), 150);
    };
    tick(retries);
  });
}

async function ensureSidecarInfo() {
  if (sidecarInfo) return sidecarInfo;
  if (!sidecar) startSidecar();
  sidecarInfo = await waitForPortFile();
  return sidecarInfo;
}

function createWindow() {
  // 应用图标（安装后由 exe 内嵌；开发/回退场景显式指定）
  const iconPath = path.join(__dirname, "..", "build", "icon.ico");
  win = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1100,
    backgroundColor: "#0f1115",
    autoHideMenuBar: true,
    ...(fs.existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (process.env.ELECTRON_START_URL) {
    win.loadURL(process.env.ELECTRON_START_URL);
  } else {
    const uiFile = process.resourcesPath
      ? path.join(process.resourcesPath, "ui", "index.html")
      : path.join(__dirname, "..", "resources", "ui", "index.html");
    if (fs.existsSync(uiFile)) {
      // UI first: the window opens immediately while the self-contained
      // sidecar keeps loading in the background (renderer polls sidecar-info
      // and shows a startup splash until the environment is ready).
      win.loadFile(uiFile);
    } else {
      const splash = "data:text/html;charset=utf-8," + encodeURIComponent(
        '<html><body style="margin:0;background:#0f1115;display:flex;align-items:center;justify-content:center;height:100vh;font-family:Segoe UI,PingFang SC,sans-serif">' +
        '<div style="text-align:center">' +
        '<svg width="52" height="52" viewBox="0 0 32 32" style="margin:0 auto 14px;display:block">' +
        '<rect width="32" height="32" rx="7" fill="#2f6ff0"/>' +
        '<rect x="6" y="19" width="20" height="4" rx="1.5" fill="#fff" opacity=".55"/>' +
        '<rect x="6" y="13" width="20" height="4" rx="1.5" fill="#fff" opacity=".8"/>' +
        '<path d="M13 4l-4 8h4l-2 6 7-9h-4l3-5z" fill="#fbbf24"/></svg>' +
        '<div style="color:#e6e9f0;font-size:14px">AISBench 前缀复用测试器</div>' +
        '<div style="color:#9aa3b2;font-size:12px;margin-top:6px">正在启动服务…</div></div></body></html>');
      win.loadURL(splash);
      // fallback (ui assets missing): sidecar serves the bundled UI same-origin
      ensureSidecarInfo().then((info) => {
        if (info && info.port) {
          win.loadURL(`http://127.0.0.1:${info.port}/`);
        } else {
          win.loadURL("data:text/html,<h2 style='font-family:sans-serif;color:#e9eaec;background:#050506;padding:24px'>Sidecar 启动失败 — 请重启应用</h2>");
        }
      });
    }
  }
  win.on("closed", () => (win = null));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => win && win.focus());
  app.whenReady().then(async () => {
    fs.mkdirSync(dataDir(), { recursive: true });
    startSidecar();
    createWindow();
  });
}

app.on("window-all-closed", () => {
  quitting = true;
  stopSidecar();
  app.quit();
});

ipcMain.handle("sidecar-info", async () => {
  // non-blocking: null while the environment is still loading — the renderer
  // polls this and shows its startup splash until the sidecar is ready
  if (sidecarInfo) return sidecarInfo;
  if (fs.existsSync(portFile())) {
    try {
      sidecarInfo = JSON.parse(fs.readFileSync(portFile(), "utf-8"));
    } catch {}
  }
  return sidecarInfo;
});
ipcMain.handle("sidecar-restart", async () => {
  startSidecar();
  sidecarInfo = await waitForPortFile();
  return sidecarInfo;
});
