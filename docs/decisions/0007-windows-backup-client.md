---
created_at: "2026-09-28T23:13:15.753230799+00:00"
doc: docs/decisions/0007-windows-backup-client.md
id: "0007"
notes: "Windows backup uses device-code login, SHA-256 identity, and the existing resumable upload API."
status: accepted
title: Use device authorization and the existing upload pipeline for the Windows backup client
type: decision
updated_at: "2026-09-28T23:13:15.753231440+00:00"
verify: null
---

# Use device authorization and the existing upload pipeline for the Windows backup client

Date: 2026-09-28

## Status

Accepted

## Context

My Drive is a self-hosted personal cloud. Browser sessions use cookies and CSRF. Resumable uploads already use offset PATCH requests, and stored objects are identified by SHA-256. A Windows backup client must talk to whatever server URL the operator runs, without embedding a domain or a password prompt when the website can authorize the device.

## Decision

The Windows client is a new component of this repository, not a second cloud. It discovers `GET /.well-known/cloud-client` and speaks API version `1` only.

Device login follows the OAuth device-code flow. The browser session approves the device; the client stores only token digests on the server and keeps access and refresh tokens in Windows DPAPI (or an encrypted local store outside SQLite). Refresh tokens rotate, and reuse of a revoked refresh token revokes the device.

Backup uploads reuse `POST/HEAD/PATCH /api/uploads` and finalization. A new `file_id` on create adds a file version instead of a second name. Content that already exists is linked to the ready object with the same SHA-256 and size, so unchanged bytes are not uploaded again. The client uses SHA-256, matching `storage_objects.checksum_sha256`. BLAKE3 would not verify against objects this server already stores.

Device tokens are scoped to backup paths. They cannot administer accounts, create shares, or download file bytes. Removing a backup job is a local action and does not delete remote data.

## Alternatives Considered

1. Ask the user to paste a developer API key. That reuses `/api/v1`, but the key rate limit is sized for scripts and the user would handle a secret directly.
2. Store the account password in the Windows client. That skips the website authorization page and expands the credential the device holds.
3. Hash with BLAKE3 end to end. It is faster, but it cannot match or reuse the SHA-256 objects already written by the web client and Google Drive import.

## Consequences

Positive:

- Each self-hosted server advertises the features that particular version implements.
- Interrupted uploads resume from the committed offset.
- Version history stays on the server; the desktop app does not overwrite local files with remote copies.

Tradeoffs:

- Servers older than this migration do not advertise device authorization, and the client must say so instead of guessing endpoints.
- Historical file versions remain referenced storage objects. Quota accounting continues to follow the current version, which is the existing rule.

## Follow-Up

- Keep the supported client API range explicit when a future server version changes the backup contract.
