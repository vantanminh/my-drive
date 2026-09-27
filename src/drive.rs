use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool, Postgres, Transaction};
use thiserror::Error;
use uuid::Uuid;

use crate::{
    auth::{AuthenticatedUser, require_csrf},
    health::AppState,
};

const ENTRY_COLUMNS: &str = "e.id, e.parent_id, e.kind, e.name, e.created_at, e.updated_at, e.deleted_at, \
    fv.size_bytes, so.mime_detected, idx.category, stats.total_bytes AS folder_bytes, \
    stats.file_count AS folder_file_count, stats.subfolder_count AS folder_subfolder_count, \
    e.system_role";
const ENTRY_JOINS: &str = "LEFT JOIN files AS f ON f.id = e.id \
    LEFT JOIN file_versions AS fv ON fv.id = f.current_version_id \
    LEFT JOIN storage_objects AS so ON so.id = fv.storage_object_id \
    LEFT JOIN entry_index AS idx ON idx.entry_id = e.id \
    LEFT JOIN folder_stats AS stats ON stats.folder_id = e.id";

const DEFAULT_PAGE_SIZE: u16 = 100;
const MAX_PAGE_SIZE: u16 = 200;
const MAX_OFFSET: u32 = 1_000_000;

#[derive(Debug, Error)]
pub(crate) enum DriveError {
    #[error("invalid request")]
    BadRequest,
    #[error("entry not found")]
    NotFound,
    #[error("name or move conflicts with an existing entry")]
    Conflict,
    #[error("system folder cannot be changed")]
    Protected,
    #[error("CSRF validation failed")]
    Csrf,
    #[error("database operation failed")]
    Database(#[source] sqlx::Error),
}

impl IntoResponse for DriveError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            Self::BadRequest => (StatusCode::BAD_REQUEST, "invalid_request"),
            Self::NotFound => (StatusCode::NOT_FOUND, "not_found"),
            Self::Conflict => (StatusCode::CONFLICT, "conflict"),
            Self::Protected => (StatusCode::CONFLICT, "protected_entry"),
            Self::Csrf => (StatusCode::FORBIDDEN, "csrf_failed"),
            Self::Database(error) => {
                tracing::error!(error = %error, "drive database operation failed");
                (StatusCode::SERVICE_UNAVAILABLE, "service_unavailable")
            }
        };
        let mut response = (status, Json(ErrorBody { error: message })).into_response();
        response.headers_mut().insert(
            axum::http::header::CACHE_CONTROL,
            axum::http::HeaderValue::from_static("no-store"),
        );
        response
    }
}

#[derive(Serialize)]
struct ErrorBody {
    error: &'static str,
}

#[derive(Serialize, FromRow)]
struct EntrySummary {
    id: Uuid,
    parent_id: Option<Uuid>,
    kind: String,
    name: String,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    deleted_at: Option<DateTime<Utc>>,
    size_bytes: Option<i64>,
    mime_detected: Option<String>,
    category: Option<String>,
    folder_bytes: Option<i64>,
    folder_file_count: Option<i64>,
    folder_subfolder_count: Option<i64>,
    system_role: Option<String>,
}

#[derive(Serialize)]
struct EntryPage {
    entries: Vec<EntrySummary>,
    limit: u16,
    next_offset: Option<u32>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ListQuery {
    parent_id: Option<Uuid>,
    limit: Option<u16>,
    offset: Option<u32>,
    sort_by: Option<String>,
    order: Option<String>,
    include_stats: Option<bool>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateFolder {
    name: String,
    parent_id: Option<Uuid>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RenameEntry {
    name: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MoveEntry {
    parent_id: Option<Uuid>,
}

pub(crate) fn router() -> Router<AppState> {
    router_at("/api")
}

pub(crate) fn router_at(prefix: &str) -> Router<AppState> {
    let p = |path: &str| format!("{prefix}{}", path.strip_prefix("/api").unwrap());
    Router::new()
        .route(&p("/api/drive"), get(list_folder))
        .route(&p("/api/drive/trash"), get(list_trash))
        .route(&p("/api/drive/trash/purge"), post(purge_trash))
        .route(&p("/api/drive/batch"), post(batch_entries))
        .route(&p("/api/folders"), post(create_folder))
        .route(&p("/api/entries/{id}"), get(get_entry).delete(trash_entry))
        .route(&p("/api/entries/{id}/rename"), patch(rename_entry))
        .route(&p("/api/entries/{id}/move"), post(move_entry))
        .route(&p("/api/entries/{id}/restore"), post(restore_entry))
        .layer(DefaultBodyLimit::max(16 * 1024))
}

async fn list_folder(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Query(query): Query<ListQuery>,
) -> Result<Json<EntryPage>, DriveError> {
    if let Some(parent_id) = query.parent_id {
        ensure_active_entry(&state, user.id, parent_id, true).await?;
    }
    let limit = page_limit(query.limit)?;
    let offset = page_offset(query.offset)?;
    let (sort_column, direction) = sort_parts(
        query.sort_by.as_deref(),
        query.order.as_deref(),
        "name",
        "asc",
        true,
    )?;
    if query.include_stats.unwrap_or(false) || query.sort_by.as_deref() == Some("size") {
        sqlx::query("SELECT refresh_folder_stats($1, $2, TRUE)")
            .bind(user.id)
            .bind(query.parent_id)
            .execute(&state.pool)
            .await
            .map_err(map_database_error)?;
    }
    let sql = format!(
        "SELECT {ENTRY_COLUMNS} \
           FROM drive_entries AS e \
           {ENTRY_JOINS} \
          WHERE e.owner_id = $1 AND e.deleted_at IS NULL \
            AND (($2::UUID IS NULL AND e.parent_id IS NULL) OR e.parent_id = $2) \
          ORDER BY {sort_column} {direction}, e.id ASC \
          LIMIT $3 OFFSET $4"
    );
    let mut entries = sqlx::query_as::<_, EntrySummary>(&sql)
        .bind(user.id)
        .bind(query.parent_id)
        .bind(i64::from(limit) + 1)
        .bind(i64::from(offset))
        .fetch_all(&state.pool)
        .await
        .map_err(map_database_error)?;
    let has_more = entries.len() > usize::from(limit);
    entries.truncate(usize::from(limit));
    Ok(Json(EntryPage {
        entries,
        limit,
        next_offset: has_more.then_some(offset + u32::from(limit)),
    }))
}

async fn list_trash(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Query(query): Query<ListQuery>,
) -> Result<Json<EntryPage>, DriveError> {
    if query.parent_id.is_some() {
        return Err(DriveError::BadRequest);
    }
    let limit = page_limit(query.limit)?;
    let offset = page_offset(query.offset)?;
    let (sort_column, direction) = sort_parts(
        query.sort_by.as_deref(),
        query.order.as_deref(),
        "deleted_at",
        "desc",
        false,
    )?;
    let sql = format!(
        "SELECT {ENTRY_COLUMNS} \
           FROM drive_entries AS e \
           {ENTRY_JOINS} \
          WHERE e.owner_id = $1 AND e.deleted_at IS NOT NULL \
          ORDER BY {sort_column} {direction}, e.id ASC \
          LIMIT $2 OFFSET $3"
    );
    let mut entries = sqlx::query_as::<_, EntrySummary>(&sql)
        .bind(user.id)
        .bind(i64::from(limit) + 1)
        .bind(i64::from(offset))
        .fetch_all(&state.pool)
        .await
        .map_err(map_database_error)?;
    let has_more = entries.len() > usize::from(limit);
    entries.truncate(usize::from(limit));
    Ok(Json(EntryPage {
        entries,
        limit,
        next_offset: has_more.then_some(offset + u32::from(limit)),
    }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PurgeTrash {
    ids: Option<Vec<Uuid>>,
    all: Option<bool>,
}

#[derive(Serialize)]
struct PurgeTrashResponse {
    roots: u64,
    entries: u64,
}

async fn purge_trash(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
    Json(request): Json<PurgeTrash>,
) -> Result<Json<PurgeTrashResponse>, DriveError> {
    require_request_csrf(&headers, &user, state.auth_settings)?;
    let report = if request.all.unwrap_or(false) {
        crate::maintenance::purge_trash_roots(&state.pool, &state.storage, user.id, user.id, None)
            .await
    } else if let Some(ids) = request.ids.as_deref() {
        crate::maintenance::purge_trash_roots(
            &state.pool,
            &state.storage,
            user.id,
            user.id,
            Some(ids),
        )
        .await
    } else {
        return Err(DriveError::BadRequest);
    }
    .map_err(|error| match error {
        crate::maintenance::MaintenanceError::NotFound => DriveError::NotFound,
        crate::maintenance::MaintenanceError::Database(error) => map_database_error(error),
        other => {
            tracing::error!(error = %other, "permanent trash delete failed");
            DriveError::Database(sqlx::Error::Protocol(other.to_string()))
        }
    })?;
    Ok(Json(PurgeTrashResponse {
        roots: report.roots,
        entries: report.entries,
    }))
}

async fn create_folder(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
    Json(request): Json<CreateFolder>,
) -> Result<(StatusCode, Json<EntrySummary>), DriveError> {
    require_request_csrf(&headers, &user, state.auth_settings)?;
    let name = normalize_name(&request.name)?;
    if let Some(parent_id) = request.parent_id {
        ensure_active_entry(&state, user.id, parent_id, true).await?;
    }

    let id = Uuid::new_v4();
    let mut transaction = state.pool.begin().await.map_err(map_database_error)?;
    sqlx::query(
        "INSERT INTO drive_entries (id, owner_id, parent_id, kind, name) VALUES ($1, $2, $3, 'folder', $4)",
    )
    .bind(id)
    .bind(user.id)
    .bind(request.parent_id)
    .bind(name)
    .execute(&mut *transaction)
    .await
    .map_err(map_database_error)?;
    sqlx::query("INSERT INTO folders (id) VALUES ($1)")
        .bind(id)
        .execute(&mut *transaction)
        .await
        .map_err(map_database_error)?;
    transaction.commit().await.map_err(map_database_error)?;
    let entry = fetch_entry(&state, user.id, id).await?;
    Ok((StatusCode::CREATED, Json(entry)))
}

async fn get_entry(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Path(id): Path<Uuid>,
) -> Result<Json<EntrySummary>, DriveError> {
    Ok(Json(fetch_entry(&state, user.id, id).await?))
}

async fn rename_entry(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(request): Json<RenameEntry>,
) -> Result<Json<EntrySummary>, DriveError> {
    require_request_csrf(&headers, &user, state.auth_settings)?;
    let name = normalize_name(&request.name)?;
    ensure_active_entry(&state, user.id, id, false).await?;
    ensure_mutable_entry(&state.pool, user.id, id).await?;
    sqlx::query(
        "UPDATE drive_entries SET name = $1, updated_at = now() WHERE id = $2 AND owner_id = $3 AND deleted_at IS NULL",
    )
    .bind(name)
    .bind(id)
    .bind(user.id)
    .execute(&state.pool)
    .await
    .map_err(map_database_error)?;
    Ok(Json(fetch_entry(&state, user.id, id).await?))
}

async fn move_entry(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(request): Json<MoveEntry>,
) -> Result<Json<EntrySummary>, DriveError> {
    require_request_csrf(&headers, &user, state.auth_settings)?;
    ensure_active_entry(&state, user.id, id, false).await?;
    ensure_mutable_entry(&state.pool, user.id, id).await?;
    if let Some(parent_id) = request.parent_id {
        ensure_active_entry(&state, user.id, parent_id, true).await?;
        if parent_id == id || folder_contains(&state.pool, user.id, id, parent_id).await? {
            return Err(DriveError::Conflict);
        }
    }
    sqlx::query(
        "UPDATE drive_entries SET parent_id = $1, updated_at = now() WHERE id = $2 AND owner_id = $3 AND deleted_at IS NULL",
    )
    .bind(request.parent_id)
    .bind(id)
    .bind(user.id)
    .execute(&state.pool)
    .await
    .map_err(map_database_error)?;
    Ok(Json(fetch_entry(&state, user.id, id).await?))
}

async fn trash_entry(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, DriveError> {
    require_request_csrf(&headers, &user, state.auth_settings)?;
    ensure_active_entry(&state, user.id, id, false).await?;
    let mut transaction = state.pool.begin().await.map_err(map_database_error)?;
    trash_owned_entry(&mut transaction, user.id, id).await?;
    transaction.commit().await.map_err(map_database_error)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn restore_entry(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<EntrySummary>, DriveError> {
    require_request_csrf(&headers, &user, state.auth_settings)?;
    let parent_id: Option<Uuid> = sqlx::query_scalar(
        "SELECT parent_id FROM drive_entries WHERE id = $1 AND owner_id = $2 AND deleted_at IS NOT NULL",
    )
    .bind(id)
    .bind(user.id)
    .fetch_optional(&state.pool)
    .await
    .map_err(map_database_error)?
    .ok_or(DriveError::NotFound)?;
    if let Some(parent_id) = parent_id {
        ensure_active_entry(&state, user.id, parent_id, true).await?;
    }
    let mut transaction = state.pool.begin().await.map_err(map_database_error)?;
    let updated = sqlx::query(
        "UPDATE drive_entries SET deleted_at = NULL, updated_at = now() WHERE id = $1 AND owner_id = $2 AND deleted_at IS NOT NULL",
    )
    .bind(id)
    .bind(user.id)
    .execute(&mut *transaction)
    .await
    .map_err(map_database_error)?;
    if updated.rows_affected() != 1 {
        return Err(DriveError::NotFound);
    }
    sqlx::query(
        "INSERT INTO audit_events (event_type, actor_id, resource_id) VALUES ('entry_restored', $1, $2)",
    )
    .bind(user.id)
    .bind(id)
    .execute(&mut *transaction)
    .await
    .map_err(map_database_error)?;
    transaction.commit().await.map_err(map_database_error)?;
    Ok(Json(fetch_entry(&state, user.id, id).await?))
}

const MAX_BATCH_ENTRIES: usize = 100;
const MAX_COPY_ENTRIES: u32 = 500;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BatchRequest {
    action: String,
    ids: Vec<Uuid>,
    parent_id: Option<Uuid>,
}

#[derive(Serialize)]
struct BatchResponse {
    action: String,
    count: usize,
    entry_ids: Vec<Uuid>,
}

async fn batch_entries(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
    Json(request): Json<BatchRequest>,
) -> Result<Json<BatchResponse>, DriveError> {
    require_request_csrf(&headers, &user, state.auth_settings)?;
    if request.ids.is_empty() || request.ids.len() > MAX_BATCH_ENTRIES {
        return Err(DriveError::BadRequest);
    }
    let mut unique = request.ids.clone();
    unique.sort();
    unique.dedup();
    if unique.len() != request.ids.len() {
        return Err(DriveError::BadRequest);
    }
    match request.action.as_str() {
        "move" | "copy" | "trash" => {}
        _ => return Err(DriveError::BadRequest),
    }
    if request.action == "trash" {
        if request.parent_id.is_some() {
            return Err(DriveError::BadRequest);
        }
    } else if let Some(parent_id) = request.parent_id {
        ensure_active_entry(&state, user.id, parent_id, true).await?;
        if request.ids.contains(&parent_id) {
            return Err(DriveError::BadRequest);
        }
    }
    let mut transaction = state.pool.begin().await.map_err(map_database_error)?;
    let mut entry_ids = Vec::with_capacity(request.ids.len());
    let mut copied = 0_u32;
    for id in &request.ids {
        match request.action.as_str() {
            "trash" => {
                trash_owned_entry(&mut transaction, user.id, *id).await?;
                entry_ids.push(*id);
            }
            "move" => {
                move_owned_entry(&mut transaction, user.id, *id, request.parent_id).await?;
                entry_ids.push(*id);
            }
            "copy" => {
                let new_id = copy_owned_entry(
                    &mut transaction,
                    user.id,
                    *id,
                    request.parent_id,
                    true,
                    0,
                    &mut copied,
                )
                .await?;
                entry_ids.push(new_id);
            }
            _ => return Err(DriveError::BadRequest),
        }
    }
    transaction.commit().await.map_err(map_database_error)?;
    Ok(Json(BatchResponse {
        action: request.action,
        count: entry_ids.len(),
        entry_ids,
    }))
}

async fn trash_owned_entry(
    transaction: &mut Transaction<'_, Postgres>,
    owner_id: Uuid,
    id: Uuid,
) -> Result<(), DriveError> {
    ensure_mutable_entry_tx(transaction, owner_id, id).await?;
    let updated = sqlx::query(
        "UPDATE drive_entries SET deleted_at = now(), updated_at = now() WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL",
    )
    .bind(id)
    .bind(owner_id)
    .execute(&mut **transaction)
    .await
    .map_err(map_database_error)?;
    if updated.rows_affected() != 1 {
        return Err(DriveError::NotFound);
    }
    sqlx::query(
        "WITH RECURSIVE subtree(id) AS ( \
             SELECT id FROM drive_entries WHERE id = $1 AND owner_id = $2 \
             UNION ALL \
             SELECT child.id FROM drive_entries AS child \
             JOIN subtree AS parent ON child.parent_id = parent.id \
             WHERE child.owner_id = $2 \
         ) \
         UPDATE shares SET revoked_at = COALESCE(revoked_at, now()) \
          WHERE owner_id = $2 AND resource_id IN (SELECT id FROM subtree)",
    )
    .bind(id)
    .bind(owner_id)
    .execute(&mut **transaction)
    .await
    .map_err(map_database_error)?;
    sqlx::query(
        "WITH RECURSIVE subtree(id) AS ( \
             SELECT id FROM drive_entries WHERE id = $1 AND owner_id = $2 \
             UNION ALL \
             SELECT child.id FROM drive_entries AS child \
             JOIN subtree AS parent ON child.parent_id = parent.id \
             WHERE child.owner_id = $2 \
         ) \
         DELETE FROM share_access_sessions AS access \
          USING shares AS share \
          WHERE access.share_id = share.id AND share.owner_id = $2 \
            AND share.resource_id IN (SELECT id FROM subtree)",
    )
    .bind(id)
    .bind(owner_id)
    .execute(&mut **transaction)
    .await
    .map_err(map_database_error)?;
    sqlx::query(
        "INSERT INTO audit_events (event_type, actor_id, resource_id) VALUES ('entry_trashed', $1, $2)",
    )
    .bind(owner_id)
    .bind(id)
    .execute(&mut **transaction)
    .await
    .map_err(map_database_error)?;
    Ok(())
}

async fn move_owned_entry(
    transaction: &mut Transaction<'_, Postgres>,
    owner_id: Uuid,
    id: Uuid,
    parent_id: Option<Uuid>,
) -> Result<(), DriveError> {
    ensure_mutable_entry_tx(transaction, owner_id, id).await?;
    if let Some(parent_id) = parent_id
        && (parent_id == id || folder_contains_tx(transaction, owner_id, id, parent_id).await?)
    {
        return Err(DriveError::Conflict);
    }
    let updated = sqlx::query(
        "UPDATE drive_entries SET parent_id = $1, updated_at = now() \
          WHERE id = $2 AND owner_id = $3 AND deleted_at IS NULL",
    )
    .bind(parent_id)
    .bind(id)
    .bind(owner_id)
    .execute(&mut **transaction)
    .await
    .map_err(map_database_error)?;
    if updated.rows_affected() != 1 {
        return Err(DriveError::NotFound);
    }
    Ok(())
}

struct CopyJob {
    source_id: Uuid,
    parent_id: Option<Uuid>,
    rename: bool,
    depth: u32,
}

async fn copy_owned_entry(
    transaction: &mut Transaction<'_, Postgres>,
    owner_id: Uuid,
    source_id: Uuid,
    parent_id: Option<Uuid>,
    rename: bool,
    depth: u32,
    copied: &mut u32,
) -> Result<Uuid, DriveError> {
    let mut pending = vec![CopyJob {
        source_id,
        parent_id,
        rename,
        depth,
    }];
    let mut root_id = None;
    while let Some(job) = pending.pop() {
        let (new_id, children) = copy_one_entry(transaction, owner_id, &job, copied).await?;
        if root_id.is_none() {
            root_id = Some(new_id);
        }
        for child_id in children.into_iter().rev() {
            pending.push(CopyJob {
                source_id: child_id,
                parent_id: Some(new_id),
                rename: false,
                depth: job.depth.saturating_add(1),
            });
        }
    }
    root_id.ok_or(DriveError::BadRequest)
}

async fn copy_one_entry(
    transaction: &mut Transaction<'_, Postgres>,
    owner_id: Uuid,
    job: &CopyJob,
    copied: &mut u32,
) -> Result<(Uuid, Vec<Uuid>), DriveError> {
    if job.depth > 40 {
        return Err(DriveError::BadRequest);
    }
    *copied = copied.saturating_add(1);
    if *copied > MAX_COPY_ENTRIES {
        return Err(DriveError::BadRequest);
    }
    let source = sqlx::query_as::<_, CopySource>(
        "SELECT kind, name, system_role FROM drive_entries \
          WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL",
    )
    .bind(job.source_id)
    .bind(owner_id)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(map_database_error)?
    .ok_or(DriveError::NotFound)?;
    if source.system_role.is_some() {
        return Err(DriveError::Protected);
    }
    let name = if job.rename {
        available_copy_name(
            transaction,
            owner_id,
            job.parent_id,
            &source.name,
            source.kind == "file",
        )
        .await?
    } else {
        source.name.clone()
    };
    let new_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO drive_entries (id, owner_id, parent_id, kind, name) VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(new_id)
    .bind(owner_id)
    .bind(job.parent_id)
    .bind(&source.kind)
    .bind(&name)
    .execute(&mut **transaction)
    .await
    .map_err(map_database_error)?;
    let children = if source.kind == "folder" {
        sqlx::query("INSERT INTO folders (id) VALUES ($1)")
            .bind(new_id)
            .execute(&mut **transaction)
            .await
            .map_err(map_database_error)?;
        sqlx::query_scalar(
            "SELECT id FROM drive_entries \
              WHERE owner_id = $1 AND parent_id = $2 AND deleted_at IS NULL \
              ORDER BY kind DESC, lower(name), id",
        )
        .bind(owner_id)
        .bind(job.source_id)
        .fetch_all(&mut **transaction)
        .await
        .map_err(map_database_error)?
    } else {
        sqlx::query("INSERT INTO files (id) VALUES ($1)")
            .bind(new_id)
            .execute(&mut **transaction)
            .await
            .map_err(map_database_error)?;
        let version = sqlx::query_as::<_, CopyVersion>(
            "SELECT version.storage_object_id, version.size_bytes, object.mime_detected \
               FROM files AS file \
               JOIN file_versions AS version ON version.id = file.current_version_id \
               JOIN storage_objects AS object ON object.id = version.storage_object_id \
              WHERE file.id = $1",
        )
        .bind(job.source_id)
        .fetch_optional(&mut **transaction)
        .await
        .map_err(map_database_error)?;
        if let Some(version) = version {
            let version_id = Uuid::new_v4();
            sqlx::query(
                "INSERT INTO file_versions (id, file_id, storage_object_id, size_bytes) \
                 VALUES ($1, $2, $3, $4)",
            )
            .bind(version_id)
            .bind(new_id)
            .bind(version.storage_object_id)
            .bind(version.size_bytes)
            .execute(&mut **transaction)
            .await
            .map_err(map_database_error)?;
            sqlx::query("UPDATE files SET current_version_id = $1 WHERE id = $2")
                .bind(version_id)
                .bind(new_id)
                .execute(&mut **transaction)
                .await
                .map_err(map_database_error)?;
            crate::transfers::enqueue_media_index_jobs(
                transaction,
                version_id,
                version.mime_detected.as_deref(),
            )
            .await
            .map_err(map_database_error)?;
        }
        Vec::new()
    };
    sqlx::query(
        "INSERT INTO audit_events (event_type, actor_id, resource_id, details) \
         VALUES ('entry_copied', $1, $2, jsonb_build_object('source_id', $3))",
    )
    .bind(owner_id)
    .bind(new_id)
    .bind(job.source_id)
    .execute(&mut **transaction)
    .await
    .map_err(map_database_error)?;
    Ok((new_id, children))
}

#[derive(FromRow)]
struct CopySource {
    kind: String,
    name: String,
    system_role: Option<String>,
}

#[derive(FromRow)]
struct CopyVersion {
    storage_object_id: Uuid,
    size_bytes: i64,
    mime_detected: Option<String>,
}

async fn available_copy_name(
    transaction: &mut Transaction<'_, Postgres>,
    owner_id: Uuid,
    parent_id: Option<Uuid>,
    original: &str,
    is_file: bool,
) -> Result<String, DriveError> {
    for attempt in 1..=40 {
        let candidate = copy_display_name(original, attempt, is_file);
        let taken: bool = sqlx::query_scalar(
            "SELECT EXISTS ( \
                SELECT 1 FROM drive_entries \
                 WHERE owner_id = $1 AND deleted_at IS NULL \
                   AND (($2::UUID IS NULL AND parent_id IS NULL) OR parent_id = $2) \
                   AND lower(name) = lower($3) \
             )",
        )
        .bind(owner_id)
        .bind(parent_id)
        .bind(&candidate)
        .fetch_one(&mut **transaction)
        .await
        .map_err(map_database_error)?;
        if !taken {
            return Ok(candidate);
        }
    }
    Err(DriveError::Conflict)
}

fn copy_display_name(original: &str, attempt: u32, is_file: bool) -> String {
    let suffix = if attempt <= 1 {
        " copy".to_owned()
    } else {
        format!(" copy {attempt}")
    };
    let (stem, extension) = if is_file {
        match original.rfind('.') {
            Some(index) if index > 0 && original.len() - index <= 12 => {
                (&original[..index], &original[index..])
            }
            _ => (original, ""),
        }
    } else {
        (original, "")
    };
    let mut name = format!("{stem}{suffix}{extension}");
    if name.chars().count() > 255 {
        let extra = suffix.chars().count() + extension.chars().count();
        let budget = 255usize.saturating_sub(extra).max(1);
        let shortened: String = stem.chars().take(budget).collect();
        name = format!("{shortened}{suffix}{extension}");
    }
    name
}

pub(crate) async fn ensure_photos_folder(
    pool: &PgPool,
    owner_id: Uuid,
) -> Result<Uuid, DriveError> {
    for _ in 0..4 {
        if let Some(id) = photos_folder_id(pool, owner_id).await? {
            return Ok(id);
        }
        let mut transaction = pool.begin().await.map_err(map_database_error)?;
        if let Some(id) = photos_folder_id_tx(&mut transaction, owner_id).await? {
            transaction.commit().await.map_err(map_database_error)?;
            return Ok(id);
        }
        let adopted: Option<Uuid> = sqlx::query_scalar(
            "SELECT id FROM drive_entries \
              WHERE owner_id = $1 AND parent_id IS NULL AND kind = 'folder' AND deleted_at IS NULL \
                AND system_role IS NULL \
                AND lower(name) IN ('photos', 'pictures', 'photos library') \
              ORDER BY CASE lower(name) WHEN 'photos' THEN 0 WHEN 'pictures' THEN 1 ELSE 2 END, id \
              LIMIT 1 \
              FOR UPDATE",
        )
        .bind(owner_id)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(map_database_error)?;
        if let Some(id) = adopted {
            let updated = sqlx::query(
                "UPDATE drive_entries SET system_role = 'photos', updated_at = now() \
                  WHERE id = $1 AND owner_id = $2 AND system_role IS NULL AND deleted_at IS NULL",
            )
            .bind(id)
            .bind(owner_id)
            .execute(&mut *transaction)
            .await
            .map_err(map_database_error)?;
            if updated.rows_affected() == 1 {
                transaction.commit().await.map_err(map_database_error)?;
                return Ok(id);
            }
            transaction.rollback().await.map_err(map_database_error)?;
            continue;
        }
        let name = next_photos_folder_name(&mut transaction, owner_id).await?;
        let id = Uuid::new_v4();
        let inserted = sqlx::query(
            "INSERT INTO drive_entries (id, owner_id, parent_id, kind, name, system_role) \
             VALUES ($1, $2, NULL, 'folder', $3, 'photos')",
        )
        .bind(id)
        .bind(owner_id)
        .bind(&name)
        .execute(&mut *transaction)
        .await;
        if let Err(error) = inserted {
            let mapped = map_database_error(error);
            transaction.rollback().await.ok();
            if matches!(mapped, DriveError::Conflict) {
                continue;
            }
            return Err(mapped);
        }
        sqlx::query("INSERT INTO folders (id) VALUES ($1)")
            .bind(id)
            .execute(&mut *transaction)
            .await
            .map_err(map_database_error)?;
        transaction.commit().await.map_err(map_database_error)?;
        return Ok(id);
    }
    Err(DriveError::Conflict)
}

async fn photos_folder_id(pool: &PgPool, owner_id: Uuid) -> Result<Option<Uuid>, DriveError> {
    sqlx::query_scalar(
        "SELECT id FROM drive_entries \
          WHERE owner_id = $1 AND system_role = 'photos' AND deleted_at IS NULL \
          LIMIT 1",
    )
    .bind(owner_id)
    .fetch_optional(pool)
    .await
    .map_err(map_database_error)
}

async fn photos_folder_id_tx(
    transaction: &mut Transaction<'_, Postgres>,
    owner_id: Uuid,
) -> Result<Option<Uuid>, DriveError> {
    sqlx::query_scalar(
        "SELECT id FROM drive_entries \
          WHERE owner_id = $1 AND system_role = 'photos' AND deleted_at IS NULL \
          LIMIT 1",
    )
    .bind(owner_id)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(map_database_error)
}

async fn next_photos_folder_name(
    transaction: &mut Transaction<'_, Postgres>,
    owner_id: Uuid,
) -> Result<String, DriveError> {
    for name in ["Photos", "Pictures", "Photos Library"] {
        let taken: bool = sqlx::query_scalar(
            "SELECT EXISTS ( \
                SELECT 1 FROM drive_entries \
                 WHERE owner_id = $1 AND parent_id IS NULL AND deleted_at IS NULL \
                   AND lower(name) = lower($2) \
             )",
        )
        .bind(owner_id)
        .bind(name)
        .fetch_one(&mut **transaction)
        .await
        .map_err(map_database_error)?;
        if !taken {
            return Ok(name.to_owned());
        }
    }
    Err(DriveError::Conflict)
}

async fn ensure_mutable_entry(pool: &PgPool, owner_id: Uuid, id: Uuid) -> Result<(), DriveError> {
    let protected: Option<bool> = sqlx::query_scalar(
        "SELECT system_role IS NOT NULL FROM drive_entries \
          WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL",
    )
    .bind(id)
    .bind(owner_id)
    .fetch_optional(pool)
    .await
    .map_err(map_database_error)?;
    match protected {
        Some(true) => Err(DriveError::Protected),
        Some(false) => Ok(()),
        None => Err(DriveError::NotFound),
    }
}

async fn ensure_mutable_entry_tx(
    transaction: &mut Transaction<'_, Postgres>,
    owner_id: Uuid,
    id: Uuid,
) -> Result<(), DriveError> {
    let protected: Option<bool> = sqlx::query_scalar(
        "SELECT system_role IS NOT NULL FROM drive_entries \
          WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL",
    )
    .bind(id)
    .bind(owner_id)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(map_database_error)?;
    match protected {
        Some(true) => Err(DriveError::Protected),
        Some(false) => Ok(()),
        None => Err(DriveError::NotFound),
    }
}

async fn folder_contains(
    pool: &PgPool,
    owner_id: Uuid,
    folder_id: Uuid,
    candidate_id: Uuid,
) -> Result<bool, DriveError> {
    folder_contains_query(pool, owner_id, folder_id, candidate_id).await
}

async fn folder_contains_tx(
    transaction: &mut Transaction<'_, Postgres>,
    owner_id: Uuid,
    folder_id: Uuid,
    candidate_id: Uuid,
) -> Result<bool, DriveError> {
    sqlx::query_scalar(
        "WITH RECURSIVE descendants(id) AS ( \
             SELECT id FROM drive_entries WHERE id = $1 AND owner_id = $2 AND kind = 'folder' \
             UNION ALL \
             SELECT child.id FROM drive_entries AS child \
             JOIN descendants AS parent ON child.parent_id = parent.id \
             WHERE child.owner_id = $2 AND child.deleted_at IS NULL \
         ) \
         SELECT EXISTS (SELECT 1 FROM descendants WHERE id = $3)",
    )
    .bind(folder_id)
    .bind(owner_id)
    .bind(candidate_id)
    .fetch_one(&mut **transaction)
    .await
    .map_err(map_database_error)
}

async fn folder_contains_query(
    pool: &PgPool,
    owner_id: Uuid,
    folder_id: Uuid,
    candidate_id: Uuid,
) -> Result<bool, DriveError> {
    sqlx::query_scalar(
        "WITH RECURSIVE descendants(id) AS ( \
             SELECT id FROM drive_entries WHERE id = $1 AND owner_id = $2 AND kind = 'folder' \
             UNION ALL \
             SELECT child.id FROM drive_entries AS child \
             JOIN descendants AS parent ON child.parent_id = parent.id \
             WHERE child.owner_id = $2 AND child.deleted_at IS NULL \
         ) \
         SELECT EXISTS (SELECT 1 FROM descendants WHERE id = $3)",
    )
    .bind(folder_id)
    .bind(owner_id)
    .bind(candidate_id)
    .fetch_one(pool)
    .await
    .map_err(map_database_error)
}

async fn fetch_entry(
    state: &AppState,
    owner_id: Uuid,
    id: Uuid,
) -> Result<EntrySummary, DriveError> {
    sqlx::query_as::<_, EntrySummary>(&format!(
        "WITH RECURSIVE parent_chain(id, parent_id, deleted_at) AS ( \
             SELECT id, parent_id, deleted_at FROM drive_entries WHERE id = $1 AND owner_id = $2 \
             UNION ALL \
             SELECT parent.id, parent.parent_id, parent.deleted_at \
               FROM drive_entries AS parent \
               JOIN parent_chain AS child ON parent.id = child.parent_id \
              WHERE parent.owner_id = $2 \
         ) \
         SELECT {ENTRY_COLUMNS} \
           FROM drive_entries AS e \
           {ENTRY_JOINS} \
          WHERE e.id = $1 AND e.owner_id = $2 AND e.deleted_at IS NULL \
            AND NOT EXISTS (SELECT 1 FROM parent_chain WHERE deleted_at IS NOT NULL)"
    ))
    .bind(id)
    .bind(owner_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(map_database_error)?
    .ok_or(DriveError::NotFound)
}

pub(crate) async fn ensure_active_entry(
    state: &AppState,
    owner_id: Uuid,
    id: Uuid,
    require_folder: bool,
) -> Result<(), DriveError> {
    let active = sqlx::query_scalar::<_, bool>(
        "WITH RECURSIVE parent_chain(id, parent_id, deleted_at, kind) AS ( \
             SELECT id, parent_id, deleted_at, kind FROM drive_entries WHERE id = $1 AND owner_id = $2 \
             UNION ALL \
             SELECT parent.id, parent.parent_id, parent.deleted_at, parent.kind \
               FROM drive_entries AS parent \
               JOIN parent_chain AS child ON parent.id = child.parent_id \
              WHERE parent.owner_id = $2 \
         ) \
         SELECT EXISTS (SELECT 1 FROM parent_chain WHERE id = $1 AND deleted_at IS NULL \
                        AND (NOT $3 OR kind = 'folder')) \
            AND NOT EXISTS (SELECT 1 FROM parent_chain WHERE deleted_at IS NOT NULL)",
    )
    .bind(id)
    .bind(owner_id)
    .bind(require_folder)
    .fetch_one(&state.pool)
    .await
    .map_err(map_database_error)?;
    if active {
        Ok(())
    } else {
        Err(DriveError::NotFound)
    }
}

pub(crate) fn require_request_csrf(
    headers: &HeaderMap,
    user: &AuthenticatedUser,
    settings: crate::auth::AuthSettings,
) -> Result<(), DriveError> {
    if require_csrf(headers, user, settings) {
        Ok(())
    } else {
        Err(DriveError::Csrf)
    }
}

pub(crate) fn normalize_name(value: &str) -> Result<String, DriveError> {
    let name = value.trim();
    let length = name.chars().count();
    if length == 0
        || length > 255
        || name == "."
        || name == ".."
        || name
            .chars()
            .any(|character| character.is_control() || character == '/' || character == '\\')
    {
        return Err(DriveError::BadRequest);
    }
    Ok(name.to_owned())
}

fn page_limit(limit: Option<u16>) -> Result<u16, DriveError> {
    let limit = limit.unwrap_or(DEFAULT_PAGE_SIZE);
    if limit == 0 || limit > MAX_PAGE_SIZE {
        return Err(DriveError::BadRequest);
    }
    Ok(limit)
}

fn page_offset(offset: Option<u32>) -> Result<u32, DriveError> {
    let offset = offset.unwrap_or(0);
    if offset > MAX_OFFSET {
        return Err(DriveError::BadRequest);
    }
    Ok(offset)
}

fn sort_parts(
    sort_by: Option<&str>,
    order: Option<&str>,
    default_sort: &'static str,
    default_order: &'static str,
    folder_stats: bool,
) -> Result<(&'static str, &'static str), DriveError> {
    let column = match sort_by.unwrap_or(default_sort) {
        "name" => "lower(e.name)",
        "created_at" => "e.created_at",
        "updated_at" => "e.updated_at",
        "deleted_at" => "e.deleted_at",
        "size" if folder_stats => "COALESCE(stats.total_bytes, fv.size_bytes, 0)",
        "size" => "COALESCE(fv.size_bytes, 0)",
        _ => return Err(DriveError::BadRequest),
    };
    let direction = match order.unwrap_or(default_order) {
        "asc" => "ASC",
        "desc" => "DESC",
        _ => return Err(DriveError::BadRequest),
    };
    Ok((column, direction))
}

fn map_database_error(error: sqlx::Error) -> DriveError {
    match &error {
        sqlx::Error::Database(database_error) => match database_error.code().as_deref() {
            Some("23505") | Some("23514") => DriveError::Conflict,
            Some("23503") => DriveError::NotFound,
            _ => DriveError::Database(error),
        },
        _ => DriveError::Database(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folder_names_are_metadata_and_cannot_become_paths() {
        assert_eq!(normalize_name("  photos ").unwrap(), "photos");
        for invalid in ["", " ", ".", "..", "../secret", "a/b", r"a\b", "bad\nname"] {
            assert!(
                normalize_name(invalid).is_err(),
                "accepted invalid name {invalid:?}"
            );
        }
    }

    #[test]
    fn pagination_and_sorting_have_hard_limits_and_safe_columns() {
        assert_eq!(page_limit(None).unwrap(), DEFAULT_PAGE_SIZE);
        assert_eq!(page_limit(Some(200)).unwrap(), 200);
        assert!(page_limit(Some(0)).is_err());
        assert!(page_limit(Some(201)).is_err());
        assert_eq!(page_offset(Some(MAX_OFFSET)).unwrap(), MAX_OFFSET);
        assert!(page_offset(Some(MAX_OFFSET + 1)).is_err());
        assert_eq!(
            sort_parts(Some("updated_at"), Some("desc"), "name", "asc", true).unwrap(),
            ("e.updated_at", "DESC")
        );
        assert_eq!(
            sort_parts(None, None, "deleted_at", "desc", false).unwrap(),
            ("e.deleted_at", "DESC")
        );
        assert!(sort_parts(Some("name; DROP TABLE users"), None, "name", "asc", true).is_err());
    }
}
