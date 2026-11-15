#!/bin/sh
# This script runs inside Linux containers and must keep LF line endings.
set -eu

VIEW_DIR="${SMB_VIEW_DIR:-/srv/view}"
USERS_LIST="${VIEW_DIR}/users.list"
STATE_DIR="/run/samba-sync"
LAST_LIST="${STATE_DIR}/users.list.last"
MANAGED_USERS="${STATE_DIR}/managed-users"

mkdir -p "$STATE_DIR" /var/lib/samba/private /var/log/samba /run/samba
chmod 0700 "$STATE_DIR"
touch "$MANAGED_USERS"

sync_users() {
    desired_file="${STATE_DIR}/desired.list"
    smbpasswd_file="${STATE_DIR}/smbpasswd.import"
    : > "$desired_file"
    : > "$smbpasswd_file"
    chmod 0600 "$desired_file" "$smbpasswd_file"

    if [ -f "$USERS_LIST" ]; then
        if [ -f "$LAST_LIST" ] && cmp -s "$USERS_LIST" "$LAST_LIST"; then
            return 0
        fi
        while IFS= read -r line || [ -n "$line" ]; do
            [ -n "$line" ] || continue
            case "$line" in
                *:*) ;;
                *) continue ;;
            esac
            username="${line%%:*}"
            nthash="${line#*:}"
            if ! printf '%s' "$username" | grep -Eq '^[a-z][a-z0-9._-]{0,31}$'; then
                echo "smb-entrypoint: skipping invalid username" >&2
                continue
            fi
            if [ "$username" = "root" ] || [ "$username" = "mydrive" ]; then
                echo "smb-entrypoint: skipping reserved username $username" >&2
                continue
            fi
            if ! printf '%s' "$nthash" | grep -Eq '^[0-9A-Fa-f]{32}$'; then
                echo "smb-entrypoint: skipping invalid NT hash for $username" >&2
                continue
            fi
            nthash="$(printf '%s' "$nthash" | tr '[:lower:]' '[:upper:]')"
            if ! id -u "$username" >/dev/null 2>&1; then
                useradd -M -s /usr/sbin/nologin -c "My Drive SMB" "$username"
            fi
            uid="$(id -u "$username")"
            lct_hex="$(printf '%08X' "$(date +%s)")"
            printf '%s\n' "$username" >> "$desired_file"
            printf '%s:%s:XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX:%s:[UX         ]:LCT-%s:\n' \
                "$username" "$uid" "$nthash" "$lct_hex" >> "$smbpasswd_file"
        done < "$USERS_LIST"
    elif [ -f "$LAST_LIST" ] && [ ! -s "$LAST_LIST" ]; then
        return 0
    fi

    if [ -s "$smbpasswd_file" ]; then
        pdbedit -i "smbpasswd:${smbpasswd_file}" >/dev/null
    fi
    rm -f "$smbpasswd_file"

    existing_smb="$(pdbedit -Lw 2>/dev/null | cut -d: -f1 || true)"
    for existing in $existing_smb; do
        if ! grep -Fxq "$existing" "$desired_file"; then
            pdbedit -x -u "$existing" >/dev/null 2>&1 || true
        fi
    done

    if [ -s "$MANAGED_USERS" ]; then
        while IFS= read -r managed || [ -n "$managed" ]; do
            [ -n "$managed" ] || continue
            if ! grep -Fxq "$managed" "$desired_file"; then
                if id -u "$managed" >/dev/null 2>&1; then
                    userdel "$managed" >/dev/null 2>&1 || true
                fi
            fi
        done < "$MANAGED_USERS"
    fi

    mv -f "$desired_file" "$MANAGED_USERS"
    if [ -f "$USERS_LIST" ]; then
        cp -f "$USERS_LIST" "$LAST_LIST"
        chmod 0600 "$LAST_LIST"
    else
        : > "$LAST_LIST"
        chmod 0600 "$LAST_LIST"
    fi
}

sync_users || echo "smb-entrypoint: initial user sync failed" >&2

(
    while true; do
        sleep 5
        sync_users || echo "smb-entrypoint: periodic user sync failed" >&2
    done
) &
sync_pid=$!

smbd -F --no-process-group --debug-stdout &
smbd_pid=$!

trap 'kill "$smbd_pid" "$sync_pid" 2>/dev/null || true; wait "$smbd_pid" 2>/dev/null || true; exit 0' TERM INT

wait "$smbd_pid"
rc=$?
kill "$sync_pid" 2>/dev/null || true
wait "$sync_pid" 2>/dev/null || true
exit "$rc"
