#!/usr/bin/env python3
"""Create and validate the small, non-secret backup bundle manifest."""

from __future__ import annotations

import argparse
import json
import re
import stat
import sys
from datetime import datetime, timezone
from pathlib import Path


FORMAT = "my-drive-encrypted-backup-v1"
ARTIFACTS = (
    "database.dump.age",
    "storage.tar.gz.age",
    "compose.yaml.age",
    "environment.env.age",
)
CHECKSUMS = "SHA256SUMS"
EXPECTED = set(ARTIFACTS) | {"manifest.json", CHECKSUMS}


def fail(message: str) -> "NoReturn":
    print(f"backup bundle error: {message}", file=sys.stderr)
    raise SystemExit(1)


def safe_source_name(value: str) -> bool:
    return bool(value) and value not in {".", ".."} and "/" not in value and "\\" not in value and "\x00" not in value


def write_manifest(args: argparse.Namespace) -> None:
    backup_dir = args.directory.resolve(strict=True)
    document = {
        "format": FORMAT,
        "created_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "backup_id": args.backup_id,
        "compose_project": args.project,
        "database_name": args.database,
        "database_user": args.user,
        "configuration": {
            "compose_source_name": args.compose_name,
            "environment_source_name": args.environment_name,
        },
        "artifacts": list(ARTIFACTS),
    }
    if not safe_source_name(args.compose_name) or not safe_source_name(args.environment_name):
        fail("configuration source names must be plain file names")
    for artifact in ARTIFACTS:
        path = backup_dir / artifact
        if not path.is_file() or path.is_symlink():
            fail(f"encrypted artifact is missing or unsafe: {artifact}")
    (backup_dir / "manifest.json").write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")


def validate_bundle(directory: Path) -> None:
    if not directory.is_dir() or directory.is_symlink():
        fail("backup path must be a real directory")
    actual = {item.name for item in directory.iterdir()}
    if actual != EXPECTED:
        missing = sorted(EXPECTED - actual)
        extra = sorted(actual - EXPECTED)
        fail(f"unexpected bundle members (missing={missing}, extra={extra})")
    for name in EXPECTED:
        path = directory / name
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
            fail(f"bundle member is not a regular file: {name}")

    try:
        document = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"manifest is unreadable: {exc}")
    if not isinstance(document, dict) or document.get("format") != FORMAT:
        fail("unsupported backup format")
    if document.get("artifacts") != list(ARTIFACTS):
        fail("manifest artifact list is invalid")
    for key in ("backup_id", "compose_project", "database_name", "database_user", "created_at"):
        if not isinstance(document.get(key), str) or not document[key]:
            fail(f"manifest field is missing: {key}")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,62}", document["compose_project"]):
        fail("manifest project name is invalid")
    if not re.fullmatch(r"[A-Za-z0-9_]{1,63}", document["database_name"]):
        fail("manifest database name is invalid")
    if not re.fullmatch(r"[A-Za-z0-9_]{1,63}", document["database_user"]):
        fail("manifest database user is invalid")
    configuration = document.get("configuration")
    if not isinstance(configuration, dict) or not all(
        safe_source_name(configuration.get(key, ""))
        for key in ("compose_source_name", "environment_source_name")
    ):
        fail("manifest configuration file names are invalid")

    lines = (directory / CHECKSUMS).read_text(encoding="ascii").splitlines()
    if len(lines) != len(ARTIFACTS) + 1:
        fail("checksum file has the wrong number of entries")
    expected_names = set(ARTIFACTS) | {"manifest.json"}
    checksums: dict[str, str] = {}
    for line in lines:
        match = re.fullmatch(r"([0-9a-f]{64})  ([A-Za-z0-9._-]+)", line)
        if not match:
            fail("checksum file contains an invalid entry")
        digest, name = match.groups()
        if name in checksums:
            fail(f"duplicate checksum entry: {name}")
        checksums[name] = digest
    if set(checksums) != expected_names:
        fail("checksum file does not cover every expected artifact")


def check_target(
    directory: Path,
    project: str,
    database: str,
    user: str,
    allow_source: str | None,
) -> None:
    try:
        document = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"manifest is unreadable: {exc}")
    expected = (project, database, user)
    actual = (
        document.get("compose_project"),
        document.get("database_name"),
        document.get("database_user"),
    )
    if actual == expected:
        return
    source_confirmation = f"{actual[0]}/{actual[1]} as {actual[2]}"
    if allow_source == source_confirmation:
        return
    if actual != expected:
        fail(
            "backup target does not match the selected Compose project/database/user "
            f"(backup={source_confirmation}, target={project}/{database} as {user}); "
            f"set CONFIRM_RESTORE_SOURCE='{source_confirmation}' to authorize a cross-project restore"
        )


def main() -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    create = subparsers.add_parser("create")
    create.add_argument("directory", type=Path)
    create.add_argument("project")
    create.add_argument("database")
    create.add_argument("user")
    create.add_argument("compose_name")
    create.add_argument("environment_name")
    create.add_argument("backup_id")
    validate = subparsers.add_parser("validate")
    validate.add_argument("directory", type=Path)
    target = subparsers.add_parser("check-target")
    target.add_argument("directory", type=Path)
    target.add_argument("project")
    target.add_argument("database")
    target.add_argument("user")
    target.add_argument("--allow-source")
    args = parser.parse_args()

    if args.command == "create":
        write_manifest(args)
    elif args.command == "validate":
        validate_bundle(args.directory)
    else:
        check_target(args.directory, args.project, args.database, args.user, args.allow_source)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
