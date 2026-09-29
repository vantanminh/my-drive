---
created_at: "2026-09-29T15:26:32.774317654+00:00"
doc: docs/decisions/0008-windows-client-versions.md
id: "0008"
links:
  - IN-033
  - US-040
notes: "The client version is clients/windows/Directory.Build.props. Each publish creates windows-client-vX.Y.Z and keeps that release. The floating windows-backup tag stays as the stable download and is no longer deleted. The app checks that version list every six hours when Check for updates is on, and installs the setup silently when automatic install is on. Bump the version before shipping client changes; CI rejects a changed client on an already published version."
status: accepted
title: Version and auto-update the Windows backup client from GitHub releases
type: decision
updated_at: "2026-09-29T15:26:32.774318336+00:00"
verify: null
---

# Version and auto-update the Windows backup client from GitHub releases
