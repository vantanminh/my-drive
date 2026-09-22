-- Store a compact, versioned appearance descriptor for CPU-friendly face
-- matching. Descriptors stay in PostgreSQL and are never returned by the API.
-- Existing observations remain valid and are re-indexed by recipe version 2.
ALTER TABLE face_observations
    ADD COLUMN descriptor BYTEA NULL,
    ADD CONSTRAINT face_observations_descriptor_size CHECK (
        descriptor IS NULL OR octet_length(descriptor) = 256
    );

CREATE INDEX face_observations_descriptor_idx
    ON face_observations (cluster_id, created_at DESC)
    WHERE cluster_id IS NOT NULL AND descriptor IS NOT NULL;
