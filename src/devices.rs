use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, Method, StatusCode, header::CACHE_CONTROL},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::FromRow;
use uuid::Uuid;

use crate::{
    auth::{AuthenticatedUser, require_csrf},
    drive,
    health::AppState,
};

const ACCESS_TOKEN_PREFIX: &str = "mdb_";
const REFRESH_TOKEN_PREFIX: &str = "mdr_";
const DEVICE_CODE_TTL_SECONDS: i64 = 600;
const ACCESS_TOKEN_TTL_SECONDS: i64 = 3600;
const REFRESH_TOKEN_TTL_SECONDS: i64 = 90 * 24 * 3600;
const DEFAULT_POLL_SECONDS: i32 = 5;
const MAX_POLL_SECONDS: i32 = 30;
const USER_CODE_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const SUPPORTED_API_VERSION: &str = "1";

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    code: &'static str,
    extra: Option<Value>,
}

impl ApiError {
    fn new(status: StatusCode, code: &'static str) -> Self {
        Self {
            status,
            code,
            extra: None,
        }
    }

    fn with_extra(status: StatusCode, code: &'static str, extra: Value) -> Self {
        Self {
            status,
            code,
            extra: Some(extra),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut body = json!({ "error": self.code });
        if let Some(extra) = self.extra
            && let Some(object) = body.as_object_mut()
            && let Some(fields) = extra.as_object()
        {
            for (key, value) in fields {
                object.insert(key.clone(), value.clone());
            }
        }
        no_store((self.status, Json(body)))
    }
}

fn no_store<T: IntoResponse>(response: T) -> Response {
    let mut response = response.into_response();
    response
        .headers_mut()
        .insert(CACHE_CONTROL, "no-store".parse().expect("static header"));
    response
}

fn db(error: sqlx::Error) -> ApiError {
    tracing::error!(error = %error, "backup device database operation failed");
    ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "service_unavailable")
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/.well-known/cloud-client", get(capabilities))
        .route("/api/device/code", post(create_code))
        .route("/api/device/token", post(exchange_token))
        .route("/api/device/refresh", post(refresh_token))
        .route("/api/device/pending", get(pending_request))
        .route("/api/device/authorize", post(approve_request))
        .route("/api/device/deny", post(deny_request))
        .route("/api/device/heartbeat", post(heartbeat))
        .route("/api/device/logout", post(logout_device))
        .route("/api/devices", get(list_devices))
        .route("/api/devices/{id}", delete(revoke_device))
        .route("/api/backup/check", post(check_content))
        .route("/api/backup/link", post(link_content))
        .route("/api/backup/folders", post(ensure_folder))
        .route("/api/files/{id}/versions", get(list_versions))
        .layer(DefaultBodyLimit::max(16 * 1024))
}

async fn capabilities() -> Response {
    no_store(Json(json!({
        "product": "my-drive",
        "apiVersion": SUPPORTED_API_VERSION,
        "serverVersion": env!("CARGO_PKG_VERSION"),
        "minClientApi": SUPPORTED_API_VERSION,
        "maxClientApi": SUPPORTED_API_VERSION,
        "features": {
            "chunkedUpload": true,
            "resumableUpload": true,
            "deduplication": true,
            "fileVersions": true,
            "deviceAuthorization": true,
            "contentHash": "sha256"
        },
        "upload": {
            "protocol": "tus-offset",
            "maxChunkBytes": 64 * 1024 * 1024
        }
    })))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CodeRequest {
    client_name: String,
    client_version: String,
    device_name: String,
    operating_system: String,
}

async fn create_code(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<CodeRequest>,
) -> Result<Response, ApiError> {
    let client_name = clean_label(&request.client_name, 80)?;
    let client_version = clean_label(&request.client_version, 40)?;
    let device_name = clean_label(&request.device_name, 120)?;
    let operating_system = clean_label(&request.operating_system, 120)?;
    let recent: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM device_authorization_requests WHERE created_at > now() - interval '1 minute'",
    )
    .fetch_one(&state.pool)
    .await
    .map_err(db)?;
    if recent >= 30 {
        return Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "too_many_attempts",
        ));
    }
    sqlx::query(
        "UPDATE device_authorization_requests SET status = 'expired' \
          WHERE status = 'pending' AND expires_at <= now()",
    )
    .execute(&state.pool)
    .await
    .map_err(db)?;

    let requested_ip = forwarded_ip(&headers);
    let (device_code, device_digest) = random_token("")?;
    let expires_at = Utc::now() + ChronoDuration::seconds(DEVICE_CODE_TTL_SECONDS);
    for _ in 0..5 {
        let user_code = new_user_code()?;
        let inserted = sqlx::query(
            "INSERT INTO device_authorization_requests \
                (id, device_code_digest, user_code, client_name, device_name, operating_system, \
                 client_version, requested_ip, expires_at, poll_interval_seconds, status) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending')",
        )
        .bind(Uuid::new_v4())
        .bind(&device_digest)
        .bind(&user_code)
        .bind(&client_name)
        .bind(&device_name)
        .bind(&operating_system)
        .bind(&client_version)
        .bind(requested_ip.as_deref())
        .bind(expires_at)
        .bind(DEFAULT_POLL_SECONDS)
        .execute(&state.pool)
        .await;
        match inserted {
            Ok(_) => {
                return Ok(no_store(Json(json!({
                    "device_code": device_code,
                    "user_code": user_code,
                    "verification_uri": "/device/authorize",
                    "verification_uri_complete": format!("/device/authorize?user_code={user_code}"),
                    "expires_in": DEVICE_CODE_TTL_SECONDS,
                    "interval": DEFAULT_POLL_SECONDS
                }))));
            }
            Err(error) if is_unique(&error) => continue,
            Err(error) => return Err(db(error)),
        }
    }
    Err(ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "service_unavailable",
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DeviceCodeRequest {
    grant_type: String,
    device_code: String,
}

async fn exchange_token(
    State(state): State<AppState>,
    Json(request): Json<DeviceCodeRequest>,
) -> Result<Response, ApiError> {
    if request.grant_type != "urn:ietf:params:oauth:grant-type:device_code" {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "unsupported_grant_type",
        ));
    }
    if request.device_code.len() < 20 || request.device_code.len() > 128 {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "invalid_grant"));
    }
    let digest = Sha256::digest(request.device_code.as_bytes()).to_vec();
    let mut transaction = state.pool.begin().await.map_err(db)?;
    let row = sqlx::query_as::<_, PendingGrant>(
        "SELECT id, status, expires_at, poll_interval_seconds, poll_after, device_id, owner_id \
           FROM device_authorization_requests WHERE device_code_digest = $1 FOR UPDATE",
    )
    .bind(digest)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(db)?;
    let Some(grant) = row else {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "invalid_grant"));
    };
    if grant.expires_at <= Utc::now() || grant.status == "expired" {
        sqlx::query(
            "UPDATE device_authorization_requests SET status = 'expired' WHERE id = $1 AND status = 'pending'",
        )
        .bind(grant.id)
        .execute(&mut *transaction)
        .await
        .map_err(db)?;
        transaction.commit().await.map_err(db)?;
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "expired_token"));
    }
    if Utc::now() < grant.poll_after {
        let interval = (grant.poll_interval_seconds + 5).min(MAX_POLL_SECONDS);
        sqlx::query(
            "UPDATE device_authorization_requests \
                SET poll_interval_seconds = $2, poll_after = now() + make_interval(secs => $2) \
              WHERE id = $1",
        )
        .bind(grant.id)
        .bind(interval)
        .execute(&mut *transaction)
        .await
        .map_err(db)?;
        transaction.commit().await.map_err(db)?;
        return Err(ApiError::with_extra(
            StatusCode::BAD_REQUEST,
            "slow_down",
            json!({ "interval": interval }),
        ));
    }
    sqlx::query(
        "UPDATE device_authorization_requests \
            SET poll_after = now() + make_interval(secs => poll_interval_seconds) \
          WHERE id = $1",
    )
    .bind(grant.id)
    .execute(&mut *transaction)
    .await
    .map_err(db)?;
    match grant.status.as_str() {
        "pending" => {
            transaction.commit().await.map_err(db)?;
            Err(ApiError::with_extra(
                StatusCode::BAD_REQUEST,
                "authorization_pending",
                json!({ "interval": grant.poll_interval_seconds }),
            ))
        }
        "denied" => {
            transaction.commit().await.map_err(db)?;
            Err(ApiError::new(StatusCode::BAD_REQUEST, "access_denied"))
        }
        "approved" => {
            let device_id = grant.device_id.ok_or_else(|| {
                ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "service_unavailable")
            })?;
            let tokens = issue_credentials(&mut transaction, device_id).await?;
            sqlx::query(
                "UPDATE device_authorization_requests SET status = 'consumed' WHERE id = $1 AND status = 'approved'",
            )
            .bind(grant.id)
            .execute(&mut *transaction)
            .await
            .map_err(db)?;
            sqlx::query(
                "INSERT INTO audit_events (event_type, actor_id, resource_id, details) \
                 VALUES ('device_token_issued', $1, $2, '{}'::jsonb)",
            )
            .bind(grant.owner_id)
            .bind(device_id)
            .execute(&mut *transaction)
            .await
            .map_err(db)?;
            transaction.commit().await.map_err(db)?;
            Ok(no_store(Json(tokens)))
        }
        _ => {
            transaction.commit().await.map_err(db)?;
            Err(ApiError::new(StatusCode::BAD_REQUEST, "invalid_grant"))
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RefreshRequest {
    grant_type: String,
    refresh_token: String,
}

async fn refresh_token(
    State(state): State<AppState>,
    Json(request): Json<RefreshRequest>,
) -> Result<Response, ApiError> {
    if request.grant_type != "refresh_token" {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "unsupported_grant_type",
        ));
    }
    if !request.refresh_token.starts_with(REFRESH_TOKEN_PREFIX) || request.refresh_token.len() != 47
    {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "invalid_grant"));
    }
    let digest = Sha256::digest(request.refresh_token.as_bytes()).to_vec();
    let mut transaction = state.pool.begin().await.map_err(db)?;
    let credential = sqlx::query_as::<_, RefreshRow>(
        "SELECT c.id, c.device_id, c.revoked_at, c.refresh_expires_at, d.revoked_at AS device_revoked_at, \
                d.owner_id, u.disabled_at IS NULL AS account_enabled \
           FROM device_credentials AS c \
           JOIN backup_devices AS d ON d.id = c.device_id \
           JOIN users AS u ON u.id = d.owner_id \
          WHERE c.refresh_token_digest = $1 FOR UPDATE OF c",
    )
    .bind(digest)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(db)?;
    let Some(credential) = credential else {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "invalid_grant"));
    };
    if credential.revoked_at.is_some() {
        sqlx::query(
            "UPDATE backup_devices SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1",
        )
        .bind(credential.device_id)
        .execute(&mut *transaction)
        .await
        .map_err(db)?;
        sqlx::query(
            "UPDATE device_credentials SET revoked_at = COALESCE(revoked_at, now()) WHERE device_id = $1",
        )
        .bind(credential.device_id)
        .execute(&mut *transaction)
        .await
        .map_err(db)?;
        sqlx::query(
            "INSERT INTO audit_events (event_type, actor_id, resource_id) \
             VALUES ('device_refresh_reuse', $1, $2)",
        )
        .bind(credential.owner_id)
        .bind(credential.device_id)
        .execute(&mut *transaction)
        .await
        .map_err(db)?;
        transaction.commit().await.map_err(db)?;
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "invalid_grant"));
    }
    if credential.device_revoked_at.is_some()
        || !credential.account_enabled
        || credential.refresh_expires_at <= Utc::now()
    {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "invalid_grant"));
    }
    sqlx::query(
        "UPDATE device_credentials SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL",
    )
    .bind(credential.id)
    .execute(&mut *transaction)
    .await
    .map_err(db)?;
    let tokens = issue_credentials(&mut transaction, credential.device_id).await?;
    transaction.commit().await.map_err(db)?;
    Ok(no_store(Json(tokens)))
}

#[derive(Deserialize)]
struct UserCodeQuery {
    user_code: String,
}

async fn pending_request(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Query(query): Query<UserCodeQuery>,
) -> Result<Response, ApiError> {
    reject_device_actor(&user)?;
    let user_code = normalize_user_code(&query.user_code)?;
    let row = sqlx::query_as::<_, PendingView>(
        "SELECT user_code, client_name, device_name, operating_system, client_version, requested_ip, \
                status, created_at, expires_at \
           FROM device_authorization_requests WHERE user_code = $1",
    )
    .bind(user_code)
    .fetch_optional(&state.pool)
    .await
    .map_err(db)?
    .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "not_found"))?;
    Ok(no_store(Json(row)))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UserCodeBody {
    user_code: String,
}

async fn approve_request(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
    Json(body): Json<UserCodeBody>,
) -> Result<Response, ApiError> {
    reject_device_actor(&user)?;
    if !require_csrf(&headers, &user, state.auth_settings) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "csrf_failed"));
    }
    if user.must_change_password {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "password_change_required",
        ));
    }
    let user_code = normalize_user_code(&body.user_code)?;
    let mut transaction = state.pool.begin().await.map_err(db)?;
    let pending = sqlx::query_as::<_, ApprovalRow>(
        "SELECT id, status, expires_at, client_name, device_name, operating_system, client_version \
           FROM device_authorization_requests WHERE user_code = $1 FOR UPDATE",
    )
    .bind(&user_code)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(db)?
    .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "not_found"))?;
    if pending.expires_at <= Utc::now() || pending.status == "expired" {
        sqlx::query(
            "UPDATE device_authorization_requests SET status = 'expired' WHERE id = $1 AND status = 'pending'",
        )
        .bind(pending.id)
        .execute(&mut *transaction)
        .await
        .map_err(db)?;
        transaction.commit().await.map_err(db)?;
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "expired_token"));
    }
    if pending.status != "pending" {
        return Err(ApiError::new(StatusCode::CONFLICT, "conflict"));
    }
    let device_id = Uuid::new_v4();
    let permissions = vec!["backup".to_owned()];
    sqlx::query(
        "INSERT INTO backup_devices \
            (id, owner_id, name, client_name, operating_system, client_version, permissions) \
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(device_id)
    .bind(user.id)
    .bind(&pending.device_name)
    .bind(&pending.client_name)
    .bind(&pending.operating_system)
    .bind(&pending.client_version)
    .bind(&permissions)
    .execute(&mut *transaction)
    .await
    .map_err(db)?;
    sqlx::query(
        "UPDATE device_authorization_requests \
            SET status = 'approved', owner_id = $2, device_id = $3 \
          WHERE id = $1 AND status = 'pending'",
    )
    .bind(pending.id)
    .bind(user.id)
    .bind(device_id)
    .execute(&mut *transaction)
    .await
    .map_err(db)?;
    sqlx::query(
        "INSERT INTO audit_events (event_type, actor_id, resource_id, details) \
         VALUES ('device_authorized', $1, $2, jsonb_build_object('name', $3::text))",
    )
    .bind(user.id)
    .bind(device_id)
    .bind(&pending.device_name)
    .execute(&mut *transaction)
    .await
    .map_err(db)?;
    transaction.commit().await.map_err(db)?;
    Ok(no_store(Json(json!({
        "status": "approved",
        "device_id": device_id,
        "device_name": pending.device_name
    }))))
}

async fn deny_request(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
    Json(body): Json<UserCodeBody>,
) -> Result<Response, ApiError> {
    reject_device_actor(&user)?;
    if !require_csrf(&headers, &user, state.auth_settings) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "csrf_failed"));
    }
    let user_code = normalize_user_code(&body.user_code)?;
    let updated = sqlx::query(
        "UPDATE device_authorization_requests SET status = 'denied' \
          WHERE user_code = $1 AND status = 'pending' AND expires_at > now()",
    )
    .bind(user_code)
    .execute(&state.pool)
    .await
    .map_err(db)?;
    if updated.rows_affected() == 0 {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "not_found"));
    }
    Ok(no_store(Json(json!({ "status": "denied" }))))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HeartbeatRequest {
    #[serde(default)]
    client_version: Option<String>,
}

async fn heartbeat(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
    Json(body): Json<HeartbeatRequest>,
) -> Result<Response, ApiError> {
    let device_id = required_device(&user)?;
    let version = match body.client_version {
        Some(value) => Some(clean_label(&value, 40)?),
        None => None,
    };
    sqlx::query(
        "UPDATE backup_devices \
            SET last_active_at = now(), \
                last_ip = COALESCE($2, last_ip), \
                client_version = COALESCE($3, client_version) \
          WHERE id = $1 AND owner_id = $4 AND revoked_at IS NULL",
    )
    .bind(device_id)
    .bind(forwarded_ip(&headers))
    .bind(version)
    .bind(user.id)
    .execute(&state.pool)
    .await
    .map_err(db)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn logout_device(
    State(state): State<AppState>,
    user: AuthenticatedUser,
) -> Result<Response, ApiError> {
    let device_id = required_device(&user)?;
    revoke_owned_device(&state, user.id, device_id).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

#[derive(Deserialize)]
struct DeviceListQuery {
    #[serde(default)]
    include_revoked: bool,
}

async fn list_devices(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Query(query): Query<DeviceListQuery>,
) -> Result<Response, ApiError> {
    reject_device_actor(&user)?;
    let devices = sqlx::query_as::<_, DeviceRecord>(
        "SELECT id, name, client_name, operating_system, client_version, permissions, created_at, \
                last_active_at, last_ip, revoked_at \
           FROM backup_devices \
          WHERE owner_id = $1 AND ($2 OR revoked_at IS NULL) \
          ORDER BY created_at DESC \
          LIMIT 100",
    )
    .bind(user.id)
    .bind(query.include_revoked)
    .fetch_all(&state.pool)
    .await
    .map_err(db)?;
    Ok(no_store(Json(json!({ "devices": devices }))))
}

async fn revoke_device(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response, ApiError> {
    reject_device_actor(&user)?;
    if !require_csrf(&headers, &user, state.auth_settings) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "csrf_failed"));
    }
    revoke_owned_device(&state, user.id, id).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CheckRequest {
    parent_id: Option<Uuid>,
    name: String,
    size_bytes: u64,
    checksum_sha256: String,
}

#[derive(Serialize)]
struct CheckResponse {
    action: &'static str,
    file_id: Option<Uuid>,
    version_id: Option<Uuid>,
    remote_checksum: Option<String>,
    reusable: bool,
}

async fn check_content(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
    Json(request): Json<CheckRequest>,
) -> Result<Response, ApiError> {
    require_backup_csrf(&headers, &user, &state)?;
    let name = drive::normalize_name(&request.name)
        .map_err(|_| ApiError::new(StatusCode::BAD_REQUEST, "invalid_request"))?;
    let checksum = parse_sha256(&request.checksum_sha256)?;
    let size = i64::try_from(request.size_bytes)
        .map_err(|_| ApiError::new(StatusCode::BAD_REQUEST, "invalid_request"))?;
    if let Some(parent_id) = request.parent_id {
        drive::ensure_active_entry(&state, user.id, parent_id, true)
            .await
            .map_err(map_drive)?;
    }
    let existing = sqlx::query_as::<_, ExistingFile>(
        "SELECT entry.id AS file_id, version.id AS version_id, object.checksum_sha256, object.size_bytes \
           FROM drive_entries AS entry \
           JOIN files AS file ON file.id = entry.id \
           JOIN file_versions AS version ON version.id = file.current_version_id \
           JOIN storage_objects AS object ON object.id = version.storage_object_id \
          WHERE entry.owner_id = $1 AND entry.deleted_at IS NULL AND entry.kind = 'file' \
            AND entry.parent_id IS NOT DISTINCT FROM $2 AND lower(entry.name) = lower($3)",
    )
    .bind(user.id)
    .bind(request.parent_id)
    .bind(&name)
    .fetch_optional(&state.pool)
    .await
    .map_err(db)?;
    let reusable: bool = sqlx::query_scalar(
        "SELECT EXISTS ( \
            SELECT 1 FROM storage_objects \
             WHERE state = 'ready' AND checksum_sha256 = $1 AND size_bytes = $2)",
    )
    .bind(&checksum)
    .bind(size)
    .fetch_one(&state.pool)
    .await
    .map_err(db)?;
    let response = match existing {
        Some(file)
            if file.checksum_sha256.as_deref() == Some(checksum.as_str())
                && file.size_bytes == size =>
        {
            CheckResponse {
                action: "skip",
                file_id: Some(file.file_id),
                version_id: Some(file.version_id),
                remote_checksum: file.checksum_sha256,
                reusable: true,
            }
        }
        Some(file) if reusable => CheckResponse {
            action: "link",
            file_id: Some(file.file_id),
            version_id: Some(file.version_id),
            remote_checksum: file.checksum_sha256,
            reusable: true,
        },
        Some(file) => CheckResponse {
            action: "upload",
            file_id: Some(file.file_id),
            version_id: Some(file.version_id),
            remote_checksum: file.checksum_sha256,
            reusable: false,
        },
        None if reusable => CheckResponse {
            action: "link",
            file_id: None,
            version_id: None,
            remote_checksum: None,
            reusable: true,
        },
        None => CheckResponse {
            action: "upload",
            file_id: None,
            version_id: None,
            remote_checksum: None,
            reusable: false,
        },
    };
    Ok(no_store(Json(response)))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LinkRequest {
    parent_id: Option<Uuid>,
    name: String,
    size_bytes: u64,
    checksum_sha256: String,
    #[serde(default)]
    modified_at: Option<DateTime<Utc>>,
}

async fn link_content(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
    Json(request): Json<LinkRequest>,
) -> Result<Response, ApiError> {
    require_backup_csrf(&headers, &user, &state)?;
    let name = drive::normalize_name(&request.name)
        .map_err(|_| ApiError::new(StatusCode::BAD_REQUEST, "invalid_request"))?;
    let checksum = parse_sha256(&request.checksum_sha256)?;
    let size = i64::try_from(request.size_bytes)
        .map_err(|_| ApiError::new(StatusCode::BAD_REQUEST, "invalid_request"))?;
    if let Some(parent_id) = request.parent_id {
        drive::ensure_active_entry(&state, user.id, parent_id, true)
            .await
            .map_err(map_drive)?;
    }
    let mut transaction = state.pool.begin().await.map_err(db)?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))")
        .bind(user.id.to_string())
        .execute(&mut *transaction)
        .await
        .map_err(db)?;
    let object_id: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM storage_objects \
          WHERE state = 'ready' AND checksum_sha256 = $1 AND size_bytes = $2 \
          LIMIT 1",
    )
    .bind(&checksum)
    .bind(size)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(db)?;
    let Some(object_id) = object_id else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "content_not_found"));
    };
    let existing = sqlx::query_as::<_, ExistingFile>(
        "SELECT entry.id AS file_id, version.id AS version_id, object.checksum_sha256, object.size_bytes \
           FROM drive_entries AS entry \
           JOIN files AS file ON file.id = entry.id \
           JOIN file_versions AS version ON version.id = file.current_version_id \
           JOIN storage_objects AS object ON object.id = version.storage_object_id \
          WHERE entry.owner_id = $1 AND entry.deleted_at IS NULL AND entry.kind = 'file' \
            AND entry.parent_id IS NOT DISTINCT FROM $2 AND lower(entry.name) = lower($3) \
          FOR UPDATE OF entry",
    )
    .bind(user.id)
    .bind(request.parent_id)
    .bind(&name)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(db)?;
    if let Some(file) = &existing
        && file.checksum_sha256.as_deref() == Some(checksum.as_str())
        && file.size_bytes == size
    {
        return Ok(no_store(Json(json!({
            "file_id": file.file_id,
            "version_id": file.version_id,
            "checksum_sha256": checksum,
            "deduplicated": true,
            "unchanged": true
        }))));
    }
    let additional = match &existing {
        Some(file) => u64::try_from((size - file.size_bytes).max(0)).unwrap_or(0),
        None => request.size_bytes,
    };
    ensure_quota(&state, &mut transaction, user.id, additional).await?;
    let version_id = Uuid::new_v4();
    let file_id = if let Some(file) = existing {
        file.file_id
    } else {
        let file_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO drive_entries (id, owner_id, parent_id, kind, name) VALUES ($1, $2, $3, 'file', $4)",
        )
        .bind(file_id)
        .bind(user.id)
        .bind(request.parent_id)
        .bind(&name)
        .execute(&mut *transaction)
        .await
        .map_err(db)?;
        sqlx::query("INSERT INTO files (id) VALUES ($1)")
            .bind(file_id)
            .execute(&mut *transaction)
            .await
            .map_err(db)?;
        file_id
    };
    sqlx::query(
        "INSERT INTO file_versions (id, file_id, storage_object_id, size_bytes, original_modified_at) \
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(version_id)
    .bind(file_id)
    .bind(object_id)
    .bind(size)
    .bind(request.modified_at)
    .execute(&mut *transaction)
    .await
    .map_err(db)?;
    sqlx::query("UPDATE files SET current_version_id = $1 WHERE id = $2")
        .bind(version_id)
        .bind(file_id)
        .execute(&mut *transaction)
        .await
        .map_err(db)?;
    sqlx::query("UPDATE drive_entries SET updated_at = now() WHERE id = $1 AND owner_id = $2")
        .bind(file_id)
        .bind(user.id)
        .execute(&mut *transaction)
        .await
        .map_err(db)?;
    transaction.commit().await.map_err(db)?;
    Ok(no_store((
        StatusCode::CREATED,
        Json(json!({
            "file_id": file_id,
            "version_id": version_id,
            "checksum_sha256": checksum,
            "deduplicated": true,
            "unchanged": false
        })),
    )))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EnsureFolderRequest {
    path: String,
}

async fn ensure_folder(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
    Json(request): Json<EnsureFolderRequest>,
) -> Result<Response, ApiError> {
    require_backup_csrf(&headers, &user, &state)?;
    let segments = split_folder_path(&request.path)?;
    let mut parent_id = None;
    let mut created = false;
    for segment in segments {
        let (id, segment_created) =
            ensure_child_folder(&state, user.id, parent_id, &segment).await?;
        parent_id = Some(id);
        created = segment_created;
    }
    let id = parent_id.ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "invalid_request"))?;
    Ok(no_store(Json(json!({ "id": id, "created": created }))))
}

async fn list_versions(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Path(id): Path<Uuid>,
) -> Result<Response, ApiError> {
    drive::ensure_active_entry(&state, user.id, id, false)
        .await
        .map_err(map_drive)?;
    let versions = sqlx::query_as::<_, VersionRecord>(
        "SELECT version.id, version.size_bytes, object.checksum_sha256, version.created_at, \
                version.original_modified_at, (version.id = file.current_version_id) AS is_current \
           FROM files AS file \
           JOIN drive_entries AS entry ON entry.id = file.id \
           JOIN file_versions AS version ON version.file_id = file.id \
           JOIN storage_objects AS object ON object.id = version.storage_object_id \
          WHERE file.id = $1 AND entry.owner_id = $2 AND entry.kind = 'file' \
          ORDER BY version.created_at DESC \
          LIMIT 50",
    )
    .bind(id)
    .bind(user.id)
    .fetch_all(&state.pool)
    .await
    .map_err(db)?;
    if versions.is_empty() {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "not_found"));
    }
    Ok(no_store(Json(json!({ "versions": versions }))))
}

pub(crate) async fn authenticate_access_token(
    state: &AppState,
    token: &str,
    reported_ip: Option<&str>,
) -> Result<Option<AuthenticatedUser>, sqlx::Error> {
    if !token.starts_with(ACCESS_TOKEN_PREFIX) || token.len() != 47 {
        return Ok(None);
    }
    let digest = Sha256::digest(token.as_bytes()).to_vec();
    let row = sqlx::query_as::<_, DeviceAuthRow>(
        "SELECT d.id AS device_id, d.owner_id, u.email, u.role, u.must_change_password, d.last_active_at \
           FROM device_credentials AS c \
           JOIN backup_devices AS d ON d.id = c.device_id \
           JOIN users AS u ON u.id = d.owner_id \
          WHERE c.access_token_digest = $1 AND c.revoked_at IS NULL AND c.access_expires_at > now() \
            AND d.revoked_at IS NULL AND u.disabled_at IS NULL",
    )
    .bind(digest)
    .fetch_optional(&state.pool)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let should_touch = row
        .last_active_at
        .is_none_or(|seen| seen < Utc::now() - ChronoDuration::minutes(5));
    if should_touch
        && let Err(error) = sqlx::query(
            "UPDATE backup_devices \
                SET last_active_at = now(), last_ip = COALESCE($2, last_ip) \
              WHERE id = $1 AND revoked_at IS NULL \
                AND (last_active_at IS NULL OR last_active_at < now() - interval '5 minutes')",
        )
        .bind(row.device_id)
        .bind(reported_ip)
        .execute(&state.pool)
        .await
    {
        tracing::warn!(error = %error, "could not update backup device activity");
    }
    Ok(Some(AuthenticatedUser::from_device(
        row.owner_id,
        row.device_id,
        row.email,
        row.role,
        row.must_change_password,
    )))
}

pub(crate) fn device_request_allowed(method: &Method, path: &str) -> bool {
    let read = *method == Method::GET || *method == Method::HEAD;
    if path == "/api/auth/me" {
        return read;
    }
    if path == "/api/storage" {
        return read;
    }
    if path == "/api/device/heartbeat" || path == "/api/device/logout" {
        return *method == Method::POST;
    }
    if path == "/api/drive" || path == "/api/drive/search" {
        return read;
    }
    if path == "/api/folders" {
        return *method == Method::POST;
    }
    if path == "/api/uploads" {
        return *method == Method::POST;
    }
    if path == "/api/backup/check" || path == "/api/backup/link" || path == "/api/backup/folders" {
        return *method == Method::POST;
    }
    if let Some(rest) = path.strip_prefix("/api/uploads/") {
        if rest.ends_with("/finalize") {
            return *method == Method::POST && !rest.trim_end_matches("/finalize").contains('/');
        }
        return (*method == Method::HEAD || *method == Method::PATCH || *method == Method::DELETE)
            && !rest.contains('/');
    }
    if let Some(rest) = path.strip_prefix("/api/entries/") {
        if rest.ends_with("/rename") {
            return *method == Method::PATCH;
        }
        if rest.ends_with("/move") {
            return *method == Method::POST;
        }
        return (read || *method == Method::DELETE) && !rest.contains('/');
    }
    if let Some(rest) = path.strip_prefix("/api/files/") {
        return read && rest.ends_with("/versions") && rest.matches('/').count() == 1;
    }
    false
}

pub(crate) fn forwarded_ip(headers: &HeaderMap) -> Option<String> {
    let value = headers.get("x-forwarded-for")?.to_str().ok()?;
    let first = value.split(',').next()?.trim();
    if (1..65).contains(&first.len())
        && first
            .chars()
            .all(|character| character.is_ascii_hexdigit() || character == '.' || character == ':')
    {
        Some(first.to_owned())
    } else {
        None
    }
}

#[derive(FromRow)]
struct PendingGrant {
    id: Uuid,
    status: String,
    expires_at: DateTime<Utc>,
    poll_interval_seconds: i32,
    poll_after: DateTime<Utc>,
    device_id: Option<Uuid>,
    owner_id: Option<Uuid>,
}

#[derive(FromRow)]
struct RefreshRow {
    id: Uuid,
    device_id: Uuid,
    revoked_at: Option<DateTime<Utc>>,
    refresh_expires_at: DateTime<Utc>,
    device_revoked_at: Option<DateTime<Utc>>,
    owner_id: Uuid,
    account_enabled: bool,
}

#[derive(FromRow, Serialize)]
struct PendingView {
    user_code: String,
    client_name: String,
    device_name: String,
    operating_system: String,
    client_version: String,
    requested_ip: Option<String>,
    status: String,
    created_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
}

#[derive(FromRow)]
struct ApprovalRow {
    id: Uuid,
    status: String,
    expires_at: DateTime<Utc>,
    client_name: String,
    device_name: String,
    operating_system: String,
    client_version: String,
}

#[derive(FromRow, Serialize)]
struct DeviceRecord {
    id: Uuid,
    name: String,
    client_name: String,
    operating_system: String,
    client_version: String,
    permissions: Vec<String>,
    created_at: DateTime<Utc>,
    last_active_at: Option<DateTime<Utc>>,
    last_ip: Option<String>,
    revoked_at: Option<DateTime<Utc>>,
}

#[derive(FromRow)]
struct ExistingFile {
    file_id: Uuid,
    version_id: Uuid,
    checksum_sha256: Option<String>,
    size_bytes: i64,
}

#[derive(FromRow, Serialize)]
struct VersionRecord {
    id: Uuid,
    size_bytes: i64,
    checksum_sha256: Option<String>,
    created_at: DateTime<Utc>,
    original_modified_at: Option<DateTime<Utc>>,
    #[serde(rename = "current")]
    is_current: bool,
}

#[derive(FromRow)]
struct DeviceAuthRow {
    device_id: Uuid,
    owner_id: Uuid,
    email: String,
    role: String,
    must_change_password: bool,
    last_active_at: Option<DateTime<Utc>>,
}

#[derive(FromRow)]
struct QuotaAccount {
    role: String,
    quota_bytes: Option<i64>,
    enabled: bool,
}

#[derive(FromRow)]
struct QuotaUsage {
    used_bytes: i64,
    reserved_bytes: i64,
}

fn reject_device_actor(user: &AuthenticatedUser) -> Result<(), ApiError> {
    if user.device_id.is_some() {
        Err(ApiError::new(StatusCode::FORBIDDEN, "insufficient_scope"))
    } else {
        Ok(())
    }
}

fn required_device(user: &AuthenticatedUser) -> Result<Uuid, ApiError> {
    user.device_id
        .ok_or_else(|| ApiError::new(StatusCode::FORBIDDEN, "insufficient_scope"))
}

fn require_backup_csrf(
    headers: &HeaderMap,
    user: &AuthenticatedUser,
    state: &AppState,
) -> Result<(), ApiError> {
    if require_csrf(headers, user, state.auth_settings) {
        Ok(())
    } else {
        Err(ApiError::new(StatusCode::FORBIDDEN, "csrf_failed"))
    }
}

fn map_drive(error: drive::DriveError) -> ApiError {
    match error {
        drive::DriveError::NotFound => ApiError::new(StatusCode::NOT_FOUND, "not_found"),
        drive::DriveError::BadRequest => ApiError::new(StatusCode::BAD_REQUEST, "invalid_request"),
        drive::DriveError::Conflict => ApiError::new(StatusCode::CONFLICT, "conflict"),
        drive::DriveError::Protected => ApiError::new(StatusCode::CONFLICT, "protected_entry"),
        drive::DriveError::Csrf => ApiError::new(StatusCode::FORBIDDEN, "csrf_failed"),
        drive::DriveError::Database(error) => db(error),
    }
}

async fn revoke_owned_device(
    state: &AppState,
    owner_id: Uuid,
    device_id: Uuid,
) -> Result<(), ApiError> {
    let mut transaction = state.pool.begin().await.map_err(db)?;
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM backup_devices WHERE id = $1 AND owner_id = $2)",
    )
    .bind(device_id)
    .bind(owner_id)
    .fetch_one(&mut *transaction)
    .await
    .map_err(db)?;
    if !exists {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "not_found"));
    }
    sqlx::query(
        "UPDATE backup_devices SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1 AND owner_id = $2",
    )
    .bind(device_id)
    .bind(owner_id)
    .execute(&mut *transaction)
    .await
    .map_err(db)?;
    sqlx::query(
        "UPDATE device_credentials SET revoked_at = COALESCE(revoked_at, now()) WHERE device_id = $1",
    )
    .bind(device_id)
    .execute(&mut *transaction)
    .await
    .map_err(db)?;
    sqlx::query(
        "INSERT INTO audit_events (event_type, actor_id, resource_id) VALUES ('device_revoked', $1, $2)",
    )
    .bind(owner_id)
    .bind(device_id)
    .execute(&mut *transaction)
    .await
    .map_err(db)?;
    transaction.commit().await.map_err(db)?;
    Ok(())
}

async fn issue_credentials(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    device_id: Uuid,
) -> Result<Value, ApiError> {
    let (access_token, access_digest) = random_token(ACCESS_TOKEN_PREFIX)?;
    let (refresh_token, refresh_digest) = random_token(REFRESH_TOKEN_PREFIX)?;
    let now = Utc::now();
    sqlx::query(
        "INSERT INTO device_credentials \
            (id, device_id, access_token_digest, refresh_token_digest, access_expires_at, refresh_expires_at) \
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(Uuid::new_v4())
    .bind(device_id)
    .bind(access_digest)
    .bind(refresh_digest)
    .bind(now + ChronoDuration::seconds(ACCESS_TOKEN_TTL_SECONDS))
    .bind(now + ChronoDuration::seconds(REFRESH_TOKEN_TTL_SECONDS))
    .execute(&mut **transaction)
    .await
    .map_err(db)?;
    Ok(json!({
        "access_token": access_token,
        "refresh_token": refresh_token,
        "token_type": "Bearer",
        "expires_in": ACCESS_TOKEN_TTL_SECONDS,
        "device_id": device_id,
        "scope": "backup"
    }))
}

async fn ensure_quota(
    state: &AppState,
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    owner_id: Uuid,
    additional: u64,
) -> Result<(), ApiError> {
    let account = sqlx::query_as::<_, QuotaAccount>(
        "SELECT role, quota_bytes, disabled_at IS NULL AS enabled FROM users WHERE id = $1",
    )
    .bind(owner_id)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(db)?
    .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "authentication_required"))?;
    if !account.enabled {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "authentication_required",
        ));
    }
    let quota_limit =
        if account.role == "member" {
            u64::try_from(account.quota_bytes.ok_or_else(|| {
                ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "service_unavailable")
            })?)
            .map_err(|_| ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "service_unavailable"))?
        } else {
            state.transfer_settings.owner_quota_bytes
        };
    let usage = sqlx::query_as::<_, QuotaUsage>(
        "SELECT \
            (SELECT COALESCE(SUM(version.size_bytes), 0)::BIGINT \
               FROM drive_entries AS entry \
               JOIN files AS file ON file.id = entry.id \
               JOIN file_versions AS version ON version.id = file.current_version_id \
               JOIN storage_objects AS object ON object.id = version.storage_object_id \
                    AND object.state = 'ready' \
              WHERE entry.owner_id = $1) AS used_bytes, \
            (SELECT COALESCE(SUM(expected_size), 0)::BIGINT \
               FROM upload_sessions \
              WHERE owner_id = $1 \
                AND (state = 'finalizing' OR (state = 'active' AND expires_at > now()))) AS reserved_bytes",
    )
    .bind(owner_id)
    .fetch_one(&mut **transaction)
    .await
    .map_err(db)?;
    let required = u64::try_from(usage.used_bytes.max(0))
        .unwrap_or(u64::MAX)
        .saturating_add(u64::try_from(usage.reserved_bytes.max(0)).unwrap_or(u64::MAX))
        .saturating_add(additional);
    if required > quota_limit {
        return Err(ApiError::new(
            StatusCode::INSUFFICIENT_STORAGE,
            "quota_exceeded",
        ));
    }
    Ok(())
}

async fn ensure_child_folder(
    state: &AppState,
    owner_id: Uuid,
    parent_id: Option<Uuid>,
    name: &str,
) -> Result<(Uuid, bool), ApiError> {
    if let Some(existing) = find_child_folder(&state.pool, owner_id, parent_id, name).await? {
        return Ok((existing, false));
    }
    let id = Uuid::new_v4();
    let mut transaction = state.pool.begin().await.map_err(db)?;
    let inserted = sqlx::query(
        "INSERT INTO drive_entries (id, owner_id, parent_id, kind, name) VALUES ($1, $2, $3, 'folder', $4)",
    )
    .bind(id)
    .bind(owner_id)
    .bind(parent_id)
    .bind(name)
    .execute(&mut *transaction)
    .await;
    if let Err(error) = inserted {
        if is_unique(&error) {
            drop(transaction);
            let existing = find_child_folder(&state.pool, owner_id, parent_id, name)
                .await?
                .ok_or_else(|| ApiError::new(StatusCode::CONFLICT, "conflict"))?;
            return Ok((existing, false));
        }
        return Err(db(error));
    }
    sqlx::query("INSERT INTO folders (id) VALUES ($1)")
        .bind(id)
        .execute(&mut *transaction)
        .await
        .map_err(db)?;
    transaction.commit().await.map_err(db)?;
    Ok((id, true))
}

async fn find_child_folder(
    pool: &sqlx::PgPool,
    owner_id: Uuid,
    parent_id: Option<Uuid>,
    name: &str,
) -> Result<Option<Uuid>, ApiError> {
    sqlx::query_scalar(
        "SELECT id FROM drive_entries \
          WHERE owner_id = $1 AND deleted_at IS NULL AND kind = 'folder' \
            AND parent_id IS NOT DISTINCT FROM $2 AND lower(name) = lower($3)",
    )
    .bind(owner_id)
    .bind(parent_id)
    .bind(name)
    .fetch_optional(pool)
    .await
    .map_err(db)
}

fn split_folder_path(path: &str) -> Result<Vec<String>, ApiError> {
    let path = path.trim();
    if path.is_empty()
        || path.len() > 1024
        || path.contains('\\')
        || path.starts_with('/')
        || path.contains("//")
    {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "invalid_request"));
    }
    let mut segments = Vec::new();
    for segment in path.split('/') {
        let name = drive::normalize_name(segment)
            .map_err(|_| ApiError::new(StatusCode::BAD_REQUEST, "invalid_request"))?;
        segments.push(name);
        if segments.len() > 32 {
            return Err(ApiError::new(StatusCode::BAD_REQUEST, "invalid_request"));
        }
    }
    if segments.is_empty() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "invalid_request"));
    }
    Ok(segments)
}

fn parse_sha256(value: &str) -> Result<String, ApiError> {
    let value = value.trim().to_ascii_lowercase();
    if value.len() == 64 && value.chars().all(|character| character.is_ascii_hexdigit()) {
        Ok(value)
    } else {
        Err(ApiError::new(StatusCode::BAD_REQUEST, "invalid_request"))
    }
}

fn clean_label(value: &str, max_chars: usize) -> Result<String, ApiError> {
    let value = value.trim();
    let length = value.chars().count();
    if length == 0 || length > max_chars || value.chars().any(|character| character.is_control()) {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "invalid_request"));
    }
    Ok(value.to_owned())
}

fn normalize_user_code(value: &str) -> Result<String, ApiError> {
    let value = value.trim().to_ascii_uppercase();
    if value.len() == 8 && !value.contains('-') {
        let formatted = format!("{}-{}", &value[..4], &value[4..]);
        return validate_user_code(formatted);
    }
    validate_user_code(value)
}

fn validate_user_code(value: String) -> Result<String, ApiError> {
    if value.len() == 9
        && value.as_bytes().get(4) == Some(&b'-')
        && value
            .bytes()
            .filter(|byte| *byte != b'-')
            .all(|byte| USER_CODE_ALPHABET.contains(&byte))
    {
        Ok(value)
    } else {
        Err(ApiError::new(StatusCode::BAD_REQUEST, "invalid_request"))
    }
}

fn new_user_code() -> Result<String, ApiError> {
    let mut raw = [0u8; 8];
    OsRng
        .try_fill_bytes(&mut raw)
        .map_err(|_| ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "service_unavailable"))?;
    let chars: String = raw
        .iter()
        .map(|byte| USER_CODE_ALPHABET[(*byte as usize) % USER_CODE_ALPHABET.len()] as char)
        .collect();
    Ok(format!("{}-{}", &chars[..4], &chars[4..]))
}

fn random_token(prefix: &str) -> Result<(String, Vec<u8>), ApiError> {
    let mut raw = [0u8; 32];
    OsRng
        .try_fill_bytes(&mut raw)
        .map_err(|_| ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "service_unavailable"))?;
    let token = format!("{prefix}{}", URL_SAFE_NO_PAD.encode(raw));
    let digest = Sha256::digest(token.as_bytes()).to_vec();
    Ok((token, digest))
}

fn is_unique(error: &sqlx::Error) -> bool {
    matches!(error, sqlx::Error::Database(database) if database.code().as_deref() == Some("23505"))
}

#[cfg(test)]
mod tests {
    use axum::http::Method;

    use super::{device_request_allowed, normalize_user_code, parse_sha256, split_folder_path};

    #[test]
    fn device_tokens_can_back_up_but_cannot_administer_or_download() {
        assert!(device_request_allowed(&Method::GET, "/api/auth/me"));
        assert!(device_request_allowed(&Method::GET, "/api/storage"));
        assert!(device_request_allowed(&Method::POST, "/api/backup/check"));
        assert!(device_request_allowed(&Method::POST, "/api/backup/link"));
        assert!(device_request_allowed(&Method::POST, "/api/backup/folders"));
        assert!(device_request_allowed(&Method::POST, "/api/uploads"));
        assert!(device_request_allowed(
            &Method::PATCH,
            "/api/uploads/11111111-1111-1111-1111-111111111111"
        ));
        assert!(device_request_allowed(
            &Method::POST,
            "/api/uploads/11111111-1111-1111-1111-111111111111/finalize"
        ));
        assert!(device_request_allowed(
            &Method::GET,
            "/api/files/11111111-1111-1111-1111-111111111111/versions"
        ));
        assert!(device_request_allowed(
            &Method::DELETE,
            "/api/entries/11111111-1111-1111-1111-111111111111"
        ));
        assert!(!device_request_allowed(
            &Method::GET,
            "/api/files/11111111-1111-1111-1111-111111111111/download"
        ));
        assert!(!device_request_allowed(&Method::POST, "/api/shares"));
        assert!(!device_request_allowed(&Method::GET, "/api/admin/accounts"));
        assert!(!device_request_allowed(
            &Method::POST,
            "/api/device/authorize"
        ));
        assert!(!device_request_allowed(
            &Method::DELETE,
            "/api/devices/11111111-1111-1111-1111-111111111111"
        ));
    }

    #[test]
    fn user_codes_accept_the_displayed_form_and_reject_ambiguous_characters() {
        assert_eq!(normalize_user_code("abcd-efgh").unwrap(), "ABCD-EFGH");
        assert_eq!(normalize_user_code("ABCDEFGH").unwrap(), "ABCD-EFGH");
        assert!(normalize_user_code("IIII-OOOO").is_err());
        assert!(normalize_user_code("ABCD_EFGH").is_err());
    }

    #[test]
    fn folder_paths_stay_inside_the_drive_namespace() {
        assert_eq!(
            split_folder_path("Backups/MY-PC/Documents").unwrap(),
            vec!["Backups", "MY-PC", "Documents"]
        );
        for invalid in ["", "/Backups", "Backups\\PC", "../secret", "a//b", "a/../b"] {
            assert!(split_folder_path(invalid).is_err(), "accepted {invalid}");
        }
    }

    #[test]
    fn checksums_must_be_64_hex_characters() {
        assert_eq!(parse_sha256(&"ab".repeat(32)).unwrap().len(), 64);
        assert!(parse_sha256("abc").is_err());
        assert!(parse_sha256(&"zz".repeat(32)).is_err());
    }
}
