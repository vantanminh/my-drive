-- Face observations deliberately keep only bounded geometry and confidence in
-- this slice. A detector can add a versioned descriptor in a later migration
-- without exposing biometric data through the API.
CREATE TABLE face_clusters (
    id UUID PRIMARY KEY,
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label TEXT NULL CHECK (
        label IS NULL
        OR (
            char_length(btrim(label)) BETWEEN 1 AND 80
            AND label = btrim(label)
        )
    ),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX face_clusters_owner_updated_idx
    ON face_clusters (owner_id, updated_at DESC, id DESC);

CREATE TABLE face_observations (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    file_version_id UUID NOT NULL REFERENCES file_versions(id) ON DELETE CASCADE,
    cluster_id UUID NULL REFERENCES face_clusters(id) ON DELETE SET NULL,
    recipe_version SMALLINT NOT NULL CHECK (recipe_version > 0),
    face_index SMALLINT NOT NULL CHECK (face_index >= 0),
    confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    box_left REAL NOT NULL CHECK (box_left >= 0 AND box_left <= 1),
    box_top REAL NOT NULL CHECK (box_top >= 0 AND box_top <= 1),
    box_width REAL NOT NULL CHECK (box_width > 0 AND box_width <= 1),
    box_height REAL NOT NULL CHECK (box_height > 0 AND box_height <= 1),
    CHECK (box_left + box_width <= 1),
    CHECK (box_top + box_height <= 1),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (file_version_id, recipe_version, face_index)
);

CREATE INDEX face_observations_cluster_idx
    ON face_observations (cluster_id, created_at DESC)
    WHERE cluster_id IS NOT NULL;

CREATE INDEX face_observations_file_version_idx
    ON face_observations (file_version_id, recipe_version, face_index);

-- A face group must never point at another account's file. The check lives in
-- the database as well as in the API because future indexers write directly.
CREATE FUNCTION validate_face_observation_owner() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    file_owner UUID;
    cluster_owner UUID;
BEGIN
    SELECT entry.owner_id
      INTO file_owner
      FROM file_versions AS version
      JOIN drive_entries AS entry ON entry.id = version.file_id
     WHERE version.id = NEW.file_version_id;

    IF file_owner IS NULL THEN
        RAISE EXCEPTION 'face observation references an unknown file version'
            USING ERRCODE = '23503';
    END IF;

    IF NEW.cluster_id IS NOT NULL THEN
        SELECT owner_id INTO cluster_owner
          FROM face_clusters
         WHERE id = NEW.cluster_id;
        IF cluster_owner IS NULL THEN
            RAISE EXCEPTION 'face observation references an unknown face cluster'
                USING ERRCODE = '23503';
        END IF;
        IF cluster_owner <> file_owner THEN
            RAISE EXCEPTION 'face cluster and file must have the same owner'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER face_observation_owner_guard
    BEFORE INSERT OR UPDATE OF file_version_id, cluster_id ON face_observations
    FOR EACH ROW EXECUTE FUNCTION validate_face_observation_owner();
