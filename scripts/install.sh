#!/usr/bin/env bash
# Run from a reviewed checkout; never execute a remote script as root.
set -Eeuo pipefail
[[ ${EUID} -eq 0 ]] || { echo 'Run with sudo bash scripts/install.sh' >&2; exit 1; }
source /etc/os-release
[[ "$ID" == ubuntu && "$VERSION_ID" =~ ^(22\.04|24\.04|26\.04)$ ]] || {
    echo 'Supported: Ubuntu 22.04, 24.04 or 26.04 with systemd.' >&2; exit 1;
}
command -v systemctl >/dev/null
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl python3 util-linux age
if ! command -v docker >/dev/null; then
    # Do not replace an existing distro/container runtime behind the operator's back.
    for package in docker.io docker-compose docker-compose-v2 podman-docker containerd runc; do
        if dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q 'install ok installed'; then
            echo "Conflicting package $package: migrate it before installing Docker CE." >&2
            exit 1
        fi
    done
    install -m 0755 -d /etc/apt/keyrings
    curl --fail --silent --show-error --location https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${UBUNTU_CODENAME:-$VERSION_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
    apt-get update
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
docker compose version >/dev/null || {
    echo 'Install the Docker Compose plugin for your existing Docker installation, then retry.' >&2; exit 1;
}
systemctl enable --now docker
exec python3 "$(dirname -- "${BASH_SOURCE[0]}")/vps.py" install "$@"
