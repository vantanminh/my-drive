mod range;

use std::{io, time::SystemTime};

use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, Path, State},
    http::{
        HeaderMap, HeaderName, HeaderValue, StatusCode,
        header::{
            ACCEPT_RANGES, CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_RANGE,
            CONTENT_TYPE, ETAG, IF_NONE_MATCH, IF_RANGE, LAST_MODIFIED, LOCATION, RANGE,
        },
    },
    response::{IntoResponse, Response},
    routing::{get, head, post},
};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use http_body_util::BodyExt;
use serde::{Deserialize, Serialize};
use sha2::Digest;
use sqlx::{FromRow, Postgres, Transaction};
use thiserror::Error;
use tokio::{
    fs as tokio_fs,
    io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt, SeekFrom},
};
use tokio_util::io::ReaderStream;
use uuid::Uuid;

use crate::{
    auth::AuthenticatedUser,
    drive::{self, DriveError},
    health::AppState,
    storage::StorageError,
};

const MAX_PATCH_BYTES: u64 = 64 * 1024 * 1024;
const IMAGE_PREVIEW_RECIPE_VERSION: i16 = 1;
const UPLOAD_COLUMNS: &str = "target_parent_id, filename, expected_size, received_size, staging_key, state, expires_at, storage_object_id, final_file_id";

#[derive(Debug, Error)]
pub(crate) enum TransferError {
    #[error("invalid request")]
    BadRequest,
    #[error("this file format is not supported for inline preview")]
    UnsupportedPreview,
    #[error("resource not found")]
    NotFound,
    #[error("request conflicts with current state")]
    Conflict,
    #[error("upload offset does not match")]
    OffsetConflict(u64),
    #[error("upload session has expired or is closed")]
    Gone,
    #[error("payload exceeds an upload limit")]
    PayloadTooLarge,
    #[error("owner quota has been reached")]
    QuotaExceeded,
    #[error("storage is unavailable")]
    Storage(StorageError),
    #[error("file data or database state is inconsistent")]
    Inconsistent,
    #[error("database operation failed")]
    Database(#[source] sqlx::Error),
    #[error("drive authorization failed")]
    Drive(#[from] DriveError),
    #[error("range is not satisfiable")]
    RangeNotSatisfiable(u64),
}

impl IntoResponse for TransferError {
    fn into_response(self) -> Response {
        if let Self::Drive(error) = self {
            return error.into_response();
        }

        let (status, code, offset, range_size) = match self {
            Self::BadRequest => (StatusCode::BAD_REQUEST, "invalid_request", None, None),
            Self::UnsupportedPreview => (
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "preview_unsupported",
                None,
                None,
            ),
            Self::NotFound => (StatusCode::NOT_FOUND, "not_found", None, None),
            Self::Conflict => (StatusCode::CONFLICT, "conflict", None, None),
            Self::OffsetConflict(offset) => {
                (StatusCode::CONFLICT, "offset_mismatch", Some(offset), None)
            }
            Self::Gone => (StatusCode::GONE, "upload_closed", None, None),
            Self::PayloadTooLarge => (
                StatusCode::PAYLOAD_TOO_LARGE,
                "payload_too_large",
                None,
                None,
            ),
            Self::QuotaExceeded => (
                StatusCode::INSUFFICIENT_STORAGE,
                "quota_exceeded",
                None,
                None,
            ),
            Self::Storage(StorageError::LowSpace) => {
                (StatusCode::INSUFFICIENT_STORAGE, "storage_low", None, None)
            }
            Self::Storage(error) => {
                tracing::error!(error = %error, "storage operation failed");
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "storage_unavailable",
                    None,
                    None,
                )
            }
            Self::Inconsistent => {
                tracing::error!("file transfer state is inconsistent");
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "storage_unavailable",
                    None,
                    None,
                )
            }
            Self::Database(error) => {
                tracing::error!(error = %error, "file transfer database operation failed");
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "service_unavailable",
                    None,
                    None,
                )
            }
            Self::RangeNotSatisfiable(size) => (
                StatusCode::RANGE_NOT_SATISFIABLE,
                "range_not_satisfiable",
                None,
                Some(size),
            ),
            Self::Drive(_) => unreachable!("drive errors are returned above"),
        };

        let mut response = (
            status,
            Json(ErrorBody {
                error: code,
                offset,
            }),
        )
            .into_response();
        response
            .headers_mut()
            .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
        if let Some(offset) = offset
            && let Ok(value) = HeaderValue::from_str(&offset.to_string())
        {
            response
                .headers_mut()
                .insert(HeaderName::from_static("upload-offset"), value);
        }
        if let Some(size) = range_size {
            if let Ok(value) = HeaderValue::from_str(&format!("bytes */{size}")) {
                response.headers_mut().insert(CONTENT_RANGE, value);
            }
            response
                .headers_mut()
                .insert(ACCEPT_RANGES, HeaderValue::from_static("bytes"));
        }
        response
    }
}

#[derive(Serialize)]
struct ErrorBody {
    error: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    offset: Option<u64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateUpload {
    filename: String,
    expected_size: u64,
    parent_id: Option<Uuid>,
}

#[derive(Serialize)]
struct UploadCreated {
    id: Uuid,
    offset: u64,
    length: u64,
}

#[derive(Serialize)]
struct UploadFinalized {
    file_id: Uuid,
    status: &'static str,
}

#[derive(FromRow)]
struct UploadSession {
    target_parent_id: Option<Uuid>,
    filename: String,
    expected_size: i64,
    received_size: i64,
    staging_key: Uuid,
    state: String,
    expires_at: DateTime<Utc>,
    storage_object_id: Option<Uuid>,
    final_file_id: Option<Uuid>,
}

#[derive(FromRow)]
struct FinalizeObject {
    storage_key: String,
    size_bytes: i64,
}

#[derive(FromRow)]
struct DownloadRecord {
    name: String,
    file_version_id: Uuid,
    size_bytes: i64,
    storage_key: String,
    mime_detected: Option<String>,
    checksum_sha256: Option<String>,
    state: String,
    version_created_at: DateTime<Utc>,
}

#[derive(FromRow)]
struct ViewerDerivative {
    recipe_version: i16,
    mime_type: String,
    size_bytes: i64,
    checksum_sha256: String,
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/uploads", post(create_upload))
        .route(
            "/api/uploads/{id}",
            head(head_upload).patch(patch_upload).delete(cancel_upload),
        )
        .route("/api/uploads/{id}/finalize", post(finalize_upload))
        .route(
            "/api/files/{id}/download",
            get(download_file).head(download_head),
        )
        .route(
            "/api/files/{id}/preview",
            get(preview_file).head(preview_head),
        )
        .layer(DefaultBodyLimit::max(16 * 1024))
}

async fn create_upload(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
    Json(request): Json<CreateUpload>,
) -> Result<Response, TransferError> {
    drive::require_request_csrf(&headers, &user, state.auth_settings)?;
    let filename = drive::normalize_name(&request.filename)?;
    if request.expected_size > state.transfer_settings.max_file_size {
        return Err(TransferError::PayloadTooLarge);
    }
    let expected_size =
        i64::try_from(request.expected_size).map_err(|_| TransferError::PayloadTooLarge)?;
    if let Some(parent_id) = request.parent_id {
        drive::ensure_active_entry(&state, user.id, parent_id, true).await?;
    }
    let ttl = i64::try_from(state.transfer_settings.upload_session_ttl_seconds)
        .map_err(|_| TransferError::BadRequest)?;
    let expires_at = Utc::now()
        .checked_add_signed(ChronoDuration::seconds(ttl))
        .ok_or(TransferError::BadRequest)?;

    let mut transaction = state.pool.begin().await.map_err(map_database_error)?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))")
        .bind(user.id)
        .execute(&mut *transaction)
        .await
        .map_err(map_database_error)?;
    let used_bytes: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(version.size_bytes), 0)::BIGINT \
           FROM drive_entries AS entry \
           JOIN files AS file ON file.id = entry.id \
           LEFT JOIN file_versions AS version ON version.id = file.current_version_id \
          WHERE entry.owner_id = $1",
    )
    .bind(user.id)
    .fetch_one(&mut *transaction)
    .await
    .map_err(map_database_error)?;
    let reserved_bytes: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(expected_size - received_size), 0)::BIGINT \
           FROM upload_sessions \
          WHERE owner_id = $1 AND state IN ('active', 'finalizing') AND expires_at > now()",
    )
    .bind(user.id)
    .fetch_one(&mut *transaction)
    .await
    .map_err(map_database_error)?;
    let required_reservation = u64::try_from(used_bytes.max(0))
        .unwrap_or(u64::MAX)
        .checked_add(u64::try_from(reserved_bytes.max(0)).unwrap_or(u64::MAX))
        .and_then(|value| value.checked_add(request.expected_size))
        .ok_or(TransferError::QuotaExceeded)?;
    if required_reservation > state.transfer_settings.owner_quota_bytes {
        return Err(TransferError::QuotaExceeded);
    }
    state
        .storage
        .check_write_capacity(
            u64::try_from(reserved_bytes.max(0))
                .unwrap_or(u64::MAX)
                .checked_add(request.expected_size)
                .ok_or(TransferError::PayloadTooLarge)?,
        )
        .map_err(TransferError::Storage)?;

    let id = Uuid::new_v4();
    let staging_key = Uuid::new_v4();
    state
        .storage
        .create_staging_file(staging_key)
        .await
        .map_err(TransferError::Storage)?;
    let insert = sqlx::query(
        "INSERT INTO upload_sessions \
            (id, owner_id, target_parent_id, filename, expected_size, staging_key, state, expires_at) \
         VALUES ($1, $2, $3, $4, $5, $6, 'active', $7)",
    )
    .bind(id)
    .bind(user.id)
    .bind(request.parent_id)
    .bind(filename)
    .bind(expected_size)
    .bind(staging_key)
    .bind(expires_at)
    .execute(&mut *transaction)
    .await;
    if let Err(error) = insert {
        let _ = state.storage.remove_staging_file(staging_key).await;
        return Err(map_database_error(error));
    }
    transaction.commit().await.map_err(map_database_error)?;

    let mut response = (
        StatusCode::CREATED,
        Json(UploadCreated {
            id,
            offset: 0,
            length: request.expected_size,
        }),
    )
        .into_response();
    response.headers_mut().insert(
        LOCATION,
        HeaderValue::from_str(&format!("/api/uploads/{id}"))
            .expect("generated upload URL is a valid header"),
    );
    response.headers_mut().insert(
        HeaderName::from_static("upload-offset"),
        HeaderValue::from_static("0"),
    );
    response.headers_mut().insert(
        HeaderName::from_static("upload-length"),
        HeaderValue::from_str(&request.expected_size.to_string())
            .expect("numeric upload length is a valid header"),
    );
    response.headers_mut().insert(
        HeaderName::from_static("tus-resumable"),
        HeaderValue::from_static("1.0.0"),
    );
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

async fn head_upload(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Path(id): Path<Uuid>,
) -> Result<Response, TransferError> {
    let session = fetch_upload(&state, user.id, id).await?;
    if session.state == "expired" || session.state == "failed" {
        return Err(TransferError::Gone);
    }
    if session.state == "active" && session.expires_at <= Utc::now() {
        return Err(TransferError::Gone);
    }
    let mut response = StatusCode::NO_CONTENT.into_response();
    set_header(
        response.headers_mut(),
        "upload-offset",
        &session.received_size.to_string(),
    )?;
    set_header(
        response.headers_mut(),
        "upload-length",
        &session.expected_size.to_string(),
    )?;
    response.headers_mut().insert(
        HeaderName::from_static("tus-resumable"),
        HeaderValue::from_static("1.0.0"),
    );
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

async fn patch_upload(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    mut body: Body,
) -> Result<Response, TransferError> {
    drive::require_request_csrf(&headers, &user, state.auth_settings)?;
    if headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        != Some("application/offset+octet-stream")
    {
        return Err(TransferError::BadRequest);
    }
    let offset = headers
        .get("upload-offset")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or(TransferError::BadRequest)?;
    if let Some(length) = headers.get(CONTENT_LENGTH) {
        let length = length
            .to_str()
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .ok_or(TransferError::BadRequest)?;
        if length == 0 || length > MAX_PATCH_BYTES {
            return Err(TransferError::PayloadTooLarge);
        }
    }

    let mut transaction = state.pool.begin().await.map_err(map_database_error)?;
    let session = fetch_upload_for_update(&mut transaction, user.id, id).await?;
    require_active(&session)?;
    let current_offset =
        u64::try_from(session.received_size).map_err(|_| TransferError::Inconsistent)?;
    if current_offset != offset {
        return Err(TransferError::OffsetConflict(current_offset));
    }
    let expected_size =
        u64::try_from(session.expected_size).map_err(|_| TransferError::Inconsistent)?;
    if current_offset >= expected_size {
        return Err(TransferError::Conflict);
    }
    let max_bytes = (expected_size - current_offset).min(MAX_PATCH_BYTES);
    let path = state.storage.staging_path(session.staging_key);
    let mut file = tokio_fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .await
        .map_err(|error| TransferError::Storage(StorageError::Io(error)))?;
    let file_length = file
        .metadata()
        .await
        .map_err(|error| TransferError::Storage(StorageError::Io(error)))?
        .len();
    if file_length < current_offset {
        return Err(TransferError::Inconsistent);
    }
    if file_length > current_offset {
        file.set_len(current_offset)
            .await
            .map_err(|error| TransferError::Storage(StorageError::Io(error)))?;
    }
    file.seek(SeekFrom::Start(current_offset))
        .await
        .map_err(|error| TransferError::Storage(StorageError::Io(error)))?;

    let appended = match write_patch_body(&state, &mut body, &mut file, max_bytes).await {
        Ok(appended) => appended,
        Err(error) => {
            let _ = file.set_len(current_offset).await;
            return Err(error);
        }
    };
    if appended == 0 {
        let _ = file.set_len(current_offset).await;
        return Err(TransferError::BadRequest);
    }
    if let Err(error) = file.sync_data().await {
        let _ = file.set_len(current_offset).await;
        return Err(TransferError::Storage(StorageError::Io(error)));
    }
    let new_offset = current_offset
        .checked_add(appended)
        .ok_or(TransferError::PayloadTooLarge)?;
    sqlx::query(
        "UPDATE upload_sessions SET received_size = $1, updated_at = now() \
          WHERE id = $2 AND owner_id = $3 AND state = 'active'",
    )
    .bind(i64::try_from(new_offset).map_err(|_| TransferError::PayloadTooLarge)?)
    .bind(id)
    .bind(user.id)
    .execute(&mut *transaction)
    .await
    .map_err(map_database_error)?;
    transaction.commit().await.map_err(map_database_error)?;

    let mut response = StatusCode::NO_CONTENT.into_response();
    set_header(
        response.headers_mut(),
        "upload-offset",
        &new_offset.to_string(),
    )?;
    response.headers_mut().insert(
        HeaderName::from_static("tus-resumable"),
        HeaderValue::from_static("1.0.0"),
    );
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

async fn write_patch_body(
    state: &AppState,
    body: &mut Body,
    file: &mut tokio_fs::File,
    max_bytes: u64,
) -> Result<u64, TransferError> {
    let mut written = 0_u64;
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|_| TransferError::BadRequest)?;
        let Ok(data) = frame.into_data() else {
            continue;
        };
        if data.is_empty() {
            continue;
        }
        let chunk_size = u64::try_from(data.len()).map_err(|_| TransferError::PayloadTooLarge)?;
        let next_size = written
            .checked_add(chunk_size)
            .ok_or(TransferError::PayloadTooLarge)?;
        if next_size > max_bytes {
            return Err(TransferError::PayloadTooLarge);
        }
        state
            .storage
            .check_write_capacity(chunk_size)
            .map_err(TransferError::Storage)?;
        file.write_all(&data)
            .await
            .map_err(|error| TransferError::Storage(StorageError::Io(error)))?;
        written = next_size;
    }
    Ok(written)
}

async fn finalize_upload(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<UploadFinalized>, TransferError> {
    drive::require_request_csrf(&headers, &user, state.auth_settings)?;
    let mut transaction = state.pool.begin().await.map_err(map_database_error)?;
    let session = fetch_upload_for_update(&mut transaction, user.id, id).await?;
    if session.state == "completed" {
        let file_id = session.final_file_id.ok_or(TransferError::Inconsistent)?;
        transaction.rollback().await.map_err(map_database_error)?;
        return Ok(Json(UploadFinalized {
            file_id,
            status: "completed",
        }));
    }
    if session.state == "failed" || session.state == "expired" {
        return Err(TransferError::Gone);
    }
    if session.state == "active" {
        require_not_expired(&session)?;
        if session.received_size != session.expected_size {
            return Err(TransferError::Conflict);
        }
        if let Some(parent_id) = session.target_parent_id {
            drive::ensure_active_entry(&state, user.id, parent_id, true).await?;
        }
        let storage_object_id = Uuid::new_v4();
        let file_id = Uuid::new_v4();
        let version_id = Uuid::new_v4();
        let storage_key = crate::storage::LocalStorage::storage_key(storage_object_id);
        sqlx::query(
            "INSERT INTO storage_objects (id, storage_key, size_bytes, state) \
             VALUES ($1, $2, $3, 'pending')",
        )
        .bind(storage_object_id)
        .bind(storage_key)
        .bind(session.expected_size)
        .execute(&mut *transaction)
        .await
        .map_err(map_database_error)?;
        sqlx::query(
            "INSERT INTO drive_entries (id, owner_id, parent_id, kind, name) \
             VALUES ($1, $2, $3, 'file', $4)",
        )
        .bind(file_id)
        .bind(user.id)
        .bind(session.target_parent_id)
        .bind(&session.filename)
        .execute(&mut *transaction)
        .await
        .map_err(map_database_error)?;
        sqlx::query("INSERT INTO files (id) VALUES ($1)")
            .bind(file_id)
            .execute(&mut *transaction)
            .await
            .map_err(map_database_error)?;
        sqlx::query(
            "INSERT INTO file_versions (id, file_id, storage_object_id, size_bytes) \
             VALUES ($1, $2, $3, $4)",
        )
        .bind(version_id)
        .bind(file_id)
        .bind(storage_object_id)
        .bind(session.expected_size)
        .execute(&mut *transaction)
        .await
        .map_err(map_database_error)?;
        sqlx::query("UPDATE files SET current_version_id = $1 WHERE id = $2")
            .bind(version_id)
            .bind(file_id)
            .execute(&mut *transaction)
            .await
            .map_err(map_database_error)?;
        sqlx::query(
            "UPDATE upload_sessions \
                SET state = 'finalizing', storage_object_id = $1, final_file_id = $2, updated_at = now() \
              WHERE id = $3 AND owner_id = $4 AND state = 'active'",
        )
        .bind(storage_object_id)
        .bind(file_id)
        .bind(id)
        .bind(user.id)
        .execute(&mut *transaction)
        .await
        .map_err(map_database_error)?;
    } else if session.state != "finalizing" {
        return Err(TransferError::Gone);
    }
    transaction.commit().await.map_err(map_database_error)?;

    let file_id = session.final_file_id;
    let storage_object_id = session.storage_object_id;
    let (file_id, storage_object_id) = match (file_id, storage_object_id) {
        (Some(file_id), Some(object_id)) => (file_id, object_id),
        (None, None) if session.state == "active" => {
            let file_id: Uuid = sqlx::query_scalar(
                "SELECT final_file_id FROM upload_sessions WHERE id = $1 AND owner_id = $2",
            )
            .bind(id)
            .bind(user.id)
            .fetch_one(&state.pool)
            .await
            .map_err(map_database_error)?;
            let object_id: Uuid = sqlx::query_scalar(
                "SELECT storage_object_id FROM upload_sessions WHERE id = $1 AND owner_id = $2",
            )
            .bind(id)
            .bind(user.id)
            .fetch_one(&state.pool)
            .await
            .map_err(map_database_error)?;
            (file_id, object_id)
        }
        _ => return Err(TransferError::Inconsistent),
    };
    if let Some(parent_id) = session.target_parent_id {
        drive::ensure_active_entry(&state, user.id, parent_id, true).await?;
    }
    let object: FinalizeObject =
        sqlx::query_as("SELECT storage_key, size_bytes FROM storage_objects WHERE id = $1")
            .bind(storage_object_id)
            .fetch_optional(&state.pool)
            .await
            .map_err(map_database_error)?
            .ok_or(TransferError::Inconsistent)?;
    let object_path = state
        .storage
        .promote_staging_file(session.staging_key, &object.storage_key)
        .await
        .map_err(TransferError::Storage)?;
    let detected_media_type = sniff_media_type_from_path(&object_path)
        .await
        .map_err(|error| TransferError::Storage(StorageError::Io(error)))?;
    let (actual_size, checksum) = hash_file(&object_path)
        .await
        .map_err(|error| TransferError::Storage(StorageError::Io(error)))?;
    if actual_size != u64::try_from(object.size_bytes).map_err(|_| TransferError::Inconsistent)? {
        return Err(TransferError::Inconsistent);
    }

    let mut transaction = state.pool.begin().await.map_err(map_database_error)?;
    let current_session = fetch_upload_for_update(&mut transaction, user.id, id).await?;
    if current_session.state == "completed" {
        let completed_file_id = current_session
            .final_file_id
            .ok_or(TransferError::Inconsistent)?;
        transaction.rollback().await.map_err(map_database_error)?;
        return Ok(Json(UploadFinalized {
            file_id: completed_file_id,
            status: "completed",
        }));
    }
    if current_session.state != "finalizing"
        || current_session.final_file_id != Some(file_id)
        || current_session.storage_object_id != Some(storage_object_id)
    {
        return Err(TransferError::Conflict);
    }
    sqlx::query(
        "UPDATE storage_objects \
            SET checksum_sha256 = $1, mime_detected = $2, state = 'ready' \
          WHERE id = $3 AND state IN ('pending', 'ready')",
    )
    .bind(checksum)
    .bind(detected_media_type)
    .bind(storage_object_id)
    .execute(&mut *transaction)
    .await
    .map_err(map_database_error)?;
    sqlx::query(
        "UPDATE upload_sessions SET state = 'completed', updated_at = now() \
          WHERE id = $1 AND owner_id = $2 AND state = 'finalizing'",
    )
    .bind(id)
    .bind(user.id)
    .execute(&mut *transaction)
    .await
    .map_err(map_database_error)?;
    if is_indexable_image_mime(detected_media_type) {
        let version_id: Option<Uuid> =
            sqlx::query_scalar("SELECT current_version_id FROM files WHERE id = $1 FOR UPDATE")
                .bind(file_id)
                .fetch_one(&mut *transaction)
                .await
                .map_err(map_database_error)?;
        let version_id = version_id.ok_or(TransferError::Inconsistent)?;
        sqlx::query(
            "INSERT INTO media_index_jobs (file_version_id, task, recipe_version) \
             VALUES ($1, 'image_preview', $2) \
             ON CONFLICT (file_version_id, task, recipe_version) DO NOTHING",
        )
        .bind(version_id)
        .bind(IMAGE_PREVIEW_RECIPE_VERSION)
        .execute(&mut *transaction)
        .await
        .map_err(map_database_error)?;
    }
    sqlx::query(
        "INSERT INTO audit_events (event_type, actor_id, resource_id) \
         VALUES ('upload_completed', $1, $2)",
    )
    .bind(user.id)
    .bind(file_id)
    .execute(&mut *transaction)
    .await
    .map_err(map_database_error)?;
    transaction.commit().await.map_err(map_database_error)?;
    Ok(Json(UploadFinalized {
        file_id,
        status: "completed",
    }))
}

async fn cancel_upload(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, TransferError> {
    drive::require_request_csrf(&headers, &user, state.auth_settings)?;
    let mut transaction = state.pool.begin().await.map_err(map_database_error)?;
    let session = fetch_upload_for_update(&mut transaction, user.id, id).await?;
    if session.state == "completed" || session.state == "finalizing" {
        return Err(TransferError::Conflict);
    }
    if session.state == "active" || session.state == "expired" {
        sqlx::query(
            "UPDATE upload_sessions SET state = 'expired', updated_at = now() \
              WHERE id = $1 AND owner_id = $2 AND state IN ('active', 'expired')",
        )
        .bind(id)
        .bind(user.id)
        .execute(&mut *transaction)
        .await
        .map_err(map_database_error)?;
    }
    transaction.commit().await.map_err(map_database_error)?;
    state
        .storage
        .remove_staging_file(session.staging_key)
        .await
        .map_err(TransferError::Storage)?;
    sqlx::query(
        "UPDATE upload_sessions SET staging_cleaned_at = now() \
          WHERE id = $1 AND state = 'expired' AND staging_cleaned_at IS NULL",
    )
    .bind(id)
    .execute(&state.pool)
    .await
    .map_err(map_database_error)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn download_file(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Response, TransferError> {
    download_response(&state, user.id, id, &headers, false).await
}

async fn download_head(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Response, TransferError> {
    download_response(&state, user.id, id, &headers, true).await
}

async fn preview_file(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Response, TransferError> {
    preview_response(&state, user.id, id, &headers, false).await
}

async fn preview_head(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Response, TransferError> {
    preview_response(&state, user.id, id, &headers, true).await
}

async fn preview_response(
    state: &AppState,
    owner_id: Uuid,
    id: Uuid,
    request_headers: &HeaderMap,
    head_only: bool,
) -> Result<Response, TransferError> {
    download_response_inner(state, owner_id, id, request_headers, head_only, true).await
}

pub(crate) async fn download_response(
    state: &AppState,
    owner_id: Uuid,
    id: Uuid,
    request_headers: &HeaderMap,
    head_only: bool,
) -> Result<Response, TransferError> {
    download_response_inner(state, owner_id, id, request_headers, head_only, false).await
}

async fn download_response_inner(
    state: &AppState,
    owner_id: Uuid,
    id: Uuid,
    request_headers: &HeaderMap,
    head_only: bool,
    inline_preview: bool,
) -> Result<Response, TransferError> {
    drive::ensure_active_entry(state, owner_id, id, false).await?;
    let entry: DownloadRecord = sqlx::query_as(
        "WITH RECURSIVE parent_chain(id, parent_id, deleted_at) AS ( \
             SELECT id, parent_id, deleted_at FROM drive_entries \
              WHERE id = $1 AND owner_id = $2 AND kind = 'file' \
             UNION ALL \
             SELECT parent.id, parent.parent_id, parent.deleted_at \
               FROM drive_entries AS parent \
               JOIN parent_chain AS child ON parent.id = child.parent_id \
              WHERE parent.owner_id = $2 \
         ) \
         SELECT entry.name, version.id AS file_version_id, version.size_bytes, object.storage_key, object.mime_detected, \
                object.checksum_sha256, object.state, version.created_at AS version_created_at \
           FROM drive_entries AS entry \
           JOIN files AS file ON file.id = entry.id \
           JOIN file_versions AS version ON version.id = file.current_version_id \
           JOIN storage_objects AS object ON object.id = version.storage_object_id \
          WHERE entry.id = $1 AND entry.owner_id = $2 AND entry.deleted_at IS NULL \
            AND NOT EXISTS (SELECT 1 FROM parent_chain WHERE deleted_at IS NOT NULL)",
    )
    .bind(id)
    .bind(owner_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(map_database_error)?
    .ok_or(TransferError::NotFound)?;
    if entry.state != "ready" {
        return Err(TransferError::Storage(StorageError::Io(io::Error::other(
            "object is not ready",
        ))));
    }
    let original_size = u64::try_from(entry.size_bytes).map_err(|_| TransferError::Inconsistent)?;
    let preview_mime = if inline_preview {
        let detected = match entry.mime_detected.as_deref() {
            Some(value) => safe_preview_mime(value),
            None => sniff_media_type_from_storage(state, &entry.storage_key).await?,
        };
        Some(detected.ok_or(TransferError::UnsupportedPreview)?)
    } else {
        None
    };
    let mut derivative_bytes = None;
    let mut representation_mime = preview_mime;
    let mut checksum = entry
        .checksum_sha256
        .clone()
        .ok_or(TransferError::Inconsistent)?;
    if inline_preview && supports_viewer_derivative(preview_mime) {
        match read_viewer_derivative(state, entry.file_version_id).await {
            Ok(Some((bytes, derivative_checksum))) => {
                derivative_bytes = Some(bytes);
                representation_mime = Some("image/webp");
                checksum = derivative_checksum;
            }
            Ok(None) => {}
            Err(error) => tracing::warn!(
                file_version_id = %entry.file_version_id,
                error = %error,
                "could not use indexed viewer derivative; serving original image"
            ),
        }
    }
    let size = derivative_bytes
        .as_ref()
        .map(|bytes: &Vec<u8>| bytes.len() as u64)
        .unwrap_or(original_size);
    let etag = format!("\"{checksum}\"");
    let last_modified = SystemTime::from(entry.version_created_at);
    let last_modified_header = httpdate::fmt_http_date(last_modified);
    let last_modified_http_date = httpdate::parse_http_date(&last_modified_header)
        .map_err(|_| TransferError::Inconsistent)?;
    let if_range_matches_current = request_headers
        .get(IF_RANGE)
        .map(|value| {
            value
                .to_str()
                .is_ok_and(|value| if_range_matches(value, &etag, last_modified_http_date))
        })
        .unwrap_or(true);
    let mut response_headers = HeaderMap::new();
    response_headers.insert(ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    response_headers.insert(CACHE_CONTROL, HeaderValue::from_static("private, no-cache"));
    response_headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_static(representation_mime.unwrap_or("application/octet-stream")),
    );
    response_headers.insert(
        CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!(
            "{}; filename=\"download\"; filename*=UTF-8''{}",
            if inline_preview {
                "inline"
            } else {
                "attachment"
            },
            encode_filename(&entry.name)
        ))
        .map_err(|_| TransferError::BadRequest)?,
    );
    response_headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    if inline_preview {
        response_headers.insert(
            "content-security-policy",
            HeaderValue::from_static("default-src 'none'; sandbox"),
        );
    }
    response_headers.insert(
        ETAG,
        HeaderValue::from_str(&etag).map_err(|_| TransferError::Inconsistent)?,
    );
    response_headers.insert(
        LAST_MODIFIED,
        HeaderValue::from_str(&last_modified_header).map_err(|_| TransferError::Inconsistent)?,
    );
    if request_headers
        .get_all(IF_NONE_MATCH)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .any(|value| if_none_match_matches(value, &etag))
    {
        let mut response = Response::builder()
            .status(StatusCode::NOT_MODIFIED)
            .body(Body::empty())
            .map_err(|_| TransferError::Inconsistent)?;
        *response.headers_mut() = response_headers;
        return Ok(response);
    }

    let range_value = if if_range_matches_current {
        request_headers
            .get(RANGE)
            .and_then(|value| value.to_str().ok())
    } else {
        None
    };
    let requested_range = range::parse_range(range_value, size)
        .map_err(|_| TransferError::RangeNotSatisfiable(size))?;
    let (status, start, length, content_range) = match requested_range {
        Some(range) => (
            StatusCode::PARTIAL_CONTENT,
            range.start,
            range.len(),
            Some(format!("bytes {}-{}/{}", range.start, range.end, size)),
        ),
        None => (StatusCode::OK, 0, size, None),
    };
    response_headers.insert(
        CONTENT_LENGTH,
        HeaderValue::from_str(&length.to_string()).map_err(|_| TransferError::Inconsistent)?,
    );
    if let Some(content_range) = content_range {
        response_headers.insert(
            CONTENT_RANGE,
            HeaderValue::from_str(&content_range).map_err(|_| TransferError::Inconsistent)?,
        );
    }

    let body = if head_only {
        Body::empty()
    } else if let Some(bytes) = derivative_bytes {
        let start = usize::try_from(start).map_err(|_| TransferError::Inconsistent)?;
        let end =
            usize::try_from(start as u64 + length).map_err(|_| TransferError::Inconsistent)?;
        Body::from(bytes[start..end].to_vec())
    } else {
        let mut file = state
            .storage
            .open_object(&entry.storage_key)
            .await
            .map_err(TransferError::Storage)?;
        file.seek(SeekFrom::Start(start))
            .await
            .map_err(|error| TransferError::Storage(StorageError::Io(error)))?;
        Body::from_stream(ReaderStream::new(file.take(length)))
    };
    let mut response = Response::builder()
        .status(status)
        .body(body)
        .map_err(|_| TransferError::Inconsistent)?;
    *response.headers_mut() = response_headers;
    Ok(response)
}

async fn read_viewer_derivative(
    state: &AppState,
    file_version_id: Uuid,
) -> Result<Option<(Vec<u8>, String)>, String> {
    let Some(previews) = state.media_preview.as_ref() else {
        return Ok(None);
    };
    let derivative = sqlx::query_as::<_, ViewerDerivative>(
        "SELECT recipe_version, mime_type, size_bytes, checksum_sha256 \
           FROM media_derivatives \
          WHERE file_version_id = $1 AND variant = 'viewer' \
          ORDER BY recipe_version DESC LIMIT 1",
    )
    .bind(file_version_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|error| format!("query viewer derivative: {error}"))?;
    let Some(derivative) = derivative else {
        return Ok(None);
    };
    if derivative.mime_type != "image/webp" {
        return Err("viewer derivative has an unsupported MIME type".to_owned());
    }
    let bytes = previews
        .read_derivative(
            file_version_id,
            "viewer",
            derivative.recipe_version,
            derivative.size_bytes,
            &derivative.checksum_sha256,
            4 * 1024 * 1024,
        )
        .await
        .map_err(|error| format!("verify viewer derivative: {error}"))?;
    Ok(Some((bytes, derivative.checksum_sha256)))
}

fn if_none_match_matches(header_value: &str, etag: &str) -> bool {
    header_value.split(',').any(|candidate| {
        let candidate = candidate.trim();
        candidate == "*" || candidate == etag || candidate.strip_prefix("W/") == Some(etag)
    })
}

fn supports_viewer_derivative(mime_type: Option<&str>) -> bool {
    matches!(mime_type, Some("image/jpeg" | "image/png" | "image/webp"))
}

async fn fetch_upload(
    state: &AppState,
    owner_id: Uuid,
    id: Uuid,
) -> Result<UploadSession, TransferError> {
    let sql =
        format!("SELECT {UPLOAD_COLUMNS} FROM upload_sessions WHERE id = $1 AND owner_id = $2");
    sqlx::query_as::<_, UploadSession>(&sql)
        .bind(id)
        .bind(owner_id)
        .fetch_optional(&state.pool)
        .await
        .map_err(map_database_error)?
        .ok_or(TransferError::NotFound)
}

async fn fetch_upload_for_update(
    transaction: &mut Transaction<'_, Postgres>,
    owner_id: Uuid,
    id: Uuid,
) -> Result<UploadSession, TransferError> {
    let sql = format!(
        "SELECT {UPLOAD_COLUMNS} FROM upload_sessions WHERE id = $1 AND owner_id = $2 FOR UPDATE"
    );
    sqlx::query_as::<_, UploadSession>(&sql)
        .bind(id)
        .bind(owner_id)
        .fetch_optional(&mut **transaction)
        .await
        .map_err(map_database_error)?
        .ok_or(TransferError::NotFound)
}

fn require_active(session: &UploadSession) -> Result<(), TransferError> {
    if session.state != "active" {
        return if session.state == "expired" || session.state == "failed" {
            Err(TransferError::Gone)
        } else {
            Err(TransferError::Conflict)
        };
    }
    require_not_expired(session)
}

fn require_not_expired(session: &UploadSession) -> Result<(), TransferError> {
    if session.expires_at <= Utc::now() {
        Err(TransferError::Gone)
    } else {
        Ok(())
    }
}

async fn sniff_media_type_from_path(
    path: &std::path::Path,
) -> Result<Option<&'static str>, io::Error> {
    let mut file = tokio_fs::File::open(path).await?;
    let mut header = [0_u8; 64];
    let length = file.read(&mut header).await?;
    Ok(sniff_media_type(&header[..length]))
}

async fn sniff_media_type_from_storage(
    state: &AppState,
    storage_key: &str,
) -> Result<Option<&'static str>, TransferError> {
    let mut file = state
        .storage
        .open_object(storage_key)
        .await
        .map_err(TransferError::Storage)?;
    let mut header = [0_u8; 64];
    let length = file
        .read(&mut header)
        .await
        .map_err(|error| TransferError::Storage(StorageError::Io(error)))?;
    Ok(sniff_media_type(&header[..length]))
}

fn safe_preview_mime(mime: &str) -> Option<&'static str> {
    match mime {
        "image/jpeg" => Some("image/jpeg"),
        "image/png" => Some("image/png"),
        "image/gif" => Some("image/gif"),
        "image/webp" => Some("image/webp"),
        "image/avif" => Some("image/avif"),
        "image/bmp" => Some("image/bmp"),
        "image/x-icon" => Some("image/x-icon"),
        "video/mp4" => Some("video/mp4"),
        "video/webm" => Some("video/webm"),
        _ => None,
    }
}

fn if_range_matches(value: &str, etag: &str, last_modified: SystemTime) -> bool {
    if value.starts_with("W/") {
        return false;
    }
    if value.starts_with('"') {
        return value == etag;
    }
    httpdate::parse_http_date(value).is_ok_and(|date| last_modified <= date)
}

fn sniff_media_type(header: &[u8]) -> Option<&'static str> {
    if header.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if header.starts_with(b"\xff\xd8\xff") {
        return Some("image/jpeg");
    }
    if header.starts_with(b"GIF87a") || header.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if header.len() >= 12 && &header[..4] == b"RIFF" && &header[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if header.starts_with(b"BM") {
        return Some("image/bmp");
    }
    if header.starts_with(&[0x00, 0x00, 0x01, 0x00]) {
        return Some("image/x-icon");
    }
    if header.get(4..8).is_some_and(|brand| brand == b"ftyp") {
        if header
            .windows(4)
            .any(|brand| brand == b"avif" || brand == b"avis")
        {
            return Some("image/avif");
        }
        if header.windows(4).any(|brand| {
            matches!(
                brand,
                b"isom"
                    | b"iso2"
                    | b"iso5"
                    | b"iso6"
                    | b"mp41"
                    | b"mp42"
                    | b"avc1"
                    | b"M4V "
                    | b"dash"
                    | b"MSNV"
            )
        }) {
            return Some("video/mp4");
        }
    }
    if header.starts_with(&[0x1a, 0x45, 0xdf, 0xa3])
        && header.windows(4).any(|doc_type| doc_type == b"webm")
    {
        return Some("video/webm");
    }
    None
}

fn is_indexable_image_mime(mime_type: Option<&str>) -> bool {
    matches!(
        mime_type,
        Some(
            "image/jpeg"
                | "image/png"
                | "image/gif"
                | "image/webp"
                | "image/avif"
                | "image/bmp"
                | "image/x-icon"
        )
    )
}

async fn hash_file(path: &std::path::Path) -> Result<(u64, String), io::Error> {
    let mut file = tokio_fs::File::open(path).await?;
    let mut buffer = vec![0_u8; 128 * 1024];
    let mut size = 0_u64;
    let mut digest = sha2::Sha256::new();
    loop {
        let read = file.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        size = size
            .checked_add(u64::try_from(read).expect("read size fits u64"))
            .ok_or_else(|| io::Error::other("file size overflow"))?;
        digest.update(&buffer[..read]);
    }
    let digest = digest.finalize();
    Ok((size, hex_digest(&digest)))
}

fn hex_digest(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[usize::from(byte >> 4)] as char);
        output.push(HEX[usize::from(byte & 0x0f)] as char);
    }
    output
}

fn encode_filename(filename: &str) -> String {
    let mut output = String::with_capacity(filename.len());
    for byte in filename.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            output.push(byte as char);
        } else {
            output.push('%');
            output.push(char::from(b"0123456789ABCDEF"[usize::from(byte >> 4)]));
            output.push(char::from(b"0123456789ABCDEF"[usize::from(byte & 0x0f)]));
        }
    }
    output
}

fn set_header(
    headers: &mut HeaderMap,
    name: &'static str,
    value: &str,
) -> Result<(), TransferError> {
    headers.insert(
        HeaderName::from_static(name),
        HeaderValue::from_str(value).map_err(|_| TransferError::Inconsistent)?,
    );
    Ok(())
}

fn map_database_error(error: sqlx::Error) -> TransferError {
    match &error {
        sqlx::Error::Database(database_error) => match database_error.code().as_deref() {
            Some("23505") | Some("23514") => TransferError::Conflict,
            Some("23503") => TransferError::NotFound,
            _ => TransferError::Database(error),
        },
        _ => TransferError::Database(error),
    }
}

#[cfg(test)]
mod media_type_tests {
    use std::time::{Duration, UNIX_EPOCH};

    use super::{
        if_none_match_matches, if_range_matches, is_indexable_image_mime, safe_preview_mime,
        sniff_media_type, supports_viewer_derivative,
    };

    #[test]
    fn detects_supported_media_from_file_signatures() {
        let samples: &[(&[u8], &str)] = &[
            (b"\x89PNG\r\n\x1a\nrest", "image/png"),
            (b"\xff\xd8\xffrest", "image/jpeg"),
            (b"GIF89arest", "image/gif"),
            (b"RIFF\x00\x00\x00\x00WEBPrest", "image/webp"),
            (b"BMrest", "image/bmp"),
            (b"\x00\x00\x01\x00rest", "image/x-icon"),
            (b"\x00\x00\x00\x18ftypavifrest", "image/avif"),
            (b"\x00\x00\x00\x18ftypisomrest", "video/mp4"),
            (b"\x1a\x45\xdf\xa3\xa3\x42\x82\x84webmrest", "video/webm"),
        ];

        for (signature, expected) in samples {
            assert_eq!(sniff_media_type(signature), Some(*expected));
        }
    }

    #[test]
    fn only_detected_raster_image_types_are_queued_for_indexing() {
        for mime_type in [
            "image/jpeg",
            "image/png",
            "image/gif",
            "image/webp",
            "image/avif",
            "image/bmp",
            "image/x-icon",
        ] {
            assert!(is_indexable_image_mime(Some(mime_type)), "{mime_type}");
        }
        for mime_type in [
            None,
            Some("image/svg+xml"),
            Some("text/html"),
            Some("video/mp4"),
        ] {
            assert!(!is_indexable_image_mime(mime_type));
        }
    }

    #[test]
    fn rejects_active_unknown_and_non_webm_ebml_content() {
        assert_eq!(
            sniff_media_type(b"<svg><script>alert(1)</script></svg>"),
            None
        );
        assert_eq!(sniff_media_type(b"plain text named photo.jpg"), None);
        assert_eq!(
            sniff_media_type(b"\x1a\x45\xdf\xa3\xa3\x42\x82\x88matroska"),
            None
        );
        assert_eq!(safe_preview_mime("image/svg+xml"), None);
        assert_eq!(safe_preview_mime("text/html"), None);
    }

    #[test]
    fn honors_only_matching_if_range_validators() {
        let last_modified = UNIX_EPOCH + Duration::from_secs(1_800_000_000);
        let etag = "\"current-checksum\"";
        assert!(if_range_matches(etag, etag, last_modified));
        assert!(!if_range_matches("\"stale-checksum\"", etag, last_modified));
        assert!(!if_range_matches(
            "W/\"current-checksum\"",
            etag,
            last_modified
        ));
        assert!(if_range_matches(
            "Tue, 14 Nov 2028 00:00:00 GMT",
            etag,
            last_modified
        ));
        assert!(!if_range_matches("not a validator", etag, last_modified));
    }

    #[test]
    fn matches_if_none_match_with_weak_comparison_and_wildcards() {
        let etag = "\"current-checksum\"";
        assert!(if_none_match_matches(etag, etag));
        assert!(if_none_match_matches("W/\"current-checksum\"", etag));
        assert!(if_none_match_matches(
            "\"other\", W/\"current-checksum\"",
            etag
        ));
        assert!(if_none_match_matches("*", etag));
        assert!(!if_none_match_matches("W/\"other\"", etag));
    }

    #[test]
    fn limits_viewer_derivatives_to_indexer_supported_formats() {
        for mime_type in ["image/jpeg", "image/png", "image/webp"] {
            assert!(supports_viewer_derivative(Some(mime_type)), "{mime_type}");
        }
        for mime_type in [Some("image/gif"), Some("image/avif"), None] {
            assert!(!supports_viewer_derivative(mime_type));
        }
    }
}
