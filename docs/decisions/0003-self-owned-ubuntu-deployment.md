---
created_at: "2026-09-27T04:04:29.942106200+00:00"
doc: docs/decisions/0003-self-owned-ubuntu-deployment.md
id: "0003"
links:
  - US-013
notes: Build reviewed source locally by default; permit operator-owned registry images. Single-volume VPS disables media cache and indexing while retaining storage mount/device verification. Separate-volume indexing remains unchanged. Pin filesystem UUIDs in root-only installer state and gate reboot startup through systemd checks. HTTPS uses ACME or an operator-controlled internal CA. Updates require encrypted application and deployment-configuration backups. No author-owned cloud account is required.
status: accepted
title: Self-owned Ubuntu deployment with optional single-volume storage
type: decision
updated_at: "2026-09-27T04:04:29.942111300+00:00"
verify: null
---

# Self-owned Ubuntu deployment with optional single-volume storage
