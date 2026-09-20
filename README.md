# My Drive

A private, single-server personal cloud. The service is a Rust/Axum modular
monolith backed by PostgreSQL. PostgreSQL stores file and security metadata;
file contents and upload staging belong on a separately mounted HDD.

## Current implementation

The service now includes validated configuration, PostgreSQL migrations,
first-owner bootstrap, a fail-closed storage mount guard, live/ready health
endpoints, authenticated folder and trash APIs, resumable HDD-backed uploads,
private downloads with byte ranges, quota checks, and upload/folder audit
events. Public shares, the browser client, physical trash collection, and
maintenance jobs are later milestones.

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
after the first successful bootstrap.

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
without duplicating the file. UPLOAD_SESSION_TTL controls session expiry.
Expired staging cleanup is part of the operations milestone.

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
and required configuration to another disk, NAS, or offsite destination. Pause
physical garbage collection while a backup runs. Restore the database and
object tree together, then run the future reconciliation command before
reopening access. A periodic restore test is required before relying on a
backup. Detailed automation and verification are part of the operations
milestone.
