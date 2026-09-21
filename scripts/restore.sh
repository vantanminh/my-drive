#!/usr/bin/env bash

set -Eeuo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/backup-common.sh"

[[ "$#" -eq 1 ]] || die "usage: AGE_IDENTITY=/path/to/age-identity CONFIRM_RESTORE_DB=project/database [CONFIRM_RESTORE_SOURCE='source-project/source-db as source-user'] scripts/restore.sh /path/to/backup"
require_compose_inputs
require_command "$AGE_BIN"
require_command mktemp
require_command sleep
require_command date
verify_identity_file
[[ "${EUID:-$(id -u)}" -eq 0 ]] || die "restore must run as root so restored files can be owned by the app user (10001)"

load_compose_metadata
resolve_compose_mounts
acquire_operation_lock
require_running_database
STORAGE_DATA_ROOT="$(realpath -e -- "$STORAGE_DATA_ROOT")"
[[ -d "$STORAGE_DATA_ROOT" ]] || die "storage root must already exist"
for child in objects uploads trash previews; do
    [[ -d "$STORAGE_DATA_ROOT/$child" && ! -L "$STORAGE_DATA_ROOT/$child" ]] || die "storage root is missing a safe $child directory"
done

restore_target="$PROJECT_NAME/$DATABASE_NAME"
if [[ "${CONFIRM_RESTORE_DB:-}" != "$restore_target" ]]; then
    printf 'refusing restore; set CONFIRM_RESTORE_DB=%s to confirm the live database target\n' "$restore_target" >&2
    exit 2
fi

backup_dir="$1"
[[ -d "$backup_dir" ]] || die "backup directory is missing: $backup_dir"
backup_dir="$(realpath -e -- "$backup_dir")"
"$SCRIPT_DIR/verify-backup.sh" "$backup_dir"
target_check_args=(check-target "$backup_dir" "$PROJECT_NAME" "$DATABASE_NAME" "$DATABASE_USER")
if [[ -n "${CONFIRM_RESTORE_SOURCE:-}" ]]; then
    target_check_args+=(--allow-source "$CONFIRM_RESTORE_SOURCE")
fi
"$PYTHON_BIN" "$SCRIPT_DIR/backup_bundle.py" "${target_check_args[@]}"

archive_bytes="$("$AGE_BIN" --decrypt --identity "$AGE_IDENTITY" "$backup_dir/storage.tar.gz.age" \
    | "$PYTHON_BIN" "$SCRIPT_DIR/storage_archive.py" validate --summary)"
[[ "$archive_bytes" =~ ^[0-9]+$ ]] || die "could not measure restored storage size"
"$PYTHON_BIN" - "$STORAGE_DATA_ROOT" "$archive_bytes" "$MIN_FREE_BYTES" "$MIN_FREE_PERCENT" <<'PY'
import math
import shutil
import sys

path, payload_text, min_bytes_text, min_percent_text = sys.argv[1:]
payload_bytes = int(payload_text)
minimum_bytes = int(min_bytes_text)
minimum_percent = float(min_percent_text)
usage = shutil.disk_usage(path)
reserve = max(minimum_bytes, math.ceil(usage.total * minimum_percent / 100.0))
if usage.free < payload_bytes + reserve:
    print(
        f"error: restore needs {payload_bytes} bytes plus a {reserve}-byte free-space reserve; "
        f"only {usage.free} bytes are available on the HDD",
        file=sys.stderr,
    )
    raise SystemExit(1)
PY

timestamp="$(date -u +%Y%m%dT%H%M%SZ)-$$"
scratch_database="restoretmp_$$_${RANDOM}"
previous_database="restoreold_$$_${RANDOM}"
[[ "${#scratch_database}" -le 63 && "${#previous_database}" -le 63 ]] || die "generated PostgreSQL database name is too long"
rollback_dir="$STORAGE_DATA_ROOT/.pre-restore-$timestamp"
[[ ! -e "$rollback_dir" ]] || die "rollback directory already exists: $rollback_dir"
restore_work=""
restore_stage=""
scratch_created=0
storage_cutover_started=0
database_cutover_started=0
restore_committed=0
APP_NEEDS_RESTART=0
INDEXER_NEEDS_RESTART=0
DATABASE_ROLLBACK_CONFIRMED=0
STORAGE_ROLLBACK_CONFIRMED=0
KEEP_SERVICES_STOPPED=0

database_exists() {
    local result
    if ! result="$(compose exec -T db psql -X -A -t -U "$DATABASE_USER" -d postgres \
        -c "SELECT 1 FROM pg_database WHERE datname = '$1';")"; then
        return 2
    fi
    if [[ "$result" == 1 ]]; then
        return 0
    fi
    [[ -z "$result" ]] && return 1
    return 2
}

rollback_database() {
    local target_exists=0 old_exists=0 scratch_exists=0 query_status
    if database_exists "$DATABASE_NAME"; then
        target_exists=1
    else
        query_status=$?
        (( query_status == 1 )) || return 1
    fi
    if database_exists "$previous_database"; then
        old_exists=1
    else
        query_status=$?
        (( query_status == 1 )) || return 1
    fi
    if database_exists "$scratch_database"; then
        scratch_exists=1
    else
        query_status=$?
        (( query_status == 1 )) || return 1
    fi

    if (( old_exists )); then
        if (( target_exists && !scratch_exists )); then
            compose exec -T db psql -X -v ON_ERROR_STOP=1 -U "$DATABASE_USER" -d postgres \
                -c "ALTER DATABASE \"$DATABASE_NAME\" RENAME TO \"$scratch_database\";" >/dev/null || return 1
            target_exists=0
            scratch_exists=1
        elif (( target_exists && scratch_exists )); then
            return 1
        fi
        if (( !target_exists )); then
            compose exec -T db psql -X -v ON_ERROR_STOP=1 -U "$DATABASE_USER" -d postgres \
                -c "ALTER DATABASE \"$previous_database\" RENAME TO \"$DATABASE_NAME\";" >/dev/null || return 1
        fi
    elif (( !target_exists )); then
        return 1
    fi

    if ! database_exists "$DATABASE_NAME"; then
        return 1
    fi
    if database_exists "$previous_database"; then
        return 1
    else
        query_status=$?
        (( query_status == 1 )) || return 1
    fi
}

rollback_storage() {
    local child
    [[ -d "$rollback_dir" ]] || return 0
    mkdir -p -- "$restore_stage/.failed-restore" 2>/dev/null || true
    for child in previews trash uploads objects; do
        if [[ -d "$STORAGE_DATA_ROOT/$child" && ! -e "$restore_stage/$child" ]]; then
            mv -- "$STORAGE_DATA_ROOT/$child" "$restore_stage/.failed-restore/$child" || return 1
        fi
        if [[ -d "$rollback_dir/$child" ]]; then
            mv -- "$rollback_dir/$child" "$STORAGE_DATA_ROOT/$child" || return 1
        fi
    done
}

cleanup() {
    local status=$?
    trap - EXIT
    set +e

    if (( status != 0 && database_cutover_started && !restore_committed )); then
        if rollback_database; then
            DATABASE_ROLLBACK_CONFIRMED=1
        else
            printf 'error: database rollback failed; inspect database %s and %s\n' "$DATABASE_NAME" "$previous_database" >&2
            status=1
            KEEP_SERVICES_STOPPED=1
        fi
    fi
    if (( status != 0 && storage_cutover_started && !restore_committed )); then
        if (( database_cutover_started && !DATABASE_ROLLBACK_CONFIRMED )); then
            printf 'error: storage rollback was not attempted because database state is uncertain; inspect %s and %s\n' "$STORAGE_DATA_ROOT" "$rollback_dir" >&2
            KEEP_SERVICES_STOPPED=1
        elif rollback_storage; then
            STORAGE_ROLLBACK_CONFIRMED=1
        else
            printf 'error: storage rollback failed; inspect %s and %s\n' "$STORAGE_DATA_ROOT" "$rollback_dir" >&2
            status=1
            KEEP_SERVICES_STOPPED=1
        fi
    fi

    if (( status != 0 && scratch_created && ( !database_cutover_started || DATABASE_ROLLBACK_CONFIRMED ) )); then
        compose exec -T db psql -X -v ON_ERROR_STOP=1 -U "$DATABASE_USER" -d postgres \
            -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$scratch_database' AND pid <> pg_backend_pid();" >/dev/null 2>&1 || true
        compose exec -T db dropdb --if-exists --username "$DATABASE_USER" "$scratch_database" >/dev/null 2>&1 || true
    fi
    if [[ -n "$restore_work" && -d "$restore_work" ]] && \
        (( !storage_cutover_started || restore_committed || STORAGE_ROLLBACK_CONFIRMED )); then
        rm -rf -- "$restore_work"
    elif [[ -n "$restore_work" && -d "$restore_work" ]]; then
        printf 'restore staging retained for recovery at: %s\n' "$restore_work" >&2
    fi

    if (( APP_NEEDS_RESTART )); then
        if (( KEEP_SERVICES_STOPPED )); then
            printf 'error: the previously running app and media indexer were left stopped because rollback is incomplete\n' >&2
            status=1
        elif ! compose start app >/dev/null || ! wait_for_app_healthy; then
            printf 'error: restore finished, but the previously running app did not return healthy\n' >&2
            status=1
        elif (( INDEXER_NEEDS_RESTART )); then
            if ! compose start media-indexer >/dev/null || ! wait_for_media_indexer_running; then
                printf 'error: restore finished, but the previously running media indexer did not return to running\n' >&2
                status=1
            fi
        fi
    fi

    if (( restore_committed )); then
        printf 'restore committed for %s\n' "$restore_target"
        printf 'pre-restore database retained as: %s\n' "$previous_database"
        printf 'pre-restore storage retained at: %s\n' "$rollback_dir"
        if (( status != 0 )); then
            printf 'error: restore committed, but post-restore app recovery failed; inspect app health before reopening access\n' >&2
        fi
    elif (( status != 0 )); then
        printf 'restore did not complete; the verified backup remains at %s\n' "$backup_dir" >&2
    fi
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for candidate in "$scratch_database" "$previous_database"; do
    if database_exists "$candidate"; then
        die "generated restore database name already exists: $candidate"
    else
        query_status=$?
        (( query_status == 1 )) || die "could not check generated restore database name: $candidate"
    fi
done

if service_is_running media-indexer && ! service_is_running app; then
    die "media-indexer is running while app is stopped; recover the Compose services before restore"
fi

if service_is_running app; then APP_NEEDS_RESTART=1; fi
if service_is_running media-indexer; then INDEXER_NEEDS_RESTART=1; fi
stop_service_for_operation media-indexer
stop_service_for_operation app

compose exec -T db createdb --username "$DATABASE_USER" --owner "$DATABASE_USER" "$scratch_database"
scratch_created=1
"$AGE_BIN" --decrypt --identity "$AGE_IDENTITY" "$backup_dir/database.dump.age" \
    | compose exec -T db pg_restore --exit-on-error --single-transaction --no-owner --no-acl \
        --username "$DATABASE_USER" --dbname "$scratch_database" >/dev/null

restore_work="$(mktemp -d "$STORAGE_DATA_ROOT/.restore-work.XXXXXXXX")"
restore_stage="$restore_work/storage"
"$AGE_BIN" --decrypt --identity "$AGE_IDENTITY" "$backup_dir/storage.tar.gz.age" \
    | "$PYTHON_BIN" "$SCRIPT_DIR/storage_archive.py" extract "$restore_stage" >/dev/null

ready_rows="$restore_stage/.ready-objects.tsv"
compose exec -T db psql -X -A -t -F $'\t' -v ON_ERROR_STOP=1 \
    -U "$DATABASE_USER" -d "$scratch_database" \
    -c "SELECT storage_key, size_bytes, rtrim(checksum_sha256) FROM storage_objects WHERE state = 'ready' ORDER BY storage_key;" \
    >"$ready_rows"
ready_count="$("$PYTHON_BIN" "$SCRIPT_DIR/storage_archive.py" validate-ready "$restore_stage" "$ready_rows")"
rm -f -- "$ready_rows"

mkdir -- "$rollback_dir"
storage_cutover_started=1
for child in objects uploads trash previews; do
    mv -- "$STORAGE_DATA_ROOT/$child" "$rollback_dir/$child"
done
for child in objects uploads trash previews; do
    mv -- "$restore_stage/$child" "$STORAGE_DATA_ROOT/$child"
done

database_cutover_started=1
compose exec -T db psql -X -v ON_ERROR_STOP=1 -U "$DATABASE_USER" -d postgres \
    -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$DATABASE_NAME' AND pid <> pg_backend_pid();" >/dev/null
compose exec -T db psql -X -v ON_ERROR_STOP=1 -U "$DATABASE_USER" -d postgres \
    -c "ALTER DATABASE \"$DATABASE_NAME\" RENAME TO \"$previous_database\";" >/dev/null
compose exec -T db psql -X -v ON_ERROR_STOP=1 -U "$DATABASE_USER" -d postgres \
    -c "ALTER DATABASE \"$scratch_database\" RENAME TO \"$DATABASE_NAME\";" >/dev/null
restore_committed=1
scratch_created=0

printf 'restored %s ready object payloads\n' "$ready_count"
