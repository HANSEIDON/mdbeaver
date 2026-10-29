import asyncio
import logging
import secrets
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
    }


@app.post("/api/jobs", status_code=202)
async def create_job(request: Request, file: UploadFile = File(...), mode: str = Form("fast")):
    if mode not in ALLOWED_MODES:
        raise HTTPException(400, "invalid_mode")
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

    job = Job(id=job_id, kind=kind, mode=mode, size=size, path=path, ip=ip)
    await store.add(job)
    log.info("job %s queued kind=%s size=%d", job_id, kind, size)
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
    return {"id": job.id, "kind": job.kind, "mode": job.mode, "size": job.size}


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
