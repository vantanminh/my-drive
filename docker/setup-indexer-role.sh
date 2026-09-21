#!/bin/sh
set -eu

: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
: "${MEDIA_INDEXER_PASSWORD:?MEDIA_INDEXER_PASSWORD is required}"

export PGPASSWORD="$POSTGRES_PASSWORD"
psql --no-password --set=ON_ERROR_STOP=1 \
    --host="${PGHOST:-db}" \
    --username="$POSTGRES_USER" \
    --dbname="$POSTGRES_DB" \
    --set=db_name="$POSTGRES_DB" \
    --set=indexer_password="$MEDIA_INDEXER_PASSWORD" <<'SQL'
BEGIN;
SELECT format(
    'CREATE ROLE media_indexer WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT CONNECTION LIMIT 3 PASSWORD %L',
    :'indexer_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'media_indexer')
\gexec
SELECT 'CREATE ROLE media_indexer_writer WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'media_indexer_writer')
\gexec

ALTER ROLE media_indexer WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT CONNECTION LIMIT 3 PASSWORD :'indexer_password';
ALTER ROLE media_indexer_writer WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
GRANT CONNECT ON DATABASE :"db_name" TO media_indexer;
GRANT USAGE ON SCHEMA public TO media_indexer;
GRANT USAGE ON SCHEMA public TO media_indexer_writer;
GRANT CREATE ON SCHEMA public TO media_indexer_writer;

GRANT SELECT (id, file_version_id, task, recipe_version, state, attempts,
              available_at, lease_expires_at)
    ON media_index_jobs TO media_indexer;
GRANT INSERT (file_version_id, task, recipe_version)
    ON media_index_jobs TO media_indexer;
GRANT UPDATE (state, attempts, available_at, lease_expires_at, current_stage,
              processed_bytes, error_code, last_error_at, updated_at, completed_at)
    ON media_index_jobs TO media_indexer;
GRANT USAGE, SELECT ON SEQUENCE media_index_jobs_id_seq TO media_indexer;

GRANT SELECT (id, storage_object_id, size_bytes, created_at)
    ON file_versions TO media_indexer;
GRANT SELECT (id, current_version_id) ON files TO media_indexer;
GRANT SELECT (id, deleted_at) ON drive_entries TO media_indexer;
GRANT SELECT (id, size_bytes, storage_key, mime_detected, checksum_sha256, state)
    ON storage_objects TO media_indexer;
GRANT SELECT (singleton, paused) ON media_index_control TO media_indexer;

GRANT INSERT, UPDATE ON media_derivatives TO media_indexer_writer;
GRANT SELECT ON media_derivatives TO media_indexer_writer;
REVOKE ALL ON media_derivatives FROM media_indexer;

CREATE OR REPLACE FUNCTION public.media_indexer_upsert_derivative(
    p_file_version_id UUID,
    p_variant TEXT,
    p_recipe_version SMALLINT,
    p_storage_key TEXT,
    p_mime_type TEXT,
    p_size_bytes BIGINT,
    p_width INTEGER,
    p_height INTEGER,
    p_checksum_sha256 TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
    IF p_variant NOT IN ('card', 'viewer', 'video_poster') THEN
        RAISE EXCEPTION 'unsupported derivative variant';
    END IF;

    INSERT INTO public.media_derivatives
        (file_version_id, variant, recipe_version, storage_key, mime_type,
         size_bytes, width, height, checksum_sha256)
    VALUES
        (p_file_version_id, p_variant, p_recipe_version, p_storage_key,
         p_mime_type, p_size_bytes, p_width, p_height, p_checksum_sha256)
    ON CONFLICT (file_version_id, variant, recipe_version) DO UPDATE
       SET storage_key = EXCLUDED.storage_key,
           mime_type = EXCLUDED.mime_type,
           size_bytes = EXCLUDED.size_bytes,
           width = EXCLUDED.width,
           height = EXCLUDED.height,
           checksum_sha256 = EXCLUDED.checksum_sha256,
           created_at = now();
END;
$function$;

REVOKE ALL ON FUNCTION public.media_indexer_upsert_derivative(
    UUID, TEXT, SMALLINT, TEXT, TEXT, BIGINT, INTEGER, INTEGER, TEXT
) FROM PUBLIC;
ALTER FUNCTION public.media_indexer_upsert_derivative(
    UUID, TEXT, SMALLINT, TEXT, TEXT, BIGINT, INTEGER, INTEGER, TEXT
) OWNER TO media_indexer_writer;
REVOKE CREATE ON SCHEMA public FROM media_indexer_writer;
GRANT EXECUTE ON FUNCTION public.media_indexer_upsert_derivative(
    UUID, TEXT, SMALLINT, TEXT, TEXT, BIGINT, INTEGER, INTEGER, TEXT
) TO media_indexer;
COMMIT;
SQL
