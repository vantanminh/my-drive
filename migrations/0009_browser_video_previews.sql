-- Keep browser playback independent from the codec/container of the HDD original.
-- Video previews are bounded MP4 derivatives stored by PreviewStorage on the SSD.

ALTER TABLE media_index_jobs
    DROP CONSTRAINT IF EXISTS media_index_jobs_task_check;

ALTER TABLE media_index_jobs
    ADD CONSTRAINT media_index_jobs_task_check CHECK (
        task IN ('image_preview', 'video_thumbnail', 'video_preview', 'face_index')
    );

ALTER TABLE media_derivatives
    DROP CONSTRAINT IF EXISTS media_derivatives_variant_check,
    DROP CONSTRAINT IF EXISTS media_derivatives_storage_key_check,
    DROP CONSTRAINT IF EXISTS media_derivatives_mime_type_check;

ALTER TABLE media_derivatives
    ALTER COLUMN width DROP NOT NULL,
    ALTER COLUMN height DROP NOT NULL;

ALTER TABLE media_derivatives
    ADD CONSTRAINT media_derivatives_variant_check CHECK (
        variant IN ('card', 'viewer', 'video_poster', 'video_preview')
    ),
    ADD CONSTRAINT media_derivatives_storage_key_check CHECK (
        storage_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/((card|viewer|video_poster)-v[1-9][0-9]*[.]webp|video_preview-v[1-9][0-9]*[.]mp4)$'
    ),
    ADD CONSTRAINT media_derivatives_mime_type_check CHECK (
        mime_type IN ('image/webp', 'video/mp4')
    );
