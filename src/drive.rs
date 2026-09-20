use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use thiserror::Error;
use uuid::Uuid;

use crate::{
    auth::{AuthenticatedUser, require_csrf},
    health::AppState,
};

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
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SearchQuery {
    q: String,
    limit: Option<u16>,
    offset: Option<u32>,
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
    Router::new()
        .route("/api/drive", get(list_folder))
        .route("/api/drive/search", get(search))
        .route("/api/drive/trash", get(list_trash))
        .route("/api/folders", post(create_folder))
        .route("/api/entries/{id}", get(get_entry).delete(trash_entry))
        .route("/api/entries/{id}/rename", patch(rename_entry))
        .route("/api/entries/{id}/move", post(move_entry))
        .route("/api/entries/{id}/restore", post(restore_entry))
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
    )?;
    let sql = format!(
        "SELECT e.id, e.parent_id, e.kind, e.name, e.created_at, e.updated_at, e.deleted_at, \
                fv.size_bytes, so.mime_detected \
           FROM drive_entries AS e \
           LEFT JOIN files AS f ON f.id = e.id \
           LEFT JOIN file_versions AS fv ON fv.id = f.current_version_id \
           LEFT JOIN storage_objects AS so ON so.id = fv.storage_object_id \
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
    )?;
    let sql = format!(
        "SELECT e.id, e.parent_id, e.kind, e.name, e.created_at, e.updated_at, e.deleted_at, \
                fv.size_bytes, so.mime_detected \
           FROM drive_entries AS e \
           LEFT JOIN files AS f ON f.id = e.id \
           LEFT JOIN file_versions AS fv ON fv.id = f.current_version_id \
           LEFT JOIN storage_objects AS so ON so.id = fv.storage_object_id \
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

async fn search(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Query(query): Query<SearchQuery>,
) -> Result<Json<EntryPage>, DriveError> {
    let term = query.q.trim();
    if term.is_empty() || term.chars().count() > 255 {
        return Err(DriveError::BadRequest);
    }
    let limit = page_limit(query.limit)?;
    let offset = page_offset(query.offset)?;
    let mut entries = sqlx::query_as::<_, EntrySummary>(
        "WITH RECURSIVE visible_entries(id) AS ( \
             SELECT id FROM drive_entries WHERE owner_id = $1 AND parent_id IS NULL AND deleted_at IS NULL \
             UNION ALL \
             SELECT child.id FROM drive_entries AS child \
             JOIN visible_entries AS parent ON child.parent_id = parent.id \
             WHERE child.owner_id = $1 AND child.deleted_at IS NULL \
         ) \
         SELECT e.id, e.parent_id, e.kind, e.name, e.created_at, e.updated_at, e.deleted_at, \
                fv.size_bytes, so.mime_detected \
           FROM drive_entries AS e \
           JOIN visible_entries AS visible ON visible.id = e.id \
           LEFT JOIN files AS f ON f.id = e.id \
           LEFT JOIN file_versions AS fv ON fv.id = f.current_version_id \
           LEFT JOIN storage_objects AS so ON so.id = fv.storage_object_id \
          WHERE e.owner_id = $1 AND position(lower($2) in lower(e.name)) > 0 \
          ORDER BY lower(e.name) ASC, e.id ASC \
          LIMIT $3 OFFSET $4",
    )
    .bind(user.id)
    .bind(term)
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
    if let Some(parent_id) = request.parent_id {
        ensure_active_entry(&state, user.id, parent_id, true).await?;
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
    let updated = sqlx::query(
        "UPDATE drive_entries SET deleted_at = now(), updated_at = now() WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL",
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
    .bind(user.id)
    .execute(&mut *transaction)
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
    .bind(user.id)
    .execute(&mut *transaction)
    .await
    .map_err(map_database_error)?;
    sqlx::query(
        "INSERT INTO audit_events (event_type, actor_id, resource_id) VALUES ('entry_trashed', $1, $2)",
    )
    .bind(user.id)
    .bind(id)
    .execute(&mut *transaction)
    .await
    .map_err(map_database_error)?;
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

async fn fetch_entry(
    state: &AppState,
    owner_id: Uuid,
    id: Uuid,
) -> Result<EntrySummary, DriveError> {
    sqlx::query_as::<_, EntrySummary>(
        "WITH RECURSIVE parent_chain(id, parent_id, deleted_at) AS ( \
             SELECT id, parent_id, deleted_at FROM drive_entries WHERE id = $1 AND owner_id = $2 \
             UNION ALL \
             SELECT parent.id, parent.parent_id, parent.deleted_at \
               FROM drive_entries AS parent \
               JOIN parent_chain AS child ON parent.id = child.parent_id \
              WHERE parent.owner_id = $2 \
         ) \
         SELECT e.id, e.parent_id, e.kind, e.name, e.created_at, e.updated_at, e.deleted_at, \
                fv.size_bytes, so.mime_detected \
           FROM drive_entries AS e \
           LEFT JOIN files AS f ON f.id = e.id \
           LEFT JOIN file_versions AS fv ON fv.id = f.current_version_id \
           LEFT JOIN storage_objects AS so ON so.id = fv.storage_object_id \
          WHERE e.id = $1 AND e.owner_id = $2 AND e.deleted_at IS NULL \
            AND NOT EXISTS (SELECT 1 FROM parent_chain WHERE deleted_at IS NOT NULL)",
    )
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
) -> Result<(&'static str, &'static str), DriveError> {
    let column = match sort_by.unwrap_or(default_sort) {
        "name" => "lower(e.name)",
        "created_at" => "e.created_at",
        "updated_at" => "e.updated_at",
        "deleted_at" => "e.deleted_at",
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
            sort_parts(Some("updated_at"), Some("desc"), "name", "asc").unwrap(),
            ("e.updated_at", "DESC")
        );
        assert_eq!(
            sort_parts(None, None, "deleted_at", "desc").unwrap(),
            ("e.deleted_at", "DESC")
        );
        assert!(sort_parts(Some("name; DROP TABLE users"), None, "name", "asc").is_err());
    }
}
