---
created_at: "2026-11-15T14:25:39.564996900+00:00"
doc: docs/decisions/0009-host-system-service.md
id: "0009"
links:
  - IN-046
  - US-054
  - US-055
notes: "Packages host scripts and docker helpers inside the runtime app image under /usr/local/share/my-drive/host-bundle so my-drive update refreshes host tooling automatically, and extends my-drive-updater.service Unix-socket RPCs with host telemetry, service status/restart, bounded log inspection, and host network/Netplan management."
status: accepted
title: DSM-style MyNAS host control service and self-updating core scripts
type: decision
updated_at: "2026-11-15T14:25:39.564999600+00:00"
verify: null
---

# DSM-style MyNAS host control service and self-updating core scripts
