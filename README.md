# My Drive

A private, single-server personal cloud. The service is a Rust/Axum modular
monolith backed by PostgreSQL. PostgreSQL stores file and security metadata;
file contents and upload staging belong on a separately mounted HDD.

## Current implementation

The service now includes validated configuration, PostgreSQL migrations,
first-owner bootstrap, a fail-closed storage mount guard, live/ready health
endpoints, authenticated folder and trash APIs, resumable HDD-backed uploads,
private downloads with byte ranges, quota checks, secure public shares, and a
responsive browser client. A background maintenance worker expires abandoned
upload sessions, purges trash after its retention period, and checks for
missing payloads while preserving recoverable database state.

## Storage boundary

- Put the app, PostgreSQL data, migrations, configuration, and logs on the SSD.
- Mount the HDD at a stable path such as `/srv/my-drive/data` and set
  `STORAGE_ROOT` to that mount.
- Never point the reverse proxy at `STORAGE_ROOT`; it is not a web root.
- The app checks the expected mount before creating its `objects`, `uploads`,
  `trash`, and `previews` directories. If a required mount is absent, startup
  and readiness fail instead of creating payload directories on the SSD.
- Compose requires `STORAGE_EXPECTED_DEVICE` to match the mounted filesystem's
  `major:minor` device number. This catches a bind-mounted fallback directory
  when the HDD did not mount.

## Development

Install Rust stable and PostgreSQL 17 or newer. Copy `.env.example` to `.env`,
set a local `DATABASE_URL` and absolute `STORAGE_ROOT`, then use the explicit
development-only `STORAGE_REQUIRE_MOUNT=false` setting. This setting must not be
used for a production service. Set both owner bootstrap variables to create
the first owner; the password must be at least 16 bytes. Remove those variables
after the first successful bootstrap. Install Node.js 22 or newer for the web
client.

```powershell
cargo run
```

The service applies embedded SQL migrations before listening. No default owner
or password exists. Liveness is available at `/health/live`; readiness at
`/health/ready` checks PostgreSQL and HDD health. Owner login uses Argon2id,
stores browser session digests in PostgreSQL, sets HttpOnly/SameSite cookies,
and requires CSRF tokens on state-changing authenticated requests. Production
cookies are Secure; local development can use `COOKIE_SECURE=false`.

## Drive and transfer API

All private routes require the owner session cookie. Every state-changing
request also sends the x-csrf-token value returned at login. Folder names are
metadata; storage objects use generated UUID keys under
objects/<2>/<2>/. Uploads are staged under generated names in uploads/.

The resumable API follows offset-based PATCH semantics:

1. POST /api/uploads with JSON containing filename, expected_size, and optional
   parent_id. The response includes an upload ID and Location.
2. HEAD /api/uploads/{id} returns Upload-Offset and Upload-Length.
3. PATCH /api/uploads/{id} with Content-Type
   application/offset+octet-stream, the current Upload-Offset, and the CSRF
   header. Each PATCH is limited to 64 MiB. A stale offset gets 409 and the
   server's current offset.
4. POST /api/uploads/{id}/finalize verifies the size, hashes the staged bytes,
   atomically moves them to the HDD object tree, and commits the file version.

The client can repeat HEAD and resume after reconnecting. The database stores
the committed offset; a retry truncates any uncommitted tail before writing.
Finalization records its pending object and file IDs before the filesystem
rename, so retrying after a process restart completes either side of the rename
without duplicating the file. UPLOAD_SESSION_TTL controls session expiry;
expired and cancelled staging files are cleaned up by the maintenance worker.

## Storage maintenance

The service runs a maintenance pass at startup and once an hour. Each pass
handles up to 100 expired uploads, trash roots, unreferenced storage objects,
and ready payload checks. A failed filesystem operation leaves its cleanup
marker or `deleting` state for the next pass to retry.

TRASH_RETENTION_DAYS controls when a trashed root and its subtree are permanently
removed; it defaults to 30 days and must be positive. The worker removes a
storage object only after no file version or finalizing upload references it.
It checks ready object paths in batches and logs a missing payload while
preserving its PostgreSQL metadata for repair. Every purge records an
`entry_purged` audit event. Monitor the JSON logs for
`storage maintenance pass completed`, retry warnings, and missing-payload
errors. Confirm TRASH_RETENTION_DAYS before deployment because this process
permanently deletes expired trash.

Private content is available at GET and HEAD
/api/files/{id}/download. Responses are attachments with nosniff, a SHA-256
ETag, and Accept-Ranges: bytes. One byte range is supported per request;
valid ranges return 206, and invalid or unsupported ranges return 416.
Unknown file types remain downloads and are never served inline.

GET /api/drive lists the current folder with bounded pagination and sorting.
Use parent_id to open a folder. POST /api/folders creates a folder;
GET /api/entries/{id}, PATCH /api/entries/{id}/rename,
POST /api/entries/{id}/move, DELETE /api/entries/{id}, and
POST /api/entries/{id}/restore inspect or change entries.
GET /api/drive/search?q=... searches visible names, and
GET /api/drive/trash lists trashed entries.

## Public share API

Authenticated owners create shares with POST /api/shares, list them with
GET /api/shares, and revoke one with POST /api/shares/{id}/revoke. Creation
accepts a file or folder ID plus optional `expires_at`, `password`,
`allow_download`, and `max_downloads`. The response contains a one-time
`share_url` at `/s/{opaque-token}`. PostgreSQL stores only the token digest;
copy the returned URL when creating the share.

GET /api/public/shares/{token} returns file metadata or a paginated folder
listing. Folder links accept `folder_id`, `limit`, and `offset` query values.
POST /api/public/shares/{token}/unlock verifies an optional password and sets
a 30-minute HttpOnly access cookie scoped to that share. Five failed password
attempts lock the share for 15 minutes. GET
/api/public/shares/{token}/download/{entry_id} streams an allowed file and
supports the same byte-range behavior as private downloads. Revocation,
expiry, trashing a shared folder, or reaching `max_downloads` disables access.

## Single-server Compose deployment

1. Mount the HDD by filesystem UUID at `/srv/my-drive/data` and ensure the
   directory is writable by UID 10001. Mount the SSD-backed PostgreSQL directory
   separately, for example `/var/lib/my-drive/postgres`.
2. Set the restricted deployment environment values shown in `.env.example`.
   Generate `POSTGRES_PASSWORD` with a password manager or
   `openssl rand -hex 32`. Set `STORAGE_DATA_HDD` to the mounted HDD path and
   `POSTGRES_DATA_SSD` to the SSD path.
3. Set `STORAGE_EXPECTED_DEVICE` to the output of
   `findmnt -n -o MAJ:MIN --target /srv/my-drive/data`. Compose compares it with
   the device mounted inside the container before storage is initialized.
4. Set `BOOTSTRAP_OWNER_EMAIL` and a unique `BOOTSTRAP_OWNER_PASSWORD` for the
   first run only. The password is Argon2id-hashed before it reaches PostgreSQL.
5. Run `docker compose up -d --build`. The app binds to loopback; configure a
   reverse proxy to terminate TLS. Do not expose the app port directly to the
   public internet.

The Compose file binds PostgreSQL's data directory to the SSD and the payload
root to the HDD. It uses `create_host_path: false` so Docker does not create a
missing bind source on the root filesystem. For a native systemd installation,
set `STORAGE_REQUIRE_MOUNT=true`, `STORAGE_EXPECTED_MOUNT`, and optionally
`STORAGE_EXPECTED_DEVICE` in the restricted environment file.

## Backup and restore

A single HDD is not a backup. Back up a PostgreSQL dump, the HDD object tree,
and required configuration to another disk, NAS, or offsite destination. Until
the backup tooling can pause maintenance, stop the app during a full object-tree
copy or take a consistent filesystem snapshot so the retention worker cannot
unlink payloads mid-copy. Restore the database and object tree together, then
start the service and review maintenance logs for missing-payload errors before
reopening access. The current check only verifies ready object paths; it does
not verify checksums or repair missing bytes. A periodic restore test is
required before relying on a backup. Backup automation and restore verification
are the next operations slice.

## Web interface

The Vite development server runs separately from Axum. From the repository
root, start the Rust service, then open a second terminal in frontend and run
npm ci followed by npm run dev. Vite proxies same-origin /api requests to
http://127.0.0.1:3000. The Rust service serves frontend/dist, including public
/s/<token> links; the Docker image builds both client and server. An unknown
/api route returns JSON 404 rather than the app shell.
