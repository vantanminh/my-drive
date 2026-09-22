#!/usr/bin/env bash

set -Eeuo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/backup-common.sh"

[[ "$#" -eq 1 ]] || die "usage: AGE_IDENTITY=/path/to/age-identity scripts/verify-backup.sh /path/to/backup"
require_compose_inputs
require_command "$AGE_BIN"
require_command "$SHA256SUM_BIN"
require_command head
verify_identity_file
require_running_database

backup_dir="$1"
[[ -d "$backup_dir" ]] || die "backup directory is missing: $backup_dir"
backup_dir="$(realpath -e -- "$backup_dir")"
"$PYTHON_BIN" "$SCRIPT_DIR/backup_bundle.py" validate "$backup_dir"
(
    cd -- "$backup_dir"
    "$SHA256SUM_BIN" --check --strict SHA256SUMS >/dev/null
)

"$AGE_BIN" --decrypt --identity "$AGE_IDENTITY" "$backup_dir/compose.yaml.age" >/dev/null
"$AGE_BIN" --decrypt --identity "$AGE_IDENTITY" "$backup_dir/environment.env.age" >/dev/null
"$AGE_BIN" --decrypt --identity "$AGE_IDENTITY" "$backup_dir/storage.tar.gz.age" \
    | "$PYTHON_BIN" "$SCRIPT_DIR/storage_archive.py" validate --roots objects uploads trash >/dev/null
"$AGE_BIN" --decrypt --identity "$AGE_IDENTITY" "$backup_dir/previews.tar.gz.age" \
    | "$PYTHON_BIN" "$SCRIPT_DIR/storage_archive.py" validate --roots previews >/dev/null
"$AGE_BIN" --decrypt --identity "$AGE_IDENTITY" "$backup_dir/database.dump.age" \
    | compose exec -T db pg_restore --list >/dev/null

printf 'backup verified: %s\n' "$backup_dir"
