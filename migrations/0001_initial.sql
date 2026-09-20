CREATE TABLE users (
    id UUID PRIMARY KEY,
    email TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_email_case_insensitive ON users (lower(email));

CREATE TABLE drive_entries (
    id UUID PRIMARY KEY,
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    parent_id UUID NULL REFERENCES drive_entries(id) ON DELETE RESTRICT,
    kind TEXT NOT NULL CHECK (kind IN ('file', 'folder')),
    name TEXT NOT NULL CHECK (
        char_length(btrim(name)) BETWEEN 1 AND 255
        AND name NOT IN ('.', '..')
        AND position('/' IN name) = 0
        AND position(chr(92) IN name) = 0
    ),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ NULL
);

CREATE UNIQUE INDEX drive_entries_active_name
    ON drive_entries (
        owner_id,
        COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::UUID),
        lower(name)
    )
    WHERE deleted_at IS NULL;

CREATE INDEX drive_entries_parent_idx ON drive_entries (owner_id, parent_id, kind);
CREATE INDEX drive_entries_trash_idx ON drive_entries (owner_id, deleted_at) WHERE deleted_at IS NOT NULL;

CREATE FUNCTION validate_drive_entry_parent() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    parent_owner UUID;
    parent_kind TEXT;
    parent_deleted_at TIMESTAMPTZ;
    creates_cycle BOOLEAN;
BEGIN
    IF NEW.parent_id IS NOT NULL THEN
        SELECT owner_id, kind, deleted_at
          INTO parent_owner, parent_kind, parent_deleted_at
          FROM drive_entries
         WHERE id = NEW.parent_id;

        IF NOT FOUND
           OR parent_kind <> 'folder'
           OR parent_owner <> NEW.owner_id
           OR parent_deleted_at IS NOT NULL THEN
            RAISE EXCEPTION 'parent must be an active folder owned by the same user'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    IF NEW.kind = 'folder' AND NEW.parent_id IS NOT NULL THEN
        WITH RECURSIVE ancestors(id, parent_id) AS (
            SELECT id, parent_id FROM drive_entries WHERE id = NEW.parent_id
            UNION ALL
            SELECT entry.id, entry.parent_id
              FROM drive_entries AS entry
              JOIN ancestors ON entry.id = ancestors.parent_id
        )
        SELECT EXISTS (SELECT 1 FROM ancestors WHERE id = NEW.id)
          INTO creates_cycle;

        IF creates_cycle THEN
            RAISE EXCEPTION 'folder move would create a cycle'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER drive_entries_parent_guard
    BEFORE INSERT OR UPDATE OF owner_id, parent_id, kind ON drive_entries
    FOR EACH ROW EXECUTE FUNCTION validate_drive_entry_parent();

CREATE TABLE folders (
    id UUID PRIMARY KEY REFERENCES drive_entries(id) ON DELETE RESTRICT
);

CREATE TABLE files (
    id UUID PRIMARY KEY REFERENCES drive_entries(id) ON DELETE RESTRICT,
    current_version_id UUID NULL
);

CREATE TABLE storage_objects (
    id UUID PRIMARY KEY,
    storage_key TEXT NOT NULL UNIQUE CHECK (
        storage_key ~ '^[0-9a-f]{2}/[0-9a-f]{2}/[0-9a-f-]{36}$'
    ),
    size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
    checksum_sha256 CHAR(64) NULL CHECK (
        checksum_sha256 IS NULL OR checksum_sha256 ~ '^[0-9a-f]{64}$'
    ),
    mime_detected TEXT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'ready', 'deleting', 'failed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE file_versions (
    id UUID PRIMARY KEY,
    file_id UUID NOT NULL REFERENCES files(id) ON DELETE RESTRICT,
    storage_object_id UUID NOT NULL REFERENCES storage_objects(id) ON DELETE RESTRICT,
    size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
    original_modified_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE files
    ADD CONSTRAINT files_current_version_fk
    FOREIGN KEY (current_version_id) REFERENCES file_versions(id) ON DELETE SET NULL;

CREATE INDEX file_versions_file_idx ON file_versions (file_id, created_at DESC);
CREATE INDEX file_versions_storage_object_idx ON file_versions (storage_object_id);

CREATE TABLE upload_sessions (
    id UUID PRIMARY KEY,
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_parent_id UUID NULL REFERENCES folders(id) ON DELETE SET NULL,
    filename TEXT NOT NULL CHECK (
        char_length(btrim(filename)) BETWEEN 1 AND 255
        AND filename NOT IN ('.', '..')
        AND position('/' IN filename) = 0
        AND position(chr(92) IN filename) = 0
    ),
    expected_size BIGINT NOT NULL CHECK (expected_size >= 0),
    received_size BIGINT NOT NULL DEFAULT 0 CHECK (received_size >= 0),
    staging_key UUID NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK (state IN ('active', 'finalizing', 'completed', 'expired', 'failed')),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (received_size <= expected_size)
);

CREATE INDEX upload_sessions_owner_state_idx ON upload_sessions (owner_id, state, expires_at);

CREATE TABLE shares (
    id UUID PRIMARY KEY,
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    resource_type TEXT NOT NULL CHECK (resource_type IN ('file', 'folder')),
    resource_id UUID NOT NULL REFERENCES drive_entries(id) ON DELETE CASCADE,
    token_digest BYTEA NOT NULL UNIQUE CHECK (octet_length(token_digest) = 32),
    password_hash TEXT NULL,
    expires_at TIMESTAMPTZ NULL,
    revoked_at TIMESTAMPTZ NULL,
    allow_download BOOLEAN NOT NULL DEFAULT true,
    max_downloads BIGINT NULL CHECK (max_downloads IS NULL OR max_downloads > 0),
    download_count BIGINT NOT NULL DEFAULT 0 CHECK (download_count >= 0),
    failed_password_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_password_attempts >= 0),
    password_locked_until TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_accessed_at TIMESTAMPTZ NULL
);

CREATE INDEX shares_owner_created_idx ON shares (owner_id, created_at DESC);
CREATE INDEX shares_active_resource_idx ON shares (resource_type, resource_id)
    WHERE revoked_at IS NULL;

CREATE TABLE sessions (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_digest BYTEA NOT NULL UNIQUE CHECK (octet_length(token_digest) = 32),
    csrf_token_digest BYTEA NOT NULL CHECK (octet_length(csrf_token_digest) = 32),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NULL
);

CREATE INDEX sessions_user_expiry_idx ON sessions (user_id, expires_at)
    WHERE revoked_at IS NULL;

CREATE TABLE audit_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_type TEXT NOT NULL,
    actor_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
    resource_id UUID NULL,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_created_idx ON audit_events (created_at DESC);
CREATE INDEX audit_events_actor_created_idx ON audit_events (actor_id, created_at DESC);
