#!/usr/bin/env bash
# Downloads every GPU engine candidate for the Phase 0 benchmark (docs/HOME_GPU_SETUP.md §3-4).
#
# Run inside WSL (Ubuntu-24.04) with the VPN OFF: only China mirrors are used.
# Safe to re-run: finished steps are skipped (markers in $MDB_HOME/.state), pip/ModelScope reuse
# what is already downloaded. Progress -> home-setup/logs/download.log, result -> logs/DONE or logs/FAILED.
#
# Layout (WSL home, not /mnt/c: OneDrive sync and 9P I/O are slow for venvs and weights):
#   ~/mdb/venvs/{paddle,mineru,ovis}   one venv per engine (their torch/transformers pins conflict)
#   ~/mdb/models/OvisOCR2              OvisOCR2 weights
#   ~/mdb/models/Qwen3.5-9B            answering model for the accuracy benchmark
#   PaddleOCR / MinerU keep weights in their own caches (~/.paddlex, ~/.mineru)
#
# Sources (checked 2026-10-28):
#   PaddleOCR-VL Blackwell guide: paddlepaddle-gpu==3.2.1 from the cu129 index + paddleocr[doc-parser];
#     model card requires paddleocr>=3.6.0 for VL-1.6. PADDLE_PDX_MODEL_SOURCE accepts bos/huggingface/
#     modelscope/aistudio (PaddleX paddlex/utils/flags.py).
#   MinerU 4 docs: "mineru[full]>=4.0,<5" (torch + vLLM on Linux), MINERU_MODEL_SOURCE=modelscope,
#     `mineru-kit models download --tier standard`.
#   OvisOCR2 model card: vllm==0.22.1; weights mirrored on ModelScope as ATH-MaaS/OvisOCR2 (Apache 2.0).
#   TeleOCR: no public weights found -> excluded.

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOGDIR="$ROOT/home-setup/logs"
LOG="$LOGDIR/download.log"
MDB_HOME="$HOME/mdb"
STATE="$MDB_HOME/.state"
SAMPLE="$ROOT/home-setup/sample.pdf"

mkdir -p "$LOGDIR" "$STATE" "$MDB_HOME/venvs" "$MDB_HOME/models"
rm -f "$LOGDIR/DONE" "$LOGDIR/FAILED"
exec >>"$LOG" 2>&1

export PIP_INDEX_URL="https://pypi.tuna.tsinghua.edu.cn/simple"
export PIP_DISABLE_PIP_VERSION_CHECK=1
export PIP_DEFAULT_TIMEOUT=120
export PIP_RETRIES=10
export PIP_PROGRESS_BAR=off
PADDLE_INDEX="https://www.paddlepaddle.org.cn/packages/stable/cu129/"

CURRENT="init"
log() { echo "[$(date '+%F %T')] $*"; }
fail() {
    local code=$?
    log "FAILED at step '$CURRENT' (exit $code)"
    { echo "step: $CURRENT"; echo "exit: $code"; echo "time: $(date '+%F %T')"; echo "--- last log lines ---"; tail -n 40 "$LOG"; } >"$LOGDIR/FAILED"
    exit "$code"
}
trap fail ERR

# step <name> <function>: runs once; a marker makes re-runs skip it.
step() {
    CURRENT="$1"
    if [[ -f "$STATE/$1.ok" ]]; then
        log "skip  $1 (already done)"
        return
    fi
    log "start $1"
    local t0=$SECONDS
    "$2"
    touch "$STATE/$1.ok"
    log "done  $1 ($((SECONDS - t0))s)"
}

# With the VPN on, WSL has no route out; wait (quietly) until the person turns it off.
wait_for_network() {
    local said=""
    until curl -s -m 10 -o /dev/null https://mirrors.tuna.tsinghua.edu.cn; do
        [[ -n "$said" ]] || { log "waiting for the network (turn the VPN off)"; said=1; }
        sleep 30
    done
    [[ -z "$said" ]] || log "network is up"
}

venv() {  # venv <name> -> creates ~/mdb/venvs/<name> if missing
    local dir="$MDB_HOME/venvs/$1"
    [[ -x "$dir/bin/python" ]] || python3 -m venv "$dir"
    "$dir/bin/python" -m pip install -U pip
}

# --- PaddleOCR-VL-1.6 --------------------------------------------------------
paddle_install() {
    venv paddle
    local py="$MDB_HOME/venvs/paddle/bin/python"
    "$py" -m pip install paddlepaddle-gpu==3.2.1 -i "$PADDLE_INDEX"
    "$py" -m pip install -U "paddleocr[doc-parser]>=3.6.0" modelscope
    "$py" -c "import paddle; paddle.utils.run_check()"
}
paddle_models() {
    # The first parse downloads the layout model and PaddleOCR-VL weights from ModelScope.
    # Python API + markdown only: the CLI's --save_path also renders visualizations, which fetch a
    # font from Baidu BOS and fail the step on a network blip even though the parse succeeded.
    local out="$MDB_HOME/warmup/paddle"
    mkdir -p "$out"
    PADDLE_PDX_MODEL_SOURCE=modelscope "$MDB_HOME/venvs/paddle/bin/python" - "$SAMPLE" "$out" <<'EOF'
import sys
from paddleocr import PaddleOCRVL
for res in PaddleOCRVL().predict(sys.argv[1]):
    res.save_to_markdown(save_path=sys.argv[2])
EOF
}

# --- MinerU 4 (MinerU2.5 VLM) ------------------------------------------------
mineru_install() {
    venv mineru
    "$MDB_HOME/venvs/mineru/bin/python" -m pip install -U "mineru[full]>=4.0,<5"
    "$MDB_HOME/venvs/mineru/bin/mineru" version --json
    "$MDB_HOME/venvs/mineru/bin/python" -c "import torch; assert torch.cuda.is_available(); print(torch.__version__, torch.version.cuda, torch.cuda.get_device_name(0), torch.cuda.get_device_capability(0))"
}
mineru_models() {
    MINERU_MODEL_SOURCE=modelscope "$MDB_HOME/venvs/mineru/bin/mineru-kit" models download --tier standard
    MINERU_MODEL_SOURCE=modelscope "$MDB_HOME/venvs/mineru/bin/mineru-kit" models verify --tier standard
}

# --- OvisOCR2 ----------------------------------------------------------------
ovis_install() {
    venv ovis
    "$MDB_HOME/venvs/ovis/bin/python" -m pip install "vllm==0.22.1" pillow modelscope pypdfium2
    "$MDB_HOME/venvs/ovis/bin/python" -c "import torch; assert torch.cuda.is_available(); print(torch.__version__, torch.version.cuda, torch.cuda.get_device_capability(0))"
}
ovis_models() {
    "$MDB_HOME/venvs/ovis/bin/modelscope" download --model ATH-MaaS/OvisOCR2 --local_dir "$MDB_HOME/models/OvisOCR2"
}

# --- Qwen3.5-9B: answering model for the accuracy benchmark (docs/BENCHMARK.md, C) ---------
# Apache 2.0, ~19 GB bf16. Same architecture as OvisOCR2 (Qwen3_5ForConditionalGeneration),
# so the OvisOCR2 venv's vLLM 0.22.1 runs it; only the weights are new.
llm_models() {
    "$MDB_HOME/venvs/ovis/bin/modelscope" download --model Qwen/Qwen3.5-9B --local_dir "$MDB_HOME/models/Qwen3.5-9B"
}

log "===== download.sh start (pid $$) ====="
nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv || true
wait_for_network
step paddle_install paddle_install
step paddle_models paddle_models
step mineru_install mineru_install
step mineru_models mineru_models
step ovis_install ovis_install
step ovis_models ovis_models
step llm_models llm_models
CURRENT="finish"
du -sh "$MDB_HOME" "$HOME/.paddlex" "$HOME/.mineru" 2>/dev/null || true
log "===== ALL DONE ====="
echo "finished: $(date '+%F %T')" >"$LOGDIR/DONE"
