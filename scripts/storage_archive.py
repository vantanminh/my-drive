#!/usr/bin/env python3
"""Validate and safely extract the encrypted backup's storage tar stream."""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import stat
import sys
import tarfile
import uuid
from pathlib import Path


ROOTS = frozenset({"objects", "uploads", "trash", "previews"})
ROOT_CHOICES = tuple(sorted(ROOTS))
OBJECT_KEY = re.compile(r"^[0-9a-f]{2}/[0-9a-f]{2}/[0-9a-f-]{36}$")
STAGING_KEY = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.part$")
CHUNK = 1024 * 1024


class ArchiveError(Exception):
    pass


def fail(message: str) -> "NoReturn":
    raise ArchiveError(message)


def member_path(
    member: tarfile.TarInfo, allowed_roots: frozenset[str] = ROOTS
) -> tuple[str, ...]:
    name = member.name
    if not name or "\x00" in name or "\\" in name or name.startswith("/"):
        fail(f"unsafe archive member name: {name!r}")
    if re.match(r"^[A-Za-z]:", name):
        fail(f"absolute archive member name: {name!r}")
    clean_name = name[:-1] if name.endswith("/") else name
    parts = clean_name.split("/")
    if not clean_name or any(part in {"", ".", ".."} for part in parts):
        fail(f"unsafe archive member path: {name!r}")
    if parts[0] not in allowed_roots:
        fail(f"unexpected storage archive root: {parts[0]!r}")
    if member.issym() or member.islnk() or member.isdev() or member.isfifo() or not (member.isdir() or member.isfile()):
        fail(f"unsupported archive member type: {name!r}")
    if len(parts) == 1 and not member.isdir():
        fail(f"storage root must be a directory: {name!r}")
    if member.size < 0:
        fail(f"negative archive member size: {name!r}")
    if parts[0] == "objects" and len(parts) > 1:
        rel = "/".join(parts[1:])
        if member.isfile():
            object_parts = rel.split("/")
            if len(object_parts) != 3 or not OBJECT_KEY.fullmatch(rel):
                fail(f"invalid object archive path: {name!r}")
            try:
                object_id = str(uuid.UUID(object_parts[2]))
            except ValueError:
                fail(f"invalid object UUID in archive path: {name!r}")
            if object_id != object_parts[2] or object_id[:2] != object_parts[0] or object_id[2:4] != object_parts[1]:
                fail(f"object key does not match its shard path: {name!r}")
        elif len(parts) > 4:
            fail(f"unexpected object directory depth: {name!r}")
    if parts[0] == "uploads" and member.isfile() and len(parts) == 2 and not STAGING_KEY.fullmatch(parts[1]):
        fail(f"invalid upload staging path: {name!r}")
    return tuple(parts)


def prepare_destination(destination: Path) -> Path:
    if destination.exists() or destination.is_symlink():
        fail("restore staging directory must be new and empty")
    destination.mkdir(mode=0o700, parents=False)
    return destination.resolve(strict=True)


def ensure_directory(destination: Path, path: Path) -> None:
    current = destination
    relative = path.relative_to(destination)
    for part in relative.parts:
        current = current / part
        try:
            info = current.lstat()
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
                fail(f"unsafe extraction parent: {current}")
        except FileNotFoundError:
            current.mkdir(mode=0o750)


def set_owner_and_mode(path: Path, mode: int) -> None:
    os.chmod(path, mode)
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        os.chown(path, 10001, 10001, follow_symlinks=False)


def process_archive(
    destination: Path | None, allowed_roots: frozenset[str]
) -> int:
    seen: dict[tuple[str, ...], str] = {}
    roots_seen: set[str] = set()
    total_bytes = 0
    destination_root = prepare_destination(destination) if destination is not None else None

    try:
        archive = tarfile.open(fileobj=sys.stdin.buffer, mode="r|gz")
        with archive:
            for member in archive:
                parts = member_path(member, allowed_roots)
                current_type = "dir" if member.isdir() else "file"
                if parts in seen:
                    fail(f"duplicate archive path: {'/'.join(parts)}")
                for depth in range(1, len(parts)):
                    ancestor = parts[:depth]
                    if seen.get(ancestor) == "file":
                        fail(f"file blocks an archive directory: {'/'.join(ancestor)}")
                    seen.setdefault(ancestor, "dir")
                seen[parts] = current_type
                if len(parts) == 1:
                    roots_seen.add(parts[0])
                target = destination_root.joinpath(*parts) if destination_root else None

                if member.isdir():
                    if target is not None:
                        ensure_directory(destination_root, target)
                    continue

                total_bytes += member.size
                source = archive.extractfile(member)
                if source is None:
                    fail(f"could not read archive member: {member.name!r}")

                if target is None:
                    remaining = member.size
                    while remaining:
                        chunk = source.read(min(CHUNK, remaining))
                        if not chunk:
                            fail(f"truncated archive member: {member.name!r}")
                        remaining -= len(chunk)
                    if source.read(1):
                        fail(f"archive member exceeds its declared size: {member.name!r}")
                    continue

                ensure_directory(destination_root, target.parent)
                flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
                if hasattr(os, "O_NOFOLLOW"):
                    flags |= os.O_NOFOLLOW
                fd = os.open(target, flags, 0o640)
                remaining = member.size
                try:
                    with os.fdopen(fd, "wb", closefd=True) as output:
                        while remaining:
                            chunk = source.read(min(CHUNK, remaining))
                            if not chunk:
                                fail(f"truncated archive member: {member.name!r}")
                            output.write(chunk)
                            remaining -= len(chunk)
                        if source.read(1):
                            fail(f"archive member exceeds its declared size: {member.name!r}")
                        output.flush()
                        os.fsync(output.fileno())
                except BaseException:
                    try:
                        target.unlink()
                    except OSError:
                        pass
                    raise
                set_owner_and_mode(target, 0o640)

        if roots_seen != allowed_roots:
            missing = ", ".join(sorted(allowed_roots - roots_seen))
            fail(f"archive is missing required storage roots: {missing}")

        if destination_root is not None:
            for root_name in sorted(allowed_roots):
                ensure_directory(destination_root, destination_root / root_name)
            for path in sorted(destination_root.rglob("*"), key=lambda item: len(item.parts), reverse=True):
                if path.is_dir() and not path.is_symlink():
                    set_owner_and_mode(path, 0o750)
            set_owner_and_mode(destination_root, 0o750)
        return total_bytes
    except (tarfile.TarError, OSError, EOFError) as exc:
        fail(f"invalid or unreadable storage archive: {exc}")


def validate_storage_tree(
    root: Path,
    allowed_roots: frozenset[str] = ROOTS,
    archive_root_name: str | None = None,
) -> int:
    if not root.is_dir() or root.is_symlink():
        fail("storage root is not a real directory")
    root = root.resolve(strict=True)
    checked = 0
    seen_inodes: set[tuple[int, int]] = set()
    if archive_root_name is not None:
        if len(allowed_roots) != 1 or archive_root_name not in allowed_roots:
            fail("a single archive root name is required for a one-root tree")
        roots_to_scan = [(archive_root_name, root)]
    else:
        roots_to_scan = [
            (root_name, root / root_name) for root_name in sorted(allowed_roots)
        ]

    for root_name, storage_root in roots_to_scan:
        if not storage_root.is_dir() or storage_root.is_symlink():
            fail(f"storage root is missing or unsafe: {root_name}")
        for current, directories, files in os.walk(storage_root, topdown=True, followlinks=False):
            current_path = Path(current)
            for name in sorted(directories + files):
                path = current_path / name
                try:
                    info = path.lstat()
                except OSError as exc:
                    fail(f"could not inspect storage path {path}: {exc}")
                relative = f"{root_name}/{path.relative_to(storage_root).as_posix()}"
                member = tarfile.TarInfo(relative)
                if stat.S_ISDIR(info.st_mode):
                    member.type = tarfile.DIRTYPE
                elif stat.S_ISREG(info.st_mode):
                    member.type = tarfile.REGTYPE
                    member.size = info.st_size
                    inode = (info.st_dev, info.st_ino)
                    if inode in seen_inodes:
                        fail(f"hard-linked storage paths are not supported: {relative!r}")
                    seen_inodes.add(inode)
                else:
                    fail(f"unsupported storage path type: {relative!r}")
                member_path(member, allowed_roots)
                checked += 1
                if stat.S_ISLNK(info.st_mode):
                    fail(f"symbolic links are not allowed in storage: {relative!r}")
            directories[:] = [
                name for name in directories if not (current_path / name).is_symlink()
            ]
    return checked


def validate_ready_objects(root: Path, rows_path: Path) -> int:
    if not root.is_dir() or root.is_symlink():
        fail("staged storage root is not a real directory")
    root = root.resolve(strict=True)
    objects_root = root / "objects"
    if not objects_root.is_dir() or objects_root.is_symlink():
        fail("staged objects directory is missing or unsafe")

    count = 0
    seen_keys: set[str] = set()
    with rows_path.open("r", encoding="utf-8", newline="") as rows:
        for line_number, line in enumerate(rows, 1):
            line = line.rstrip("\r\n")
            if not line:
                continue
            fields = line.split("\t")
            if len(fields) != 3:
                fail(f"malformed ready-object row at line {line_number}")
            key, size_text, expected_checksum = fields
            if key in seen_keys or not OBJECT_KEY.fullmatch(key):
                fail(f"invalid or duplicate ready-object key: {key!r}")
            seen_keys.add(key)
            parts = key.split("/")
            try:
                object_id = str(uuid.UUID(parts[2]))
                expected_size = int(size_text)
            except (ValueError, TypeError):
                fail(f"invalid ready-object key or size: {key!r}")
            if (
                object_id != parts[2]
                or object_id[:2] != parts[0]
                or object_id[2:4] != parts[1]
                or expected_size < 0
                or not re.fullmatch(r"[0-9a-f]{64}", expected_checksum)
            ):
                fail(f"invalid ready-object key or size: {key!r}")

            path = objects_root / parts[0] / parts[1] / parts[2]
            current = objects_root
            for component in parts[:2]:
                current = current / component
                try:
                    info = current.lstat()
                except FileNotFoundError:
                    fail(f"ready object payload is missing: {key}")
                if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
                    fail(f"ready object shard path is unsafe: {key}")
            try:
                info = path.lstat()
            except FileNotFoundError:
                fail(f"ready object payload is missing: {key}")
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
                fail(f"ready object payload is not a regular file: {key}")
            if info.st_size != expected_size:
                fail(f"ready object size mismatch for {key}: expected {expected_size}, found {info.st_size}")
            digest = hashlib.sha256()
            try:
                with path.open("rb") as payload:
                    while chunk := payload.read(CHUNK):
                        digest.update(chunk)
            except OSError as exc:
                fail(f"could not read ready object payload {key}: {exc}")
            if digest.hexdigest() != expected_checksum:
                fail(f"ready object checksum mismatch for {key}")
            count += 1
    return count


def main() -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    validate = subparsers.add_parser("validate")
    validate.add_argument("--summary", action="store_true")
    validate.add_argument("--roots", nargs="+", choices=ROOT_CHOICES)
    extract = subparsers.add_parser("extract")
    extract.add_argument("destination", type=Path)
    extract.add_argument("--roots", nargs="+", choices=ROOT_CHOICES)
    check = subparsers.add_parser("validate-ready")
    check.add_argument("root", type=Path)
    check.add_argument("rows", type=Path)
    tree = subparsers.add_parser("validate-tree")
    tree.add_argument("root", type=Path)
    tree.add_argument("--roots", nargs="+", choices=ROOT_CHOICES)
    tree.add_argument("--root-name", choices=ROOT_CHOICES)
    args = parser.parse_args()

    try:
        if args.command == "validate-ready":
            count = validate_ready_objects(args.root, args.rows)
            print(count)
            return 0
        if args.command == "validate-tree":
            allowed_roots = frozenset(args.roots or ROOT_CHOICES)
            checked = validate_storage_tree(args.root, allowed_roots, args.root_name)
            print(f"storage tree validated: {checked} entries")
            return 0
        allowed_roots = frozenset(args.roots or ROOT_CHOICES)
        destination = args.destination if args.command == "extract" else None
        total_bytes = process_archive(destination, allowed_roots)
        if args.command == "validate" and args.summary:
            print(total_bytes)
        else:
            print(f"storage archive validated: {total_bytes} file bytes")
        return 0
    except ArchiveError as exc:
        print(f"storage archive error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
