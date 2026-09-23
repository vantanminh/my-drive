CREATE TABLE google_drive_connections (
    id UUID PRIMARY KEY,
    owner_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    google_subject TEXT NOT NULL CHECK (char_length(google_subject) BETWEEN 1 AND 255),
    google_email TEXT NOT NULL CHECK (char_length(google_email) BETWEEN 3 AND 320),
    refresh_nonce BYTEA NOT NULL CHECK (octet_length(refresh_nonce) = 12),
    refresh_token BYTEA NOT NULL CHECK (octet_length(refresh_token) > 0),
    paused BOOLEAN NOT NULL DEFAULT FALSE,
    auth_state TEXT NOT NULL DEFAULT 'active' CHECK (auth_state IN ('active', 'reauth_required')),
    local_root_id UUID NULL REFERENCES folders(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE google_drive_oauth_states (
    state_digest BYTEA PRIMARY KEY CHECK (octet_length(state_digest) = 32),
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX google_drive_oauth_states_expiry_idx
    ON google_drive_oauth_states (expires_at);

CREATE TABLE google_drive_sources (
    id UUID PRIMARY KEY,
    connection_id UUID NOT NULL REFERENCES google_drive_connections(id) ON DELETE CASCADE,
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    google_folder_id TEXT NOT NULL CHECK (char_length(google_folder_id) BETWEEN 1 AND 128),
    google_folder_name TEXT NOT NULL CHECK (char_length(google_folder_name) BETWEEN 1 AND 255),
    local_folder_id UUID NULL REFERENCES folders(id) ON DELETE SET NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (owner_id, google_folder_id)
);

CREATE INDEX google_drive_sources_connection_idx
    ON google_drive_sources (connection_id, created_at);

CREATE TABLE google_drive_runs (
    id UUID PRIMARY KEY,
    source_id UUID NOT NULL REFERENCES google_drive_sources(id) ON DELETE CASCADE,
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    state TEXT NOT NULL CHECK (state IN ('listing', 'downloading', 'completed', 'failed', 'cancelled')),
    discovered_files BIGINT NOT NULL DEFAULT 0 CHECK (discovered_files >= 0),
    discovered_folders BIGINT NOT NULL DEFAULT 0 CHECK (discovered_folders >= 0),
    discovered_bytes BIGINT NOT NULL DEFAULT 0 CHECK (discovered_bytes >= 0),
    downloaded_files BIGINT NOT NULL DEFAULT 0 CHECK (downloaded_files >= 0),
    downloaded_bytes BIGINT NOT NULL DEFAULT 0 CHECK (downloaded_bytes >= 0),
    skipped_files BIGINT NOT NULL DEFAULT 0 CHECK (skipped_files >= 0),
    failed_files BIGINT NOT NULL DEFAULT 0 CHECK (failed_files >= 0),
    current_name TEXT NULL CHECK (current_name IS NULL OR char_length(current_name) <= 255),
    current_bytes BIGINT NOT NULL DEFAULT 0 CHECK (current_bytes >= 0),
    current_total_bytes BIGINT NULL CHECK (current_total_bytes IS NULL OR current_total_bytes >= 0),
    throttle_reason TEXT NULL CHECK (
        throttle_reason IS NULL OR throttle_reason IN (
            'pace', 'image_index', 'indexer_running', 'rate_limit'
        )
    ),
    error_code TEXT NULL CHECK (error_code IS NULL OR char_length(error_code) <= 64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ NULL
);

CREATE INDEX google_drive_runs_source_idx
    ON google_drive_runs (source_id, created_at DESC);

CREATE INDEX google_drive_runs_active_idx
    ON google_drive_runs (updated_at)
    WHERE state IN ('listing', 'downloading');

CREATE TABLE google_drive_list_queue (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    run_id UUID NOT NULL REFERENCES google_drive_runs(id) ON DELETE CASCADE,
    google_folder_id TEXT NOT NULL CHECK (char_length(google_folder_id) BETWEEN 1 AND 128),
    local_folder_id UUID NULL REFERENCES folders(id) ON DELETE SET NULL,
    page_token TEXT NULL CHECK (page_token IS NULL OR char_length(page_token) <= 1024),
    done BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE (run_id, google_folder_id)
);

CREATE INDEX google_drive_list_queue_pending_idx
    ON google_drive_list_queue (run_id, id)
    WHERE done = FALSE;

CREATE TABLE google_drive_items (
    id UUID PRIMARY KEY,
    run_id UUID NOT NULL REFERENCES google_drive_runs(id) ON DELETE CASCADE,
    source_id UUID NOT NULL REFERENCES google_drive_sources(id) ON DELETE CASCADE,
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    google_file_id TEXT NOT NULL CHECK (char_length(google_file_id) BETWEEN 1 AND 128),
    parent_local_id UUID NULL REFERENCES folders(id) ON DELETE SET NULL,
    name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 255),
    google_mime TEXT NOT NULL CHECK (char_length(google_mime) BETWEEN 1 AND 255),
    size_bytes BIGINT NULL CHECK (size_bytes IS NULL OR size_bytes >= 0),
    md5_checksum TEXT NULL CHECK (md5_checksum IS NULL OR md5_checksum ~ '^[0-9a-f]{32}$'),
    modified_at TIMESTAMPTZ NULL,
    priority SMALLINT NOT NULL CHECK (priority IN (0, 1, 2)),
    state TEXT NOT NULL CHECK (
        state IN ('pending', 'downloading', 'committing', 'stored', 'skipped', 'failed')
    ),
    bytes_downloaded BIGINT NOT NULL DEFAULT 0 CHECK (bytes_downloaded >= 0),
    staging_key UUID NULL,
    storage_object_id UUID NULL REFERENCES storage_objects(id) ON DELETE SET NULL,
    local_file_id UUID NULL REFERENCES files(id) ON DELETE SET NULL,
    checksum_sha256 CHAR(64) NULL CHECK (
        checksum_sha256 IS NULL OR checksum_sha256 ~ '^[0-9a-f]{64}$'
    ),
    index_mime TEXT NULL CHECK (index_mime IS NULL OR char_length(index_mime) <= 255),
    export_mime TEXT NULL CHECK (export_mime IS NULL OR char_length(export_mime) <= 255),
    error_code TEXT NULL CHECK (error_code IS NULL OR char_length(error_code) <= 64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (run_id, google_file_id)
);

CREATE INDEX google_drive_items_claim_idx
    ON google_drive_items (priority, size_bytes, created_at, id)
    WHERE state IN ('pending', 'downloading', 'committing');

CREATE TABLE google_drive_links (
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    google_file_id TEXT NOT NULL CHECK (char_length(google_file_id) BETWEEN 1 AND 128),
    local_entry_id UUID NOT NULL REFERENCES drive_entries(id) ON DELETE CASCADE,
    md5_checksum TEXT NULL CHECK (md5_checksum IS NULL OR md5_checksum ~ '^[0-9a-f]{32}$'),
    size_bytes BIGINT NULL CHECK (size_bytes IS NULL OR size_bytes >= 0),
    modified_at TIMESTAMPTZ NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_id, google_file_id)
);

CREATE INDEX google_drive_links_entry_idx ON google_drive_links (local_entry_id);
