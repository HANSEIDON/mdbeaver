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
from .jobs import DONE, FAILED, Job, JobStore, new_job_id

log = logging.getLogger("mdbeaver.gateway")
settings = load_settings()
store = JobStore(settings)

MAX_MARKDOWN_BYTES = 20 * 1024 * 1024
ALLOWED_MODES = {"fast", "precise"}
PAGES = re.compile(r"^\d{1,4}(,\d{1,4}){0,499}$")  # page list from the browser: "1,4,5"


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


def friend_name(code: str) -> str | None:
    """Name of the friend code sent in X-Friend-Code, if it is one of ours."""
    code = code.strip()
    if not code:
        return None
    match = None
    for name, known in settings.friend_codes:  # compare against every code: no early exit
        if secrets.compare_digest(code.encode(), known.encode()):
            match = name
    return match


_bad_codes: dict[str, deque] = {}


def code_attempt_allowed(ip: str) -> bool:
    """At most 10 wrong friend codes per IP per hour."""
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


@app.post("/api/friend")
def check_friend(request: Request):
    """Lets the page check a friend code before it is used; answers with the page limit it unlocks."""
    ip = client_ip(request)
    if not code_attempt_allowed(ip):
        raise HTTPException(429, "too_many_attempts")
    if not friend_name(request.headers.get("x-friend-code", "")):
        _bad_codes[ip].append(time.time())
        raise HTTPException(403, "unknown_code")
    return {"max_gpu_pages": settings.friend_max_pages}


@app.post("/api/jobs", status_code=202)
async def create_job(request: Request, file: UploadFile = File(...), mode: str = Form("fast"),
                     pages: str = Form("")):
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

    job_id = new_job_id()
    path = settings.upload_dir / f"{job_id}.{kind}"
    size = len(head)
    try:
        with path.open("wb") as out:
            out.write(head)
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > settings.max_upload_bytes:
                    raise HTTPException(413, "too_large")
                out.write(chunk)
    except BaseException:
        path.unlink(missing_ok=True)
        raise

    friend = friend_name(request.headers.get("x-friend-code", "")) or ""
    max_pages = settings.friend_max_pages if friend else settings.max_gpu_pages
    job = Job(id=job_id, kind=kind, mode=mode, size=size, path=path, ip=ip, pages=pages,
              max_pages=max_pages, friend=friend)
    await store.add(job)
    log.info("job %s queued kind=%s size=%d%s", job_id, kind, size, f" friend={friend}" if friend else "")
    return {"id": job_id, "position": store.position(job)}


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    job = store.jobs.get(job_id)
    if not job:
        raise HTTPException(404, "not_found")
    body = {"status": job.status, "position": store.position(job)}
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


@app.post("/api/worker/jobs/{job_id}/fail", dependencies=[Depends(require_worker)])
def worker_fail(job_id: str, body: FailIn):
    store.finish(running_job(job_id), error=body.error)
    log.info("job %s failed: %s", job_id, body.error)
    return {"ok": True}
