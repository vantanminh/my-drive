use std::{
    collections::{HashMap, VecDeque},
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

use argon2::{Argon2, PasswordVerifier, password_hash::PasswordHash};
use axum::{
    Json,
    extract::{ConnectInfo, FromRequestParts, Path, State},
    http::{
        HeaderMap, HeaderValue, StatusCode,
        header::{AUTHORIZATION, CACHE_CONTROL, COOKIE, RETRY_AFTER, SET_COOKIE},
        request::Parts,
    },
    response::{IntoResponse, Response},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{Duration as ChronoDuration, Utc};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::FromRow;
use subtle::ConstantTimeEq;
use uuid::Uuid;

use super::{MAX_PASSWORD_BYTES, MIN_PASSWORD_CHARS, valid_email};
use crate::health::AppState;

const LOGIN_FAILURE_LIMIT: usize = 10;
const LOGIN_FAILURE_WINDOW: Duration = Duration::from_secs(15 * 60);
const MAX_LOGIN_IDENTITIES: usize = 10_000;
const MAX_LOGIN_PASSWORD_BYTES: usize = MAX_PASSWORD_BYTES;
const MIN_NEW_PASSWORD_CHARS: usize = MIN_PASSWORD_CHARS;
const SESSION_TOKEN_BYTES: usize = 32;
const CSRF_TOKEN_BYTES: usize = 32;

#[derive(Clone, Copy)]
pub struct AuthSettings {
    pub cookie_secure: bool,
    pub session_ttl_seconds: u64,
}

impl AuthSettings {
    fn session_cookie_name(self) -> &'static str {
        if self.cookie_secure {
            "__Host-my_drive_session"
        } else {
            "my_drive_session"
        }
    }

    fn csrf_cookie_name(self) -> &'static str {
        if self.cookie_secure {
            "__Host-my_drive_csrf"
        } else {
            "my_drive_csrf"
        }
    }
}

#[derive(Clone, Default)]
pub struct LoginRateLimiter {
    buckets: Arc<Mutex<HashMap<[u8; 32], AttemptBucket>>>,
}

#[derive(Default)]
struct AttemptBucket {
    failed_at: VecDeque<Instant>,
}

impl LoginRateLimiter {
    pub fn retry_after_seconds(&self, identity: &str) -> Option<u64> {
        self.retry_after_at(identity, Instant::now())
    }

    pub fn record_failure(&self, identity: &str) {
        self.record_failure_at(identity, Instant::now());
    }

    pub fn clear(&self, identity: &str) {
        let key = identity_digest(identity);
        self.buckets
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&key);
    }

    fn retry_after_at(&self, identity: &str, now: Instant) -> Option<u64> {
        let key = identity_digest(identity);
        let mut buckets = self
            .buckets
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        prune_buckets(&mut buckets, now);
        let attempts = buckets.get(&key)?;
        if attempts.failed_at.len() < LOGIN_FAILURE_LIMIT {
            return None;
        }
        let oldest = attempts.failed_at.front()?;
        Some(
            LOGIN_FAILURE_WINDOW
                .saturating_sub(now.saturating_duration_since(*oldest))
                .as_secs()
                .max(1),
        )
    }

    fn record_failure_at(&self, identity: &str, now: Instant) {
        let key = identity_digest(identity);
        let mut buckets = self
            .buckets
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        prune_buckets(&mut buckets, now);
        if !buckets.contains_key(&key)
            && buckets.len() >= MAX_LOGIN_IDENTITIES
            && let Some(oldest_key) = buckets
                .iter()
                .min_by_key(|(_, bucket)| bucket.failed_at.back().copied())
                .map(|(key, _)| *key)
        {
            buckets.remove(&oldest_key);
        }
        buckets.entry(key).or_default().failed_at.push_back(now);
    }
}

fn prune_buckets(buckets: &mut HashMap<[u8; 32], AttemptBucket>, now: Instant) {
    buckets.retain(|_, bucket| {
        bucket
            .failed_at
            .retain(|failed_at| now.saturating_duration_since(*failed_at) < LOGIN_FAILURE_WINDOW);
        !bucket.failed_at.is_empty()
    });
}

fn identity_digest(identity: &str) -> [u8; 32] {
    Sha256::digest(identity.as_bytes()).into()
}

#[derive(Clone)]
pub struct AuthenticatedUser {
    pub id: Uuid,
    pub session_id: Uuid,
    pub email: String,
    pub role: String,
    pub must_change_password: bool,
    csrf_token_digest: Vec<u8>,
    pub api_key_id: Option<Uuid>,
    pub device_id: Option<Uuid>,
    pub is_bearer_session: bool,
}

#[derive(FromRow)]
struct LoginUser {
    id: Uuid,
    email: String,
    role: String,
    password_hash: String,
    must_change_password: bool,
}

#[derive(FromRow)]
struct SessionUser {
    session_id: Uuid,
    id: Uuid,
    email: String,
    role: String,
    must_change_password: bool,
    csrf_token_digest: Vec<u8>,
    last_seen_at: Option<chrono::DateTime<Utc>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LoginRequest {
    email: String,
    password: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PasswordChangeRequest {
    current_password: String,
    new_password: String,
}

#[derive(FromRow, Serialize)]
struct BrowserSessionResponse {
    id: Uuid,
    created_at: chrono::DateTime<Utc>,
    last_seen_at: Option<chrono::DateTime<Utc>>,
    expires_at: chrono::DateTime<Utc>,
    is_current: bool,
    ip_address: Option<String>,
    user_agent: Option<String>,
    client_type: String,
    device_label: Option<String>,
}

#[derive(Serialize)]
struct UserResponse {
    id: Uuid,
    email: String,
    role: String,
    must_change_password: bool,
}

#[derive(Serialize)]
struct LoginResponse {
    user: UserResponse,
    csrf_token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_token: Option<String>,
}

const MOBILE_SESSION_PREFIX: &str = "mds_";

pub(crate) struct OptionalPeerIp(Option<IpAddr>);

impl<S> FromRequestParts<S> for OptionalPeerIp
where
    S: Send + Sync,
{
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        let ip = parts
            .extensions
            .get::<ConnectInfo<SocketAddr>>()
            .map(|info| info.0.ip());
        Ok(Self(ip))
    }
}

fn is_mobile_client(headers: &HeaderMap) -> bool {
    headers
        .get("x-mydrive-client")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("mobile"))
}

fn is_trusted_proxy_ip(ip: IpAddr) -> bool {
    if ip.is_loopback() {
        return true;
    }
    match ip {
        IpAddr::V4(v4) => v4.is_private() || v4.is_link_local(),
        IpAddr::V6(v6) => (v6.segments()[0] & 0xfe00) == 0xfc00 || v6.is_unicast_link_local(),
    }
}

fn parse_forwarded_ip(headers: &HeaderMap) -> Option<String> {
    for name in ["cf-connecting-ip", "x-real-ip", "x-forwarded-for"] {
        let Some(raw) = headers.get(name).and_then(|value| value.to_str().ok()) else {
            continue;
        };
        let candidate = raw.split(',').next().map(str::trim).unwrap_or("");
        if let Ok(ip) = candidate.parse::<IpAddr>() {
            return Some(ip.to_string());
        }
    }
    None
}

fn extract_client_ip(headers: &HeaderMap, peer_ip: Option<IpAddr>) -> Option<String> {
    match peer_ip {
        Some(ip) if !is_trusted_proxy_ip(ip) => Some(ip.to_string()),
        _ => parse_forwarded_ip(headers).or_else(|| peer_ip.map(|ip| ip.to_string())),
    }
}

fn sanitize_header_text(raw: &str, max_chars: usize) -> Option<String> {
    let cleaned: String = raw
        .chars()
        .filter(|ch| !ch.is_control())
        .take(max_chars)
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_owned())
    }
}

fn extract_user_agent(headers: &HeaderMap) -> Option<String> {
    headers
        .get(axum::http::header::USER_AGENT)
        .and_then(|value| value.to_str().ok())
        .and_then(|raw| sanitize_header_text(raw, 255))
}

fn extract_client_type(headers: &HeaderMap, is_bearer: bool) -> &'static str {
    if is_bearer || is_mobile_client(headers) {
        "mobile"
    } else {
        "web"
    }
}

fn detect_device_label(headers: &HeaderMap, client_type: &str, user_agent: Option<&str>) -> String {
    if let Some(hint) = headers
        .get("x-mydrive-device")
        .and_then(|value| value.to_str().ok())
        .and_then(|raw| sanitize_header_text(raw, 80))
    {
        return hint;
    }

    let ua = user_agent.unwrap_or("");
    let os = if ua.contains("iPhone") {
        Some("iPhone")
    } else if ua.contains("iPad") {
        Some("iPad")
    } else if ua.contains("Android") {
        Some("Android")
    } else if ua.contains("Windows") {
        Some("Windows")
    } else if ua.contains("Macintosh") || ua.contains("Mac OS X") {
        Some("macOS")
    } else if ua.contains("Linux") {
        Some("Linux")
    } else if ua.contains("CFNetwork") || ua.contains("Darwin") {
        Some("iOS")
    } else {
        None
    };

    if client_type == "mobile" {
        return match os {
            Some("iPhone") => "iPhone (Mobile App)".to_owned(),
            Some("iPad") => "iPad (Mobile App)".to_owned(),
            Some("Android") => "Android (Mobile App)".to_owned(),
            Some("iOS") => "iOS App".to_owned(),
            _ => "MyDrive Mobile App".to_owned(),
        };
    }

    let browser = if ua.contains("Edg/") || ua.contains("EdgiOS/") {
        Some("Edge")
    } else if ua.contains("OPR/") || ua.contains("Opera") {
        Some("Opera")
    } else if ua.contains("Firefox/") || ua.contains("FxiOS/") {
        Some("Firefox")
    } else if ua.contains("Chrome/") || ua.contains("CriOS/") {
        Some("Chrome")
    } else if ua.contains("Safari/") && !ua.contains("Chromium") {
        Some("Safari")
    } else if ua.contains("curl/") {
        Some("curl")
    } else {
        None
    };

    match (browser, os) {
        (Some(browser), Some(os)) => format!("{browser} on {os}"),
        (Some(browser), None) => browser.to_owned(),
        (None, Some(os)) => format!("Browser on {os}"),
        (None, None) => "Web Browser".to_owned(),
    }
}

#[derive(Serialize)]
struct ErrorResponse {
    error: &'static str,
}

pub async fn login(
    State(state): State<AppState>,
    OptionalPeerIp(peer_ip): OptionalPeerIp,
    headers: HeaderMap,
    Json(payload): Json<LoginRequest>,
) -> Response {
    let email = payload.email.trim().to_lowercase();
    if let Some(retry_after) = state.login_rate_limiter.retry_after_seconds(&email) {
        let mut response = api_error(StatusCode::TOO_MANY_REQUESTS, "too_many_attempts");
        response.headers_mut().insert(
            RETRY_AFTER,
            HeaderValue::from_str(&retry_after.to_string())
                .expect("numeric retry interval is a valid header"),
        );
        return response;
    }

    let user = match sqlx::query_as::<_, LoginUser>(
        "SELECT id, email, role, password_hash, must_change_password \
           FROM users WHERE lower(email) = $1 AND disabled_at IS NULL",
    )
    .bind(&email)
    .fetch_optional(&state.pool)
    .await
    {
        Ok(user) => user,
        Err(error) => {
            tracing::error!(error = %error, "login database lookup failed");
            return api_error(StatusCode::SERVICE_UNAVAILABLE, "service_unavailable");
        }
    };

    let valid_email = valid_email(&email);
    let password_len_ok = payload.password.len() <= MAX_LOGIN_PASSWORD_BYTES;
    let password = payload.password;
    let encoded_hash = user.as_ref().map(|user| user.password_hash.clone());
    let password_valid = if password_len_ok {
        match tokio::task::spawn_blocking(move || verify_login_password(encoded_hash, &password))
            .await
        {
            Ok(valid) => valid,
            Err(error) => {
                tracing::error!(error = %error, "password verification worker failed");
                return api_error(StatusCode::SERVICE_UNAVAILABLE, "service_unavailable");
            }
        }
    } else {
        false
    };

    if !valid_email || !password_valid {
        state.login_rate_limiter.record_failure(&email);
        if let Err(error) =
            insert_login_failure(&state.pool, user.as_ref().map(|user| user.id)).await
        {
            tracing::warn!(error = %error, "could not record login failure audit event");
        }
        return api_error(StatusCode::UNAUTHORIZED, "invalid_credentials");
    }

    let user = user.expect("a valid password can only come from an existing user");
    state.login_rate_limiter.clear(&email);
    let (session_raw, session_token) = match secure_token(SESSION_TOKEN_BYTES) {
        Ok(token) => token,
        Err(error) => {
            tracing::error!(error = %error, "secure session token generation failed");
            return api_error(StatusCode::INTERNAL_SERVER_ERROR, "service_unavailable");
        }
    };
    let (csrf_raw, csrf_token) = match secure_token(CSRF_TOKEN_BYTES) {
        Ok(token) => token,
        Err(error) => {
            tracing::error!(error = %error, "secure CSRF token generation failed");
            return api_error(StatusCode::INTERNAL_SERVER_ERROR, "service_unavailable");
        }
    };
    let session_digest = Sha256::digest(&session_raw).to_vec();
    let csrf_digest = Sha256::digest(&csrf_raw).to_vec();
    let ttl_seconds = match i64::try_from(state.auth_settings.session_ttl_seconds) {
        Ok(ttl) if ttl > 0 => ttl,
        _ => {
            tracing::error!(
                "SESSION_TTL must be greater than zero and fit in a signed 64-bit integer"
            );
            return api_error(StatusCode::INTERNAL_SERVER_ERROR, "service_unavailable");
        }
    };
    let expires_at = match Utc::now().checked_add_signed(ChronoDuration::seconds(ttl_seconds)) {
        Some(expires_at) => expires_at,
        None => return api_error(StatusCode::INTERNAL_SERVER_ERROR, "service_unavailable"),
    };

    let session_id = Uuid::new_v4();
    let mut transaction = match state.pool.begin().await {
        Ok(transaction) => transaction,
        Err(error) => {
            tracing::error!(error = %error, "could not begin login transaction");
            return api_error(StatusCode::SERVICE_UNAVAILABLE, "service_unavailable");
        }
    };
    let account_password: Option<String> = match sqlx::query_scalar(
        "SELECT password_hash FROM users \
          WHERE id = $1 AND disabled_at IS NULL FOR SHARE",
    )
    .bind(user.id)
    .fetch_optional(&mut *transaction)
    .await
    {
        Ok(password_hash) => password_hash,
        Err(error) => {
            tracing::error!(error = %error, "could not revalidate account before session creation");
            return api_error(StatusCode::SERVICE_UNAVAILABLE, "service_unavailable");
        }
    };
    if account_password.as_deref() != Some(user.password_hash.as_str()) {
        return api_error(StatusCode::UNAUTHORIZED, "invalid_credentials");
    }
    let client_ip = extract_client_ip(&headers, peer_ip);
    let user_agent = extract_user_agent(&headers);
    let client_type = extract_client_type(&headers, false);
    let device_label = detect_device_label(&headers, client_type, user_agent.as_deref());
    let insert_session = sqlx::query(
        "INSERT INTO sessions (id, user_id, token_digest, csrf_token_digest, expires_at, ip_address, user_agent, client_type, device_label) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    )
    .bind(session_id)
    .bind(user.id)
    .bind(session_digest)
    .bind(csrf_digest)
    .bind(expires_at)
    .bind(client_ip)
    .bind(user_agent)
    .bind(client_type)
    .bind(device_label)
    .execute(&mut *transaction)
    .await;
    if let Err(error) = insert_session {
        tracing::error!(error = %error, "could not persist browser session");
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "service_unavailable");
    }
    if let Err(error) =
        sqlx::query("INSERT INTO audit_events (event_type, actor_id) VALUES ('login_success', $1)")
            .bind(user.id)
            .execute(&mut *transaction)
            .await
    {
        tracing::error!(error = %error, "could not record login audit event");
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "service_unavailable");
    }
    if let Err(error) = transaction.commit().await {
        tracing::error!(error = %error, "could not commit login transaction");
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "service_unavailable");
    }

    let mobile_token =
        is_mobile_client(&headers).then(|| format!("{MOBILE_SESSION_PREFIX}{session_token}"));
    let mut response = (
        StatusCode::OK,
        Json(LoginResponse {
            user: public_user(&user),
            csrf_token: csrf_token.clone(),
            session_token: mobile_token,
        }),
    )
        .into_response();
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    add_cookie(
        &mut response,
        state.auth_settings.session_cookie_name(),
        &session_token,
        true,
        state.auth_settings.session_ttl_seconds,
        state.auth_settings.cookie_secure,
        false,
    );
    add_cookie(
        &mut response,
        state.auth_settings.csrf_cookie_name(),
        &csrf_token,
        false,
        state.auth_settings.session_ttl_seconds,
        state.auth_settings.cookie_secure,
        true,
    );
    response
}

#[derive(Serialize)]
struct MobileTokenResponse {
    session_token: String,
}

pub async fn issue_mobile_token(
    State(state): State<AppState>,
    OptionalPeerIp(peer_ip): OptionalPeerIp,
    user: AuthenticatedUser,
    headers: HeaderMap,
) -> Response {
    if !is_mobile_client(&headers) {
        return api_error(StatusCode::BAD_REQUEST, "mobile_client_required");
    }
    if !require_csrf(&headers, &user, state.auth_settings) {
        return api_error(StatusCode::FORBIDDEN, "csrf_failed");
    }
    let (session_raw, session_token) = match secure_token(SESSION_TOKEN_BYTES) {
        Ok(token) => token,
        Err(error) => {
            tracing::error!(error = %error, "secure session token generation failed");
            return api_error(StatusCode::INTERNAL_SERVER_ERROR, "service_unavailable");
        }
    };
    let session_digest = Sha256::digest(&session_raw).to_vec();
    let client_ip = extract_client_ip(&headers, peer_ip);
    let user_agent = extract_user_agent(&headers);
    let device_label = detect_device_label(&headers, "mobile", user_agent.as_deref());
    let updated = sqlx::query(
        "UPDATE sessions \
            SET token_digest = $1, \
                last_seen_at = now(), \
                client_type = 'mobile', \
                ip_address = COALESCE($4, ip_address), \
                user_agent = COALESCE($5, user_agent), \
                device_label = $6 \
          WHERE id = $2 AND user_id = $3 AND revoked_at IS NULL AND expires_at > now()",
    )
    .bind(session_digest)
    .bind(user.session_id)
    .bind(user.id)
    .bind(client_ip)
    .bind(user_agent)
    .bind(device_label)
    .execute(&state.pool)
    .await;

    match updated {
        Ok(result) if result.rows_affected() == 1 => {}
        Ok(_) => return api_error(StatusCode::UNAUTHORIZED, "authentication_required"),
        Err(error) => {
            tracing::error!(error = %error, "could not rotate mobile session token");
            return api_error(StatusCode::SERVICE_UNAVAILABLE, "service_unavailable");
        }
    }

    let mut response = (
        StatusCode::OK,
        Json(MobileTokenResponse {
            session_token: format!("{MOBILE_SESSION_PREFIX}{session_token}"),
        }),
    )
        .into_response();
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    if !user.is_bearer_session {
        add_cookie(
            &mut response,
            state.auth_settings.session_cookie_name(),
            &session_token,
            true,
            state.auth_settings.session_ttl_seconds,
            state.auth_settings.cookie_secure,
            false,
        );
    }
    response
}

pub async fn me(State(_state): State<AppState>, user: AuthenticatedUser) -> Response {
    let mut response = (StatusCode::OK, Json(public_user_from_auth(&user))).into_response();
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

pub async fn list_sessions(State(state): State<AppState>, user: AuthenticatedUser) -> Response {
    let sessions = sqlx::query_as::<_, BrowserSessionResponse>(
        "SELECT id, created_at, last_seen_at, expires_at, (id = $2) AS is_current, \
                ip_address, user_agent, client_type, device_label \
           FROM sessions \
          WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() \
          ORDER BY (id = $2) DESC, COALESCE(last_seen_at, created_at) DESC, created_at DESC",
    )
    .bind(user.id)
    .bind(user.session_id)
    .fetch_all(&state.pool)
    .await;

    let sessions = match sessions {
        Ok(sessions) => sessions,
        Err(error) => {
            tracing::error!(error = %error, "could not list browser sessions");
            return api_error(StatusCode::SERVICE_UNAVAILABLE, "service_unavailable");
        }
    };

    let mut response = (StatusCode::OK, Json(sessions)).into_response();
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

pub async fn revoke_session(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
    Path(session_id): Path<Uuid>,
) -> Response {
    if !require_csrf(&headers, &user, state.auth_settings) {
        return api_error(StatusCode::FORBIDDEN, "csrf_failed");
    }
    if session_id == user.session_id {
        return api_error(StatusCode::CONFLICT, "cannot_revoke_current_session");
    }

    let revoked = sqlx::query(
        "UPDATE sessions SET revoked_at = now() \
          WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > now()",
    )
    .bind(session_id)
    .bind(user.id)
    .execute(&state.pool)
    .await;

    let revoked = match revoked {
        Ok(result) => result.rows_affected() == 1,
        Err(error) => {
            tracing::error!(error = %error, "could not revoke browser session");
            return api_error(StatusCode::SERVICE_UNAVAILABLE, "service_unavailable");
        }
    };
    if !revoked {
        return api_error(StatusCode::NOT_FOUND, "session_not_found");
    }

    if let Err(error) = sqlx::query(
        "INSERT INTO audit_events (event_type, actor_id, resource_id) \
         VALUES ('session_revoked', $1, $2)",
    )
    .bind(user.id)
    .bind(session_id)
    .execute(&state.pool)
    .await
    {
        tracing::warn!(error = %error, "could not record browser session revocation");
    }

    let mut response = StatusCode::NO_CONTENT.into_response();
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

pub async fn revoke_other_sessions(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
) -> Response {
    if !require_csrf(&headers, &user, state.auth_settings) {
        return api_error(StatusCode::FORBIDDEN, "csrf_failed");
    }

    let revoked = sqlx::query(
        "UPDATE sessions SET revoked_at = now() \
          WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL AND expires_at > now()",
    )
    .bind(user.id)
    .bind(user.session_id)
    .execute(&state.pool)
    .await;
    let revoked_count = match revoked {
        Ok(result) => result.rows_affected(),
        Err(error) => {
            tracing::error!(error = %error, "could not revoke other browser sessions");
            return api_error(StatusCode::SERVICE_UNAVAILABLE, "service_unavailable");
        }
    };

    if revoked_count > 0
        && let Err(error) = sqlx::query(
            "INSERT INTO audit_events (event_type, actor_id) VALUES ('sessions_revoked', $1)",
        )
        .bind(user.id)
        .execute(&state.pool)
        .await
    {
        tracing::warn!(error = %error, "could not record browser session revocation");
    }

    let mut response = StatusCode::NO_CONTENT.into_response();
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

pub async fn change_password(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
    Json(payload): Json<PasswordChangeRequest>,
) -> Response {
    if !require_csrf(&headers, &user, state.auth_settings) {
        return api_error(StatusCode::FORBIDDEN, "csrf_failed");
    }
    if payload.current_password.len() > MAX_LOGIN_PASSWORD_BYTES
        || payload.new_password.len() > MAX_LOGIN_PASSWORD_BYTES
        || payload.new_password.chars().count() < MIN_NEW_PASSWORD_CHARS
        || payload.current_password == payload.new_password
    {
        return api_error(StatusCode::BAD_REQUEST, "password_requirements");
    }

    let current_hash = match sqlx::query_scalar::<_, String>(
        "SELECT password_hash FROM users WHERE id = $1 AND disabled_at IS NULL",
    )
    .bind(user.id)
    .fetch_optional(&state.pool)
    .await
    {
        Ok(Some(hash)) => hash,
        Ok(None) => return api_error(StatusCode::UNAUTHORIZED, "authentication_required"),
        Err(error) => {
            tracing::error!(error = %error, "password change account lookup failed");
            return api_error(StatusCode::SERVICE_UNAVAILABLE, "service_unavailable");
        }
    };
    let encoded_hash = current_hash.clone();
    let current_password = payload.current_password;
    let current_password_valid = match tokio::task::spawn_blocking(move || {
        verify_login_password(Some(encoded_hash), &current_password)
    })
    .await
    {
        Ok(valid) => valid,
        Err(error) => {
            tracing::error!(error = %error, "password verification worker failed");
            return api_error(StatusCode::SERVICE_UNAVAILABLE, "service_unavailable");
        }
    };
    if !current_password_valid {
        return api_error(StatusCode::UNAUTHORIZED, "current_password_incorrect");
    }

    let password_to_hash = payload.new_password;
    let new_hash =
        match tokio::task::spawn_blocking(move || super::password_hash(&password_to_hash)).await {
            Ok(Ok(hash)) => hash,
            Ok(Err(error)) => {
                tracing::error!(error = %error, "new password hashing failed");
                return api_error(StatusCode::SERVICE_UNAVAILABLE, "service_unavailable");
            }
            Err(error) => {
                tracing::error!(error = %error, "password hashing worker failed");
                return api_error(StatusCode::SERVICE_UNAVAILABLE, "service_unavailable");
            }
        };

    let mut transaction = match state.pool.begin().await {
        Ok(transaction) => transaction,
        Err(error) => {
            tracing::error!(error = %error, "could not begin password change transaction");
            return api_error(StatusCode::SERVICE_UNAVAILABLE, "service_unavailable");
        }
    };
    let changed = match sqlx::query(
        "UPDATE users SET password_hash = $1, must_change_password = FALSE, updated_at = now() \
          WHERE id = $2 AND password_hash = $3 AND disabled_at IS NULL",
    )
    .bind(new_hash)
    .bind(user.id)
    .bind(&current_hash)
    .execute(&mut *transaction)
    .await
    {
        Ok(result) => result.rows_affected() == 1,
        Err(error) => {
            tracing::error!(error = %error, "could not update account password");
            return api_error(StatusCode::SERVICE_UNAVAILABLE, "service_unavailable");
        }
    };
    if !changed {
        return api_error(StatusCode::CONFLICT, "credentials_changed");
    }
    if let Err(error) = sqlx::query(
        "UPDATE sessions SET revoked_at = now() \
          WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL",
    )
    .bind(user.id)
    .bind(user.session_id)
    .execute(&mut *transaction)
    .await
    {
        tracing::error!(error = %error, "could not revoke old account sessions");
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "service_unavailable");
    }
    if let Err(error) = sqlx::query(
        "INSERT INTO audit_events (event_type, actor_id) VALUES ('password_changed', $1)",
    )
    .bind(user.id)
    .execute(&mut *transaction)
    .await
    {
        tracing::error!(error = %error, "could not record password change audit event");
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "service_unavailable");
    }
    if let Err(error) = transaction.commit().await {
        tracing::error!(error = %error, "could not commit password change");
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "service_unavailable");
    }

    let mut response = StatusCode::NO_CONTENT.into_response();
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

pub async fn logout(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
) -> Response {
    if !require_csrf(&headers, &user, state.auth_settings) {
        return api_error(StatusCode::FORBIDDEN, "csrf_failed");
    }

    if let Err(error) =
        sqlx::query("UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL")
            .bind(user.session_id)
            .execute(&state.pool)
            .await
    {
        tracing::error!(error = %error, "could not revoke browser session");
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "service_unavailable");
    }
    if let Err(error) =
        sqlx::query("INSERT INTO audit_events (event_type, actor_id) VALUES ('logout', $1)")
            .bind(user.id)
            .execute(&state.pool)
            .await
    {
        tracing::warn!(error = %error, "could not record logout audit event");
    }

    let mut response = StatusCode::NO_CONTENT.into_response();
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    add_cookie(
        &mut response,
        state.auth_settings.session_cookie_name(),
        "",
        true,
        0,
        state.auth_settings.cookie_secure,
        false,
    );
    add_cookie(
        &mut response,
        state.auth_settings.csrf_cookie_name(),
        "",
        false,
        0,
        state.auth_settings.cookie_secure,
        true,
    );
    response
}

pub fn require_csrf(headers: &HeaderMap, user: &AuthenticatedUser, settings: AuthSettings) -> bool {
    if user.api_key_id.is_some() || user.device_id.is_some() || user.is_bearer_session {
        return true;
    }
    let Some(cookie_token) = cookie_value(headers, settings.csrf_cookie_name()) else {
        return false;
    };
    let Some(header_token) = headers
        .get("x-csrf-token")
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    if cookie_token.len() != 43
        || header_token.len() != 43
        || cookie_token
            .as_bytes()
            .ct_eq(header_token.as_bytes())
            .unwrap_u8()
            != 1
    {
        return false;
    }
    let Ok(raw_token) = URL_SAFE_NO_PAD.decode(cookie_token) else {
        return false;
    };
    if raw_token.len() != CSRF_TOKEN_BYTES {
        return false;
    }
    let digest = Sha256::digest(raw_token);
    digest
        .as_slice()
        .ct_eq(user.csrf_token_digest.as_slice())
        .unwrap_u8()
        == 1
}

impl AuthenticatedUser {
    pub(crate) fn from_api(id: Uuid, key_id: Uuid, email: String, role: String) -> Self {
        Self {
            id,
            session_id: key_id,
            email,
            role,
            must_change_password: false,
            csrf_token_digest: vec![],
            api_key_id: Some(key_id),
            device_id: None,
            is_bearer_session: false,
        }
    }

    pub(crate) fn from_device(
        id: Uuid,
        device_id: Uuid,
        email: String,
        role: String,
        must_change_password: bool,
    ) -> Self {
        Self {
            id,
            session_id: device_id,
            email,
            role,
            must_change_password,
            csrf_token_digest: Vec::new(),
            api_key_id: None,
            device_id: Some(device_id),
            is_bearer_session: false,
        }
    }
}

async fn authenticate_session_token(
    state: &AppState,
    token: &str,
    path: &str,
    is_bearer_session: bool,
    client_ip: Option<&str>,
    user_agent: Option<&str>,
) -> Result<AuthenticatedUser, (StatusCode, &'static str)> {
    if token.len() != 43 {
        return Err((StatusCode::UNAUTHORIZED, "authentication_required"));
    }
    let Ok(raw_token) = URL_SAFE_NO_PAD.decode(token) else {
        return Err((StatusCode::UNAUTHORIZED, "authentication_required"));
    };
    if raw_token.len() != SESSION_TOKEN_BYTES {
        return Err((StatusCode::UNAUTHORIZED, "authentication_required"));
    }
    let token_digest = Sha256::digest(raw_token).to_vec();
    let session = sqlx::query_as::<_, SessionUser>(
        "SELECT sessions.id AS session_id, users.id, users.email, users.role, \
                users.must_change_password, sessions.csrf_token_digest, sessions.last_seen_at \
           FROM sessions JOIN users ON users.id = sessions.user_id \
          WHERE sessions.token_digest = $1 AND sessions.revoked_at IS NULL \
            AND sessions.expires_at > now() AND users.disabled_at IS NULL",
    )
    .bind(token_digest)
    .fetch_optional(&state.pool)
    .await;

    match session {
        Ok(Some(session)) => {
            let should_update_last_seen = session
                .last_seen_at
                .as_ref()
                .is_none_or(|seen_at| *seen_at < Utc::now() - ChronoDuration::minutes(5));
            let user = AuthenticatedUser {
                id: session.id,
                session_id: session.session_id,
                email: session.email,
                role: session.role,
                must_change_password: session.must_change_password,
                csrf_token_digest: session.csrf_token_digest,
                api_key_id: None,
                device_id: None,
                is_bearer_session,
            };
            if should_update_last_seen
                && let Err(error) = sqlx::query(
                    "UPDATE sessions \
                        SET last_seen_at = now(), \
                            ip_address = COALESCE($2, ip_address), \
                            user_agent = COALESCE(user_agent, $3), \
                            client_type = CASE WHEN $4 THEN 'mobile' ELSE client_type END \
                      WHERE id = $1 AND (last_seen_at IS NULL OR last_seen_at < now() - interval '5 minutes')",
                )
                .bind(user.session_id)
                .bind(client_ip)
                .bind(user_agent)
                .bind(is_bearer_session)
                .execute(&state.pool)
                .await
            {
                tracing::warn!(error = %error, "could not update session activity");
            }
            let allowed_while_changing_password = matches!(
                path,
                "/api/auth/me" | "/api/auth/password" | "/api/auth/logout"
            );
            if user.must_change_password && !allowed_while_changing_password {
                Err((StatusCode::FORBIDDEN, "password_change_required"))
            } else {
                Ok(user)
            }
        }
        Ok(None) => Err((StatusCode::UNAUTHORIZED, "authentication_required")),
        Err(error) => {
            tracing::error!(error = %error, "session lookup failed");
            Err((StatusCode::SERVICE_UNAVAILABLE, "service_unavailable"))
        }
    }
}

impl FromRequestParts<AppState> for AuthenticatedUser {
    type Rejection = Response;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        if let Some(user) = parts.extensions.get::<AuthenticatedUser>() {
            return Ok(user.clone());
        }
        let peer_ip = parts
            .extensions
            .get::<ConnectInfo<SocketAddr>>()
            .map(|info| info.0.ip());
        let client_ip = extract_client_ip(&parts.headers, peer_ip);
        let user_agent = extract_user_agent(&parts.headers);
        if let Some(token) = bearer_token(&parts.headers) {
            if let Some(session_token) = token.strip_prefix(MOBILE_SESSION_PREFIX) {
                return authenticate_session_token(
                    state,
                    session_token,
                    parts.uri.path(),
                    true,
                    client_ip.as_deref(),
                    user_agent.as_deref(),
                )
                .await
                .map_err(|(status, code)| api_error(status, code));
            }
            if !token.starts_with("mdb_") {
                return Err(api_error(
                    StatusCode::UNAUTHORIZED,
                    "authentication_required",
                ));
            }
            let reported_ip = crate::devices::forwarded_ip(&parts.headers);
            match crate::devices::authenticate_access_token(state, token, reported_ip.as_deref())
                .await
            {
                Ok(Some(user)) => {
                    if user.must_change_password {
                        return Err(api_error(StatusCode::FORBIDDEN, "password_change_required"));
                    }
                    if !crate::devices::device_request_allowed(&parts.method, parts.uri.path()) {
                        return Err(api_error(StatusCode::FORBIDDEN, "insufficient_scope"));
                    }
                    return Ok(user);
                }
                Ok(None) => {
                    return Err(api_error(
                        StatusCode::UNAUTHORIZED,
                        "authentication_required",
                    ));
                }
                Err(error) => {
                    tracing::error!(error = %error, "device token lookup failed");
                    return Err(api_error(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "service_unavailable",
                    ));
                }
            }
        }
        let Some(token) = cookie_value(&parts.headers, state.auth_settings.session_cookie_name())
        else {
            return Err(api_error(
                StatusCode::UNAUTHORIZED,
                "authentication_required",
            ));
        };
        authenticate_session_token(
            state,
            token,
            parts.uri.path(),
            false,
            client_ip.as_deref(),
            user_agent.as_deref(),
        )
        .await
        .map_err(|(status, code)| api_error(status, code))
    }
}

fn public_user(user: &LoginUser) -> UserResponse {
    UserResponse {
        id: user.id,
        email: user.email.clone(),
        role: user.role.clone(),
        must_change_password: user.must_change_password,
    }
}

fn public_user_from_auth(user: &AuthenticatedUser) -> UserResponse {
    UserResponse {
        id: user.id,
        email: user.email.clone(),
        role: user.role.clone(),
        must_change_password: user.must_change_password,
    }
}

pub(crate) fn new_temporary_password() -> anyhow::Result<String> {
    secure_token(CSRF_TOKEN_BYTES).map(|(_, encoded)| encoded)
}

pub(crate) fn verify_login_password(encoded_hash: Option<String>, password: &str) -> bool {
    let user_exists = encoded_hash.is_some();
    let encoded_hash = encoded_hash.unwrap_or_else(|| dummy_password_hash().to_owned());
    let parsed_hash = PasswordHash::new(&encoded_hash);
    let hash_is_valid = parsed_hash.is_ok();
    let dummy_hash = PasswordHash::new(dummy_password_hash())
        .expect("dummy Argon2id hash is generated by this application");
    let hash = parsed_hash.unwrap_or(dummy_hash);
    let verified = Argon2::default()
        .verify_password(password.as_bytes(), &hash)
        .is_ok();
    user_exists && hash_is_valid && verified
}

static DUMMY_PASSWORD_HASH: OnceLock<String> = OnceLock::new();

fn dummy_password_hash() -> &'static str {
    DUMMY_PASSWORD_HASH
        .get_or_init(|| {
            super::password_hash("not-a-real-owner-password-for-timing-equalization")
                .expect("generate dummy Argon2id hash")
        })
        .as_str()
}

fn secure_token(size: usize) -> anyhow::Result<(Vec<u8>, String)> {
    let mut raw = vec![0u8; size];
    OsRng
        .try_fill_bytes(&mut raw)
        .map_err(|_| anyhow::anyhow!("operating system random generator failed"))?;
    let encoded = URL_SAFE_NO_PAD.encode(&raw);
    Ok((raw, encoded))
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get(AUTHORIZATION)?.to_str().ok()?;
    let token = value.strip_prefix("Bearer ")?;
    if token.is_empty() || token.chars().any(char::is_whitespace) {
        None
    } else {
        Some(token)
    }
}

fn cookie_value<'a>(headers: &'a HeaderMap, wanted_name: &str) -> Option<&'a str> {
    let header = headers.get(COOKIE)?.to_str().ok()?;
    let mut result = None;
    for cookie in header.split(';') {
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

fn add_cookie(
    response: &mut Response,
    name: &str,
    value: &str,
    http_only: bool,
    max_age_seconds: u64,
    secure: bool,
    strict_same_site: bool,
) {
    let http_only_flag = if http_only { "; HttpOnly" } else { "" };
    let secure_flag = if secure { "; Secure" } else { "" };
    let same_site = if strict_same_site { "Strict" } else { "Lax" };
    let cookie = format!(
        "{name}={value}; Path=/; Max-Age={max_age_seconds}; SameSite={same_site}{http_only_flag}{secure_flag}"
    );
    response.headers_mut().append(
        SET_COOKIE,
        HeaderValue::from_str(&cookie).expect("cookie value uses safe generated characters"),
    );
}

fn api_error(status: StatusCode, error: &'static str) -> Response {
    let mut response = (status, Json(ErrorResponse { error })).into_response();
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn insert_login_failure(
    pool: &sqlx::PgPool,
    actor_id: Option<Uuid>,
) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT INTO audit_events (event_type, actor_id) VALUES ('login_failure', $1)")
        .bind(actor_id)
        .execute(pool)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_rate_limiter_blocks_after_ten_failures_and_expires_them() {
        let limiter = LoginRateLimiter::default();
        let now = Instant::now();
        for _ in 0..LOGIN_FAILURE_LIMIT {
            limiter.record_failure_at("owner@example.test", now);
        }
        assert!(limiter.retry_after_at("owner@example.test", now).is_some());
        assert!(limiter.retry_after_at("other@example.test", now).is_none());
        assert!(
            limiter
                .retry_after_at(
                    "owner@example.test",
                    now + LOGIN_FAILURE_WINDOW + Duration::from_secs(1)
                )
                .is_none()
        );
    }

    #[test]
    fn password_verification_uses_dummy_hash_for_unknown_accounts() {
        assert!(!verify_login_password(None, "wrong-password"));
        let encoded = super::super::password_hash("owner password for test").unwrap();
        assert!(verify_login_password(
            Some(encoded.clone()),
            "owner password for test"
        ));
        assert!(!verify_login_password(Some(encoded), "wrong-password"));
    }

    #[test]
    fn session_and_csrf_cookies_use_host_prefix_only_when_secure() {
        let secure = AuthSettings {
            cookie_secure: true,
            session_ttl_seconds: 3600,
        };
        let development = AuthSettings {
            cookie_secure: false,
            session_ttl_seconds: 3600,
        };
        assert_eq!(secure.session_cookie_name(), "__Host-my_drive_session");
        assert_eq!(secure.csrf_cookie_name(), "__Host-my_drive_csrf");
        assert_eq!(development.session_cookie_name(), "my_drive_session");
        assert_eq!(development.csrf_cookie_name(), "my_drive_csrf");
    }

    #[test]
    fn duplicate_cookie_names_are_rejected() {
        let mut headers = HeaderMap::new();
        headers.insert(
            COOKIE,
            HeaderValue::from_static("my_drive_session=one; my_drive_session=two"),
        );
        assert!(cookie_value(&headers, "my_drive_session").is_none());
    }

    #[test]
    fn csrf_validation_requires_matching_cookie_header_and_database_digest() {
        let raw_token = [0x5a; CSRF_TOKEN_BYTES];
        let token = URL_SAFE_NO_PAD.encode(raw_token);
        let user = AuthenticatedUser {
            id: Uuid::new_v4(),
            session_id: Uuid::new_v4(),
            email: "owner@example.test".to_owned(),
            role: "owner".to_owned(),
            must_change_password: false,
            api_key_id: None,
            device_id: None,
            is_bearer_session: false,
            csrf_token_digest: Sha256::digest(raw_token).to_vec(),
        };
        let settings = AuthSettings {
            cookie_secure: false,
            session_ttl_seconds: 3600,
        };
        let mut headers = HeaderMap::new();
        headers.insert(
            COOKIE,
            HeaderValue::from_str(&format!("my_drive_csrf={token}")).unwrap(),
        );
        headers.insert("x-csrf-token", HeaderValue::from_str(&token).unwrap());
        assert!(require_csrf(&headers, &user, settings));

        headers.insert("x-csrf-token", HeaderValue::from_static("wrong-token"));
        assert!(!require_csrf(&headers, &user, settings));
    }

    #[test]
    fn mobile_bearer_sessions_bypass_cookie_csrf_and_require_client_header() {
        let user = AuthenticatedUser {
            id: Uuid::new_v4(),
            session_id: Uuid::new_v4(),
            email: "owner@example.test".to_owned(),
            role: "owner".to_owned(),
            must_change_password: false,
            api_key_id: None,
            device_id: None,
            is_bearer_session: true,
            csrf_token_digest: Vec::new(),
        };
        let settings = AuthSettings {
            cookie_secure: true,
            session_ttl_seconds: 3600,
        };
        let mut headers = HeaderMap::new();
        assert!(require_csrf(&headers, &user, settings));
        assert!(!is_mobile_client(&headers));

        headers.insert("x-mydrive-client", HeaderValue::from_static("Mobile"));
        assert!(is_mobile_client(&headers));
    }

    #[test]
    fn secure_cookies_are_host_only_httponly_for_sessions_and_not_for_csrf() {
        let settings = AuthSettings {
            cookie_secure: true,
            session_ttl_seconds: 3600,
        };
        let mut response = StatusCode::OK.into_response();
        add_cookie(
            &mut response,
            settings.session_cookie_name(),
            "session-token",
            true,
            settings.session_ttl_seconds,
            true,
            false,
        );
        add_cookie(
            &mut response,
            settings.csrf_cookie_name(),
            "csrf-token",
            false,
            settings.session_ttl_seconds,
            true,
            true,
        );
        let values = response
            .headers()
            .get_all(SET_COOKIE)
            .iter()
            .map(|value| value.to_str().unwrap())
            .collect::<Vec<_>>();
        assert!(values[0].contains("__Host-my_drive_session=session-token"));
        assert!(values[0].contains("HttpOnly"));
        assert!(values[0].contains("Secure"));
        assert!(values[0].contains("SameSite=Lax"));
        assert!(values[1].contains("__Host-my_drive_csrf=csrf-token"));
        assert!(!values[1].contains("HttpOnly"));
        assert!(values[1].contains("SameSite=Strict"));
    }

    #[test]
    fn extract_client_ip_trusts_proxy_headers_only_from_local_proxies() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "cf-connecting-ip",
            HeaderValue::from_static("198.51.100.42"),
        );
        headers.insert(
            "x-forwarded-for",
            HeaderValue::from_static("203.0.113.9, 10.0.0.1"),
        );

        let trusted_proxy: IpAddr = "172.18.0.5".parse().unwrap();
        assert_eq!(
            extract_client_ip(&headers, Some(trusted_proxy)).as_deref(),
            Some("198.51.100.42")
        );

        let direct_public: IpAddr = "203.0.113.77".parse().unwrap();
        assert_eq!(
            extract_client_ip(&headers, Some(direct_public)).as_deref(),
            Some("203.0.113.77")
        );

        headers.insert("cf-connecting-ip", HeaderValue::from_static("not-an-ip"));
        assert_eq!(
            extract_client_ip(&headers, Some(trusted_proxy)).as_deref(),
            Some("203.0.113.9")
        );
    }

    #[test]
    fn detect_device_label_parses_mobile_and_browser_agents() {
        let mut mobile_headers = HeaderMap::new();
        mobile_headers.insert("x-mydrive-client", HeaderValue::from_static("mobile"));
        mobile_headers.insert(
            "x-mydrive-device",
            HeaderValue::from_static("MyDrive iPhone 16 Pro"),
        );
        assert_eq!(
            detect_device_label(&mobile_headers, "mobile", Some("Darwin/24.0")),
            "MyDrive iPhone 16 Pro"
        );

        let web_headers = HeaderMap::new();
        assert_eq!(
            detect_device_label(
                &web_headers,
                "web",
                Some(
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0"
                )
            ),
            "Edge on Windows"
        );
        assert_eq!(
            detect_device_label(
                &web_headers,
                "web",
                Some(
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15"
                )
            ),
            "Safari on macOS"
        );
    }
}
