"""In-memory job queue.

Single-process by design: the gateway runs one uvicorn worker, so plain
in-memory state is enough. A restart drops queued jobs (files are wiped too),
which is acceptable because nothing is meant to be stored long-term.
"""

import asyncio
import secrets
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path

QUEUED, RUNNING, DONE, FAILED = "queued", "running", "done", "failed"


@dataclass
class Job:
    id: str
    kind: str
    mode: str
    size: int
    path: Path
    ip: str
    pages: str = ""  # "1,4,5": convert only these pages (the browser already has the rest); "" = all
    created: float = field(default_factory=time.time)
    status: str = QUEUED
    started: float | None = None
    finished: float | None = None
    result: str | None = None
    error: str | None = None

    def priority(self, now: float) -> float:
        # Small files first, but every 30s of waiting is worth 1MB so big jobs never starve.
        return self.size / 1_048_576 - (now - self.created) / 30


class JobStore:
    def __init__(self, settings):
        self.s = settings
        self.jobs: dict[str, Job] = {}
        self.ip_hits: dict[str, deque] = {}
        self.worker_last_seen = 0.0
        self._cond = asyncio.Condition()

    # --- public side ---------------------------------------------------
    def queued(self) -> list[Job]:
        now = time.time()
        return sorted((j for j in self.jobs.values() if j.status == QUEUED), key=lambda j: j.priority(now))

    def position(self, job: Job) -> int | None:
        if job.status != QUEUED:
            return None
        return next(i for i, j in enumerate(self.queued()) if j.id == job.id) + 1

    def worker_online(self) -> bool:
        # A worker busy with a long job does not call claim, so a running job also counts as alive.
        recent = time.time() - self.worker_last_seen < self.s.worker_online_window_sec
        return recent or any(j.status == RUNNING for j in self.jobs.values())

    def allow_ip(self, ip: str) -> bool:
        now = time.time()
        hits = self.ip_hits.setdefault(ip, deque())
        while hits and now - hits[0] > 3600:
            hits.popleft()
        if len(hits) >= self.s.jobs_per_ip_per_hour:
            return False
        hits.append(now)
        return True

    def queue_full(self) -> bool:
        return sum(1 for j in self.jobs.values() if j.status == QUEUED) >= self.s.max_queue

    async def add(self, job: Job) -> None:
        async with self._cond:
            self.jobs[job.id] = job
            self._cond.notify_all()

    def remove(self, job_id: str) -> None:
        job = self.jobs.pop(job_id, None)
        if job:
            job.path.unlink(missing_ok=True)

    # --- worker side ---------------------------------------------------
    async def claim(self, wait_sec: float) -> Job | None:
        self.worker_last_seen = time.time()
        deadline = time.monotonic() + wait_sec
        async with self._cond:
            while True:
                queued = self.queued()
                if queued:
                    job = queued[0]
                    job.status, job.started = RUNNING, time.time()
                    return job
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return None
                try:
                    await asyncio.wait_for(self._cond.wait(), remaining)
                except asyncio.TimeoutError:
                    return None

    def finish(self, job: Job, result: str | None = None, error: str | None = None) -> None:
        job.status = FAILED if error else DONE
        job.result, job.error, job.finished = result, error, time.time()
        job.path.unlink(missing_ok=True)

    # --- housekeeping --------------------------------------------------
    def sweep(self) -> None:
        now = time.time()
        for job in list(self.jobs.values()):
            if job.status == RUNNING and now - (job.started or now) > self.s.job_timeout_sec:
                self.finish(job, error="timeout")
            elif job.status in (DONE, FAILED) and now - (job.finished or now) > self.s.result_ttl_sec:
                self.remove(job.id)
            elif job.status == QUEUED and now - job.created > self.s.job_timeout_sec * 2:
                self.finish(job, error="expired")
            elif job.status == QUEUED and not self.worker_online():
                # Nobody will pick it up; fail now so the browser converts it locally instead.
                self.finish(job, error="worker_offline")


def new_job_id() -> str:
    return secrets.token_urlsafe(18)
