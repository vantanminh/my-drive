---
created_at: "2026-09-28T09:31:20.681634+00:00"
doc: docs/decisions/0005-google-drive-webui-oauth.md
id: "0005"
links:
  - US-028
notes: "Owners may configure Client ID, Client Secret and Redirect URI through a CSRF-protected WebUI API. Encrypt the secret in PostgreSQL using the server-only GOOGLE_DRIVE_TOKEN_KEY. Allow key-only environment setup; persisted settings override environment OAuth values. Requests and the sync worker read current settings without restart. Reject non-HTTPS callbacks except loopback. Changing Client ID invalidates OAuth states and requires reconnection."
status: accepted
title: Owner-managed encrypted Google Drive OAuth settings
type: decision
updated_at: "2026-09-28T09:31:20.681637200+00:00"
verify: null
---

# Owner-managed encrypted Google Drive OAuth settings
