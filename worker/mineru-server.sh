#!/usr/bin/env bash
# Runs the MinerU parsing API in WSL for the `mineru` worker engine (worker/engines/mineru.py).
# The worker (Windows) reaches it at http://127.0.0.1:8010 through WSL localhost forwarding.
# Models load once at start-up (~1-3 min), then each parse is a few seconds.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$HOME/mdb/logs"
DATA_DIR="$HOME/mdb/mineru-data"  # the API stores uploads and results (blobs/) under its working directory
PORT="${MINERU_PORT:-8010}"
mkdir -p "$LOG_DIR" "$DATA_DIR"
cd "$DATA_DIR"
export MINERU_MODEL_SOURCE=modelscope

# Deleting a file through the API removes only its record; the blob with the document's text
# stays on disk. The worker fetches results synchronously, so anything older than 10 minutes
# is no longer needed and is removed (privacy: user documents must not be kept).
(while sleep 60; do find "$DATA_DIR/blobs" -type f -mmin +10 -delete 2>/dev/null || true; done) &
SWEEPER=$!

# The first parse after start-up is slow (30-50 s of engine warm-up), so do it here with the
# repo's one-page sample instead of on a user's document.
(until curl -sf "http://127.0.0.1:$PORT/v1/health" >/dev/null; do sleep 5; done
 printf '{"files":[{"source":{"type":"inline","name":"warmup.pdf","data":"%s"}}],"tier":"standard","output_formats":["markdown"]}' \
     "$(base64 -w0 "$REPO/home-setup/sample.pdf")" |
     curl -s -o /dev/null -H 'Content-Type: application/json' --data-binary @- "http://127.0.0.1:$PORT/v1/file_parse") &
trap 'kill $SWEEPER 2>/dev/null' EXIT

"$HOME/mdb/venvs/mineru/bin/mineru-kit" api-server \
    --host 127.0.0.1 --port "$PORT" --tier standard --preload-models \
    --retention-seconds 600 --max-inline-bytes $((60 * 1024 * 1024)) >>"$LOG_DIR/mineru-server.log" 2>&1
