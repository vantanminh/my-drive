-- Media indexing and photo-library browsing are scoped to the per-account
-- system Photos folder. The recursive function is evaluated against live
-- drive_entries rows, so moving or copying a folder into Photos makes its
-- current media eligible without a separate rescan request.
CREATE FUNCTION photos_entry_ids(p_owner UUID) RETURNS SETOF UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    WITH RECURSIVE tree AS (
        SELECT root.id
          FROM drive_entries AS root
         WHERE root.owner_id = p_owner
           AND root.system_role = 'photos'
           AND root.deleted_at IS NULL
        UNION ALL
        SELECT child.id
          FROM drive_entries AS child
          JOIN tree AS parent ON child.parent_id = parent.id
         WHERE child.owner_id = p_owner
           AND child.deleted_at IS NULL
    )
    SELECT id FROM tree;
$$;

REVOKE ALL ON FUNCTION photos_entry_ids(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION photos_entry_ids(UUID) TO CURRENT_USER;

-- No-argument variant for worker-wide backfill queries. Keeping the recursive
-- walk uncorrelated avoids re-walking every user's Photos tree once per row.
CREATE FUNCTION photos_entry_pairs() RETURNS TABLE(owner_id UUID, entry_id UUID)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    WITH RECURSIVE tree AS (
        SELECT root.owner_id, root.id AS entry_id
          FROM drive_entries AS root
         WHERE root.system_role = 'photos'
           AND root.deleted_at IS NULL
        UNION ALL
        SELECT child.owner_id, child.id AS entry_id
          FROM drive_entries AS child
          JOIN tree AS parent ON child.parent_id = parent.entry_id
         WHERE child.owner_id = parent.owner_id
           AND child.deleted_at IS NULL
    )
    SELECT owner_id, entry_id FROM tree;
$$;

REVOKE ALL ON FUNCTION photos_entry_pairs() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION photos_entry_pairs() TO CURRENT_USER;
