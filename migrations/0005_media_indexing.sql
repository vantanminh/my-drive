CREATE TABLE media_index_jobs (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    file_version_id UUID NOT NULL REFERENCES file_versions(id) ON DELETE CASCADE,
    task TEXT NOT NULL CHECK (task IN ('image_preview', 'video_thumbnail', 'face_index')),
    recipe_version SMALLINT NOT NULL CHECK (recipe_version > 0),
    state TEXT NOT NULL DEFAULT 'queued' CHECK (
        state IN ('queued', 'running', 'completed', 'unsupported', 'retry_wait', 'failed')
    ),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    lease_expires_at TIMESTAMPTZ NULL,
    current_stage TEXT NULL CHECK (current_stage IS NULL OR char_length(current_stage) <= 64),
    processed_bytes BIGINT NOT NULL DEFAULT 0 CHECK (processed_bytes >= 0),
    error_code TEXT NULL CHECK (error_code IS NULL OR char_length(error_code) <= 64),
    last_error_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ NULL,
    UNIQUE (file_version_id, task, recipe_version)
);

CREATE INDEX media_index_jobs_claim_idx
    ON media_index_jobs (available_at, id)
    WHERE state IN ('queued', 'retry_wait', 'running');

CREATE INDEX media_index_jobs_state_idx
    ON media_index_jobs (task, state, updated_at DESC);

CREATE TABLE media_derivatives (
    file_version_id UUID NOT NULL REFERENCES file_versions(id) ON DELETE CASCADE,
    variant TEXT NOT NULL CHECK (variant IN ('card', 'viewer', 'video_poster')),
    recipe_version SMALLINT NOT NULL CHECK (recipe_version > 0),
    storage_key TEXT NOT NULL CHECK (
        storage_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(card|viewer|video_poster)-v[1-9][0-9]*[.]webp$'
    ),
    mime_type TEXT NOT NULL CHECK (mime_type = 'image/webp'),
    size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
    width INTEGER NOT NULL CHECK (width > 0),
    height INTEGER NOT NULL CHECK (height > 0),
    checksum_sha256 CHAR(64) NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (file_version_id, variant, recipe_version)
);

CREATE TABLE media_index_control (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    paused BOOLEAN NOT NULL DEFAULT FALSE,
    changed_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO media_index_control (singleton) VALUES (TRUE);
