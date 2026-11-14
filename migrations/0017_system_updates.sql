CREATE TABLE system_update_settings (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    auto_check_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    auto_update_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    check_interval_minutes INTEGER NOT NULL DEFAULT 60 CHECK (check_interval_minutes BETWEEN 15 AND 10080),
    last_checked_at TIMESTAMPTZ,
    last_check_status TEXT CHECK (last_check_status IS NULL OR last_check_status IN ('ok', 'error')),
    last_check_error TEXT,
    latest_tag TEXT,
    latest_commit_sha TEXT,
    latest_published_at TIMESTAMPTZ,
    latest_release_url TEXT,
    latest_release_notes TEXT,
    last_triggered_at TIMESTAMPTZ,
    last_triggered_tag TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO system_update_settings (singleton) VALUES (TRUE)
ON CONFLICT (singleton) DO NOTHING;
