"""Coupons: codes the owner hands out that lift the GPU page and upload limits.

All coupons live in one JSON file (MDB_COUPONS_FILE):

    {"coupons": [{"code": "dam-...", "name": "friends", "max_pages": 1000, "max_upload_mb": 200,
                  "uses": null, "used": 0, "expires": "2026-12-31"}]}

"uses" null means unlimited; a number makes a limited coupon (1 = one-time). One use is one file
sent to the GPU: it is taken when the job is queued and given back if the job fails or is
withdrawn. "expires" (optional) is the last valid day, UTC.

Manage them on the server with the CLI (run from /opt/mdbeaver/gateway, as the service user):

    python -m app.coupons add --name friends --pages 1000 --upload 200
    python -m app.coupons add --name launch --uses 1 --count 20 --expires 2026-12-31
    python -m app.coupons list
    python -m app.coupons remove --name launch        (or --code dam-...)
"""

import argparse
import datetime as dt
import json
import os
import secrets
from pathlib import Path

ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"  # no 0/o, 1/l/i: easy to read out and type


def new_code() -> str:
    part = lambda: "".join(secrets.choice(ALPHABET) for _ in range(4))  # noqa: E731
    return f"dam-{part()}-{part()}-{part()}"


class Coupons:
    def __init__(self, path: Path):
        self.path = path

    def load(self) -> dict:
        try:
            return json.loads(self.path.read_text("utf-8"))
        except FileNotFoundError:
            return {"coupons": []}

    def save(self, data: dict) -> None:
        # 0600: the codes are secrets, whoever runs this (the service or mdb-coupons).
        tmp = self.path.with_suffix(".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(json.dumps(data, indent=2))
        os.chmod(tmp, 0o600)
        os.replace(tmp, self.path)

    @staticmethod
    def _match(data: dict, code: str) -> dict | None:
        code, found = code.strip(), None
        for c in data["coupons"]:  # compare against every code: no early exit
            if code and secrets.compare_digest(code.encode(), c["code"].encode()):
                found = c
        return found

    @staticmethod
    def state(c: dict) -> str:
        """"ok", "expired" or "used_up"."""
        if c.get("expires") and dt.date.fromisoformat(c["expires"]) < dt.datetime.now(dt.timezone.utc).date():
            return "expired"
        if c.get("uses") is not None and c.get("used", 0) >= c["uses"]:
            return "used_up"
        return "ok"

    @staticmethod
    def public(c: dict) -> dict:
        """What the page may see about a coupon (never the code list or other coupons)."""
        left = None if c.get("uses") is None else max(0, c["uses"] - c.get("used", 0))
        return {"max_gpu_pages": c["max_pages"], "max_upload_mb": c["max_upload_mb"],
                "uses_left": left, "expires": c.get("expires")}

    def find(self, code: str) -> dict | None:
        return self._match(self.load(), code)

    def take(self, code: str) -> dict | None:
        """Use the coupon once if it is valid; returns it, or None (then normal limits apply)."""
        data = self.load()
        c = self._match(data, code)
        if not c or self.state(c) != "ok":
            return None
        if c.get("uses") is not None:
            c["used"] = c.get("used", 0) + 1
            self.save(data)
        return c

    def give_back(self, code: str) -> None:
        data = self.load()
        c = self._match(data, code)
        if c and c.get("uses") is not None and c.get("used", 0) > 0:
            c["used"] -= 1
            self.save(data)


def main() -> None:
    from .config import load_settings

    parser = argparse.ArgumentParser(prog="python -m app.coupons")
    sub = parser.add_subparsers(dest="cmd", required=True)
    add = sub.add_parser("add", help="create coupons and print their codes")
    add.add_argument("--name", required=True, help="who or what they are for, shown in the log")
    add.add_argument("--pages", type=int, default=1000, help="GPU pages per file")
    add.add_argument("--upload", type=int, default=200, help="upload limit in MB")
    add.add_argument("--uses", type=int, default=None, help="files per coupon; omit for unlimited")
    add.add_argument("--expires", default=None, help="last valid day, YYYY-MM-DD")
    add.add_argument("--count", type=int, default=1, help="how many coupons to make")
    sub.add_parser("list", help="show all coupons")
    rm = sub.add_parser("remove", help="delete coupons")
    rm.add_argument("--code")
    rm.add_argument("--name")
    args = parser.parse_args()

    store = Coupons(load_settings(require_token=False).coupons_file)
    data = store.load()
    if args.cmd == "add":
        if args.expires:
            dt.date.fromisoformat(args.expires)
        for _ in range(args.count):
            c = {"code": new_code(), "name": args.name, "max_pages": args.pages, "max_upload_mb": args.upload,
                 "uses": args.uses, "used": 0, "expires": args.expires}
            data["coupons"].append(c)
            print(c["code"])
        store.save(data)
    elif args.cmd == "list":
        for c in data["coupons"]:
            uses = "unlimited" if c.get("uses") is None else f"{c.get('used', 0)}/{c['uses']} used"
            print(f"{c['code']}  {c['name']:<12} {c['max_pages']} pages  {c['max_upload_mb']} MB  {uses}"
                  f"  {'until ' + c['expires'] if c.get('expires') else 'no expiry'}  [{Coupons.state(c)}]")
    elif args.cmd == "remove":
        if not (args.code or args.name):
            parser.error("give --code or --name")
        keep = [c for c in data["coupons"] if c["code"] != args.code and c["name"] != args.name]
        print(f"removed {len(data['coupons']) - len(keep)}")
        data["coupons"] = keep
        store.save(data)


if __name__ == "__main__":
    main()
