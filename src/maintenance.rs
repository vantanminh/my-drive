use std::time::Duration;

use sqlx::{FromRow, PgPool};
use thiserror::Error;
use tokio::time::{MissedTickBehavior, interval};
use uuid::Uuid;

use crate::storage::{LocalStorage, StorageError};

const BATCH_SIZE: i64 = 100;
const RUN_INTERVAL: Duration = Duration::from_secs(60 * 60);

#[derive(Clone, Copy)]
pub(crate) struct Settings {
    pub trash_retention_days: u64,
    pub upload_session_ttl_seconds: u64,
}

#[derive(Debug, Default)]
pub(crate) struct RunSummary {
    pub expired_uploads_cleaned: u64,
    pub expired_upload_cleanup_failures: u64,
    pub trash_roots_purged: u64,
    pub entries_purged: u64,
    pub storage_objects_removed: u64,
    pub storage_object_cleanup_failures: u64,
    pub missing_payloads: u64,
}

#[derive(Debug, Error)]
pub(crate) enum MaintenanceError {
    #[error("maintenance database operation failed: {0}")]
    Database(#[from] sqlx::Error),
    #[error("maintenance storage operation failed: {0}")]
    Storage(#[from] StorageError),
    #[error("maintenance retention value is outside the supported range")]
    RetentionOutOfRange,
    #[error("trash entry was not found")]
    NotFound,
}

#[derive(FromRow)]
struct ExpiredUpload {
    id: Uuid,
    staging_key: Uuid,
}

#[derive(FromRow)]
struct TrashEntry {
    id: Uuid,
    owner_id: Uuid,
    kind: String,
}

#[derive(FromRow)]
struct StorageObject {
    id: Uuid,
    storage_key: String,
}

pub(crate) async fn run_worker(pool: PgPool, storage: LocalStorage, settings: Settings) {
    let mut cadence = interval(RUN_INTERVAL);
    cadence.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        cadence.tick().await;
        match run_once(&pool, &storage, settings).await {
            Ok(summary) => {
                tracing::info!(
                    expired_uploads_cleaned = summary.expired_uploads_cleaned,
                    expired_upload_cleanup_failures = summary.expired_upload_cleanup_failures,
                    trash_roots_purged = summary.trash_roots_purged,
                    entries_purged = summary.entries_purged,
                    storage_objects_removed = summary.storage_objects_removed,
                    storage_object_cleanup_failures = summary.storage_object_cleanup_failures,
                    missing_payloads = summary.missing_payloads,
                    "storage maintenance pass completed"
                );
            }
            Err(error) => {
                tracing::error!(error = %error, "storage maintenance pass failed");
            }
        }
    }
}

pub(crate) async fn run_once(
    pool: &PgPool,
    storage: &LocalStorage,
    settings: Settings,
) -> Result<RunSummary, MaintenanceError> {
    storage.ensure_mounted()?;
    let trash_retention_days = i64::try_from(settings.trash_retention_days)
        .map_err(|_| MaintenanceError::RetentionOutOfRange)?;
    let upload_session_ttl_seconds = i64::try_from(settings.upload_session_ttl_seconds)
        .map_err(|_| MaintenanceError::RetentionOutOfRange)?;

    let mut summary = RunSummary::default();
    let (cleaned, failures) = clean_expired_uploads(pool, storage).await?;
    summary.expired_uploads_cleaned = cleaned;
    summary.expired_upload_cleanup_failures = failures;
    let (roots, entries) = purge_expired_trash(pool, trash_retention_days).await?;
    summary.trash_roots_purged = roots;
    summary.entries_purged = entries;
    let (removed, failures) =
        remove_unreferenced_objects(pool, storage, upload_session_ttl_seconds).await?;
    summary.storage_objects_removed = removed;
    summary.storage_object_cleanup_failures = failures;
    summary.missing_payloads = report_missing_payloads(pool, storage).await?;
    Ok(summary)
}

async fn clean_expired_uploads(
    pool: &PgPool,
    storage: &LocalStorage,
) -> Result<(u64, u64), MaintenanceError> {
    let mut transaction = pool.begin().await?;
    let uploads = sqlx::query_as::<_, ExpiredUpload>(
        "WITH candidates AS ( \
             SELECT id FROM upload_sessions \
              WHERE staging_cleaned_at IS NULL \
                AND ((state = 'active' AND expires_at <= now()) OR state IN ('expired', 'failed')) \
              ORDER BY expires_at ASC, id ASC \
              LIMIT $1 \
              FOR UPDATE SKIP LOCKED \
         ) \
         UPDATE upload_sessions AS upload \
            SET state = CASE WHEN upload.state = 'active' THEN 'expired' ELSE upload.state END, \
                updated_at = CASE WHEN upload.state = 'active' THEN now() ELSE upload.updated_at END \
           FROM candidates \
          WHERE upload.id = candidates.id \
         RETURNING upload.id, upload.staging_key",
    )
    .bind(BATCH_SIZE)
    .fetch_all(&mut *transaction)
    .await?;
    transaction.commit().await?;

    let mut cleaned = 0;
    let mut failures = 0;
    for upload in uploads {
        match storage.remove_staging_file(upload.staging_key).await {
            Ok(()) => {
                sqlx::query(
                    "UPDATE upload_sessions \
                        SET staging_cleaned_at = now() \
                      WHERE id = $1 AND staging_cleaned_at IS NULL \
                        AND state IN ('expired', 'failed')",
                )
                .bind(upload.id)
                .execute(pool)
                .await?;
                cleaned += 1;
            }
            Err(error) => {
                failures += 1;
                tracing::warn!(
                    upload_id = %upload.id,
                    error = %error,
                    "could not remove expired upload staging file; cleanup will retry"
                );
            }
        }
    }
    Ok((cleaned, failures))
}

async fn purge_expired_trash(
    pool: &PgPool,
    retention_days: i64,
) -> Result<(u64, u64), MaintenanceError> {
    let roots = sqlx::query_scalar::<_, Uuid>(
        "SELECT entry.id \
           FROM drive_entries AS entry \
           LEFT JOIN drive_entries AS parent ON parent.id = entry.parent_id \
          WHERE entry.deleted_at IS NOT NULL \
            AND entry.deleted_at <= now() - ($1::double precision * interval '1 day') \
            AND (entry.parent_id IS NULL OR parent.deleted_at IS NULL) \
          ORDER BY entry.deleted_at ASC, entry.id ASC \
          LIMIT $2",
    )
    .bind(retention_days)
    .bind(BATCH_SIZE)
    .fetch_all(pool)
    .await?;

    let mut purged_roots = 0;
    let mut purged_entries = 0;
    for root_id in roots {
        let mut transaction = pool.begin().await?;
        let root = sqlx::query_as::<_, (Uuid, Uuid)>(
            "SELECT id, owner_id FROM drive_entries \
              WHERE id = $1 \
                AND deleted_at <= now() - ($2::double precision * interval '1 day') \
              FOR UPDATE",
        )
        .bind(root_id)
        .bind(retention_days)
        .fetch_optional(&mut *transaction)
        .await?;
        let Some((root_id, owner_id)) = root else {
            transaction.rollback().await?;
            continue;
        };

        let entries = sqlx::query_as::<_, TrashEntry>(
            "WITH RECURSIVE subtree(id, owner_id, kind, depth) AS ( \
                 SELECT id, owner_id, kind, 0 \
                   FROM drive_entries \
                  WHERE id = $1 AND owner_id = $2 \
                 UNION ALL \
                 SELECT child.id, child.owner_id, child.kind, parent.depth + 1 \
                   FROM drive_entries AS child \
                   JOIN subtree AS parent ON child.parent_id = parent.id \
                  WHERE child.owner_id = $2 \
             ) \
             SELECT id, owner_id, kind FROM subtree ORDER BY depth DESC, id ASC",
        )
        .bind(root_id)
        .bind(owner_id)
        .fetch_all(&mut *transaction)
        .await?;
        if entries.is_empty() {
            transaction.rollback().await?;
            continue;
        }

        for entry in &entries {
            match entry.kind.as_str() {
                "file" => {
                    sqlx::query("DELETE FROM file_versions WHERE file_id = $1")
                        .bind(entry.id)
                        .execute(&mut *transaction)
                        .await?;
                    sqlx::query("DELETE FROM files WHERE id = $1")
                        .bind(entry.id)
                        .execute(&mut *transaction)
                        .await?;
                }
                "folder" => {
                    sqlx::query("DELETE FROM folders WHERE id = $1")
                        .bind(entry.id)
                        .execute(&mut *transaction)
                        .await?;
                }
                _ => unreachable!("drive_entries.kind is checked by PostgreSQL"),
            }
            sqlx::query("DELETE FROM drive_entries WHERE id = $1 AND owner_id = $2")
                .bind(entry.id)
                .bind(entry.owner_id)
                .execute(&mut *transaction)
                .await?;
        }
        sqlx::query(
            "INSERT INTO audit_events (event_type, resource_id, details) \
             VALUES ('entry_purged', $1, jsonb_build_object('entry_count', $2))",
        )
        .bind(root_id)
        .bind(i64::try_from(entries.len()).unwrap_or(i64::MAX))
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        purged_roots += 1;
        purged_entries += u64::try_from(entries.len()).unwrap_or(u64::MAX);
    }
    Ok((purged_roots, purged_entries))
}

#[derive(Debug)]
pub(crate) struct TrashPurgeReport {
    pub roots: u64,
    pub entries: u64,
}

pub(crate) async fn purge_trash_roots(
    pool: &PgPool,
    storage: &LocalStorage,
    owner_id: Uuid,
    actor_id: Uuid,
    only_ids: Option<&[Uuid]>,
) -> Result<TrashPurgeReport, MaintenanceError> {
    let mut report = TrashPurgeReport {
        roots: 0,
        entries: 0,
    };
    let roots = if let Some(ids) = only_ids {
        let mut unique = ids.to_vec();
        unique.sort();
        unique.dedup();
        if unique.is_empty() || unique.len() > 100 {
            return Err(MaintenanceError::NotFound);
        }
        let found = trash_roots(pool, owner_id, Some(&unique)).await?;
        if found.len() != unique.len() {
            return Err(MaintenanceError::NotFound);
        }
        found
    } else {
        Vec::new()
    };

    if only_ids.is_some() {
        for root_id in roots {
            record_purged_root(
                &mut report,
                purge_one_trash_root(pool, storage, owner_id, actor_id, root_id).await?,
            );
        }
        return Ok(report);
    }

    loop {
        if report.roots >= 5_000 {
            break;
        }
        let batch = trash_roots(pool, owner_id, None).await?;
        if batch.is_empty() {
            break;
        }
        let purged_before = report.roots;
        for root_id in batch {
            record_purged_root(
                &mut report,
                purge_one_trash_root(pool, storage, owner_id, actor_id, root_id).await?,
            );
        }
        if report.roots == purged_before {
            break;
        }
    }
    Ok(report)
}

fn record_purged_root(report: &mut TrashPurgeReport, entries: u64) {
    if entries > 0 {
        report.roots += 1;
        report.entries += entries;
    }
}

async fn trash_roots(
    pool: &PgPool,
    owner_id: Uuid,
    ids: Option<&[Uuid]>,
) -> Result<Vec<Uuid>, MaintenanceError> {
    let filter_ids = ids.is_some();
    let id_list = ids.unwrap_or(&[]);
    sqlx::query_scalar(
        "SELECT entry.id \
           FROM drive_entries AS entry \
           LEFT JOIN drive_entries AS parent ON parent.id = entry.parent_id \
          WHERE entry.owner_id = $1 \
            AND entry.deleted_at IS NOT NULL \
            AND (entry.parent_id IS NULL OR parent.deleted_at IS NULL) \
            AND (NOT $2 OR entry.id = ANY($3)) \
          ORDER BY entry.deleted_at ASC, entry.id ASC \
          LIMIT $4",
    )
    .bind(owner_id)
    .bind(filter_ids)
    .bind(id_list)
    .bind(if filter_ids { 100 } else { BATCH_SIZE })
    .fetch_all(pool)
    .await
    .map_err(MaintenanceError::Database)
}

async fn purge_one_trash_root(
    pool: &PgPool,
    storage: &LocalStorage,
    owner_id: Uuid,
    actor_id: Uuid,
    root_id: Uuid,
) -> Result<u64, MaintenanceError> {
    let mut transaction = pool.begin().await?;
    let locked: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM drive_entries \
          WHERE id = $1 AND owner_id = $2 AND deleted_at IS NOT NULL \
          FOR UPDATE",
    )
    .bind(root_id)
    .bind(owner_id)
    .fetch_optional(&mut *transaction)
    .await?;
    let Some(root_id) = locked else {
        transaction.rollback().await?;
        return Ok(0);
    };
    let entries = sqlx::query_as::<_, TrashEntry>(
        "WITH RECURSIVE subtree(id, owner_id, kind, depth) AS ( \
             SELECT id, owner_id, kind, 0 \
               FROM drive_entries \
              WHERE id = $1 AND owner_id = $2 \
             UNION ALL \
             SELECT child.id, child.owner_id, child.kind, parent.depth + 1 \
               FROM drive_entries AS child \
               JOIN subtree AS parent ON child.parent_id = parent.id \
              WHERE child.owner_id = $2 \
         ) \
         SELECT id, owner_id, kind FROM subtree ORDER BY depth DESC, id ASC",
    )
    .bind(root_id)
    .bind(owner_id)
    .fetch_all(&mut *transaction)
    .await?;
    if entries.is_empty() {
        transaction.rollback().await?;
        return Ok(0);
    }
    let object_ids = sqlx::query_scalar::<_, Uuid>(
        "SELECT DISTINCT version.storage_object_id \
           FROM file_versions AS version \
          WHERE version.file_id = ANY($1)",
    )
    .bind(entries.iter().map(|entry| entry.id).collect::<Vec<_>>())
    .fetch_all(&mut *transaction)
    .await?;

    for entry in &entries {
        match entry.kind.as_str() {
            "file" => {
                sqlx::query("DELETE FROM file_versions WHERE file_id = $1")
                    .bind(entry.id)
                    .execute(&mut *transaction)
                    .await?;
                sqlx::query("DELETE FROM files WHERE id = $1")
                    .bind(entry.id)
                    .execute(&mut *transaction)
                    .await?;
            }
            "folder" => {
                sqlx::query("DELETE FROM folders WHERE id = $1")
                    .bind(entry.id)
                    .execute(&mut *transaction)
                    .await?;
            }
            _ => unreachable!("drive_entries.kind is checked by PostgreSQL"),
        }
        sqlx::query("DELETE FROM drive_entries WHERE id = $1 AND owner_id = $2")
            .bind(entry.id)
            .bind(entry.owner_id)
            .execute(&mut *transaction)
            .await?;
    }
    sqlx::query(
        "INSERT INTO audit_events (event_type, actor_id, resource_id, details) \
         VALUES ('entry_purged', $1, $2, jsonb_build_object('entry_count', $3, 'immediate', true))",
    )
    .bind(actor_id)
    .bind(root_id)
    .bind(i64::try_from(entries.len()).unwrap_or(i64::MAX))
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;

    if let Err(error) = delete_unreferenced_objects(pool, storage, &object_ids).await {
        tracing::warn!(
            error = %error,
            root_id = %root_id,
            "permanent trash delete removed metadata; payload cleanup will retry"
        );
    }
    Ok(u64::try_from(entries.len()).unwrap_or(u64::MAX))
}

async fn delete_unreferenced_objects(
    pool: &PgPool,
    storage: &LocalStorage,
    object_ids: &[Uuid],
) -> Result<(), MaintenanceError> {
    if object_ids.is_empty() {
        return Ok(());
    }
    let objects = sqlx::query_as::<_, StorageObject>(
        "UPDATE storage_objects AS object SET state = 'deleting' \
          WHERE object.id = ANY($1) \
            AND NOT EXISTS ( \
                SELECT 1 FROM file_versions AS version \
                 WHERE version.storage_object_id = object.id \
            ) \
            AND NOT EXISTS ( \
                SELECT 1 FROM upload_sessions AS upload \
                 WHERE upload.storage_object_id = object.id \
                   AND upload.state = 'finalizing' \
            ) \
        RETURNING object.id, object.storage_key",
    )
    .bind(object_ids)
    .fetch_all(pool)
    .await?;
    for object in objects {
        storage.remove_object(&object.storage_key).await?;
        sqlx::query(
            "DELETE FROM storage_objects AS object \
              WHERE object.id = $1 AND object.state = 'deleting' \
                AND NOT EXISTS ( \
                    SELECT 1 FROM file_versions AS version \
                     WHERE version.storage_object_id = object.id \
                )",
        )
        .bind(object.id)
        .execute(pool)
        .await?;
    }
    Ok(())
}

async fn remove_unreferenced_objects(
    pool: &PgPool,
    storage: &LocalStorage,
    upload_session_ttl_seconds: i64,
) -> Result<(u64, u64), MaintenanceError> {
    let mut transaction = pool.begin().await?;
    let objects = sqlx::query_as::<_, StorageObject>(
        "WITH candidates AS ( \
             SELECT object.id \
               FROM storage_objects AS object \
              WHERE object.state IN ('pending', 'ready', 'failed', 'deleting') \
                AND (object.state = 'deleting' OR object.created_at <= \
                     now() - ($1::double precision * interval '1 second')) \
                AND NOT EXISTS ( \
                    SELECT 1 FROM file_versions AS version \
                     WHERE version.storage_object_id = object.id \
                ) \
                AND NOT EXISTS ( \
                    SELECT 1 FROM upload_sessions AS upload \
                     WHERE upload.storage_object_id = object.id \
                       AND upload.state = 'finalizing' \
                ) \
              ORDER BY (object.state = 'deleting') DESC, object.created_at ASC, object.id ASC \
              LIMIT $2 \
              FOR UPDATE SKIP LOCKED \
         ) \
         UPDATE storage_objects AS object SET state = 'deleting' \
           FROM candidates \
          WHERE object.id = candidates.id \
         RETURNING object.id, object.storage_key",
    )
    .bind(upload_session_ttl_seconds)
    .bind(BATCH_SIZE)
    .fetch_all(&mut *transaction)
    .await?;
    transaction.commit().await?;

    let mut removed = 0;
    let mut failures = 0;
    for object in objects {
        if let Err(error) = storage.remove_object(&object.storage_key).await {
            failures += 1;
            tracing::warn!(
                storage_object_id = %object.id,
                error = %error,
                "could not remove unreferenced payload; cleanup will retry"
            );
            continue;
        }
        let result = sqlx::query(
            "DELETE FROM storage_objects AS object \
              WHERE object.id = $1 AND object.state = 'deleting' \
                AND NOT EXISTS ( \
                    SELECT 1 FROM file_versions AS version \
                     WHERE version.storage_object_id = object.id \
                ) \
                AND NOT EXISTS ( \
                    SELECT 1 FROM upload_sessions AS upload \
                     WHERE upload.storage_object_id = object.id \
                       AND upload.state = 'finalizing' \
                )",
        )
        .bind(object.id)
        .execute(pool)
        .await?;
        if result.rows_affected() == 1 {
            removed += 1;
        } else {
            failures += 1;
            tracing::warn!(
                storage_object_id = %object.id,
                "unreferenced payload metadata changed during cleanup; deletion will retry"
            );
        }
    }
    Ok((removed, failures))
}

async fn report_missing_payloads(
    pool: &PgPool,
    storage: &LocalStorage,
) -> Result<u64, MaintenanceError> {
    let mut transaction = pool.begin().await?;
    let objects = sqlx::query_as::<_, StorageObject>(
        "SELECT id, storage_key FROM storage_objects \
          WHERE state = 'ready' \
            AND (last_checked_at IS NULL OR last_checked_at <= now() - interval '1 day') \
          ORDER BY last_checked_at ASC NULLS FIRST, created_at ASC, id ASC \
          LIMIT $1 \
          FOR UPDATE SKIP LOCKED",
    )
    .bind(BATCH_SIZE)
    .fetch_all(&mut *transaction)
    .await?;

    let mut ids = Vec::with_capacity(objects.len());
    let mut missing = Vec::new();
    for object in objects {
        ids.push(object.id);
        if !storage.object_exists(&object.storage_key).await? {
            missing.push(object);
        }
    }
    if !ids.is_empty() {
        sqlx::query("UPDATE storage_objects SET last_checked_at = now() WHERE id = ANY($1)")
            .bind(&ids)
            .execute(&mut *transaction)
            .await?;
    }
    transaction.commit().await?;

    for object in &missing {
        tracing::error!(
            storage_object_id = %object.id,
            storage_key = %object.storage_key,
            "ready storage payload is missing; metadata was preserved"
        );
    }
    Ok(u64::try_from(missing.len()).unwrap_or(u64::MAX))
}
