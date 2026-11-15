ALTER TABLE network_drive_settings
    ADD COLUMN smb_enabled BOOLEAN NOT NULL DEFAULT FALSE;

-- Samba authenticates with an NT hash, so SMB uses its own password per user
-- (the account password is only stored as an Argon2id hash).
CREATE TABLE smb_accounts (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    username TEXT NOT NULL UNIQUE CHECK (username ~ '^[a-z][a-z0-9._-]{0,31}$'),
    nt_hash BYTEA NOT NULL CHECK (octet_length(nt_hash) = 16),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
