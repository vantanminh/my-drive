use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, StatusCode, header::CACHE_CONTROL},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};
use thiserror::Error;
use uuid::Uuid;

use crate::{
    auth::{AuthenticatedUser, require_csrf},
    health::AppState,
};

const DEFAULT_PAGE_SIZE: u16 = 50;
const MAX_PAGE_SIZE: u16 = 100;
const MAX_OFFSET: u32 = 1_000_000;
const MAX_MERGE_SOURCES: usize = 64;
const MAX_LABEL_CHARS: usize = 80;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/faces", get(list_faces))
        .route("/api/faces/{cluster_id}", patch(rename_face))
        .route("/api/faces/merge", post(merge_faces))
        .route("/api/admin/faces", get(list_admin_faces))
        .layer(DefaultBodyLimit::max(16 * 1024))
}

#[derive(Debug, Error)]
enum FaceError {
    #[error("invalid request")]
    BadRequest,
    #[error("face cluster not found")]
    NotFound,
    #[error("CSRF validation failed")]
    Csrf,
    #[error("owner permission required")]
    Forbidden,
    #[error("database operation failed")]
    Database(#[source] sqlx::Error),
}

impl IntoResponse for FaceError {
    fn into_response(self) -> Response {
        let (status, code) = match self {
            Self::BadRequest => (StatusCode::BAD_REQUEST, "invalid_request"),
            Self::NotFound => (StatusCode::NOT_FOUND, "not_found"),
            Self::Csrf => (StatusCode::FORBIDDEN, "csrf_failed"),
            Self::Forbidden => (StatusCode::FORBIDDEN, "forbidden"),
            Self::Database(error) => {
                tracing::error!(error = %error, "face index database operation failed");
                (StatusCode::SERVICE_UNAVAILABLE, "service_unavailable")
            }
        };
        let mut response = (status, Json(ErrorBody { error: code })).into_response();
        response.headers_mut().insert(
            CACHE_CONTROL,
            "no-store".parse().expect("static header is valid"),
        );
        response
    }
}

#[derive(Serialize)]
struct ErrorBody {
    error: &'static str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FaceListQuery {
    limit: Option<u16>,
    offset: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AdminFaceListQuery {
    owner_id: Option<Uuid>,
    limit: Option<u16>,
    offset: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RenameRequest {
    label: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MergeRequest {
    target_id: Uuid,
    source_ids: Vec<Uuid>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FacePage {
    clusters: Vec<FaceClusterResponse>,
    limit: u16,
    next_offset: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AdminFacePage {
    clusters: Vec<AdminFaceClusterResponse>,
    limit: u16,
    next_offset: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FaceClusterResponse {
    id: Uuid,
    label: Option<String>,
    face_count: i64,
    asset_count: i64,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AdminFaceClusterResponse {
    id: Uuid,
    owner_id: Uuid,
    owner_email: String,
    label: Option<String>,
    face_count: i64,
    asset_count: i64,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MergeResponse {
    target_id: Uuid,
    merged_clusters: u64,
    moved_faces: u64,
}

#[derive(FromRow)]
struct FaceClusterRow {
    id: Uuid,
    owner_id: Uuid,
    owner_email: String,
    label: Option<String>,
    face_count: i64,
    asset_count: i64,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

async fn list_faces(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Query(query): Query<FaceListQuery>,
) -> Result<Response, FaceError> {
    let (limit, offset) = page_bounds(query.limit, query.offset)?;
    let mut rows = fetch_clusters(&state.pool, Some(user.id), limit, offset).await?;
    let has_more = rows.len() > usize::from(limit);
    rows.truncate(usize::from(limit));
    let next_offset = has_more.then_some(offset + u32::from(limit));
    let response = FacePage {
        clusters: rows.into_iter().map(FaceClusterResponse::from).collect(),
        limit,
        next_offset,
    };
    Ok(no_store(Json(response)))
}

async fn list_admin_faces(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Query(query): Query<AdminFaceListQuery>,
) -> Result<Response, FaceError> {
    require_owner(&user)?;
    let (limit, offset) = page_bounds(query.limit, query.offset)?;
    let mut rows = fetch_clusters(&state.pool, query.owner_id, limit, offset).await?;
    let has_more = rows.len() > usize::from(limit);
    rows.truncate(usize::from(limit));
    let next_offset = has_more.then_some(offset + u32::from(limit));
    let response = AdminFacePage {
        clusters: rows
            .into_iter()
            .map(AdminFaceClusterResponse::from)
            .collect(),
        limit,
        next_offset,
    };
    Ok(no_store(Json(response)))
}

async fn fetch_clusters(
    pool: &PgPool,
    owner_id: Option<Uuid>,
    limit: u16,
    offset: u32,
) -> Result<Vec<FaceClusterRow>, FaceError> {
    sqlx::query_as::<_, FaceClusterRow>(
        "SELECT cluster.id, cluster.owner_id, owner.email AS owner_email, cluster.label, \
                COUNT(observation.id) FILTER (WHERE entry.id IS NOT NULL)::BIGINT AS face_count, \
                COUNT(DISTINCT observation.file_version_id) FILTER (WHERE entry.id IS NOT NULL)::BIGINT AS asset_count, \
                cluster.created_at, cluster.updated_at \
           FROM face_clusters AS cluster \
           JOIN users AS owner ON owner.id = cluster.owner_id \
           LEFT JOIN face_observations AS observation ON observation.cluster_id = cluster.id \
           LEFT JOIN file_versions AS version ON version.id = observation.file_version_id \
           LEFT JOIN drive_entries AS entry ON entry.id = version.file_id \
                AND entry.deleted_at IS NULL AND entry.kind = 'file' \
          WHERE ($1::UUID IS NULL OR cluster.owner_id = $1) \
          GROUP BY cluster.id, owner.email \
          ORDER BY cluster.updated_at DESC, cluster.id DESC \
          LIMIT $2 OFFSET $3",
    )
    .bind(owner_id)
    .bind(i64::from(limit) + 1)
    .bind(i64::from(offset))
    .fetch_all(pool)
    .await
    .map_err(FaceError::Database)
}

async fn rename_face(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
    Path(cluster_id): Path<Uuid>,
    Json(request): Json<RenameRequest>,
) -> Result<Response, FaceError> {
    if !require_csrf(&headers, &user, state.auth_settings) {
        return Err(FaceError::Csrf);
    }
    let label = normalize_label(request.label)?;
    let mut transaction = state.pool.begin().await.map_err(FaceError::Database)?;
    let result = sqlx::query(
        "UPDATE face_clusters SET label = $1, updated_at = now() \
           WHERE id = $2 AND owner_id = $3",
    )
    .bind(&label)
    .bind(cluster_id)
    .bind(user.id)
    .execute(&mut *transaction)
    .await
    .map_err(FaceError::Database)?;
    if result.rows_affected() != 1 {
        return Err(FaceError::NotFound);
    }
    sqlx::query(
        "INSERT INTO audit_events (event_type, actor_id, resource_id, details) \
         VALUES ('face_cluster_renamed', $1, $2, jsonb_build_object('label', $3))",
    )
    .bind(user.id)
    .bind(cluster_id)
    .bind(&label)
    .execute(&mut *transaction)
    .await
    .map_err(FaceError::Database)?;
    transaction.commit().await.map_err(FaceError::Database)?;
    Ok(no_store(Json(serde_json::json!({
        "id": cluster_id,
        "label": label,
    }))))
}

async fn merge_faces(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
    Json(request): Json<MergeRequest>,
) -> Result<Response, FaceError> {
    if !require_csrf(&headers, &user, state.auth_settings) {
        return Err(FaceError::Csrf);
    }
    validate_merge_request(&request)?;

    let mut transaction = state.pool.begin().await.map_err(FaceError::Database)?;
    let target_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM face_clusters WHERE id = $1 AND owner_id = $2)",
    )
    .bind(request.target_id)
    .bind(user.id)
    .fetch_one(&mut *transaction)
    .await
    .map_err(FaceError::Database)?;
    if !target_exists {
        return Err(FaceError::NotFound);
    }

    let owned_source_ids: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM face_clusters \
           WHERE owner_id = $1 AND id = ANY($2::UUID[]) \
           ORDER BY id FOR UPDATE",
    )
    .bind(user.id)
    .bind(&request.source_ids)
    .fetch_all(&mut *transaction)
    .await
    .map_err(FaceError::Database)?;
    if owned_source_ids.len() != request.source_ids.len() {
        return Err(FaceError::NotFound);
    }

    let moved_faces = sqlx::query(
        "UPDATE face_observations SET cluster_id = $1 \
           WHERE cluster_id = ANY($2::UUID[])",
    )
    .bind(request.target_id)
    .bind(&request.source_ids)
    .execute(&mut *transaction)
    .await
    .map_err(FaceError::Database)?
    .rows_affected();
    let merged_clusters = sqlx::query(
        "DELETE FROM face_clusters \
           WHERE owner_id = $1 AND id = ANY($2::UUID[])",
    )
    .bind(user.id)
    .bind(&request.source_ids)
    .execute(&mut *transaction)
    .await
    .map_err(FaceError::Database)?
    .rows_affected();
    sqlx::query("UPDATE face_clusters SET updated_at = now() WHERE id = $1")
        .bind(request.target_id)
        .execute(&mut *transaction)
        .await
        .map_err(FaceError::Database)?;
    sqlx::query(
        "INSERT INTO audit_events (event_type, actor_id, resource_id, details) \
         VALUES ('face_clusters_merged', $1, $2, jsonb_build_object('source_ids', $3::jsonb, 'moved_faces', $4))",
    )
    .bind(user.id)
    .bind(request.target_id)
    .bind(serde_json::to_string(&request.source_ids).map_err(|_| FaceError::BadRequest)?)
    .bind(i64::try_from(moved_faces).unwrap_or(i64::MAX))
    .execute(&mut *transaction)
    .await
    .map_err(FaceError::Database)?;
    transaction.commit().await.map_err(FaceError::Database)?;

    Ok(no_store(Json(MergeResponse {
        target_id: request.target_id,
        merged_clusters,
        moved_faces,
    })))
}

fn require_owner(user: &AuthenticatedUser) -> Result<(), FaceError> {
    if user.role == "owner" {
        Ok(())
    } else {
        Err(FaceError::Forbidden)
    }
}

fn page_bounds(limit: Option<u16>, offset: Option<u32>) -> Result<(u16, u32), FaceError> {
    let limit = limit.unwrap_or(DEFAULT_PAGE_SIZE);
    let offset = offset.unwrap_or(0);
    if limit == 0 || limit > MAX_PAGE_SIZE || offset > MAX_OFFSET {
        return Err(FaceError::BadRequest);
    }
    Ok((limit, offset))
}

fn normalize_label(label: Option<String>) -> Result<Option<String>, FaceError> {
    label
        .map(|value| {
            let trimmed = value.trim();
            if trimmed.is_empty() || trimmed.chars().count() > MAX_LABEL_CHARS {
                return Err(FaceError::BadRequest);
            }
            Ok(trimmed.to_owned())
        })
        .transpose()
}

fn validate_merge_request(request: &MergeRequest) -> Result<(), FaceError> {
    if request.source_ids.is_empty() || request.source_ids.len() > MAX_MERGE_SOURCES {
        return Err(FaceError::BadRequest);
    }
    let mut unique = request.source_ids.clone();
    unique.sort_unstable();
    unique.dedup();
    if unique.len() != request.source_ids.len() || request.source_ids.contains(&request.target_id) {
        return Err(FaceError::BadRequest);
    }
    Ok(())
}

fn no_store<T: IntoResponse>(response: T) -> Response {
    let mut response = response.into_response();
    response.headers_mut().insert(
        CACHE_CONTROL,
        "no-store".parse().expect("static header is valid"),
    );
    response
}

impl From<FaceClusterRow> for FaceClusterResponse {
    fn from(row: FaceClusterRow) -> Self {
        Self {
            id: row.id,
            label: row.label,
            face_count: row.face_count,
            asset_count: row.asset_count,
            created_at: row.created_at,
            updated_at: row.updated_at,
        }
    }
}

impl From<FaceClusterRow> for AdminFaceClusterResponse {
    fn from(row: FaceClusterRow) -> Self {
        Self {
            id: row.id,
            owner_id: row.owner_id,
            owner_email: row.owner_email,
            label: row.label,
            face_count: row.face_count,
            asset_count: row.asset_count,
            created_at: row.created_at,
            updated_at: row.updated_at,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{FaceError, MergeRequest, normalize_label, page_bounds, validate_merge_request};
    use uuid::Uuid;

    #[test]
    fn page_bounds_are_bounded() {
        assert_eq!(page_bounds(None, None).unwrap(), (50, 0));
        assert!(matches!(
            page_bounds(Some(0), None),
            Err(FaceError::BadRequest)
        ));
        assert!(matches!(
            page_bounds(Some(101), None),
            Err(FaceError::BadRequest)
        ));
        assert!(matches!(
            page_bounds(None, Some(1_000_001)),
            Err(FaceError::BadRequest)
        ));
    }

    #[test]
    fn labels_are_trimmed_and_limited() {
        assert_eq!(
            normalize_label(Some("  Alice  ".to_owned())).unwrap(),
            Some("Alice".to_owned())
        );
        assert_eq!(normalize_label(None).unwrap(), None);
        assert!(matches!(
            normalize_label(Some("   ".to_owned())),
            Err(FaceError::BadRequest)
        ));
        assert!(matches!(
            normalize_label(Some("a".repeat(81))),
            Err(FaceError::BadRequest)
        ));
    }

    #[test]
    fn merge_rejects_duplicate_or_target_source_ids() {
        let target = Uuid::new_v4();
        let source = Uuid::new_v4();
        assert!(
            validate_merge_request(&MergeRequest {
                target_id: target,
                source_ids: vec![source],
            })
            .is_ok()
        );
        assert!(matches!(
            validate_merge_request(&MergeRequest {
                target_id: target,
                source_ids: vec![source, source],
            }),
            Err(FaceError::BadRequest)
        ));
        assert!(matches!(
            validate_merge_request(&MergeRequest {
                target_id: target,
                source_ids: vec![target],
            }),
            Err(FaceError::BadRequest)
        ));
    }
}
