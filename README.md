# My Drive

A private, single-server personal cloud. The service is a Rust/Axum modular
monolith backed by PostgreSQL. PostgreSQL stores file and security metadata;
file contents and upload staging belong on a separately mounted HDD.

## Current implementation

The first milestone provides validated configuration, PostgreSQL migrations,
first-owner bootstrap, a fail-closed storage mount guard, and live/ready health
endpoints. File management, resumable uploads, downloads, shares, the browser
client, and maintenance jobs are being added in later milestones.

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
`/health/ready` checks PostgreSQL and HDD health.

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
