CREATE TABLE network_drive_settings (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    webdav_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    updated_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO network_drive_settings (singleton) VALUES (TRUE)
ON CONFLICT (singleton) DO NOTHING;
