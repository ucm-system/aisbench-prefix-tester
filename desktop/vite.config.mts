import { defineConfig, Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PORT_FILE = path.resolve(__dirname, ".sidecar-dev.json");
let sidecarProc: ChildProcess | null = null;

/**
 * Dev convenience: spawn the Python sidecar (mock-friendly) and expose its
 * {port, token} to the renderer at GET /dev-sidecar-info, so the same
 * renderer code runs in a plain browser during development.
 */
function devSidecar(): Plugin {
  return {
    name: "dev-sidecar",
    configureServer(server) {
      const python = process.env.PYTHON || "py";
      const args = ["-3.11", "-m", "app.main", "--port-file", PORT_FILE];
      if (!fs.existsSync(PORT_FILE)) {
        sidecarProc = spawn(python, args, {
          cwd: path.resolve(__dirname, "../sidecar"),
          env: { ...process.env, PYTHONUNBUFFERED: "1" },
          stdio: "inherit",
        });
      }
      server.middlewares.use((req, res, next) => {
        if (req.url && req.url.startsWith("/dev-sidecar-info")) {
          if (fs.existsSync(PORT_FILE)) {
            res.setHeader("content-type", "application/json");
            res.end(fs.readFileSync(PORT_FILE, "utf-8"));
          } else {
            res.statusCode = 503;
            res.end("{}");
          }
          return;
        }
        next();
      });
      server.httpServer?.once("close", () => sidecarProc?.kill());
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), devSidecar()],
  server: { port: 5173, strictPort: false },
});
