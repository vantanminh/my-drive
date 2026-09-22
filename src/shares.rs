use argon2::{Argon2, PasswordVerifier, password_hash::PasswordHash};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{
        HeaderMap, HeaderName, HeaderValue, StatusCode,
        header::{CACHE_CONTROL, COOKIE, SET_COOKIE},
    },
    response::{IntoResponse, Response},
    routing::{get, post},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::FromRow;
use thiserror::Error;
use uuid::Uuid;

use crate::{
    auth::{self, AuthenticatedUser},
    drive::{self, DriveError},
    health::AppState,
    transfers::{self, TransferError},
};

const SHARE_TOKEN_BYTES: usize = 32;
const ACCESS_GRANT_TTL_SECONDS: i64 = 30 * 60;
const PASSWORD_MIN_BYTES: usize = 8;
const PASSWORD_MAX_BYTES: usize = 128;
const PASSWORD_FAILURE_LIMIT: i32 = 5;
const PASSWORD_LOCKOUT_SECONDS: i64 = 15 * 60;
const DEFAULT_PAGE_SIZE: u16 = 50;
const MAX_PAGE_SIZE: u16 = 100;
const MAX_PAGE_OFFSET: i64 = 1_000_000;
const ACCESS_COOKIE_NAME: &str = "my_drive_share_access";

#[derive(Debug, Error)]
enum ShareError {
    #[error("invalid request")]
    BadRequest,
    #[error("share not found")]
    NotFound,
    #[error("download is disabled for this share")]
    Forbidden,
    #[error("share password is required")]
    PasswordRequired,
    #[error("share password is invalid")]
    InvalidPassword,
    #[error("share password attempts are temporarily limited")]
    TooManyAttempts(u64),
    #[error("share is expired, revoked, or exhausted")]
    Gone,
    #[error("share conflicts with existing state")]
    Conflict,
    #[error("cryptographic operation failed")]
    Crypto,
    #[error("database operation failed")]
    Database(#[source] sqlx::Error),
    #[error("drive authorization failed")]
    Drive(#[from] DriveError),
    #[error("download failed")]
    Transfer(#[from] TransferError),
}

impl IntoResponse for ShareError {
    fn into_response(self) -> Response {
        if let Self::Drive(error) = self {
            return error.into_response();
        }
        if let Self::Transfer(error) = self {
            return error.into_response();
        }

        let (status, code, retry_after) = match self {
            Self::BadRequest => (StatusCode::BAD_REQUEST, "invalid_request", None),
            Self::NotFound => (StatusCode::NOT_FOUND, "not_found", None),
            Self::Forbidden => (StatusCode::FORBIDDEN, "download_disabled", None),
            Self::PasswordRequired => (StatusCode::UNAUTHORIZED, "password_required", None),
            Self::InvalidPassword => (StatusCode::UNAUTHORIZED, "invalid_password", None),
            Self::TooManyAttempts(seconds) => (
                StatusCode::TOO_MANY_REQUESTS,
                "too_many_attempts",
                Some(seconds.max(1)),
            ),
            Self::Gone => (StatusCode::GONE, "share_unavailable", None),
            Self::Conflict => (StatusCode::CONFLICT, "conflict", None),
            Self::Crypto => {
                tracing::error!("share cryptographic operation failed");
                (StatusCode::SERVICE_UNAVAILABLE, "service_unavailable", None)
            }
            Self::Database(error) => {
                tracing::error!(error = %error, "share database operation failed");
                (StatusCode::SERVICE_UNAVAILABLE, "service_unavailable", None)
            }
            Self::Drive(_) | Self::Transfer(_) => unreachable!(),
        };

        let mut response = (status, Json(ErrorBody { error: code })).into_response();
        response
            .headers_mut()
            .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
        if let Some(seconds) = retry_after
            && let Ok(value) = HeaderValue::from_str(&seconds.to_string())
        {
            response
                .headers_mut()
                .insert(HeaderName::from_static("retry-after"), value);
        }
        response
    }
}

#[derive(Serialize)]
struct ErrorBody {
    error: &'static str,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum ResourceType {
    File,
    Folder,
}

impl ResourceType {
    fn as_str(self) -> &'static str {
        match self {
            Self::File => "file",
            Self::Folder => "folder",
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateShare {
    resource_type: ResourceType,
    resource_id: Uuid,
    expires_at: Option<DateTime<Utc>>,
    password: Option<String>,
    allow_download: Option<bool>,
    max_downloads: Option<u64>,
}

#[derive(Serialize)]
struct CreatedShare {
    id: Uuid,
    resource_type: ResourceType,
    resource_id: Uuid,
    share_url: String,
    expires_at: Option<DateTime<Utc>>,
    password_protected: bool,
    allow_download: bool,
    max_downloads: Option<i64>,
}

#[derive(Deserialize, Default)]
struct PageQuery {
    limit: Option<u16>,
    offset: Option<i64>,
}

#[derive(Serialize, FromRow)]
struct ShareSummary {
    id: Uuid,
    resource_type: String,
    resource_id: Uuid,
    resource_name: String,
    expires_at: Option<DateTime<Utc>>,
    revoked_at: Option<DateTime<Utc>>,
    password_protected: bool,
    allow_download: bool,
    max_downloads: Option<i64>,
    download_count: i64,
    created_at: DateTime<Utc>,
    last_accessed_at: Option<DateTime<Utc>>,
}

#[derive(Serialize)]
struct ShareList {
    shares: Vec<ShareSummary>,
    next_offset: Option<i64>,
}

#[derive(Serialize)]
struct PublicEntry {
    id: Uuid,
    name: String,
    kind: String,
    size_bytes: Option<i64>,
    updated_at: DateTime<Utc>,
}

#[derive(FromRow)]
struct PublicEntryRow {
    id: Uuid,
    name: String,
    kind: String,
    size_bytes: Option<i64>,
    updated_at: DateTime<Utc>,
}

impl From<PublicEntryRow> for PublicEntry {
    fn from(value: PublicEntryRow) -> Self {
        Self {
            id: value.id,
            name: value.name,
            kind: value.kind,
            size_bytes: value.size_bytes,
            updated_at: value.updated_at,
        }
    }
}

#[derive(Serialize)]
struct Breadcrumb {
    id: Uuid,
    name: String,
}

#[derive(Serialize)]
struct PublicShareView {
    share_id: Uuid,
    resource: PublicEntry,
    current_folder: Option<Uuid>,
    breadcrumbs: Vec<Breadcrumb>,
    entries: Vec<PublicEntry>,
    allow_download: bool,
    expires_at: Option<DateTime<Utc>>,
    next_offset: Option<i64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UnlockShare {
    password: String,
}

#[derive(FromRow)]
struct ShareRecord {
    id: Uuid,
    owner_id: Uuid,
    resource_type: String,
    resource_id: Uuid,
    password_hash: Option<String>,
    expires_at: Option<DateTime<Utc>>,
    allow_download: bool,
    password_locked_until: Option<DateTime<Utc>>,
}

#[derive(FromRow)]
struct FailedPasswordUpdate {
    failed_password_attempts: i32,
    password_locked_until: Option<DateTime<Utc>>,
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/shares", get(list_shares).post(create_share))
        .route("/api/shares/{id}/revoke", post(revoke_share))
        .route("/api/public/shares/{token}", get(public_share))
        .route("/api/public/shares/{token}/unlock", post(unlock_share))
        .route(
            "/api/public/shares/{token}/download/{entry_id}",
            get(download_shared),
        )
        .route(
            "/api/public/shares/{token}/preview/{entry_id}",
            get(preview_shared),
        )
        .route(
            "/api/public/shares/{token}/thumbnail/{entry_id}",
            get(thumbnail_shared),
        )
        .layer(DefaultBodyLimit::max(16 * 1024))
}

async fn create_share(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
    Json(request): Json<CreateShare>,
) -> Result<Response, ShareError> {
    drive::require_request_csrf(&headers, &user, state.auth_settings)?;
    if request
        .expires_at
        .is_some_and(|expires_at| expires_at <= Utc::now())
    {
        return Err(ShareError::BadRequest);
    }
    if request.password.as_ref().is_some_and(|password| {
        password.len() < PASSWORD_MIN_BYTES || password.len() > PASSWORD_MAX_BYTES
    }) {
        return Err(ShareError::BadRequest);
    }
    let max_downloads = request
        .max_downloads
        .map(i64::try_from)
        .transpose()
        .map_err(|_| ShareError::BadRequest)?;
    if max_downloads.is_some_and(|count| count <= 0) {
        return Err(ShareError::BadRequest);
    }

    let require_folder = matches!(request.resource_type, ResourceType::Folder);
    drive::ensure_active_entry(&state, user.id, request.resource_id, require_folder).await?;
    let actual_type: Option<String> =
        sqlx::query_scalar("SELECT kind FROM drive_entries WHERE id = $1 AND owner_id = $2")
            .bind(request.resource_id)
            .bind(user.id)
            .fetch_optional(&state.pool)
            .await
            .map_err(map_database_error)?;
    if actual_type.as_deref() != Some(request.resource_type.as_str()) {
        return Err(ShareError::BadRequest);
    }

    let password_hash = if let Some(password) = request.password.as_ref() {
        let password = password.clone();
        Some(
            tokio::task::spawn_blocking(move || auth::password_hash(&password))
                .await
                .map_err(|_| ShareError::Crypto)?
                .map_err(|_| ShareError::Crypto)?,
        )
    } else {
        None
    };
    let (raw_token, token) = secure_token()?;
    let token_digest = Sha256::digest(&raw_token).to_vec();
    let share_id = Uuid::new_v4();
    let allow_download = request.allow_download.unwrap_or(true);

    let mut transaction = state.pool.begin().await.map_err(map_database_error)?;
    sqlx::query(
        "INSERT INTO shares \
            (id, owner_id, resource_type, resource_id, token_digest, password_hash, expires_at, allow_download, max_downloads) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    )
    .bind(share_id)
    .bind(user.id)
    .bind(request.resource_type.as_str())
    .bind(request.resource_id)
    .bind(token_digest)
    .bind(password_hash.as_deref())
    .bind(request.expires_at)
    .bind(allow_download)
    .bind(max_downloads)
    .execute(&mut *transaction)
    .await
    .map_err(map_database_error)?;
    sqlx::query(
        "INSERT INTO audit_events (event_type, actor_id, resource_id, details) \
         VALUES ('share_created', $1, $2, $3)",
    )
    .bind(user.id)
    .bind(request.resource_id)
    .bind(json!({ "share_id": share_id, "resource_type": request.resource_type.as_str() }))
    .execute(&mut *transaction)
    .await
    .map_err(map_database_error)?;
    transaction.commit().await.map_err(map_database_error)?;

    let response = (
        StatusCode::CREATED,
        Json(CreatedShare {
            id: share_id,
            resource_type: request.resource_type,
            resource_id: request.resource_id,
            share_url: format!("/s/{token}"),
            expires_at: request.expires_at,
            password_protected: password_hash.is_some(),
            allow_download,
            max_downloads,
        }),
    )
        .into_response();
    Ok(no_store(response))
}

async fn list_shares(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Query(query): Query<PageQuery>,
) -> Result<Response, ShareError> {
    let (limit, offset) = page_values(query.limit, query.offset)?;
    let rows: Vec<ShareSummary> = sqlx::query_as(
        "SELECT share.id, share.resource_type, share.resource_id, entry.name AS resource_name, \
                share.expires_at, share.revoked_at, (share.password_hash IS NOT NULL) AS password_protected, \
                share.allow_download, share.max_downloads, share.download_count, share.created_at, share.last_accessed_at \
           FROM shares AS share \
           JOIN drive_entries AS entry ON entry.id = share.resource_id AND entry.owner_id = share.owner_id \
          WHERE share.owner_id = $1 \
          ORDER BY share.created_at DESC, share.id \
          LIMIT $2 OFFSET $3",
    )
    .bind(user.id)
    .bind(i64::from(limit) + 1)
    .bind(offset)
    .fetch_all(&state.pool)
    .await
    .map_err(map_database_error)?;
    let has_more = rows.len() > usize::from(limit);
    let mut shares = rows;
    if has_more {
        shares.pop();
    }
    let next_offset = has_more.then_some(offset + i64::from(limit));
    Ok(no_store(
        Json(ShareList {
            shares,
            next_offset,
        })
        .into_response(),
    ))
}

async fn revoke_share(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response, ShareError> {
    drive::require_request_csrf(&headers, &user, state.auth_settings)?;
    let mut transaction = state.pool.begin().await.map_err(map_database_error)?;
    let resource_id: Option<Uuid> = sqlx::query_scalar(
        "UPDATE shares SET revoked_at = COALESCE(revoked_at, now()) \
          WHERE id = $1 AND owner_id = $2 \
          RETURNING resource_id",
    )
    .bind(id)
    .bind(user.id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(map_database_error)?;
    let Some(resource_id) = resource_id else {
        return Err(ShareError::NotFound);
    };
    sqlx::query("DELETE FROM share_access_sessions WHERE share_id = $1")
        .bind(id)
        .execute(&mut *transaction)
        .await
        .map_err(map_database_error)?;
    sqlx::query(
        "INSERT INTO audit_events (event_type, actor_id, resource_id, details) \
         VALUES ('share_revoked', $1, $2, $3)",
    )
    .bind(user.id)
    .bind(resource_id)
    .bind(json!({ "share_id": id }))
    .execute(&mut *transaction)
    .await
    .map_err(map_database_error)?;
    transaction.commit().await.map_err(map_database_error)?;
    Ok(no_store(StatusCode::NO_CONTENT.into_response()))
}

#[derive(Deserialize, Default)]
struct PublicShareQuery {
    folder_id: Option<Uuid>,
    limit: Option<u16>,
    offset: Option<i64>,
}

async fn public_share(
    State(state): State<AppState>,
    Path(token): Path<String>,
    Query(query): Query<PublicShareQuery>,
    headers: HeaderMap,
) -> Result<Response, ShareError> {
    let share = fetch_active_share(&state, &token).await?;
    require_password_grant(&state, &headers, &share).await?;

    let root = fetch_public_entry(&state, share.owner_id, share.resource_id).await?;
    let (current_folder, breadcrumbs, entries, next_offset) = if share.resource_type == "file" {
        if query.folder_id.is_some() || root.kind != "file" {
            return Err(ShareError::NotFound);
        }
        (None, Vec::new(), Vec::new(), None)
    } else {
        if root.kind != "folder" {
            return Err(ShareError::NotFound);
        }
        let folder_id = query.folder_id.unwrap_or(share.resource_id);
        if !folder_in_share(&state, share.owner_id, share.resource_id, folder_id).await? {
            return Err(ShareError::NotFound);
        }
        drive::ensure_active_entry(&state, share.owner_id, folder_id, true).await?;
        let (limit, offset) = page_values(query.limit, query.offset)?;
        let breadcrumbs =
            fetch_breadcrumbs(&state, share.owner_id, folder_id, share.resource_id).await?;
        let rows: Vec<PublicEntryRow> = sqlx::query_as(
            "SELECT entry.id, entry.name, entry.kind, version.size_bytes, entry.updated_at \
               FROM drive_entries AS entry \
               LEFT JOIN files AS file ON file.id = entry.id \
               LEFT JOIN file_versions AS version ON version.id = file.current_version_id \
              WHERE entry.owner_id = $1 AND entry.parent_id = $2 AND entry.deleted_at IS NULL \
              ORDER BY lower(entry.name), entry.id \
              LIMIT $3 OFFSET $4",
        )
        .bind(share.owner_id)
        .bind(folder_id)
        .bind(i64::from(limit) + 1)
        .bind(offset)
        .fetch_all(&state.pool)
        .await
        .map_err(map_database_error)?;
        let has_more = rows.len() > usize::from(limit);
        let mut entries = rows.into_iter().map(PublicEntry::from).collect::<Vec<_>>();
        if has_more {
            entries.pop();
        }
        (
            Some(folder_id),
            breadcrumbs,
            entries,
            has_more.then_some(offset + i64::from(limit)),
        )
    };

    touch_share(&state, share.id).await?;
    Ok(no_store(
        Json(PublicShareView {
            share_id: share.id,
            resource: root,
            current_folder,
            breadcrumbs,
            entries,
            allow_download: share.allow_download,
            expires_at: share.expires_at,
            next_offset,
        })
        .into_response(),
    ))
}

async fn unlock_share(
    State(state): State<AppState>,
    Path(token): Path<String>,
    Json(request): Json<UnlockShare>,
) -> Result<Response, ShareError> {
    let share = fetch_active_share(&state, &token).await?;
    let Some(password_hash) = share.password_hash.clone() else {
        return Err(ShareError::BadRequest);
    };
    if request.password.len() > PASSWORD_MAX_BYTES {
        return Err(ShareError::BadRequest);
    }
    if let Some(locked_until) = share.password_locked_until
        && locked_until > Utc::now()
    {
        return Err(ShareError::TooManyAttempts(
            (locked_until - Utc::now()).num_seconds().max(1) as u64,
        ));
    }

    let password = request.password;
    let valid = tokio::task::spawn_blocking(move || verify_password(&password_hash, &password))
        .await
        .map_err(|_| ShareError::Crypto)?;
    if !valid {
        let password_error = record_password_failure(&state, &share).await?;
        return Err(password_error);
    }

    let (raw_grant, grant) = secure_token()?;
    let digest = Sha256::digest(&raw_grant).to_vec();
    let token_digest = share_token_digest(&token)?;
    let mut transaction = state.pool.begin().await.map_err(map_database_error)?;
    let active_id: Option<Uuid> = sqlx::query_scalar(
        "UPDATE shares SET failed_password_attempts = 0, password_locked_until = NULL, last_accessed_at = now() \
          WHERE id = $1 AND token_digest = $2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) \
            AND password_hash IS NOT NULL \
          RETURNING id",
    )
    .bind(share.id)
    .bind(token_digest)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(map_database_error)?;
    if active_id.is_none() {
        return Err(ShareError::NotFound);
    }
    let inserted = sqlx::query(
        "INSERT INTO share_access_sessions (token_digest, share_id, expires_at) \
         SELECT $1, id, LEAST(COALESCE(expires_at, $3), $3) FROM shares \
          WHERE id = $2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())",
    )
    .bind(digest)
    .bind(share.id)
    .bind(Utc::now() + ChronoDuration::seconds(ACCESS_GRANT_TTL_SECONDS))
    .execute(&mut *transaction)
    .await
    .map_err(map_database_error)?;
    if inserted.rows_affected() != 1 {
        return Err(ShareError::NotFound);
    }
    sqlx::query(
        "INSERT INTO audit_events (event_type, actor_id, resource_id, details) \
         VALUES ('share_password_success', NULL, $1, $2)",
    )
    .bind(share.resource_id)
    .bind(json!({ "share_id": share.id }))
    .execute(&mut *transaction)
    .await
    .map_err(map_database_error)?;
    transaction.commit().await.map_err(map_database_error)?;

    let secure = if state.auth_settings.cookie_secure {
        "; Secure"
    } else {
        ""
    };
    let cookie_path = format!("/api/public/shares/{token}");
    let cookie = format!(
        "{ACCESS_COOKIE_NAME}={grant}; Path={cookie_path}; Max-Age={ACCESS_GRANT_TTL_SECONDS}; SameSite=Strict; HttpOnly{secure}"
    );
    let mut response = StatusCode::NO_CONTENT.into_response();
    response.headers_mut().append(
        SET_COOKIE,
        HeaderValue::from_str(&cookie).map_err(|_| ShareError::Crypto)?,
    );
    Ok(no_store(response))
}

async fn download_shared(
    State(state): State<AppState>,
    Path((token, entry_id)): Path<(String, Uuid)>,
    headers: HeaderMap,
) -> Result<Response, ShareError> {
    let share = fetch_active_share(&state, &token).await?;
    require_password_grant(&state, &headers, &share).await?;
    if !share.allow_download {
        return Err(ShareError::Forbidden);
    }
    if !file_in_share(
        &state,
        share.owner_id,
        share.resource_type.as_str(),
        share.resource_id,
        entry_id,
    )
    .await?
    {
        return Err(ShareError::NotFound);
    }
    reserve_download(&state, &share, entry_id).await?;
    transfers::download_response(&state, share.owner_id, entry_id, &headers, false)
        .await
        .map_err(ShareError::Transfer)
}

async fn preview_shared(
    State(state): State<AppState>,
    Path((token, entry_id)): Path<(String, Uuid)>,
    headers: HeaderMap,
) -> Result<Response, ShareError> {
    let share = fetch_active_share(&state, &token).await?;
    require_password_grant(&state, &headers, &share).await?;
    if !file_in_share(
        &state,
        share.owner_id,
        share.resource_type.as_str(),
        share.resource_id,
        entry_id,
    )
    .await?
    {
        return Err(ShareError::NotFound);
    }
    if share.allow_download {
        transfers::preview_response(&state, share.owner_id, entry_id, &headers, false)
            .await
            .map_err(ShareError::Transfer)
    } else {
        transfers::preview_derivative_response(&state, share.owner_id, entry_id, &headers, false)
            .await
            .map_err(ShareError::Transfer)
    }
}

async fn thumbnail_shared(
    State(state): State<AppState>,
    Path((token, entry_id)): Path<(String, Uuid)>,
    headers: HeaderMap,
) -> Result<Response, ShareError> {
    let share = fetch_active_share(&state, &token).await?;
    require_password_grant(&state, &headers, &share).await?;
    if !file_in_share(
        &state,
        share.owner_id,
        share.resource_type.as_str(),
        share.resource_id,
        entry_id,
    )
    .await?
    {
        return Err(ShareError::NotFound);
    }
    transfers::thumbnail_response(&state, share.owner_id, entry_id, &headers, false)
        .await
        .map_err(ShareError::Transfer)
}

async fn fetch_active_share(state: &AppState, token: &str) -> Result<ShareRecord, ShareError> {
    let token_digest = share_token_digest(token)?;
    let share: ShareRecord = sqlx::query_as(
        "SELECT id, owner_id, resource_type, resource_id, password_hash, expires_at, \
                allow_download, password_locked_until \
           FROM shares \
          WHERE token_digest = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())",
    )
    .bind(token_digest)
    .fetch_optional(&state.pool)
    .await
    .map_err(map_database_error)?
    .ok_or(ShareError::NotFound)?;
    let require_folder = share.resource_type == "folder";
    drive::ensure_active_entry(state, share.owner_id, share.resource_id, require_folder).await?;
    let actual_kind: Option<String> =
        sqlx::query_scalar("SELECT kind FROM drive_entries WHERE id = $1 AND owner_id = $2")
            .bind(share.resource_id)
            .bind(share.owner_id)
            .fetch_optional(&state.pool)
            .await
            .map_err(map_database_error)?;
    if actual_kind.as_deref() != Some(share.resource_type.as_str()) {
        return Err(ShareError::NotFound);
    }
    Ok(share)
}

async fn require_password_grant(
    state: &AppState,
    headers: &HeaderMap,
    share: &ShareRecord,
) -> Result<(), ShareError> {
    if share.password_hash.is_none() {
        return Ok(());
    }
    let Some(grant) = cookie_value(headers, ACCESS_COOKIE_NAME) else {
        return Err(ShareError::PasswordRequired);
    };
    let Ok(raw_grant) = URL_SAFE_NO_PAD.decode(grant) else {
        return Err(ShareError::PasswordRequired);
    };
    if raw_grant.len() != SHARE_TOKEN_BYTES {
        return Err(ShareError::PasswordRequired);
    }
    let digest = Sha256::digest(&raw_grant).to_vec();
    let valid: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM share_access_sessions \
          WHERE share_id = $1 AND token_digest = $2 AND expires_at > now())",
    )
    .bind(share.id)
    .bind(digest)
    .fetch_one(&state.pool)
    .await
    .map_err(map_database_error)?;
    if valid {
        Ok(())
    } else {
        Err(ShareError::PasswordRequired)
    }
}

async fn record_password_failure(
    state: &AppState,
    share: &ShareRecord,
) -> Result<ShareError, ShareError> {
    let mut transaction = state.pool.begin().await.map_err(map_database_error)?;
    let update: Option<FailedPasswordUpdate> = sqlx::query_as(
        "UPDATE shares \
            SET failed_password_attempts = CASE \
                    WHEN password_locked_until IS NOT NULL AND password_locked_until <= now() THEN 1 \
                    ELSE failed_password_attempts + 1 END, \
                password_locked_until = CASE \
                    WHEN password_locked_until IS NOT NULL AND password_locked_until <= now() THEN NULL \
                    WHEN failed_password_attempts + 1 >= $2 THEN now() + ($3 * INTERVAL '1 second') \
                    ELSE NULL END \
          WHERE id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) \
            AND (password_locked_until IS NULL OR password_locked_until <= now()) \
          RETURNING failed_password_attempts, password_locked_until",
    )
    .bind(share.id)
    .bind(PASSWORD_FAILURE_LIMIT)
    .bind(PASSWORD_LOCKOUT_SECONDS)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(map_database_error)?;
    let Some(update) = update else {
        transaction.rollback().await.map_err(map_database_error)?;
        let locked_until: Option<DateTime<Utc>> = sqlx::query_scalar(
            "SELECT password_locked_until FROM shares WHERE id = $1 AND revoked_at IS NULL \
              AND (expires_at IS NULL OR expires_at > now())",
        )
        .bind(share.id)
        .fetch_optional(&state.pool)
        .await
        .map_err(map_database_error)?
        .flatten();
        return if let Some(locked_until) = locked_until.filter(|value| *value > Utc::now()) {
            Ok(ShareError::TooManyAttempts(
                (locked_until - Utc::now()).num_seconds().max(1) as u64,
            ))
        } else {
            Ok(ShareError::NotFound)
        };
    };
    sqlx::query(
        "INSERT INTO audit_events (event_type, actor_id, resource_id, details) \
         VALUES ('share_password_failure', NULL, $1, $2)",
    )
    .bind(share.resource_id)
    .bind(json!({
        "share_id": share.id,
        "attempts": update.failed_password_attempts
    }))
    .execute(&mut *transaction)
    .await
    .map_err(map_database_error)?;
    transaction.commit().await.map_err(map_database_error)?;
    if let Some(locked_until) = update
        .password_locked_until
        .filter(|value| *value > Utc::now())
    {
        Ok(ShareError::TooManyAttempts(
            (locked_until - Utc::now()).num_seconds().max(1) as u64,
        ))
    } else {
        Ok(ShareError::InvalidPassword)
    }
}

async fn reserve_download(
    state: &AppState,
    share: &ShareRecord,
    entry_id: Uuid,
) -> Result<(), ShareError> {
    let mut transaction = state.pool.begin().await.map_err(map_database_error)?;
    let count: Option<i64> = sqlx::query_scalar(
        "UPDATE shares \
            SET download_count = download_count + 1, last_accessed_at = now() \
          WHERE id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) \
            AND allow_download AND (max_downloads IS NULL OR download_count < max_downloads) \
          RETURNING download_count",
    )
    .bind(share.id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(map_database_error)?;
    let Some(count) = count else {
        return Err(ShareError::Gone);
    };
    sqlx::query(
        "INSERT INTO audit_events (event_type, actor_id, resource_id, details) \
         VALUES ('share_download', NULL, $1, $2)",
    )
    .bind(entry_id)
    .bind(json!({ "share_id": share.id, "download_count": count }))
    .execute(&mut *transaction)
    .await
    .map_err(map_database_error)?;
    transaction.commit().await.map_err(map_database_error)?;
    Ok(())
}

async fn fetch_public_entry(
    state: &AppState,
    owner_id: Uuid,
    id: Uuid,
) -> Result<PublicEntry, ShareError> {
    let row: PublicEntryRow = sqlx::query_as(
        "SELECT entry.id, entry.name, entry.kind, version.size_bytes, entry.updated_at \
           FROM drive_entries AS entry \
           LEFT JOIN files AS file ON file.id = entry.id \
           LEFT JOIN file_versions AS version ON version.id = file.current_version_id \
          WHERE entry.id = $1 AND entry.owner_id = $2 AND entry.deleted_at IS NULL",
    )
    .bind(id)
    .bind(owner_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(map_database_error)?
    .ok_or(ShareError::NotFound)?;
    Ok(row.into())
}

async fn folder_in_share(
    state: &AppState,
    owner_id: Uuid,
    share_root_id: Uuid,
    folder_id: Uuid,
) -> Result<bool, ShareError> {
    let within_share: bool = sqlx::query_scalar(
        "WITH RECURSIVE parent_chain(id, parent_id, deleted_at, kind) AS ( \
             SELECT id, parent_id, deleted_at, kind FROM drive_entries \
              WHERE id = $1 AND owner_id = $2 AND kind = 'folder' \
             UNION ALL \
             SELECT parent.id, parent.parent_id, parent.deleted_at, parent.kind \
               FROM drive_entries AS parent \
               JOIN parent_chain AS child ON parent.id = child.parent_id \
              WHERE parent.owner_id = $2 \
         ) \
         SELECT EXISTS (SELECT 1 FROM parent_chain WHERE id = $3 AND kind = 'folder') \
            AND NOT EXISTS (SELECT 1 FROM parent_chain WHERE deleted_at IS NOT NULL)",
    )
    .bind(folder_id)
    .bind(owner_id)
    .bind(share_root_id)
    .fetch_one(&state.pool)
    .await
    .map_err(map_database_error)?;
    Ok(within_share)
}

async fn file_in_share(
    state: &AppState,
    owner_id: Uuid,
    resource_type: &str,
    share_root_id: Uuid,
    file_id: Uuid,
) -> Result<bool, ShareError> {
    let in_scope: bool = sqlx::query_scalar(
        "WITH RECURSIVE parent_chain(id, parent_id, deleted_at) AS ( \
             SELECT id, parent_id, deleted_at FROM drive_entries \
              WHERE id = $1 AND owner_id = $2 AND kind = 'file' \
             UNION ALL \
             SELECT parent.id, parent.parent_id, parent.deleted_at \
               FROM drive_entries AS parent \
               JOIN parent_chain AS child ON parent.id = child.parent_id \
              WHERE parent.owner_id = $2 \
         ) \
         SELECT NOT EXISTS (SELECT 1 FROM parent_chain WHERE deleted_at IS NOT NULL) \
            AND EXISTS (SELECT 1 FROM parent_chain WHERE id = $3) \
            AND ($4 = 'folder' OR $1 = $3)",
    )
    .bind(file_id)
    .bind(owner_id)
    .bind(share_root_id)
    .bind(resource_type)
    .fetch_one(&state.pool)
    .await
    .map_err(map_database_error)?;
    Ok(in_scope)
}

async fn fetch_breadcrumbs(
    state: &AppState,
    owner_id: Uuid,
    folder_id: Uuid,
    root_id: Uuid,
) -> Result<Vec<Breadcrumb>, ShareError> {
    #[derive(FromRow)]
    struct BreadcrumbRow {
        id: Uuid,
        name: String,
    }
    let rows: Vec<BreadcrumbRow> = sqlx::query_as(
        "WITH RECURSIVE breadcrumb(id, parent_id, name, depth) AS ( \
             SELECT id, parent_id, name, 0 FROM drive_entries WHERE id = $1 AND owner_id = $2 \
             UNION ALL \
             SELECT parent.id, parent.parent_id, parent.name, child.depth + 1 \
               FROM drive_entries AS parent \
               JOIN breadcrumb AS child ON parent.id = child.parent_id \
              WHERE child.id <> $3 AND parent.owner_id = $2 AND parent.deleted_at IS NULL \
         ) \
         SELECT id, name FROM breadcrumb ORDER BY depth DESC",
    )
    .bind(folder_id)
    .bind(owner_id)
    .bind(root_id)
    .fetch_all(&state.pool)
    .await
    .map_err(map_database_error)?;
    Ok(rows
        .into_iter()
        .map(|row| Breadcrumb {
            id: row.id,
            name: row.name,
        })
        .collect())
}

async fn touch_share(state: &AppState, id: Uuid) -> Result<(), ShareError> {
    let result = sqlx::query(
        "UPDATE shares SET last_accessed_at = now() \
          WHERE id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())",
    )
    .bind(id)
    .execute(&state.pool)
    .await
    .map_err(map_database_error)?;
    if result.rows_affected() == 1 {
        Ok(())
    } else {
        Err(ShareError::NotFound)
    }
}

fn page_values(limit: Option<u16>, offset: Option<i64>) -> Result<(u16, i64), ShareError> {
    let limit = limit.unwrap_or(DEFAULT_PAGE_SIZE);
    let offset = offset.unwrap_or(0);
    if limit == 0 || limit > MAX_PAGE_SIZE || !(0..=MAX_PAGE_OFFSET).contains(&offset) {
        return Err(ShareError::BadRequest);
    }
    Ok((limit, offset))
}

fn verify_password(encoded_hash: &str, password: &str) -> bool {
    let Ok(hash) = PasswordHash::new(encoded_hash) else {
        return false;
    };
    Argon2::default()
        .verify_password(password.as_bytes(), &hash)
        .is_ok()
}

fn secure_token() -> Result<(Vec<u8>, String), ShareError> {
    let mut raw = vec![0_u8; SHARE_TOKEN_BYTES];
    OsRng
        .try_fill_bytes(&mut raw)
        .map_err(|_| ShareError::Crypto)?;
    let token = URL_SAFE_NO_PAD.encode(&raw);
    Ok((raw, token))
}

fn share_token_digest(token: &str) -> Result<Vec<u8>, ShareError> {
    if token.len() > 64 {
        return Err(ShareError::NotFound);
    }
    let raw = URL_SAFE_NO_PAD
        .decode(token)
        .map_err(|_| ShareError::NotFound)?;
    if raw.len() != SHARE_TOKEN_BYTES {
        return Err(ShareError::NotFound);
    }
    Ok(Sha256::digest(raw).to_vec())
}

fn cookie_value<'a>(headers: &'a HeaderMap, wanted_name: &str) -> Option<&'a str> {
    let cookie_header = headers.get(COOKIE)?.to_str().ok()?;
    let mut result = None;
    for cookie in cookie_header.split(';') {
        let (name, value) = cookie.trim().split_once('=')?;
        if name == wanted_name {
            if result.is_some() {
                return None;
            }
            result = Some(value);
        }
    }
    result
}

fn no_store(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn map_database_error(error: sqlx::Error) -> ShareError {
    match &error {
        sqlx::Error::Database(database_error) => match database_error.code().as_deref() {
            Some("23505") | Some("23514") => ShareError::Conflict,
            Some("23503") => ShareError::NotFound,
            _ => ShareError::Database(error),
        },
        _ => ShareError::Database(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_tokens_are_url_safe_256_bit_values_and_only_hashes_are_used_for_lookup() {
        let (raw, token) = secure_token().unwrap();
        assert_eq!(raw.len(), SHARE_TOKEN_BYTES);
        assert_eq!(URL_SAFE_NO_PAD.decode(&token).unwrap(), raw);
        assert_eq!(
            share_token_digest(&token).unwrap(),
            Sha256::digest(&raw).to_vec()
        );
        assert_ne!(share_token_digest(&token).unwrap(), raw);
        assert!(share_token_digest("../outside").is_err());
        assert!(share_token_digest("short").is_err());
    }

    #[test]
    fn share_passwords_are_argon2id_verified_without_exposing_the_password() {
        let password = "a private share password";
        let hash = auth::password_hash(password).unwrap();
        assert!(hash.starts_with("$argon2id$v=19$"));
        assert!(verify_password(&hash, password));
        assert!(!verify_password(&hash, "wrong password"));
        assert!(!hash.contains(password));
    }

    #[test]
    fn share_pagination_is_bounded() {
        assert_eq!(page_values(None, None).unwrap(), (DEFAULT_PAGE_SIZE, 0));
        assert!(page_values(Some(0), None).is_err());
        assert!(page_values(Some(MAX_PAGE_SIZE + 1), None).is_err());
        assert!(page_values(None, Some(-1)).is_err());
    }
}
