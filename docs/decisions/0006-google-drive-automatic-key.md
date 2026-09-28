---
created_at: "2026-09-28T09:43:17.955634600+00:00"
doc: docs/decisions/0006-google-drive-automatic-key.md
id: "0006"
links:
  - US-029
  - "0005"
notes: Supersedes the manual server-key prerequisite in decision 0005. All Google Drive OAuth setup is available in WebUI without environment configuration. At startup generate a random 32-byte encryption key at STORAGE_ROOT/.secrets/google-drive-token.key and reuse it across restarts; use Unix directory/file permissions 0700/0600 and serialize creation with an exclusive file lock. Explicit environment credentials/key remain optional overrides. Encrypted backups and rollback-aware restore include optional .secrets and support older archives. The owner-only CSRF-protected API never returns the key or client secret.
status: accepted
title: Automatically provision Google Drive encryption keys
type: decision
updated_at: "2026-09-28T09:43:17.955637600+00:00"
verify: null
---

# Automatically provision Google Drive encryption keys
