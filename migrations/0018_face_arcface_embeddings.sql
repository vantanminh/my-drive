-- Upgrade face descriptors to 512-dim float32 ArcFace embeddings (2048 bytes)
-- while preserving legacy 256-byte rows during recipe transition, and store a
-- cluster centroid/anchor embedding plus auto_merge flag on face_clusters.
ALTER TABLE face_observations
    DROP CONSTRAINT face_observations_descriptor_size,
    ADD CONSTRAINT face_observations_descriptor_size CHECK (
        descriptor IS NULL OR octet_length(descriptor) IN (256, 2048)
    );

ALTER TABLE face_clusters
    ADD COLUMN anchor_embedding BYTEA NULL CHECK (
        anchor_embedding IS NULL OR octet_length(anchor_embedding) = 2048
    ),
    ADD COLUMN auto_merge BOOLEAN NOT NULL DEFAULT TRUE;
