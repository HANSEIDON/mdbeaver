#!/usr/bin/env bash
# Runs the MinerU parsing API in WSL for the `mineru` worker engine (worker/engines/mineru.py).
# The worker (Windows) reaches it at http://127.0.0.1:8010 through WSL localhost forwarding.
# Models load once at start-up (~3 min), then each parse is a few seconds.
set -euo pipefail
LOG_DIR="$HOME/mdb/logs"
mkdir -p "$LOG_DIR"
export MINERU_MODEL_SOURCE=modelscope
exec "$HOME/mdb/venvs/mineru/bin/mineru-kit" api-server \
    --host 127.0.0.1 --port "${MINERU_PORT:-8010}" --tier standard --preload-models \
    --retention-seconds 600 --max-inline-bytes $((60 * 1024 * 1024)) >>"$LOG_DIR/mineru-server.log" 2>&1
