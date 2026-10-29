#!/usr/bin/env bash
# Runs every engine benchmark in turn (WSL). Usage: bash bench/engines/run_all.sh [paddle mineru ovis]
# Engines run one at a time so VRAM and timing are not shared. Log: bench/out/run.log
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
mkdir -p ../out
exec >>../out/run.log 2>&1

ENGINES=("${@:-paddle mineru ovis}")
read -r -a ENGINES <<<"${ENGINES[*]}"
for e in "${ENGINES[@]}"; do
    echo "[$(date '+%F %T')] start $e"
    "$HOME/mdb/venvs/$e/bin/python" "${e}_bench.py"
    echo "[$(date '+%F %T')] end $e rc=$?"
done
echo "[$(date '+%F %T')] ALL DONE"
