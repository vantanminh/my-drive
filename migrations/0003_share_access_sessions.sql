CREATE TABLE share_access_sessions (
    token_digest BYTEA PRIMARY KEY CHECK (octet_length(token_digest) = 32),
    share_id UUID NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX share_access_sessions_share_expiry_idx
    ON share_access_sessions (share_id, expires_at);
