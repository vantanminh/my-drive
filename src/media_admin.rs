use axum::{
    Json, Router,
    extract::{Query, State},
    http::{HeaderMap, StatusCode, header::CACHE_CONTROL},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use thiserror::Error;

use crate::{auth::AuthenticatedUser, drive, health::AppState};

const DEFAULT_PAGE_SIZE: u16 = 25;
const MAX_PAGE_SIZE: u16 = 100;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/admin/media-index", get(status))
        .route("/api/admin/media-index/pause", post(set_pause))
        .route("/api/admin/media-index/retry", post(retry_failed))
}

#[derive(Debug, Error)]
enum AdminError {
    #[error("owner permission required")]
    Forbidden,
    #[error("invalid request")]
    BadRequest,
    #[error("CSRF validation failed")]
    Csrf,
    #[error("database operation failed")]
    Database(#[source] sqlx::Error),
}

impl IntoResponse for AdminError {
    fn into_response(self) -> Response {
        let (status, code) = match self {
            Self::Forbidden => (StatusCode::FORBIDDEN, "forbidden"),
            Self::BadRequest => (StatusCode::BAD_REQUEST, "invalid_request"),
            Self::Csrf => (StatusCode::FORBIDDEN, "csrf_failed"),
            Self::Database(error) => {
                tracing::error!(error = %error, "media indexing admin database operation failed");
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
struct StatusQuery {
    limit: Option<u16>,
    before_id: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PauseRequest {
    paused: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RetryRequest {
    job_id: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusResponse {
    preview_storage_available: bool,
    paused: bool,
    counts: StatusCounts,
    task_metrics: Vec<TaskMetrics>,
    pending_bytes: i64,
    processed_bytes: i64,
    jobs: Vec<JobSummary>,
    next_before_id: Option<i64>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct StatusCounts {
    queued: i64,
    running: i64,
    completed: i64,
    unsupported: i64,
    retry_wait: i64,
    failed: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskMetrics {
    task: String,
    counts: StatusCounts,
    pending_bytes: i64,
    processed_bytes: i64,
}

#[derive(FromRow)]
struct StatusAggregate {
    queued: i64,
    running: i64,
    completed: i64,
    unsupported: i64,
    retry_wait: i64,
    failed: i64,
    pending_bytes: Option<i64>,
    processed_bytes: Option<i64>,
}

#[derive(FromRow)]
struct TaskAggregate {
    task: String,
    queued: i64,
    running: i64,
    completed: i64,
    unsupported: i64,
    retry_wait: i64,
    failed: i64,
    pending_bytes: Option<i64>,
    processed_bytes: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JobSummary {
    id: i64,
    file_id: uuid::Uuid,
    file_name: String,
    task: String,
    state: String,
    attempts: i32,
    current_stage: Option<String>,
    processed_bytes: i64,
    total_bytes: i64,
    error_code: Option<&'static str>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

#[derive(FromRow)]
struct JobSummaryRow {
    id: i64,
    file_id: uuid::Uuid,
    file_name: String,
    task: String,
    state: String,
    attempts: i32,
    current_stage: Option<String>,
    processed_bytes: i64,
    total_bytes: i64,
    error_code: Option<String>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

async fn status(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Query(query): Query<StatusQuery>,
) -> Result<Response, AdminError> {
    require_owner(&user)?;
    let limit = query.limit.unwrap_or(DEFAULT_PAGE_SIZE);
    if limit == 0 || limit > MAX_PAGE_SIZE || query.before_id.is_some_and(|id| id <= 0) {
        return Err(AdminError::BadRequest);
    }

    let (paused,): (bool,) =
        sqlx::query_as("SELECT paused FROM media_index_control WHERE singleton = TRUE")
            .fetch_one(&state.pool)
            .await
            .map_err(AdminError::Database)?;
    let aggregate = sqlx::query_as::<_, StatusAggregate>(
        "SELECT \
            COUNT(*) FILTER (WHERE job.state = 'queued')::BIGINT AS queued, \
            COUNT(*) FILTER (WHERE job.state = 'running')::BIGINT AS running, \
            COUNT(*) FILTER (WHERE job.state = 'completed')::BIGINT AS completed, \
            COUNT(*) FILTER (WHERE job.state = 'unsupported')::BIGINT AS unsupported, \
            COUNT(*) FILTER (WHERE job.state = 'retry_wait')::BIGINT AS retry_wait, \
            COUNT(*) FILTER (WHERE job.state = 'failed')::BIGINT AS failed, \
            COALESCE(SUM(version.size_bytes) FILTER (WHERE job.state IN \
                ('queued', 'running', 'retry_wait', 'failed')), 0)::BIGINT AS pending_bytes, \
            COALESCE(SUM(job.processed_bytes) FILTER (WHERE job.state = 'running'), 0)::BIGINT \
                AS processed_bytes \
          FROM media_index_jobs AS job \
          JOIN file_versions AS version ON version.id = job.file_version_id \
         WHERE job.task IN ('image_preview', 'video_thumbnail', 'video_preview', 'face_index')",
    )
    .fetch_one(&state.pool)
    .await
    .map_err(AdminError::Database)?;
    let task_metrics = sqlx::query_as::<_, TaskAggregate>(
        "SELECT job.task, \
            COUNT(*) FILTER (WHERE job.state = 'queued')::BIGINT AS queued, \
            COUNT(*) FILTER (WHERE job.state = 'running')::BIGINT AS running, \
            COUNT(*) FILTER (WHERE job.state = 'completed')::BIGINT AS completed, \
            COUNT(*) FILTER (WHERE job.state = 'unsupported')::BIGINT AS unsupported, \
            COUNT(*) FILTER (WHERE job.state = 'retry_wait')::BIGINT AS retry_wait, \
            COUNT(*) FILTER (WHERE job.state = 'failed')::BIGINT AS failed, \
            COALESCE(SUM(version.size_bytes) FILTER (WHERE job.state IN \
                ('queued', 'running', 'retry_wait', 'failed')), 0)::BIGINT AS pending_bytes, \
            COALESCE(SUM(job.processed_bytes) FILTER (WHERE job.state = 'running'), 0)::BIGINT \
                AS processed_bytes \
          FROM media_index_jobs AS job \
          JOIN file_versions AS version ON version.id = job.file_version_id \
         WHERE job.task IN ('image_preview', 'video_thumbnail', 'video_preview', 'face_index') \
         GROUP BY job.task \
         ORDER BY CASE job.task \
            WHEN 'image_preview' THEN 0 \
            WHEN 'video_thumbnail' THEN 1 \
            WHEN 'video_preview' THEN 2 \
            WHEN 'face_index' THEN 3 \
            ELSE 4 END",
    )
    .fetch_all(&state.pool)
    .await
    .map_err(AdminError::Database)?;
    let mut jobs = sqlx::query_as::<_, JobSummaryRow>(
        "SELECT job.id, version.file_id, entry.name AS file_name, job.task, job.state, job.attempts, \
                job.current_stage, job.processed_bytes, version.size_bytes AS total_bytes, \
                job.error_code, job.created_at, job.updated_at \
           FROM media_index_jobs AS job \
           JOIN file_versions AS version ON version.id = job.file_version_id \
           JOIN drive_entries AS entry ON entry.id = version.file_id \
          WHERE job.task IN ('image_preview', 'video_thumbnail', 'video_preview', 'face_index') \
            AND ($1::BIGINT IS NULL OR job.id < $1) \
          ORDER BY job.id DESC LIMIT $2",
    )
    .bind(query.before_id)
    .bind(i64::from(limit) + 1)
    .fetch_all(&state.pool)
    .await
    .map_err(AdminError::Database)?;
    let has_more = jobs.len() > usize::from(limit);
    jobs.truncate(usize::from(limit));
    let next_before_id = has_more.then(|| jobs.last().map(|job| job.id)).flatten();
    let jobs = jobs
        .into_iter()
        .map(|job| JobSummary {
            id: job.id,
            file_id: job.file_id,
            file_name: job.file_name,
            task: job.task,
            state: job.state,
            attempts: job.attempts,
            current_stage: job.current_stage,
            processed_bytes: job.processed_bytes,
            total_bytes: job.total_bytes,
            error_code: sanitize_error_code(job.error_code.as_deref()),
            created_at: job.created_at,
            updated_at: job.updated_at,
        })
        .collect();
    let response = StatusResponse {
        preview_storage_available: state
            .media_preview
            .as_ref()
            .is_some_and(|storage| storage.health().is_ok()),
        paused,
        counts: StatusCounts {
            queued: aggregate.queued,
            running: aggregate.running,
            completed: aggregate.completed,
            unsupported: aggregate.unsupported,
            retry_wait: aggregate.retry_wait,
            failed: aggregate.failed,
        },
        task_metrics: task_metrics
            .into_iter()
            .map(|task| TaskMetrics {
                task: task.task,
                counts: StatusCounts {
                    queued: task.queued,
                    running: task.running,
                    completed: task.completed,
                    unsupported: task.unsupported,
                    retry_wait: task.retry_wait,
                    failed: task.failed,
                },
                pending_bytes: task.pending_bytes.unwrap_or_default(),
                processed_bytes: task.processed_bytes.unwrap_or_default(),
            })
            .collect(),
        pending_bytes: aggregate.pending_bytes.unwrap_or_default(),
        processed_bytes: aggregate.processed_bytes.unwrap_or_default(),
        jobs,
        next_before_id,
    };
    let mut response = Json(response).into_response();
    response.headers_mut().insert(
        CACHE_CONTROL,
        "no-store".parse().expect("static header is valid"),
    );
    Ok(response)
}

async fn set_pause(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
    Json(request): Json<PauseRequest>,
) -> Result<Response, AdminError> {
    require_owner(&user)?;
    drive::require_request_csrf(&headers, &user, state.auth_settings)
        .map_err(|_| AdminError::Csrf)?;
    let mut transaction = state.pool.begin().await.map_err(AdminError::Database)?;
    sqlx::query(
        "UPDATE media_index_control \
            SET paused = $1, changed_by = $2, updated_at = now() \
          WHERE singleton = TRUE",
    )
    .bind(request.paused)
    .bind(user.id)
    .execute(&mut *transaction)
    .await
    .map_err(AdminError::Database)?;
    sqlx::query("INSERT INTO audit_events (event_type, actor_id) VALUES ($1, $2)")
        .bind(if request.paused {
            "media_index_paused"
        } else {
            "media_index_resumed"
        })
        .bind(user.id)
        .execute(&mut *transaction)
        .await
        .map_err(AdminError::Database)?;
    transaction.commit().await.map_err(AdminError::Database)?;
    let mut response = Json(PauseResponse {
        paused: request.paused,
    })
    .into_response();
    response.headers_mut().insert(
        CACHE_CONTROL,
        "no-store".parse().expect("static header is valid"),
    );
    Ok(response)
}

async fn retry_failed(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
    Json(request): Json<RetryRequest>,
) -> Result<Response, AdminError> {
    require_owner(&user)?;
    drive::require_request_csrf(&headers, &user, state.auth_settings)
        .map_err(|_| AdminError::Csrf)?;
    if request.job_id.is_some_and(|id| id <= 0) {
        return Err(AdminError::BadRequest);
    }
    let mut transaction = state.pool.begin().await.map_err(AdminError::Database)?;
    let result = sqlx::query(
        "UPDATE media_index_jobs \
            SET state = 'queued', attempts = 0, available_at = now(), lease_expires_at = NULL, \
                current_stage = NULL, processed_bytes = 0, error_code = NULL, \
                last_error_at = NULL, completed_at = NULL, updated_at = now() \
          WHERE task IN ('image_preview', 'video_thumbnail', 'video_preview', 'face_index') AND state = 'failed' \
            AND ($1::BIGINT IS NULL OR id = $1)",
    )
    .bind(request.job_id)
    .execute(&mut *transaction)
    .await
    .map_err(AdminError::Database)?;
    let retried = result.rows_affected();
    if retried > 0 {
        sqlx::query(
            "INSERT INTO audit_events (event_type, actor_id) VALUES ('media_index_retried', $1)",
        )
        .bind(user.id)
        .execute(&mut *transaction)
        .await
        .map_err(AdminError::Database)?;
    }
    transaction.commit().await.map_err(AdminError::Database)?;
    let mut response = Json(RetryResponse { retried }).into_response();
    response.headers_mut().insert(
        CACHE_CONTROL,
        "no-store".parse().expect("static header is valid"),
    );
    Ok(response)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PauseResponse {
    paused: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RetryResponse {
    retried: u64,
}

fn require_owner(user: &AuthenticatedUser) -> Result<(), AdminError> {
    require_owner_role(&user.role)
}

fn require_owner_role(role: &str) -> Result<(), AdminError> {
    if role == "owner" {
        Ok(())
    } else {
        Err(AdminError::Forbidden)
    }
}

fn sanitize_error_code(code: Option<&str>) -> Option<&'static str> {
    match code? {
        "unsupported_format" => Some("unsupported_format"),
        "decode_failed" => Some("decode_failed"),
        "input_missing" => Some("input_missing"),
        "resource_limit" => Some("resource_limit"),
        "detector_unavailable" => Some("detector_unavailable"),
        "preview_storage_unavailable" => Some("preview_storage_unavailable"),
        _ => Some("processing_failed"),
    }
}

#[cfg(test)]
mod tests {
    use super::{AdminError, require_owner_role, sanitize_error_code};

    #[test]
    fn only_the_owner_role_can_access_indexing_controls() {
        assert!(require_owner_role("owner").is_ok());
        assert!(matches!(
            require_owner_role("admin"),
            Err(AdminError::Forbidden)
        ));
        assert!(matches!(
            require_owner_role("user"),
            Err(AdminError::Forbidden)
        ));
    }

    #[test]
    fn internal_indexing_errors_are_reduced_to_a_fixed_public_vocabulary() {
        assert_eq!(sanitize_error_code(None), None);
        assert_eq!(
            sanitize_error_code(Some("decode_failed")),
            Some("decode_failed")
        );
        assert_eq!(
            sanitize_error_code(Some("/srv/my-drive/data/private.jpg")),
            Some("processing_failed")
        );
    }
}
