#!/usr/bin/env bash

set -Eeuo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/backup-common.sh"

if [[ "$#" -ne 0 ]]; then
    die "usage: BACKUP_ROOT=/mounted/backup AGE_RECIPIENT=age1... APP_ENV_FILE=/path/to/env scripts/backup.sh"
fi

require_compose_inputs
require_command "$AGE_BIN"
require_command "$TAR_BIN"
require_command "$SHA256SUM_BIN"
require_command gzip
require_command date
require_command mktemp
require_command head

[[ -n "${AGE_RECIPIENT:-}" ]] || die "set AGE_RECIPIENT to the age public recipient"
validate_backup_root "${BACKUP_ROOT:-}"
load_compose_metadata
resolve_compose_mounts
validate_separate_backup_filesystem "$DATABASE_DATA_ROOT" "$STORAGE_DATA_ROOT"
acquire_operation_lock
require_running_database

backup_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
final_dir="$BACKUP_ROOT/my-drive-$backup_id"
[[ ! -e "$final_dir" ]] || die "backup destination already exists: $final_dir"
MEDIA_INDEXER_DEFINED=0
if compose_service_defined media-indexer; then MEDIA_INDEXER_DEFINED=1; fi
staging_dir="$(mktemp -d "$BACKUP_ROOT/.my-drive-backup.XXXXXXXX")"
APP_NEEDS_RESTART=0
INDEXER_NEEDS_RESTART=0

cleanup() {
    local status=$?
    trap - EXIT
    set +e
    if [[ -n "${staging_dir:-}" && -d "$staging_dir" ]]; then
        rm -rf -- "$staging_dir"
    fi
    if (( APP_NEEDS_RESTART )); then
        if ! compose start app >/dev/null || ! wait_for_app_healthy; then
            printf 'error: backup finished, but the previously running app did not return healthy\n' >&2
            status=1
        elif (( INDEXER_NEEDS_RESTART )); then
            if ! compose start media-indexer >/dev/null || ! wait_for_media_indexer_running; then
                printf 'error: backup finished, but the previously running media indexer did not return to running\n' >&2
                status=1
            fi
        fi
    fi
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if (( MEDIA_INDEXER_DEFINED )) && service_is_running media-indexer && ! service_is_running app; then
    die "media-indexer is running while app is stopped; recover the Compose services before backup"
fi

if service_is_running app; then APP_NEEDS_RESTART=1; fi
if (( MEDIA_INDEXER_DEFINED )); then
    if service_is_running media-indexer; then INDEXER_NEEDS_RESTART=1; fi
    stop_service_for_operation media-indexer
fi
stop_service_for_operation app

compose exec -T db sh -ec 'exec pg_dump --format=custom --no-owner --no-acl --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"' \
    | "$AGE_BIN" --recipient "$AGE_RECIPIENT" --output "$staging_dir/database.dump.age"

"$TAR_BIN" --numeric-owner --warning=no-file-changed --create --gzip --file=- \
    --directory "$STORAGE_DATA_ROOT" objects uploads trash previews \
    | "$AGE_BIN" --recipient "$AGE_RECIPIENT" --output "$staging_dir/storage.tar.gz.age"

"$PYTHON_BIN" "$SCRIPT_DIR/storage_archive.py" validate-tree "$STORAGE_DATA_ROOT"

"$AGE_BIN" --recipient "$AGE_RECIPIENT" --output "$staging_dir/compose.yaml.age" "$COMPOSE_FILE_PATH"
"$AGE_BIN" --recipient "$AGE_RECIPIENT" --output "$staging_dir/environment.env.age" "$APP_ENV_FILE"

"$PYTHON_BIN" "$SCRIPT_DIR/backup_bundle.py" create "$staging_dir" \
    "$PROJECT_NAME" "$DATABASE_NAME" "$DATABASE_USER" \
    "$(basename -- "$COMPOSE_FILE_PATH")" "$(basename -- "$APP_ENV_FILE")" "$backup_id"
(
    cd -- "$staging_dir"
    "$SHA256SUM_BIN" database.dump.age storage.tar.gz.age compose.yaml.age environment.env.age manifest.json >SHA256SUMS
)

mv -T -- "$staging_dir" "$final_dir"
staging_dir=""
printf 'encrypted backup created: %s\n' "$final_dir"
printf 'restore confirmation target: %s/%s\n' "$PROJECT_NAME" "$DATABASE_NAME"
