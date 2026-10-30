"""MDBeaver worker: pulls jobs from the gateway over HTTPS, converts, uploads results.

Only outbound HTTPS is used, so the machine running this needs no open ports.
Config comes from environment variables or worker/.env (see .env.example).
"""

import logging
import os
import tempfile
import threading
import time
from contextlib import contextmanager
from pathlib import Path

import httpx

from engines import get_engine

log = logging.getLogger("mdbeaver.worker")


def load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip())


def run() -> None:
    load_dotenv(Path(__file__).with_name(".env"))
    gateway = os.environ["MDB_GATEWAY_URL"].rstrip("/")
    token = os.environ["MDB_WORKER_TOKEN"]
    engine = get_engine(os.environ.get("MDB_ENGINE", "basic"))
    client = httpx.Client(
        base_url=gateway,
        headers={"Authorization": f"Bearer {token}"},
        timeout=httpx.Timeout(60, connect=15),
    )
    log.info("worker started: gateway=%s engine=%s", gateway, engine.NAME)

    backoff = 1
    while True:
        try:
            resp = client.post("/api/worker/claim", timeout=httpx.Timeout(35, connect=15))
            if resp.status_code == 204:
                backoff = 1
                continue
            resp.raise_for_status()
            backoff = 1
            process(client, engine, resp.json())
        except httpx.HTTPError as exc:
            log.warning("gateway unreachable (%s), retrying in %ss", type(exc).__name__, backoff)
            time.sleep(backoff)
            backoff = min(backoff * 2, 60)


@contextmanager
def heartbeat(client: httpx.Client, every: float = 15):
    """While a job runs, tell the gateway every few seconds that this worker is still alive, so a
    switched-off PC is noticed within a minute instead of at the job's timeout. Uses its own
    connection: the main one may be busy uploading."""
    stop = threading.Event()

    def beat() -> None:
        with httpx.Client(base_url=client.base_url, headers=client.headers, timeout=10) as hb:
            while not stop.wait(every):
                try:
                    hb.post("/api/worker/heartbeat")
                except httpx.HTTPError:
                    pass

    thread = threading.Thread(target=beat, daemon=True)
    thread.start()
    try:
        yield
    finally:
        stop.set()


def process(client: httpx.Client, engine, job: dict) -> None:
    with heartbeat(client):
        _process(client, engine, job)


def _process(client: httpx.Client, engine, job: dict) -> None:
    job_id = job["id"]
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="mdb-") as tmp:
        path = Path(tmp) / f"input.{job['kind']}"
        with client.stream("GET", f"/api/worker/jobs/{job_id}/file") as resp:
            if resp.status_code == 404:  # the user pressed Stop before we got the file
                log.info("job %s withdrawn", job_id)
                return
            resp.raise_for_status()
            with path.open("wb") as out:
                for chunk in resp.iter_bytes():
                    out.write(chunk)
        # The browser sends only the pages it could not read itself ("1,4,5"); empty means all.
        pages = [int(p) for p in job.get("pages", "").split(",") if p] or None
        try:
            # The gateway sets the page limit per job (higher with a coupon). Long jobs report
            # each finished chunk, so the page shows progress and the Markdown done so far.
            def progress(done: int, total: int, markdown: str | None = None) -> None:
                try:
                    client.post(f"/api/worker/jobs/{job_id}/progress",
                                json={"done": done, "total": total, "markdown": markdown})
                except httpx.HTTPError:
                    pass  # progress is a nicety; never fail the job over it

            markdown = engine.convert(path, job["kind"], job["mode"], pages, job.get("max_pages"), progress)
        except Exception as exc:  # report a short code, never document content
            code = str(exc) if isinstance(exc, ValueError) else type(exc).__name__
            log.warning("job %s failed: %s", job_id, code)
            client.post(f"/api/worker/jobs/{job_id}/fail", json={"error": code[:200]})
            return
    resp = client.post(f"/api/worker/jobs/{job_id}/result", json={"markdown": markdown})
    if resp.status_code == 404:  # withdrawn (Stop) while we were converting: nothing to deliver
        log.info("job %s withdrawn after %.1fs", job_id, time.monotonic() - started)
        return
    resp.raise_for_status()
    log.info("job %s done in %.1fs (%d chars)", job_id, time.monotonic() - started, len(markdown))


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    run()
