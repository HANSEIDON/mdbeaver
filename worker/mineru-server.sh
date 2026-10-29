#!/usr/bin/env bash
# Runs the MinerU parsing API in WSL for the `mineru` worker engine (worker/engines/mineru.py).
# The worker (Windows) reaches it at http://127.0.0.1:8010 through WSL localhost forwarding.
# Models load once at start-up (~1-3 min), then each parse is a few seconds.
set -euo pipefail
LOG_DIR="$HOME/mdb/logs"
DATA_DIR="$HOME/mdb/mineru-data"  # the API stores uploads and results (blobs/) under its working directory
mkdir -p "$LOG_DIR" "$DATA_DIR"
cd "$DATA_DIR"
export MINERU_MODEL_SOURCE=modelscope

# Deleting a file through the API removes only its record; the blob with the document's text
# stays on disk. The worker fetches results synchronously, so anything older than 10 minutes
# is no longer needed and is removed (privacy: user documents must not be kept).
(while sleep 60; do find "$DATA_DIR/blobs" -type f -mmin +10 -delete 2>/dev/null || true; done) &
SWEEPER=$!
trap 'kill $SWEEPER 2>/dev/null' EXIT

"$HOME/mdb/venvs/mineru/bin/mineru-kit" api-server \
    --host 127.0.0.1 --port "${MINERU_PORT:-8010}" --tier standard --preload-models \
    --retention-seconds 600 --max-inline-bytes $((60 * 1024 * 1024)) >>"$LOG_DIR/mineru-server.log" 2>&1
