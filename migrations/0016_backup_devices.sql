CREATE TABLE backup_devices (
    id UUID PRIMARY KEY,
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
    client_name TEXT NOT NULL CHECK (char_length(btrim(client_name)) BETWEEN 1 AND 80),
    operating_system TEXT NOT NULL CHECK (char_length(btrim(operating_system)) BETWEEN 1 AND 120),
    client_version TEXT NOT NULL CHECK (char_length(btrim(client_version)) BETWEEN 1 AND 40),
    permissions TEXT[] NOT NULL CHECK (
        cardinality(permissions) > 0
        AND permissions <@ ARRAY['backup']::TEXT[]
    ),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_active_at TIMESTAMPTZ NULL,
    last_ip TEXT NULL CHECK (last_ip IS NULL OR char_length(last_ip) BETWEEN 1 AND 64),
    revoked_at TIMESTAMPTZ NULL
);

CREATE INDEX backup_devices_owner_idx ON backup_devices (owner_id, created_at DESC);

CREATE TABLE device_authorization_requests (
    id UUID PRIMARY KEY,
    device_code_digest BYTEA NOT NULL UNIQUE CHECK (octet_length(device_code_digest) = 32),
    user_code TEXT NOT NULL UNIQUE CHECK (
        user_code ~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$'
    ),
    client_name TEXT NOT NULL,
    device_name TEXT NOT NULL,
    operating_system TEXT NOT NULL,
    client_version TEXT NOT NULL,
    requested_ip TEXT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    poll_interval_seconds INTEGER NOT NULL DEFAULT 5 CHECK (poll_interval_seconds BETWEEN 1 AND 60),
    poll_after TIMESTAMPTZ NOT NULL DEFAULT now(),
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'consumed', 'expired')),
    owner_id UUID NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id UUID NULL REFERENCES backup_devices(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX device_authorization_requests_expiry_idx
    ON device_authorization_requests (status, expires_at);

CREATE TABLE device_credentials (
    id UUID PRIMARY KEY,
    device_id UUID NOT NULL REFERENCES backup_devices(id) ON DELETE CASCADE,
    access_token_digest BYTEA NOT NULL UNIQUE CHECK (octet_length(access_token_digest) = 32),
    refresh_token_digest BYTEA NOT NULL UNIQUE CHECK (octet_length(refresh_token_digest) = 32),
    access_expires_at TIMESTAMPTZ NOT NULL,
    refresh_expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX device_credentials_device_idx ON device_credentials (device_id, created_at DESC);

ALTER TABLE upload_sessions
    ADD COLUMN replace_file_id UUID NULL REFERENCES files(id) ON DELETE SET NULL,
    ADD COLUMN original_modified_at TIMESTAMPTZ NULL;
