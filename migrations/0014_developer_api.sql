CREATE TABLE api_keys (
    id UUID PRIMARY KEY,
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
    token_digest BYTEA NOT NULL UNIQUE CHECK (octet_length(token_digest) = 32),
    prefix TEXT NOT NULL,
    scopes TEXT[] NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    rate_window TIMESTAMPTZ NOT NULL DEFAULT now(),
    rate_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX api_keys_owner ON api_keys(owner_id, created_at DESC);
ALTER TABLE shares ADD COLUMN created_by_api_key_id UUID REFERENCES api_keys(id) ON DELETE RESTRICT;
CREATE INDEX shares_api_key ON shares(created_by_api_key_id) WHERE created_by_api_key_id IS NOT NULL;
CREATE TABLE api_request_logs (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    api_key_id UUID NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
    method TEXT NOT NULL,
    route TEXT NOT NULL,
    status INTEGER NOT NULL,
    duration_ms BIGINT NOT NULL,
    request_bytes BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX api_request_logs_owner ON api_request_logs(owner_id, id DESC);
CREATE INDEX api_request_logs_time ON api_request_logs(created_at);
CREATE INDEX api_request_logs_key ON api_request_logs(api_key_id, created_at DESC);
