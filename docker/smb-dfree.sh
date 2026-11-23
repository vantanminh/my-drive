#!/bin/sh
# Samba dfree command: reports accurate per-user mapped drive capacity.
# Receives the share directory path (e.g. /srv/view/tree/<username>[/...]) and
# prints: <total_blocks> <available_blocks> <block_size_bytes>
set -eu

dir="${1:-.}"
rel="${dir#/srv/view/tree/}"
user="${rel%%/*}"

if [ -n "$user" ] && [ "$user" != "$dir" ] && [ -f "/srv/view/quota/$user" ]; then
    total_kb=""
    free_kb=""
    read -r total_kb free_kb < "/srv/view/quota/$user" || true
    case "$total_kb" in
        ''|*[!0-9]*) ;;
        *)
            case "$free_kb" in
                ''|*[!0-9]*) ;;
                *)
                    printf '%s %s 1024\n' "$total_kb" "$free_kb"
                    exit 0
                    ;;
            esac
            ;;
    esac
fi

if [ -d "/srv/my-drive/data" ]; then
    df -Pk /srv/my-drive/data | awk 'NR==2 {print $2, $4, 1024}'
else
    df -Pk "$dir" | awk 'NR==2 {print $2, $4, 1024}'
fi
