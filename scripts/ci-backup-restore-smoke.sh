#!/usr/bin/env bash

set -Eeuo pipefail

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
RUN_ID="${GITHUB_RUN_ID:-local-$$}"
PROJECT_NAME="backup-smoke-${RUN_ID}"
WORK_ROOT="${RUNNER_TEMP:-/tmp}/my-drive-backup-smoke-${RUN_ID}"
DATABASE_ROOT="$WORK_ROOT/postgres"
STORAGE_ROOT="$WORK_ROOT/storage"
PREVIEW_ROOT="$WORK_ROOT/previews"
BACKUP_ROOT="/dev/shm/my-drive-backup-smoke-${RUN_ID}"
COMPOSE_FILE_PATH="$WORK_ROOT/compose.yaml"
APP_ENV_FILE="$WORK_ROOT/.env"
AGE_IDENTITY="$WORK_ROOT/age-identity"

compose=(
    docker compose
    --project-directory "$PROJECT_ROOT"
    --project-name "$PROJECT_NAME"
    --file "$COMPOSE_FILE_PATH"
    --env-file "$APP_ENV_FILE"
)

cleanup() {
    local status=$?
    trap - EXIT
    set +e
    "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1
    sudo rm -rf -- "$WORK_ROOT" "$BACKUP_ROOT"
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p \
    "$DATABASE_ROOT" \
    "$STORAGE_ROOT/objects/aa/bb" \
    "$STORAGE_ROOT/uploads" \
    "$STORAGE_ROOT/trash" \
    "$PREVIEW_ROOT" \
    "$BACKUP_ROOT"
chmod 700 "$WORK_ROOT" "$BACKUP_ROOT"

age-keygen -o "$AGE_IDENTITY" >/dev/null 2>&1
chmod 600 "$AGE_IDENTITY"
AGE_RECIPIENT="$(age-keygen -y "$AGE_IDENTITY")"

cat >"$APP_ENV_FILE" <<EOF
POSTGRES_PASSWORD=backup-smoke-postgres-password
DB_ROOT=$DATABASE_ROOT
STORAGE_ROOT=$STORAGE_ROOT
PREVIEW_ROOT=$PREVIEW_ROOT
EOF
chmod 600 "$APP_ENV_FILE"

cat >"$COMPOSE_FILE_PATH" <<'EOF'
services:
  db:
    image: postgres:17-alpine
    environment:
      POSTGRES_DB: mydrive
      POSTGRES_USER: mydrive
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - type: bind
        source: ${DB_ROOT}
        target: /var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U mydrive -d mydrive"]
      interval: 2s
      timeout: 3s
      retries: 30

  app:
    image: busybox:1.36
    command: ["sh", "-c", "while true; do sleep 3600; done"]
    environment:
      MIN_FREE_BYTES: "0"
      MIN_FREE_PERCENT: "0"
    depends_on:
      db:
        condition: service_healthy
    volumes:
      - type: bind
        source: ${STORAGE_ROOT}
        target: /srv/my-drive/data
      - type: bind
        source: ${PREVIEW_ROOT}
        target: /srv/my-drive/previews
EOF

"${compose[@]}" up -d
for attempt in $(seq 1 60); do
    if "${compose[@]}" exec -T db pg_isready -U mydrive -d mydrive >/dev/null 2>&1; then
        break
    fi
    [[ "$attempt" -lt 60 ]] || {
        "${compose[@]}" logs --no-color
        exit 1
    }
    sleep 2
done

object_id="00000000-0000-0000-0000-000000000001"
object_key="aa/bb/$object_id"
payload='backup-smoke-original-payload'
printf '%s' "$payload" >"$STORAGE_ROOT/objects/$object_key"
preview_key="$PREVIEW_ROOT/$object_id/viewer-v1.webp"
mkdir -p "$(dirname -- "$preview_key")"
printf 'backup-smoke-original-preview' >"$preview_key"
payload_size="$(wc -c <"$STORAGE_ROOT/objects/$object_key")"
payload_checksum="$(sha256sum "$STORAGE_ROOT/objects/$object_key" | cut -d' ' -f1)"

"${compose[@]}" exec -T db psql -v ON_ERROR_STOP=1 -U mydrive -d mydrive <<SQL
CREATE TABLE storage_objects (
    id UUID PRIMARY KEY,
    storage_key TEXT NOT NULL,
    size_bytes BIGINT NOT NULL,
    checksum_sha256 CHAR(64) NOT NULL,
    state TEXT NOT NULL
);
CREATE TABLE restore_marker (value TEXT NOT NULL);
INSERT INTO storage_objects (id, storage_key, size_bytes, checksum_sha256, state)
VALUES ('$object_id', '$object_key', $payload_size, '$payload_checksum', 'ready');
INSERT INTO restore_marker (value) VALUES ('original');
SQL

backup_output="$(sudo -E env \
    APP_ENV_FILE="$APP_ENV_FILE" \
    COMPOSE_FILE_PATH="$COMPOSE_FILE_PATH" \
    COMPOSE_PROJECT_NAME="$PROJECT_NAME" \
    BACKUP_ROOT="$BACKUP_ROOT" \
    AGE_RECIPIENT="$AGE_RECIPIENT" \
    "$PROJECT_ROOT/scripts/backup.sh" 2>&1)"
printf '%s\n' "$backup_output"
backup_dir="$(printf '%s\n' "$backup_output" | sed -n 's/^encrypted backup created: //p')"
[[ -n "$backup_dir" && -d "$backup_dir" ]] || {
    printf 'backup output did not contain a valid destination\n' >&2
    exit 1
}

bad_backup="$WORK_ROOT/corrupt-backup"
sudo cp -a -- "$backup_dir" "$bad_backup"
sudo sh -c 'printf corruption >>"$1"' sh "$bad_backup/database.dump.age"
if sudo -E env \
    APP_ENV_FILE="$APP_ENV_FILE" \
    COMPOSE_FILE_PATH="$COMPOSE_FILE_PATH" \
    COMPOSE_PROJECT_NAME="$PROJECT_NAME" \
    AGE_IDENTITY="$AGE_IDENTITY" \
    CONFIRM_RESTORE_DB="$PROJECT_NAME/mydrive" \
    "$PROJECT_ROOT/scripts/restore.sh" "$bad_backup"; then
    printf 'corrupt backup was accepted\n' >&2
    exit 1
fi

if sudo -E env \
    APP_ENV_FILE="$APP_ENV_FILE" \
    COMPOSE_FILE_PATH="$COMPOSE_FILE_PATH" \
    COMPOSE_PROJECT_NAME="$PROJECT_NAME" \
    AGE_IDENTITY="$AGE_IDENTITY" \
    CONFIRM_RESTORE_DB="$PROJECT_NAME/wrong-database" \
    "$PROJECT_ROOT/scripts/restore.sh" "$backup_dir"; then
    printf 'wrong restore target was accepted\n' >&2
    exit 1
fi

"${compose[@]}" exec -T db psql -v ON_ERROR_STOP=1 -U mydrive -d mydrive \
    -c "UPDATE restore_marker SET value = 'mutated';"
printf 'backup-smoke-mutated-payload' >"$STORAGE_ROOT/objects/$object_key"
rm -f -- "$preview_key"

restore_output="$(sudo -E env \
    APP_ENV_FILE="$APP_ENV_FILE" \
    COMPOSE_FILE_PATH="$COMPOSE_FILE_PATH" \
    COMPOSE_PROJECT_NAME="$PROJECT_NAME" \
    AGE_IDENTITY="$AGE_IDENTITY" \
    CONFIRM_RESTORE_DB="$PROJECT_NAME/mydrive" \
    "$PROJECT_ROOT/scripts/restore.sh" "$backup_dir" 2>&1)"
printf '%s\n' "$restore_output"

restored_marker="$("${compose[@]}" exec -T db psql -X -A -t -U mydrive -d mydrive -c 'SELECT value FROM restore_marker;')"
[[ "$restored_marker" == original ]] || {
    printf 'database marker was not restored: %s\n' "$restored_marker" >&2
    exit 1
}
[[ "$(cat -- "$STORAGE_ROOT/objects/$object_key")" == "$payload" ]] || {
    printf 'storage payload was not restored\n' >&2
    exit 1
}
[[ "$(cat -- "$preview_key")" == backup-smoke-original-preview ]] || {
    printf 'preview payload was not restored\n' >&2
    exit 1
}
compgen -G "$STORAGE_ROOT/.pre-restore-*" >/dev/null || {
    printf 'pre-restore storage rollback directory was not retained\n' >&2
    exit 1
}
compgen -G "$WORK_ROOT/.pre-restore-previews-*" >/dev/null || {
    printf 'pre-restore preview rollback directory was not retained\n' >&2
    exit 1
}
"${compose[@]}" ps --status running --services | grep -Fxq app || {
    printf 'app was not restarted after restore\n' >&2
    exit 1
}

printf 'backup/verify/restore smoke passed for %s\n' "$PROJECT_NAME"
