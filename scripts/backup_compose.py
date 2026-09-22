#!/usr/bin/env python3
"""Read only the non-secret bits needed from `docker compose config`."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path


ROOTS = {
    "database": "/var/lib/postgresql/data",
    "storage": "/srv/my-drive/data",
    "preview": "/srv/my-drive/previews",
}

MOUNT_SPECS = (
    ("db", ROOTS["database"]),
    ("app", ROOTS["storage"]),
    ("app", ROOTS["preview"]),
)


def fail(message: str) -> "NoReturn":
    print(f"Compose configuration error: {message}", file=sys.stderr)
    raise SystemExit(1)


def windows_path_to_wsl(value: str) -> str:
    match = re.fullmatch(r"([A-Za-z]):[\\/](.*)", value)
    if not match:
        return value
    drive, tail = match.groups()
    return f"/mnt/{drive.lower()}/{tail.replace(chr(92), '/') }"


def volumes_for(service: dict, service_name: str) -> list[dict]:
    volumes = service.get("volumes", [])
    if not isinstance(volumes, list):
        fail(f"service {service_name} has invalid volumes")
    return volumes


def environment_for(service: dict) -> dict[str, str]:
    raw = service.get("environment", {})
    if isinstance(raw, dict):
        return {str(key): "" if value is None else str(value) for key, value in raw.items()}
    if isinstance(raw, list):
        result: dict[str, str] = {}
        for item in raw:
            if isinstance(item, str) and "=" in item:
                key, value = item.split("=", 1)
                result[key] = value
        return result
    fail("service environment is not a mapping")


def read_config() -> dict:
    try:
        document = json.load(sys.stdin)
    except (json.JSONDecodeError, OSError) as exc:
        fail(f"could not parse Compose JSON: {exc}")
    if not isinstance(document, dict):
        fail("Compose output is not an object")
    return document


def metadata(document: dict) -> dict:
    services = document.get("services")
    if not isinstance(services, dict) or not isinstance(services.get("db"), dict) or not isinstance(services.get("app"), dict):
        fail("both db and app services are required")

    db_environment = environment_for(services["db"])
    app_environment = environment_for(services["app"])
    name = document.get("name")
    database = db_environment.get("POSTGRES_DB")
    user = db_environment.get("POSTGRES_USER")
    if not all(isinstance(value, str) and value for value in (name, database, user)):
        fail("project name, POSTGRES_DB, and POSTGRES_USER must resolve")

    try:
        min_free_bytes = int(app_environment.get("MIN_FREE_BYTES", "5368709120"))
        min_free_percent = float(app_environment.get("MIN_FREE_PERCENT", "5"))
    except ValueError:
        fail("MIN_FREE_BYTES and MIN_FREE_PERCENT must be numeric")
    if min_free_bytes < 0 or min_free_percent < 0 or min_free_percent > 100:
        fail("storage free-space limits are outside supported bounds")

    return {
        "project": name,
        "database": database,
        "user": user,
        "min_free_bytes": min_free_bytes,
        "min_free_percent": min_free_percent,
    }


def mounts(document: dict) -> list[str]:
    services = document.get("services")
    if not isinstance(services, dict):
        fail("services are missing")

    result: list[str] = []
    for service_name, target in MOUNT_SPECS:
        service = services.get(service_name)
        if not isinstance(service, dict):
            fail(f"service {service_name} is missing")
        matches = [
            volume
            for volume in volumes_for(service, service_name)
            if isinstance(volume, dict) and volume.get("target") == target
        ]
        if len(matches) != 1:
            fail(f"service {service_name} must bind-mount {target} exactly once")
        volume = matches[0]
        if volume.get("type") != "bind" or not isinstance(volume.get("source"), str):
            fail(f"service {service_name} must use a host bind mount for {target}")
        source = windows_path_to_wsl(volume["source"])
        path = Path(source)
        if not path.is_absolute() or not path.is_dir():
            fail(f"bind source for {target} must already exist as an absolute directory")
        resolved = path.resolve(strict=True)
        if "\n" in str(resolved) or "\r" in str(resolved):
            fail("bind sources cannot contain newlines")
        result.append(str(resolved))

    paths = [Path(path) for path in result]
    for index, left in enumerate(paths):
        for right in paths[index + 1 :]:
            try:
                left.relative_to(right)
                overlaps = True
            except ValueError:
                try:
                    right.relative_to(left)
                    overlaps = True
                except ValueError:
                    overlaps = False
            if overlaps:
                fail("database, storage, and preview bind sources must not overlap")
    return result


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in {"metadata", "mounts"}:
        print("usage: backup_compose.py metadata|mounts", file=sys.stderr)
        return 2
    document = read_config()
    if sys.argv[1] == "metadata":
        print(json.dumps(metadata(document), separators=(",", ":")))
    else:
        print("\n".join(mounts(document)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
