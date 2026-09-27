-- A per-account Photos folder is created by the application and must stay put.
-- Users can add files inside it, but they cannot rename, move, or delete it.
ALTER TABLE drive_entries
    ADD COLUMN system_role TEXT NULL,
    ADD CONSTRAINT drive_entries_system_role_check CHECK (
        system_role IS NULL OR system_role = 'photos'
    ),
    ADD CONSTRAINT drive_entries_system_role_folder CHECK (
        system_role IS NULL OR kind = 'folder'
    );

CREATE UNIQUE INDEX drive_entries_one_system_role
    ON drive_entries (owner_id, system_role)
    WHERE system_role IS NOT NULL AND deleted_at IS NULL;
