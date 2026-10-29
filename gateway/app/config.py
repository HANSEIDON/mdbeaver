import os
from dataclasses import dataclass
from pathlib import Path


def _int(name: str, default: int) -> int:
    return int(os.environ.get(name, default))


@dataclass(frozen=True)
class Settings:
    worker_token: str
    upload_dir: Path
    max_upload_bytes: int
    max_queue: int
    jobs_per_ip_per_hour: int
    result_ttl_sec: int
    job_timeout_sec: int
    worker_online_window_sec: int = 45


def load_settings() -> Settings:
    token = os.environ.get("MDB_WORKER_TOKEN", "")
    if len(token) < 32:
        raise RuntimeError("MDB_WORKER_TOKEN must be set (32+ chars)")
    upload_dir = Path(os.environ.get("MDB_UPLOAD_DIR", "./uploads"))
    upload_dir.mkdir(parents=True, exist_ok=True)
    return Settings(
        worker_token=token,
        upload_dir=upload_dir,
        max_upload_bytes=_int("MDB_MAX_UPLOAD_MB", 50) * 1024 * 1024,
        max_queue=_int("MDB_MAX_QUEUE", 100),
        jobs_per_ip_per_hour=_int("MDB_JOBS_PER_IP_PER_HOUR", 30),
        result_ttl_sec=_int("MDB_RESULT_TTL_SEC", 600),
        job_timeout_sec=_int("MDB_JOB_TIMEOUT_SEC", 900),
    )
