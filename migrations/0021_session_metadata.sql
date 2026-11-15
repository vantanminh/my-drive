ALTER TABLE sessions
    ADD COLUMN IF NOT EXISTS ip_address TEXT,
    ADD COLUMN IF NOT EXISTS user_agent TEXT,
    ADD COLUMN IF NOT EXISTS client_type TEXT NOT NULL DEFAULT 'web',
    ADD COLUMN IF NOT EXISTS device_label TEXT;

CREATE INDEX IF NOT EXISTS idx_sessions_user_active
    ON sessions (user_id, expires_at DESC)
    WHERE revoked_at IS NULL;
