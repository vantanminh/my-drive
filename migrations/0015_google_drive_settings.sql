CREATE TABLE google_drive_settings (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    client_id TEXT NOT NULL CHECK (char_length(client_id) BETWEEN 10 AND 200),
    redirect_uri TEXT NOT NULL CHECK (char_length(redirect_uri) BETWEEN 16 AND 500),
    secret_nonce BYTEA NOT NULL CHECK (octet_length(secret_nonce) = 12),
    secret_ciphertext BYTEA NOT NULL CHECK (octet_length(secret_ciphertext) > 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
