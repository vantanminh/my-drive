#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
DOCKER_BIN="${DOCKER_BIN:-docker}"
AGE_BIN="${AGE_BIN:-age}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
TAR_BIN="${TAR_BIN:-tar}"
SHA256SUM_BIN="${SHA256SUM_BIN:-sha256sum}"
COMPOSE_FILE_PATH="${COMPOSE_FILE_PATH:-$PROJECT_ROOT/compose.yaml}"
APP_ENV_FILE="${APP_ENV_FILE:-$PROJECT_ROOT/.env}"

die() {
    printf 'error: %s\n' "$*" >&2
    exit 1
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || die "required command is unavailable: $1"
}

require_compose_inputs() {
    [[ -f "$COMPOSE_FILE_PATH" && ! -L "$COMPOSE_FILE_PATH" ]] || die "Compose file is missing or is a symlink: $COMPOSE_FILE_PATH"
    [[ -f "$APP_ENV_FILE" && ! -L "$APP_ENV_FILE" ]] || die "APP_ENV_FILE must name the protected Compose env file: $APP_ENV_FILE"
    COMPOSE_FILE_PATH="$(realpath -e -- "$COMPOSE_FILE_PATH")"
    APP_ENV_FILE="$(realpath -e -- "$APP_ENV_FILE")"
    DOCKER_BIN_PATH="$(command -v "$DOCKER_BIN")" || die "Docker CLI is unavailable: $DOCKER_BIN"
    DOCKER_BIN="$DOCKER_BIN_PATH"
    require_command "$PYTHON_BIN"
    require_command realpath
    require_command stat
    require_command flock

    compose_args=(--project-directory "$PROJECT_ROOT" --file "$COMPOSE_FILE_PATH" --env-file "$APP_ENV_FILE")
    if [[ -n "${COMPOSE_PROJECT_NAME:-}" ]]; then
        compose_args+=(--project-name "$COMPOSE_PROJECT_NAME")
    fi
}

compose() {
    "$DOCKER_BIN" compose "${compose_args[@]}" "$@"
}

acquire_operation_lock() {
    local database_key storage_key first_key second_key lock_key lock_path lock_fd
    [[ "${EUID:-$(id -u)}" -eq 0 ]] || die "backup and restore must run as root to use the protected shared operation lock"
    [[ -d /run/lock && ! -L /run/lock && -w /run/lock ]] || die "the protected operation lock directory /run/lock is unavailable"
    require_command "$SHA256SUM_BIN"
    require_command cut

    database_key="$(printf '%s' "$DATABASE_DATA_ROOT" | "$SHA256SUM_BIN" | cut -c1-32)"
    storage_key="$(printf '%s' "$STORAGE_DATA_ROOT" | "$SHA256SUM_BIN" | cut -c1-32)"
    [[ "$database_key" != "$storage_key" ]] || die "database and storage bind sources must be distinct"
    if [[ "$database_key" < "$storage_key" ]]; then
        first_key="$database_key"
        second_key="$storage_key"
    else
        first_key="$storage_key"
        second_key="$database_key"
    fi

    for lock_key in "$first_key" "$second_key"; do
        lock_path="/run/lock/my-drive-${lock_key}.backup-restore.lock"
        [[ ! -L "$lock_path" && ( ! -e "$lock_path" || -f "$lock_path" ) ]] || die "unsafe backup/restore lock path: $lock_path"
        exec {lock_fd}>>"$lock_path"
        chmod 600 "$lock_path" || die "could not protect backup/restore lock: $lock_path"
        flock -n "$lock_fd" || die "another backup or restore is already using a database/storage bind source"
    done
}

compose_metadata() {
    compose config --format json | "$PYTHON_BIN" "$SCRIPT_DIR/backup_compose.py" metadata
}

compose_mounts() {
    compose config --format json | "$PYTHON_BIN" "$SCRIPT_DIR/backup_compose.py" mounts
}

compose_running_id() {
    local service="$1" container_ids container_id details state exit_code oom_killed restarting restart_policy first_running="" container_count=0
    container_ids="$(compose ps --all -q "$service")" || return 2
    [[ -n "$container_ids" ]] || return 1

    while IFS= read -r container_id; do
        [[ -n "$container_id" ]] || continue
        ((container_count += 1))
        (( container_count == 1 )) || return 2
        details="$("$DOCKER_BIN" inspect -f '{{.State.Status}}|{{.State.ExitCode}}|{{.State.OOMKilled}}|{{.State.Restarting}}|{{.HostConfig.RestartPolicy.Name}}' "$container_id")" || return 2
        IFS='|' read -r state exit_code oom_killed restarting restart_policy <<<"$details"
        case "$state" in
            running)
                first_running="$container_id"
                ;;
            exited)
                [[ "$oom_killed" == false && "$restarting" == false ]] || return 2
                case "$restart_policy" in
                    no) ;;
                    on-failure)
                        [[ "$exit_code" == 0 ]] || return 2
                        ;;
                    *) return 2 ;;
                esac
                ;;
            created) ;;
            *) return 2 ;;
        esac
    done <<<"$container_ids"

    if [[ -n "$first_running" ]]; then
        printf '%s' "$first_running"
        return 0
    fi
    return 1
}

service_has_containers() {
    local container_ids
    if container_ids="$(compose ps --all -q "$1")"; then
        [[ -n "$container_ids" ]]
        return
    fi
    die "could not inspect Compose containers for service: $1"
}

service_is_running() {
    local id status
    if id="$(compose_running_id "$1")"; then
        [[ -n "$id" ]]
        return
    else
        status=$?
    fi
    if (( status == 1 )); then
        return 1
    fi
    die "could not determine a safe Compose state for service: $1"
}

service_is_active() {
    local service="$1" container_ids container_id details state restarting container_count=0
    container_ids="$(compose ps --all -q "$service")" || die "could not inspect Compose containers for service: $service"
    [[ -n "$container_ids" ]] || return 1

    while IFS= read -r container_id; do
        [[ -n "$container_id" ]] || continue
        ((container_count += 1))
        (( container_count == 1 )) || die "multiple containers are unsupported for Compose service: $service"
        details="$("$DOCKER_BIN" inspect -f '{{.State.Status}}|{{.State.Restarting}}' "$container_id")" || die "could not inspect Compose container for service: $service"
        IFS='|' read -r state restarting <<<"$details"
        case "$state" in
            running) return 0 ;;
            exited|created)
                [[ "$restarting" == false ]] || die "Compose service is still restarting after stop: $service"
                ;;
            *) die "Compose service is not in a stable stopped state: $service ($state)" ;;
        esac
    done <<<"$container_ids"
    return 1
}

stop_service_for_operation() {
    local service="$1"
    if service_has_containers "$service"; then
        compose stop "$service" >/dev/null || die "could not stop Compose service before storage operation: $service"
        if service_is_active "$service"; then
            die "Compose service remained active after stop: $service"
        fi
    fi
}

wait_for_app_healthy() {
    local id state health attempt
    for attempt in {1..120}; do
        id="$(compose ps --all -q app)" || return 1
        id="${id%%$'\n'*}"
        if [[ -z "$id" ]]; then
            sleep 1
            continue
        fi
        state="$("$DOCKER_BIN" inspect -f '{{.State.Status}}' "$id" 2>/dev/null || true)"
        health="$("$DOCKER_BIN" inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id" 2>/dev/null || true)"
        if [[ "$state" == running && ( "$health" == healthy || "$health" == none ) ]]; then
            return 0
        fi
        if [[ "$state" == exited || "$state" == dead || "$health" == unhealthy ]]; then
            "$DOCKER_BIN" logs --tail 60 "$id" >&2 || true
            return 1
        fi
        sleep 1
    done
    [[ -n "${id:-}" ]] && "$DOCKER_BIN" logs --tail 60 "$id" >&2 || true
    return 1
}

wait_for_media_indexer_running() {
    local id state attempt
    for attempt in {1..30}; do
        id="$(compose ps --all -q media-indexer)" || return 1
        id="${id%%$'\n'*}"
        if [[ -z "$id" ]]; then
            sleep 1
            continue
        fi
        state="$("$DOCKER_BIN" inspect -f '{{.State.Status}}' "$id" 2>/dev/null || true)"
        if [[ "$state" == running ]]; then
            return 0
        fi
        if [[ "$state" == exited || "$state" == dead ]]; then
            "$DOCKER_BIN" logs --tail 60 "$id" >&2 || true
            return 1
        fi
        sleep 1
    done
    [[ -n "${id:-}" ]] && "$DOCKER_BIN" logs --tail 60 "$id" >&2 || true
    return 1
}

extract_json_field() {
    local json="$1" field="$2"
    "$PYTHON_BIN" -c 'import json,sys; value=json.load(sys.stdin); key=sys.argv[1]; out=value[key]; print(out)' "$field" <<<"$json"
}

validate_backup_root() {
    local requested="$1"
    [[ -n "$requested" ]] || die "set BACKUP_ROOT to an existing directory on a separate filesystem"
    [[ -d "$requested" ]] || die "BACKUP_ROOT must already exist; refusing to create it on an unmounted path: $requested"
    BACKUP_ROOT="$(realpath -e -- "$requested")"
    [[ -w "$BACKUP_ROOT" ]] || die "BACKUP_ROOT is not writable: $BACKUP_ROOT"
}

validate_separate_backup_filesystem() {
    local db_root="$1" storage_root="$2" backup_device db_device storage_device
    [[ -d "$db_root" && -d "$storage_root" ]] || die "Compose database and storage bind sources must exist"
    db_root="$(realpath -e -- "$db_root")"
    storage_root="$(realpath -e -- "$storage_root")"
    backup_device="$(stat -c '%d' -- "$BACKUP_ROOT")"
    db_device="$(stat -c '%d' -- "$db_root")"
    storage_device="$(stat -c '%d' -- "$storage_root")"
    [[ "$backup_device" != "$db_device" ]] || die "BACKUP_ROOT is on the same filesystem as PostgreSQL data"
    [[ "$backup_device" != "$storage_device" ]] || die "BACKUP_ROOT is on the same filesystem as HDD storage"
}

load_compose_metadata() {
    COMPOSE_INFO="$(compose_metadata)" || die "could not resolve Compose configuration"
    PROJECT_NAME="$(extract_json_field "$COMPOSE_INFO" project)" || die "Compose project name is missing"
    DATABASE_NAME="$(extract_json_field "$COMPOSE_INFO" database)" || die "Compose database name is missing"
    DATABASE_USER="$(extract_json_field "$COMPOSE_INFO" user)" || die "Compose database user is missing"
    MIN_FREE_BYTES="$(extract_json_field "$COMPOSE_INFO" min_free_bytes)" || die "Compose storage free-space limit is missing"
    MIN_FREE_PERCENT="$(extract_json_field "$COMPOSE_INFO" min_free_percent)" || die "Compose storage free-space percentage is missing"

    [[ "$PROJECT_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$ ]] || die "unsupported Compose project name"
    [[ "$DATABASE_NAME" =~ ^[A-Za-z0-9_]{1,63}$ ]] || die "unsupported PostgreSQL database name"
    [[ "$DATABASE_USER" =~ ^[A-Za-z0-9_]{1,63}$ ]] || die "unsupported PostgreSQL user name"
}

resolve_compose_mounts() {
    local mounts
    mounts="$(compose_mounts)" || die "could not resolve Compose bind mounts"
    mapfile -t COMPOSE_MOUNTS <<<"$mounts"
    [[ "${#COMPOSE_MOUNTS[@]}" -eq 2 ]] || die "Compose must define exactly the database and storage bind sources"
    DATABASE_DATA_ROOT="${COMPOSE_MOUNTS[0]}"
    STORAGE_DATA_ROOT="${COMPOSE_MOUNTS[1]}"
    case "$DATABASE_DATA_ROOT/" in
        "$STORAGE_DATA_ROOT/"*) die "database and storage bind sources must not overlap" ;;
    esac
    case "$STORAGE_DATA_ROOT/" in
        "$DATABASE_DATA_ROOT/"*) die "database and storage bind sources must not overlap" ;;
    esac
}

require_running_database() {
    service_is_running db || die "the Compose db service must already be running"
}

verify_identity_file() {
    local identity="${AGE_IDENTITY:-}"
    [[ -n "$identity" ]] || die "set AGE_IDENTITY to the private age identity file"
    [[ -f "$identity" && -r "$identity" && ! -L "$identity" ]] || die "AGE_IDENTITY must name a readable regular file"
    AGE_IDENTITY="$(realpath -e -- "$identity")"
}
