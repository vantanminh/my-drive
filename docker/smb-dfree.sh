#!/bin/sh
# Samba dfree command: reports accurate per-user mapped drive capacity.
# Receives the share directory path (e.g. /srv/view/tree/<username>[/...]) and
# prints: <total_blocks> <available_blocks> <block_size_bytes>
set -eu

dir="${1:-.}"
rel="${dir#/srv/view/tree/}"
user="${rel%%/*}"

# The view must never be able to over-report the filesystem it physically
# writes to. Production mounts the view on the HDD, but legacy/manual installs
# may still use a small Docker volume on the OS SSD; cap advertised free space
# by that filesystem and keep the normal My Drive safety reserve when it is
# not the HDD filesystem.
view_total_kb=""
view_free_kb=""
if [ -d "/srv/view" ]; then
    view_total_kb="$(df -Pk /srv/view | awk 'NR==2 {print $2}')"
    view_free_kb="$(df -Pk /srv/view | awk 'NR==2 {print $4}')"
fi

cap_free_kb() {
    free_kb="$1"
    case "$view_free_kb" in
        ''|*[!0-9]*)
            printf '%s\n' "$free_kb"
            return
            ;;
    esac

    capped="$view_free_kb"
    data_dev="$(stat -c '%d' /srv/my-drive/data 2>/dev/null || true)"
    view_dev="$(stat -c '%d' /srv/view 2>/dev/null || true)"
    if [ -n "$data_dev" ] && [ -n "$view_dev" ] && [ "$data_dev" != "$view_dev" ]; then
        reserve_kb=5242880
        case "$view_total_kb" in
            ''|*[!0-9]*) ;;
            *)
                percent_reserve=$((view_total_kb / 20))
                if [ "$percent_reserve" -gt "$reserve_kb" ]; then
                    reserve_kb="$percent_reserve"
                fi
                ;;
        esac
        capped=$((capped - reserve_kb))
        if [ "$capped" -lt 0 ]; then
            capped=0
        fi
    fi
    if [ "$free_kb" -gt "$capped" ]; then
        free_kb="$capped"
    fi
    printf '%s\n' "$free_kb"
}

if [ -n "$user" ] && [ "$user" != "$dir" ] && [ -f "/srv/view/quota/$user" ]; then
    total_kb=""
    free_kb=""
    read -r total_kb free_kb < "/srv/view/quota/$user" || true
    case "$total_kb" in
        ''|*[!0-9]*) ;;
        *)
            case "$free_kb" in
                ''|*[!0-9]* ) ;;
                *)
                    printf '%s %s 1024\n' "$total_kb" "$(cap_free_kb "$free_kb")"
                    exit 0
                    ;;
            esac
            ;;
    esac
fi

if [ -d "/srv/my-drive/data" ]; then
    total_kb="$(df -Pk /srv/my-drive/data | awk 'NR==2 {print $2}')"
    free_kb="$(df -Pk /srv/my-drive/data | awk 'NR==2 {print $4}')"
else
    total_kb="$(df -Pk "$dir" | awk 'NR==2 {print $2}')"
    free_kb="$(df -Pk "$dir" | awk 'NR==2 {print $4}')"
fi
printf '%s %s 1024\n' "$total_kb" "$(cap_free_kb "$free_kb")"
