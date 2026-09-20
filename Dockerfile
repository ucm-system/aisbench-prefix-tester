# AISBench Prefix Tester — self-contained server deployment
#
# One container = Python sidecar + ais_bench CLI + built web UI.
# Deploy on the test server, operate from your local browser:
#   docker build -t aisbench-prefix-tester .
#   docker run -d --name pt-server -p 8180:8180 \
#     -v /home/dxlong/pt-data:/data \
#     aisbench-prefix-tester
#   open http://<server-ip>:8180  (UI + API same origin, token bootstrapped automatically)
#
# The benchmark client needs no GPU; run this container on any Linux box that
# can reach the vLLM service, or on the NPU server itself.

# ---------- stage 1: build the web UI ----------
FROM node:20-slim AS ui
WORKDIR /build
COPY desktop/package.json desktop/package-lock.json* ./
RUN npm install --no-fund --no-audit
COPY desktop/ ./
RUN npm run build

# ---------- stage 2: sidecar + ais_bench ----------
FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl procps && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY sidecar/requirements.txt sidecar/requirements.txt
RUN pip install --no-cache-dir -r sidecar/requirements.txt \
    && pip install --no-cache-dir "ais_bench_benchmark==3.1.20260630"

COPY sidecar/ sidecar/
COPY --from=ui /build/dist ui/

ENV PT_UI_DIR=/app/ui \
    PT_HOME=/data \
    AISBENCH_PT_HOME=/data \
    PYTHONPATH=/app/sidecar
VOLUME /data
EXPOSE 8180

WORKDIR /app/sidecar
HEALTHCHECK --interval=30s --timeout=5s CMD curl -sf http://127.0.0.1:8180/api/boot >/dev/null || exit 1

CMD ["python", "-m", "app.main", "--host", "0.0.0.0", "--port", "8180", "--home", "/data", "--port-file", "/data/sidecar.port"]
