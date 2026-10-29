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
    max_gpu_pages: int = 50
    friend_max_pages: int = 300
    friend_codes: tuple[tuple[str, str], ...] = ()  # (name, code): codes the owner hands to friends
    worker_online_window_sec: int = 45


def _friend_codes(raw: str) -> tuple[tuple[str, str], ...]:
    """MDB_FRIEND_CODES="alice:code1,bob:code2". Codes under 8 characters are ignored."""
    pairs = (item.split(":", 1) for item in raw.split(",") if ":" in item)
    return tuple((name.strip(), code.strip()) for name, code in pairs if len(code.strip()) >= 8)


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
        max_gpu_pages=_int("MDB_MAX_GPU_PAGES", 50),
        friend_max_pages=_int("MDB_FRIEND_MAX_PAGES", 300),
        friend_codes=_friend_codes(os.environ.get("MDB_FRIEND_CODES", "")),
    )
