import asyncio
import logging
import re
import secrets
import time
from collections import deque
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from .config import load_settings
from .coupons import Coupons
from .jobs import DONE, FAILED, RUNNING, Job, JobStore, new_job_id
from .stats import KINDS, Stats

log = logging.getLogger("mdbeaver.gateway")
settings = load_settings()
coupons = Coupons(settings.coupons_file)
store = JobStore(settings, give_back=coupons.give_back)
stats = Stats(settings.stats_file)

MAX_MARKDOWN_BYTES = 20 * 1024 * 1024
ALLOWED_MODES = {"fast", "precise"}
PAGES = re.compile(r"^\d{1,4}(,\d{1,4}){0,1999}$")  # page list from the browser: "1,4,5"


async def _sweeper():
    while True:
        await asyncio.sleep(30)
        store.sweep()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Nothing survives a restart: wipe leftover uploads from a previous run.
    for p in settings.upload_dir.iterdir():
        p.unlink(missing_ok=True)
    task = asyncio.create_task(_sweeper())
    yield
    task.cancel()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


def client_ip(request: Request) -> str:
    # The app only listens on localhost behind Nginx, which sets X-Real-IP.
    return request.headers.get("x-real-ip") or (request.client.host if request.client else "unknown")


_bad_codes: dict[str, deque] = {}


def code_attempt_allowed(ip: str) -> bool:
    """At most 10 wrong coupon codes per IP per hour."""
    now = time.time()
    misses = _bad_codes.setdefault(ip, deque())
    while misses and now - misses[0] > 3600:
        misses.popleft()
    return len(misses) < 10


def sniff_kind(head: bytes) -> str | None:
    if head.startswith(b"%PDF-"):
        return "pdf"
    return None


# --- public API ------------------------------------------------------------
@app.get("/api/status")
def status():
    return {
        "worker_online": store.worker_online(),
        "queue_length": len(store.queued()),
        "max_upload_mb": settings.max_upload_bytes // 1_048_576,
        "max_gpu_pages": settings.max_gpu_pages,
    }


@app.post("/api/coupon")
def check_coupon(request: Request):
    """Lets the page check a coupon (sent in X-Coupon) before using it: its limits and uses left."""
    ip = client_ip(request)
    if not code_attempt_allowed(ip):
        raise HTTPException(429, "too_many_attempts")
    c = coupons.find(request.headers.get("x-coupon", ""))
    if not c:
        _bad_codes[ip].append(time.time())
        raise HTTPException(403, "unknown_coupon")
    if (state := Coupons.state(c)) != "ok":
        raise HTTPException(410, state)
    return Coupons.public(c)


class CountIn(BaseModel):
    kind: str
    pages: int = Field(default=0, ge=0, le=100_000)
    gpu: bool = False
    ok: bool = True


# Counts per IP per day, in memory only, so one visitor can't inflate the totals much.
_counted: dict[str, int] = {}
_counted_day = ""
COUNTS_PER_IP_PER_DAY = 500


@app.post("/api/count", status_code=204)
def count(body: CountIn, request: Request):
    """One finished file, for the anonymous daily totals (app/stats.py). Nothing identifying is kept."""
    global _counted_day
    if body.kind not in KINDS:
        raise HTTPException(400, "bad_kind")
    today = time.strftime("%Y-%m-%d", time.gmtime())
    if today != _counted_day:
        _counted.clear()
        _counted_day = today
    ip = client_ip(request)
    if _counted.get(ip, 0) >= COUNTS_PER_IP_PER_DAY:
        return Response(status_code=204)
    _counted[ip] = _counted.get(ip, 0) + 1
    stats.add(body.kind, body.pages, body.gpu, body.ok)
    return Response(status_code=204)


@app.post("/api/jobs", status_code=202)
async def create_job(request: Request, file: UploadFile = File(...), mode: str = Form("fast"),
                     pages: str = Form(""), coupon_code: str = Form("", alias="coupon")):
    if mode not in ALLOWED_MODES:
        raise HTTPException(400, "invalid_mode")
    if pages and not PAGES.match(pages):
        raise HTTPException(400, "invalid_pages")
    if not store.worker_online():
        raise HTTPException(503, "worker_offline")
    if store.queue_full():
        raise HTTPException(429, "queue_full")
    ip = client_ip(request)
    if not store.allow_ip(ip):
        raise HTTPException(429, "rate_limited")

    head = await file.read(8)
    kind = sniff_kind(head)
    if kind is None:
        raise HTTPException(415, "unsupported_type")

    # A valid coupon raises this file's limits and is used once; an invalid one is ignored.
    # It comes as a form field (some browser extensions drop uploads that carry extra headers).
    code = coupon_code or request.headers.get("x-coupon", "")
    coupon = coupons.take(code) if code else None
    max_bytes = coupon["max_upload_mb"] * 1_048_576 if coupon else settings.max_upload_bytes
    job_id = new_job_id()
    path = settings.upload_dir / f"{job_id}.{kind}"
    size = len(head)
    try:
        with path.open("wb") as out:
            out.write(head)
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > max_bytes:
                    raise HTTPException(413, "too_large")
                out.write(chunk)
    except BaseException:
        path.unlink(missing_ok=True)
        if coupon:
            coupons.give_back(code)
        raise

    job = Job(id=job_id, kind=kind, mode=mode, size=size, path=path, ip=ip, pages=pages,
              max_pages=coupon["max_pages"] if coupon else settings.max_gpu_pages,
              coupon=code if coupon else "")
    await store.add(job)
    log.info("job %s queued kind=%s size=%d%s", job_id, kind, size, f" coupon={coupon['name']}" if coupon else "")
    return {"id": job_id, "position": store.position(job)}


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str, since: int = 0):
    """since: how many finished chunks the page already has; only newer ones are sent."""
    job = store.jobs.get(job_id)
    if not job:
        raise HTTPException(404, "not_found")
    body = {"status": job.status, "position": store.position(job)}
    if job.status == RUNNING and job.progress is not None:
        body["progress"] = job.progress
    if job.status == RUNNING and len(job.parts) > since >= 0:
        body["parts"] = job.parts[since:]
    if job.status == DONE:
        body["markdown"] = job.result
    elif job.status == FAILED:
        body["error"] = job.error
    return body


@app.delete("/api/jobs/{job_id}", status_code=204)
def delete_job(job_id: str):
    store.remove(job_id)
    return Response(status_code=204)


# --- worker API ------------------------------------------------------------
def require_worker(request: Request) -> None:
    auth = request.headers.get("authorization", "")
    token = auth.removeprefix("Bearer ").strip()
    if not secrets.compare_digest(token.encode(), settings.worker_token.encode()):
        raise HTTPException(401, "unauthorized")


class ResultIn(BaseModel):
    markdown: str = Field(max_length=MAX_MARKDOWN_BYTES)


class FailIn(BaseModel):
    error: str = Field(max_length=200)


class ProgressIn(BaseModel):
    done: int = Field(ge=0)
    total: int = Field(gt=0)
    markdown: str | None = Field(default=None, max_length=MAX_MARKDOWN_BYTES)  # the chunk just done


def running_job(job_id: str) -> Job:
    job = store.jobs.get(job_id)
    if not job or job.status != "running":
        raise HTTPException(404, "not_running")
    return job


@app.post("/api/worker/claim", dependencies=[Depends(require_worker)])
async def worker_claim():
    job = await store.claim(wait_sec=20)
    if not job:
        return Response(status_code=204)
    return {"id": job.id, "kind": job.kind, "mode": job.mode, "size": job.size, "pages": job.pages,
            "max_pages": job.max_pages}


@app.get("/api/worker/jobs/{job_id}/file", dependencies=[Depends(require_worker)])
def worker_file(job_id: str):
    return FileResponse(running_job(job_id).path, media_type="application/octet-stream")


@app.post("/api/worker/jobs/{job_id}/result", dependencies=[Depends(require_worker)])
def worker_result(job_id: str, body: ResultIn):
    store.finish(running_job(job_id), result=body.markdown)
    log.info("job %s done", job_id)
    return {"ok": True}


@app.post("/api/worker/jobs/{job_id}/progress", dependencies=[Depends(require_worker)])
def worker_progress(job_id: str, body: ProgressIn):
    job = running_job(job_id)
    store.heartbeat()
    job.progress = min(1.0, body.done / body.total)
    if body.markdown:
        job.parts.append(body.markdown)
    return {"ok": True}


@app.post("/api/worker/heartbeat", dependencies=[Depends(require_worker)])
def worker_heartbeat():
    store.heartbeat()
    return {"ok": True}


@app.post("/api/worker/jobs/{job_id}/fail", dependencies=[Depends(require_worker)])
def worker_fail(job_id: str, body: FailIn):
    store.finish(running_job(job_id), error=body.error)
    log.info("job %s failed: %s", job_id, body.error)
    return {"ok": True}
