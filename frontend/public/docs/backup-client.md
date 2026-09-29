# Windows Backup Client

[Overview](/docs/index.md)

The desktop client is part of this server, not a separate cloud. It asks you for the server URL, opens this site to approve the device, and then uploads only changed files.

There is no built-in server address. `GET /.well-known/cloud-client` describes the API version and which features this exact server implements. This client speaks API version `1`.

## Authorize a device

The Windows app starts an [OAuth device authorization](https://datatracker.ietf.org/doc/html/rfc8628) grant. It does not ask for the account password.

| Method | Path | Auth |
|---|---|---|
| POST | /api/device/code | Public. Body `{client_name, client_version, device_name, operating_system}` |
| POST | /api/device/token | Public. Body `{grant_type:"urn:ietf:params:oauth:grant-type:device_code", device_code}` |
| POST | /api/device/refresh | Public. Body `{grant_type:"refresh_token", refresh_token}`. Refresh tokens rotate. |
| GET | /api/device/pending?user_code= | Browser session. Shows the device waiting for approval. |
| POST | /api/device/authorize | Browser session and CSRF. Body `{user_code}` |
| POST | /api/device/deny | Browser session and CSRF. Body `{user_code}` |
| GET | /api/devices | Browser session. Active backup devices. |
| DELETE | /api/devices/{id} | Browser session and CSRF. Revokes the device and its tokens. |
| POST | /api/device/heartbeat | Device token. |
| POST | /api/device/logout | Device token. Revokes the calling device. |

Token responses contain `access_token`, `refresh_token`, `expires_in`, and `device_id`. Only SHA-256 digests are stored. A revoked refresh token that is presented again revokes the whole device.

While the code is waiting, `/api/device/token` returns `authorization_pending`. Polling faster than `interval` returns `slow_down`.

Approved devices call the normal drive and upload routes with `Authorization: Bearer mdb_…`. They do not send a CSRF header. The token cannot download file bytes, create shares, or administer accounts.

## Backup protocol

| Method | Path | Purpose |
|---|---|---|
| POST | /api/backup/check | `{parent_id, name, size_bytes, checksum_sha256}` → `skip`, `link`, or `upload` |
| POST | /api/backup/link | Reuse a ready object with the same SHA-256 and size. Creates a new version when the local file changed. |
| POST | /api/backup/folders | `{path:"Backups/MY-PC/Documents"}` creates missing folders and returns the leaf id. |
| POST | /api/uploads | Existing resumable create. Optional `file_id` adds a version of that file. Optional `original_modified_at` is stored on the version. |
| HEAD, PATCH | /api/uploads/{id} | Existing offset resume. Each PATCH is at most 64 MiB. |
| POST | /api/uploads/{id}/finalize | Existing finalize. Optional `X-Content-SHA256` must match the stored object or the upload is rejected and removed. |
| GET | /api/files/{id}/versions | Version history for a file you own. |
| GET | /api/storage | Quota. `unlimited` is true when no positive quota applies. |
| DELETE | /api/entries/{id} | Move a backed-up file to trash. The client does this only when the job's deletion policy says so. |

`skip` means the current remote version already has this content. `link` means some ready object already has this content, so the client must not upload the bytes again. `upload` means the bytes are not on the server yet. Pass `file_id` from the check when the path already exists so the server keeps the previous version.

Removing a backup job in the Windows app does not call these delete routes.
