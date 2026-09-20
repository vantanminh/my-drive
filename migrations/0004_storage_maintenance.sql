ALTER TABLE upload_sessions
    ADD COLUMN staging_cleaned_at TIMESTAMPTZ NULL;

ALTER TABLE storage_objects
    ADD COLUMN last_checked_at TIMESTAMPTZ NULL;

CREATE INDEX upload_sessions_cleanup_idx
    ON upload_sessions (expires_at, id)
    WHERE staging_cleaned_at IS NULL
      AND state IN ('active', 'expired', 'failed');

CREATE INDEX storage_objects_reconcile_idx
    ON storage_objects (last_checked_at, created_at, id)
    WHERE state = 'ready';
