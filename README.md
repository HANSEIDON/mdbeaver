# mdbeaver

PDF / PPTX → AI-ready Markdown. Live at https://mdbeaver.com

mdbeaver is free. If it saved you time, you can support it with WeChat:

<img src="web/donate-wechat.jpg" width="200" alt="WeChat donation QR code">

Design notes and decisions: [docs/DESIGN.md](docs/DESIGN.md)

## Layout

| Path | What | Runs on |
|---|---|---|
| `web/` | Static UI (vanilla JS). PPTX and fallback PDF conversion run in the browser | Oracle (Nginx) |
| `gateway/` | FastAPI: uploads, in-memory job queue, worker pull API | Oracle (systemd, localhost:8000) |
| `worker/` | Pulls jobs over HTTPS, converts, posts results. Engines are pluggable | Home GPU PC |
| `deploy/` | Nginx config, systemd unit, deploy scripts | — |

## Flow

1. Browser: PPTX → converted locally. PDF → uploaded only if a worker is online (otherwise local fallback).
2. Gateway queues the PDF (small files first), deletes it as soon as a worker finishes.
3. Worker (outbound HTTPS only) claims → downloads → converts → posts Markdown.
4. Browser polls the job, shows the result, then deletes the job.

## Deploy (from repo root, Git Bash)

```bash
cd web && npm install && npm run vendor && cd ..
bash deploy/deploy.sh
```

The worker token is generated on the server on first deploy (`/etc/mdbeaver/gateway.env`) and never committed.

## Run a worker (home PC)

```bash
cd worker
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
```

Create `worker/.env` (gitignored):

```
MDB_GATEWAY_URL=https://mdbeaver.com
MDB_WORKER_TOKEN=<value of MDB_WORKER_TOKEN on the server>
MDB_ENGINE=basic
```

Then `.venv/Scripts/python worker.py`. The site's status dot turns green while the worker is connected.

Engines live in `worker/engines/` and share `convert(path, kind, mode, pages, max_pages, on_progress) -> markdown`. `basic` reads the PDF text layer on CPU. `mineru` (GPU, chosen in `bench/results/engines-2026-10-29.md`) calls the MinerU API, which runs in WSL: start it with `wsl -d Ubuntu-24.04 -- bash worker/mineru-server.sh` (models load in ~1–3 min), then set `MDB_ENGINE=mineru`. MinerU's licence requires the attribution line (Credits on `web/about.html`) to be live before the site serves MinerU output.

### Coupons

A file normally gets up to `MDB_MAX_GPU_PAGES` (50) GPU pages and 50 MB. A coupon raises that for the person who has it: paste it under Settings → Coupon (it is remembered in their browser). Coupons live in `/var/lib/mdbeaver/coupons.json` on the server; manage them there with `mdb-coupons`:

```
mdb-coupons add --name friends --pages 1000 --upload 200        # unlimited uses
mdb-coupons add --name launch --uses 1 --count 20 --expires 2026-12-31   # 20 one-time coupons
mdb-coupons list
mdb-coupons remove --name launch
```

One use is one file sent to the GPU; it is given back if that job fails or is withdrawn. Long documents run on the GPU 100 pages at a time and the page shows real progress.
