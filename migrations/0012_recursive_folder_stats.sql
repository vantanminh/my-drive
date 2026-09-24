-- Fix recursive folder-stat aggregation used by the drive listing and storage
-- analytics. The migration is separate because 0011 is already applied.
CREATE OR REPLACE FUNCTION refresh_folder_stats(p_owner UUID, p_parent UUID, p_children BOOLEAN) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    WITH RECURSIVE children AS (
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

REVOKE ALL ON FUNCTION refresh_folder_stats(UUID, UUID, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION refresh_folder_stats(UUID, UUID, BOOLEAN) TO CURRENT_USER;
