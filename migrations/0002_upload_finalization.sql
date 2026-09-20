ALTER TABLE upload_sessions
    ADD COLUMN storage_object_id UUID NULL REFERENCES storage_objects(id) ON DELETE SET NULL,
    ADD COLUMN final_file_id UUID NULL REFERENCES files(id) ON DELETE CASCADE,
    ADD CONSTRAINT upload_sessions_finalization_state_check CHECK (
        (state = 'finalizing' AND storage_object_id IS NOT NULL AND final_file_id IS NOT NULL)
        OR (state = 'completed' AND final_file_id IS NOT NULL)
        OR state NOT IN ('finalizing', 'completed')
    );

CREATE INDEX upload_sessions_final_file_idx
    ON upload_sessions (final_file_id)
    WHERE final_file_id IS NOT NULL;
