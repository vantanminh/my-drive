#!/usr/bin/env bash
# Standalone entry point: only deployment files are downloaded, never app source.
set -Eeuo pipefail
[[ ${EUID} -eq 0 ]] || { echo 'Run this bootstrap as root (sudo).' >&2; exit 1; }
source /etc/os-release
[[ "$ID" == ubuntu && "$VERSION_ID" =~ ^(22\.04|24\.04|26\.04)$ ]] || {
    echo 'Supported: Ubuntu 22.04, 24.04 or 26.04.' >&2; exit 1;
}
[[ $(uname -m) == x86_64 ]] || {
    echo 'The published CI images currently support amd64 VPS only.' >&2; exit 1;
}
repository="${MY_DRIVE_REPOSITORY:-vantanminh/my-drive}"
ref="${MY_DRIVE_REF:-master}"
image_prefix="${MY_DRIVE_IMAGE_PREFIX:-ghcr.io/${repository,,}}"
image_tag="${MY_DRIVE_IMAGE_TAG:-latest}"
[[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ && "$ref" =~ ^[A-Za-z0-9_.-]+$ ]] || {
    echo 'Invalid repository/ref; use an owner/repo and branch, tag or commit.' >&2; exit 1;
}
interactive=1
for argument in "$@"; do
    case "$argument" in --config|--config=*) interactive=0 ;; esac
done
if (( interactive )); then
    # stdin may be the curl|bash pipe; reserve the terminal for the wizard.
    if ! { exec 3</dev/tty; } 2>/dev/null; then
        echo 'No terminal available. Pass --config /path/to/private-config.json.' >&2
        exit 1
    fi
fi
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl
workdir="$(mktemp -d /tmp/my-drive-bootstrap.XXXXXXXX)"
trap 'rm -rf -- "$workdir"' EXIT
mkdir -p "$workdir/scripts" "$workdir/docker"
files=(compose.yaml docker/setup-indexer-role.sh scripts/install.sh scripts/vps.py
       scripts/backup.sh scripts/backup-common.sh scripts/backup_compose.py
       scripts/backup_bundle.py scripts/storage_archive.py scripts/restore.sh scripts/verify-backup.sh)
for file in "${files[@]}"; do
    curl --fail --silent --show-error --location --retry 3 \
        "https://raw.githubusercontent.com/$repository/$ref/$file" --output "$workdir/$file"
done
echo "Installing published images from $image_prefix:$image_tag (no VPS build)."
if (( interactive )); then
    bash "$workdir/scripts/install.sh" --prebuilt --image-prefix "$image_prefix" --image-tag "$image_tag" "$@" <&3
else
    bash "$workdir/scripts/install.sh" --prebuilt --image-prefix "$image_prefix" --image-tag "$image_tag" "$@"
fi
