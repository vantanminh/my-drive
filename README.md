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
- The app checks the expected HDD mount before creating its `objects`,
  `uploads`, and `trash` directories. Keep generated preview files in the
  separate SSD cache mount configured with `MEDIA_PREVIEW_ROOT`; if that mount
  is unavailable, preview-cache writes stay disabled instead of falling back
  to the HDD or another filesystem.
- Compose requires `STORAGE_EXPECTED_DEVICE` to match the mounted filesystem's
  `major:minor` device number. This catches a bind-mounted fallback directory
  when the HDD did not mount. It also checks the preview SSD against
  `MEDIA_PREVIEW_EXPECTED_DEVICE` and rejects using the HDD device for both.

## Development

Install Rust stable and PostgreSQL 17 or newer. Copy `.env.example` to `.env`,
set a local `DATABASE_URL` and absolute `STORAGE_ROOT`, then use the explicit
development-only `STORAGE_REQUIRE_MOUNT=false` setting. This setting must not be
used for a production service. Set `MEDIA_PREVIEW_ROOT` to a separate local
cache directory and `MEDIA_PREVIEW_REQUIRE_MOUNT=false` when developing with
preview storage. Set both owner bootstrap variables to create the first owner;
the password must be at least 16 bytes. Remove those variables after the first
successful bootstrap. Install Node.js 22 or newer for the web client.

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

## Running a prebuilt Docker image

GitHub Actions builds both the web app image and the isolated media indexer
image for every pull request. Pushes to `master` publish
`ghcr.io/vantanminh/my-drive:latest` and
`ghcr.io/vantanminh/my-drive-indexer:latest`, plus commit-specific tags;
version tags such as `v1.2.3` publish matching image tags. The workflow builds
`linux/amd64` from this repository's `Dockerfile` and publishes to GitHub
Container Registry (GHCR). The published GHCR images are public and can be
pulled without logging in.

On the Linux host, keep `compose.yaml`, `docker/setup-indexer-role.sh`, and a
protected `.env` file. The app does not need the source checkout at runtime.
Prepare the SSD and mounted HDD paths as described below, then set `MY_DRIVE_IMAGE` and
`MY_DRIVE_INDEXER_IMAGE` in `.env` to the published tags you want to run. For
the latest images from `master`, use:

```dotenv
MY_DRIVE_IMAGE=ghcr.io/vantanminh/my-drive:latest
MY_DRIVE_INDEXER_IMAGE=ghcr.io/vantanminh/my-drive-indexer:latest
```

Pull and start it:

```sh
docker compose pull app media-indexer
docker compose up -d
docker compose ps
docker compose logs -f app
docker compose logs -f media-indexer
```

To build and run the images locally instead, run both commands from the
repository root on the target machine, then set the image names in `.env`:

```sh
docker build --target runtime -t my-drive:local .
docker build --target media-indexer-runtime -t my-drive-indexer:local .
```

```dotenv
MY_DRIVE_IMAGE=my-drive:local
MY_DRIVE_INDEXER_IMAGE=my-drive-indexer:local
```

Start it with `docker compose up -d`. Compose uses the local image when it is
present; it does not need to build from source. You still need the Compose
file, `.env`, PostgreSQL data directory, HDD payload directory, and SSD preview
cache directory, and the database-role setup script mounted by Compose. The app
image includes the Rust service and built web client.
The separate indexer image includes the constrained image decoder and worker.
Neither image contains secrets or persistent data.

The indexer currently creates card and viewer WebP previews for JPEG, PNG,
and WebP uploads. GIF, AVIF, BMP, and ICO files remain available as originals
and their preview jobs are reported as unsupported. Configure
`MEDIA_INDEXER_PASSWORD` as a separate random hex secret; Compose creates a
limited PostgreSQL role for the worker after the app has applied migrations.

## Single-server Compose deployment

1. Mount the HDD by filesystem UUID at `/srv/my-drive/data` and ensure the
   directory is writable by UID 10001. Keep PostgreSQL and generated preview
   cache on the SSD, for example `/var/lib/my-drive/postgres` and
   `/var/lib/my-drive/previews`. The SSD preview directory must be on a
   different filesystem from the HDD storage.
2. Set the restricted deployment environment values shown in `.env.example`.
   Generate `POSTGRES_PASSWORD` with a password manager or
   `openssl rand -hex 32`; generate a different `MEDIA_INDEXER_PASSWORD` the
   same way. Set `STORAGE_DATA_HDD` to the mounted HDD path and
   `POSTGRES_DATA_SSD` and `MEDIA_PREVIEW_DATA_SSD` to their SSD paths.
3. Set `STORAGE_EXPECTED_DEVICE` to the output of
   `findmnt -n -o MAJ:MIN --target /srv/my-drive/data`. Compose compares it with
   the device mounted inside the container before storage is initialized. Set
   `MEDIA_PREVIEW_EXPECTED_DEVICE` from
   `findmnt -n -o MAJ:MIN --target "$MEDIA_PREVIEW_DATA_SSD"`. Confirm the two
   reported device IDs differ. Both HDD and preview SSD device checks are
   required when preview storage is configured.
4. Set `BOOTSTRAP_OWNER_EMAIL` and a unique `BOOTSTRAP_OWNER_PASSWORD` for the
   first run only. The password is Argon2id-hashed before it reaches PostgreSQL.
5. Set both `MY_DRIVE_IMAGE` and `MY_DRIVE_INDEXER_IMAGE` in `.env` to matching
   GHCR tags (or to `my-drive:local` and `my-drive-indexer:local` after building
   locally). Pull both images with `docker compose pull app media-indexer`, then
   run `docker compose up -d`. The app binds to loopback; configure a reverse
   proxy to terminate TLS. Do not expose the app port directly to the public
   internet.

The Compose file binds PostgreSQL and preview cache directories to the SSD and
the original payload root to the HDD. It uses `create_host_path: false` so
Docker does not create a missing bind source on the root filesystem. Preview
files are rebuildable cache data; the source files remain on the HDD. For a
native systemd installation, configure separate `STORAGE_*` and
`MEDIA_PREVIEW_*` roots, mount points, and expected device IDs in the restricted
environment file. Keep device matching enabled for both mounts.

## Encrypted backup and restore

A single HDD is not a backup. Store encrypted backups on a mounted disk, NAS, or
offsite destination that is separate from both the PostgreSQL filesystem and
the HDD storage filesystem. The scripts require Linux or WSL, Docker Compose
v2, `age`, GNU `tar`, Python 3, `sha256sum`, `realpath`, `stat`, and `flock`.
Install `age` with the package manager for the backup host. Create an age
identity and keep its private file offline or in a protected secrets store:

```sh
umask 077
mkdir -p "$HOME/.config/my-drive"
age-keygen -o "$HOME/.config/my-drive/age-identity"
```

Use `age-keygen -y` to derive the public recipient for backup. Backups encrypt
the PostgreSQL dump, the `objects`, `uploads`, `trash`, and `previews` tree, the
Compose file, and the protected environment file. The published bundle contains
only age-encrypted payloads, a manifest, and SHA-256 checksums. The backup
script stops the app and media indexer while capturing the database and storage
tree, then restarts each service only if it was running before the backup.

Create the destination directory after the other filesystem is mounted. The
script refuses to create a missing destination and checks that its filesystem
device differs from both configured data roots. A separate filesystem can
still be in the same building; keep another copy offsite for disaster recovery.

```sh
sudo mkdir -p /mnt/backup/my-drive
findmnt --target /mnt/backup/my-drive
findmnt --target /var/lib/my-drive/postgres
findmnt --target /srv/my-drive/data
```

Run backup as root so backup and restore share protected, deployment-scoped
operation locks:

```sh
sudo env \
  COMPOSE_FILE_PATH="$PWD/compose.yaml" \
  APP_ENV_FILE="$PWD/.env" \
  BACKUP_ROOT=/mnt/backup/my-drive \
  AGE_RECIPIENT="$(age-keygen -y "$HOME/.config/my-drive/age-identity")" \
  ./scripts/backup.sh
```

The command prints the backup directory and exact Compose project/database
confirmation value. Preserve the printed path with your recovery notes.

Verify a bundle while its PostgreSQL service is running. Verification checks
the manifest and every bundle checksum, decrypts every age artifact, validates
the storage archive, and asks `pg_restore` to inspect the dump. It does not
stop the app or change the database.

```sh
COMPOSE_FILE_PATH="$PWD/compose.yaml" APP_ENV_FILE="$PWD/.env" \
  AGE_IDENTITY="$HOME/.config/my-drive/age-identity" \
  ./scripts/verify-backup.sh /mnt/backup/my-drive/my-drive-<backup-id>
```

Restore only after verifying the bundle and confirming the intended target.
The Compose database service must be running. Restore imports into a temporary
database and extracts into a new HDD staging directory before it changes the
live database or storage. It checks each ready database object for a valid key,
matching file size, and matching stored SHA-256 checksum. Set
`CONFIRM_RESTORE_DB` to the exact `project/database` value printed by backup or
reported by Compose:

```sh
sudo env \
  COMPOSE_FILE_PATH="$PWD/compose.yaml" \
  APP_ENV_FILE="$PWD/.env" \
  AGE_IDENTITY="$HOME/.config/my-drive/age-identity" \
  CONFIRM_RESTORE_DB=my-drive/mydrive \
  ./scripts/restore.sh /mnt/backup/my-drive/my-drive-<backup-id>
```

When testing a backup against a separate staging Compose project, also set
`CONFIRM_RESTORE_SOURCE` to the exact source shown in the mismatch error, such
as `my-drive/mydrive as mydrive`. The target confirmation remains required.
This extra confirmation prevents an accidental cross-project restore while
allowing an intentional staging restore.

Restore stops the app and media indexer during the operation. After a successful
restore or confirmed rollback, it restarts only the services that were running
when restore began. If database or storage rollback cannot be confirmed, it
leaves both services stopped and reports the recovery paths. A successful
restore keeps the previous database under a generated `restoreold_*` name and
the previous storage directories under
`.pre-restore-*` on the HDD. Keep both until the restored service and files have
been checked; remove them only after the recovery window has passed.

Periodically test a recent backup by verifying and restoring it into isolated
staging PostgreSQL and storage directories. Check representative file hashes,
login, browsing, downloads, and the readiness endpoint before relying on the
backup. Do not use production paths for restore drills.

## Web interface

The Vite development server runs separately from Axum. From the repository
root, start the Rust service, then open a second terminal in frontend and run
npm ci followed by npm run dev. Vite proxies same-origin /api requests to
http://127.0.0.1:3000. The Rust service serves frontend/dist, including public
/s/<token> links; the Docker image builds both client and server. An unknown
/api route returns JSON 404 rather than the app shell.
