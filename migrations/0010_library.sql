-- Search index, folder analytics, and albums.
-- Index rows stay aligned with drive metadata through SECURITY DEFINER triggers
-- so the restricted media-indexer role can keep writing derivatives.

CREATE TABLE entry_index (
    entry_id UUID PRIMARY KEY REFERENCES drive_entries(id) ON DELETE CASCADE,
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    parent_id UUID NULL,
    kind TEXT NOT NULL CHECK (kind IN ('file', 'folder')),
    name TEXT NOT NULL,
    name_normalized TEXT NOT NULL,
    mime_type TEXT NULL,
    category TEXT NOT NULL CHECK (
        category IN ('folder', 'image', 'video', 'audio', 'document', 'archive', 'other')
    ),
    size_bytes BIGINT NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    deleted_at TIMESTAMPTZ NULL,
    buried BOOLEAN NOT NULL DEFAULT FALSE,
    media JSONB NOT NULL DEFAULT '{}'::jsonb,
    indexed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX entry_index_owner_listing_idx
    ON entry_index (owner_id, parent_id, name_normalized, entry_id)
    WHERE deleted_at IS NULL AND NOT buried;

CREATE INDEX entry_index_owner_updated_idx
    ON entry_index (owner_id, updated_at DESC, entry_id)
    WHERE deleted_at IS NULL AND NOT buried;

CREATE INDEX entry_index_owner_created_idx
    ON entry_index (owner_id, created_at DESC, entry_id)
    WHERE deleted_at IS NULL AND NOT buried;

CREATE INDEX entry_index_owner_size_idx
    ON entry_index (owner_id, size_bytes, entry_id)
    WHERE deleted_at IS NULL AND NOT buried;

CREATE INDEX entry_index_owner_category_idx
    ON entry_index (owner_id, category, updated_at DESC)
    WHERE deleted_at IS NULL AND NOT buried;

CREATE INDEX entry_index_media_timeline_idx
    ON entry_index (owner_id, created_at DESC, entry_id DESC)
    WHERE deleted_at IS NULL AND NOT buried AND category IN ('image', 'video');

CREATE INDEX entry_index_owner_trash_idx
    ON entry_index (owner_id, deleted_at DESC, entry_id)
    WHERE deleted_at IS NOT NULL;

CREATE TABLE folder_stats (
    folder_id UUID PRIMARY KEY REFERENCES drive_entries(id) ON DELETE CASCADE,
    owner_id UUID NOT NULL,
    total_bytes BIGINT NOT NULL DEFAULT 0 CHECK (total_bytes >= 0),
    file_count BIGINT NOT NULL DEFAULT 0 CHECK (file_count >= 0),
    subfolder_count BIGINT NOT NULL DEFAULT 0 CHECK (subfolder_count >= 0),
    by_category JSONB NOT NULL DEFAULT '{}'::jsonb,
    computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX folder_stats_owner_size_idx
    ON folder_stats (owner_id, total_bytes DESC, folder_id);

CREATE TABLE albums (
    id UUID PRIMARY KEY,
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (
        char_length(btrim(name)) BETWEEN 1 AND 120
        AND name = btrim(name)
    ),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX albums_owner_updated_idx
    ON albums (owner_id, updated_at DESC, id);

CREATE TABLE album_items (
    album_id UUID NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    file_id UUID NOT NULL REFERENCES drive_entries(id) ON DELETE CASCADE,
    added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (album_id, file_id)
);

CREATE INDEX album_items_added_idx
    ON album_items (album_id, added_at DESC, file_id);

CREATE FUNCTION entry_category(p_kind TEXT, p_mime TEXT) RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT CASE
        WHEN p_kind = 'folder' THEN 'folder'
        WHEN p_mime LIKE 'image/%' THEN 'image'
        WHEN p_mime LIKE 'video/%' THEN 'video'
        WHEN p_mime LIKE 'audio/%' THEN 'audio'
        WHEN p_mime LIKE 'text/%'
            OR p_mime IN (
                'application/pdf',
                'application/msword',
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                'application/vnd.ms-excel',
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                'application/vnd.ms-powerpoint',
                'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                'application/rtf',
                'application/json'
            ) THEN 'document'
        WHEN p_mime IN (
                'application/zip',
                'application/x-zip-compressed',
                'application/x-tar',
                'application/gzip',
                'application/x-gzip',
                'application/x-7z-compressed',
                'application/x-rar-compressed',
                'application/vnd.rar',
                'application/x-bzip2'
            ) THEN 'archive'
        ELSE 'other'
    END;
$$;

CREATE FUNCTION refresh_entry_index(p_id UUID) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    rec RECORD;
BEGIN
    SELECT entry.id, entry.owner_id, entry.parent_id, entry.kind, entry.name,
           entry.created_at, entry.updated_at, entry.deleted_at,
           version.size_bytes, object.mime_detected, derivative.width, derivative.height
      INTO rec
      FROM drive_entries AS entry
      LEFT JOIN files AS file ON file.id = entry.id
      LEFT JOIN file_versions AS version ON version.id = file.current_version_id
      LEFT JOIN storage_objects AS object ON object.id = version.storage_object_id
      LEFT JOIN LATERAL (
          SELECT media.width, media.height
            FROM media_derivatives AS media
           WHERE media.file_version_id = version.id
             AND media.variant IN ('viewer', 'video_poster', 'card')
             AND media.width IS NOT NULL
             AND media.height IS NOT NULL
           ORDER BY CASE media.variant
                        WHEN 'viewer' THEN 0
                        WHEN 'video_poster' THEN 1
                        ELSE 2
                    END
           LIMIT 1
      ) AS derivative ON TRUE
     WHERE entry.id = p_id;

    IF NOT FOUND THEN
        DELETE FROM entry_index WHERE entry_id = p_id;
        RETURN;
    END IF;

    INSERT INTO entry_index (
        entry_id, owner_id, parent_id, kind, name, name_normalized, mime_type, category,
        size_bytes, created_at, updated_at, deleted_at, media, indexed_at
    ) VALUES (
        rec.id, rec.owner_id, rec.parent_id, rec.kind, rec.name, lower(rec.name),
        rec.mime_detected, entry_category(rec.kind, rec.mime_detected),
        COALESCE(rec.size_bytes, 0), rec.created_at, rec.updated_at, rec.deleted_at,
        CASE
            WHEN rec.width IS NULL THEN '{}'::jsonb
            ELSE jsonb_build_object('width', rec.width, 'height', rec.height)
        END,
        now()
    )
    ON CONFLICT (entry_id) DO UPDATE SET
        owner_id = EXCLUDED.owner_id,
        parent_id = EXCLUDED.parent_id,
        kind = EXCLUDED.kind,
        name = EXCLUDED.name,
        name_normalized = EXCLUDED.name_normalized,
        mime_type = EXCLUDED.mime_type,
        category = EXCLUDED.category,
        size_bytes = EXCLUDED.size_bytes,
        created_at = EXCLUDED.created_at,
        updated_at = EXCLUDED.updated_at,
        deleted_at = EXCLUDED.deleted_at,
        media = CASE
            WHEN EXCLUDED.media = '{}'::jsonb THEN entry_index.media
            ELSE entry_index.media || EXCLUDED.media
        END,
        indexed_at = now();
END;
$$;

CREATE FUNCTION bury_descendants(p_root UUID, p_owner UUID) RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    WITH RECURSIVE subtree AS (
        SELECT id
          FROM drive_entries
         WHERE parent_id = p_root AND owner_id = p_owner
        UNION ALL
        SELECT child.id
          FROM drive_entries AS child
          JOIN subtree ON child.parent_id = subtree.id
         WHERE child.owner_id = p_owner
    )
    UPDATE entry_index
       SET buried = TRUE
     WHERE entry_id IN (SELECT id FROM subtree);
$$;

CREATE FUNCTION rebase_descendants(p_root UUID, p_owner UUID) RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    WITH RECURSIVE walk AS (
        SELECT id, deleted_at, FALSE AS ancestor_deleted
          FROM drive_entries
         WHERE id = p_root AND owner_id = p_owner
        UNION ALL
        SELECT child.id, child.deleted_at,
               walk.ancestor_deleted OR walk.deleted_at IS NOT NULL
          FROM drive_entries AS child
          JOIN walk ON child.parent_id = walk.id
         WHERE child.owner_id = p_owner
    )
    UPDATE entry_index AS idx
       SET buried = walk.ancestor_deleted
      FROM walk
     WHERE idx.entry_id = walk.id
       AND walk.id <> p_root;
$$;

CREATE FUNCTION sync_drive_entry_index() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    parent_hidden BOOLEAN := FALSE;
BEGIN
    PERFORM refresh_entry_index(NEW.id);

    IF TG_OP = 'UPDATE'
       AND NEW.parent_id IS NOT DISTINCT FROM OLD.parent_id
       AND NEW.deleted_at IS NOT DISTINCT FROM OLD.deleted_at THEN
        RETURN NEW;
    END IF;

    IF NEW.deleted_at IS NOT NULL THEN
        UPDATE entry_index SET buried = FALSE WHERE entry_id = NEW.id;
        PERFORM bury_descendants(NEW.id, NEW.owner_id);
        RETURN NEW;
    END IF;

    IF NEW.parent_id IS NOT NULL THEN
        SELECT COALESCE(parent_index.buried, FALSE) OR parent_entry.deleted_at IS NOT NULL
          INTO parent_hidden
          FROM drive_entries AS parent_entry
          LEFT JOIN entry_index AS parent_index ON parent_index.entry_id = parent_entry.id
         WHERE parent_entry.id = NEW.parent_id;
        parent_hidden := COALESCE(parent_hidden, FALSE);
    END IF;

    UPDATE entry_index SET buried = parent_hidden WHERE entry_id = NEW.id;
    PERFORM rebase_descendants(NEW.id, NEW.owner_id);
    RETURN NEW;
END;
$$;

CREATE TRIGGER drive_entries_index_sync
    AFTER INSERT OR UPDATE OF name, parent_id, kind, created_at, updated_at, deleted_at
    ON drive_entries
    FOR EACH ROW EXECUTE FUNCTION sync_drive_entry_index();

CREATE FUNCTION sync_file_index() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    PERFORM refresh_entry_index(NEW.id);
    RETURN NEW;
END;
$$;

CREATE TRIGGER files_index_sync
    AFTER INSERT OR UPDATE OF current_version_id ON files
    FOR EACH ROW EXECUTE FUNCTION sync_file_index();

CREATE FUNCTION sync_version_index() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    PERFORM refresh_entry_index(NEW.file_id);
    RETURN NEW;
END;
$$;

CREATE TRIGGER file_versions_index_sync
    AFTER INSERT OR UPDATE OF size_bytes, storage_object_id ON file_versions
    FOR EACH ROW EXECUTE FUNCTION sync_version_index();

CREATE FUNCTION sync_object_index() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    PERFORM refresh_entry_index(version.file_id)
       FROM file_versions AS version
      WHERE version.storage_object_id = NEW.id;
    RETURN NEW;
END;
$$;

CREATE TRIGGER storage_objects_index_sync
    AFTER UPDATE OF mime_detected, size_bytes, state ON storage_objects
    FOR EACH ROW EXECUTE FUNCTION sync_object_index();

CREATE FUNCTION sync_derivative_index() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    PERFORM refresh_entry_index(version.file_id)
       FROM file_versions AS version
      WHERE version.id = NEW.file_version_id;
    RETURN NEW;
END;
$$;

CREATE TRIGGER media_derivatives_index_sync
    AFTER INSERT OR UPDATE ON media_derivatives
    FOR EACH ROW EXECUTE FUNCTION sync_derivative_index();

CREATE FUNCTION refresh_folder_stats(p_owner UUID, p_parent UUID, p_children BOOLEAN) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    WITH children AS (
        SELECT id
          FROM drive_entries
         WHERE owner_id = p_owner
           AND kind = 'folder'
           AND deleted_at IS NULL
           AND (
                (p_children AND ((p_parent IS NULL AND parent_id IS NULL) OR parent_id = p_parent))
                OR (NOT p_children AND id = p_parent)
           )
    ),
    tree AS (
        SELECT child.id AS folder_id, entry.id AS node_id, entry.kind, 0 AS depth
          FROM children AS child
          JOIN drive_entries AS entry ON entry.id = child.id
        UNION ALL
        SELECT tree.folder_id, entry.id, entry.kind, tree.depth + 1
          FROM tree
          JOIN drive_entries AS entry ON entry.parent_id = tree.node_id
         WHERE entry.owner_id = p_owner
           AND entry.deleted_at IS NULL
           AND tree.depth < 40
    ),
    rolled AS (
        SELECT tree.folder_id,
               COALESCE(SUM(idx.size_bytes) FILTER (WHERE tree.kind = 'file'), 0)::BIGINT AS total_bytes,
               COUNT(*) FILTER (WHERE tree.kind = 'file')::BIGINT AS file_count,
               COUNT(*) FILTER (
                   WHERE tree.kind = 'folder' AND tree.node_id <> tree.folder_id
               )::BIGINT AS subfolder_count
          FROM tree
          LEFT JOIN entry_index AS idx ON idx.entry_id = tree.node_id
         GROUP BY tree.folder_id
    ),
    categories AS (
        SELECT tree.folder_id, idx.category, SUM(idx.size_bytes)::BIGINT AS bytes
          FROM tree
          JOIN entry_index AS idx ON idx.entry_id = tree.node_id
         WHERE tree.kind = 'file'
         GROUP BY tree.folder_id, idx.category
    )
    INSERT INTO folder_stats (
        folder_id, owner_id, total_bytes, file_count, subfolder_count, by_category, computed_at
    )
    SELECT rolled.folder_id,
           p_owner,
           rolled.total_bytes,
           rolled.file_count,
           rolled.subfolder_count,
           COALESCE((
               SELECT jsonb_object_agg(categories.category, categories.bytes)
                 FROM categories
                WHERE categories.folder_id = rolled.folder_id
           ), '{}'::jsonb),
           now()
      FROM rolled
    ON CONFLICT (folder_id) DO UPDATE SET
        owner_id = EXCLUDED.owner_id,
        total_bytes = EXCLUDED.total_bytes,
        file_count = EXCLUDED.file_count,
        subfolder_count = EXCLUDED.subfolder_count,
        by_category = EXCLUDED.by_category,
        computed_at = now();
END;
$$;

REVOKE ALL ON FUNCTION entry_category(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION refresh_entry_index(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION bury_descendants(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION rebase_descendants(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION sync_drive_entry_index() FROM PUBLIC;
REVOKE ALL ON FUNCTION sync_file_index() FROM PUBLIC;
REVOKE ALL ON FUNCTION sync_version_index() FROM PUBLIC;
REVOKE ALL ON FUNCTION sync_object_index() FROM PUBLIC;
REVOKE ALL ON FUNCTION sync_derivative_index() FROM PUBLIC;
REVOKE ALL ON FUNCTION refresh_folder_stats(UUID, UUID, BOOLEAN) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION entry_category(TEXT, TEXT) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION refresh_entry_index(UUID) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION bury_descendants(UUID, UUID) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION rebase_descendants(UUID, UUID) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION sync_drive_entry_index() TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION sync_file_index() TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION sync_version_index() TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION sync_object_index() TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION sync_derivative_index() TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION refresh_folder_stats(UUID, UUID, BOOLEAN) TO CURRENT_USER;

SELECT refresh_entry_index(id) FROM drive_entries;
SELECT bury_descendants(id, owner_id) FROM drive_entries WHERE deleted_at IS NOT NULL;

ALTER TABLE shares ADD COLUMN album_id UUID NULL REFERENCES albums(id) ON DELETE CASCADE;

ALTER TABLE shares ALTER COLUMN resource_id DROP NOT NULL;

DO $$
DECLARE
    constraint_name TEXT;
BEGIN
    SELECT con.conname INTO constraint_name
      FROM pg_constraint AS con
      JOIN pg_class AS rel ON rel.oid = con.conrelid
      JOIN pg_namespace AS nsp ON nsp.oid = rel.relnamespace
     WHERE nsp.nspname = 'public'
       AND rel.relname = 'shares'
       AND con.contype = 'c'
       AND pg_get_constraintdef(con.oid) ILIKE '%resource_type%';
    IF constraint_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE shares DROP CONSTRAINT %I', constraint_name);
    END IF;
END $$;

ALTER TABLE shares
    ADD CONSTRAINT shares_resource_type_check
        CHECK (resource_type IN ('file', 'folder', 'album')),
    ADD CONSTRAINT shares_resource_target_check CHECK (
        (
            resource_type IN ('file', 'folder')
            AND resource_id IS NOT NULL
            AND album_id IS NULL
        )
        OR (
            resource_type = 'album'
            AND album_id IS NOT NULL
            AND resource_id IS NULL
        )
    );

CREATE INDEX shares_album_idx ON shares (album_id) WHERE album_id IS NOT NULL;
