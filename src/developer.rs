use crate::{
    auth::{AuthenticatedUser, require_csrf},
    health::AppState,
};
use axum::{
    Json, Router,
    body::Body,
    extract::{MatchedPath, Path, Query, State},
    http::{HeaderMap, Request, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Utc};
use http_body_util::BodyExt;
use rand_core::{OsRng, RngCore};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};
use uuid::Uuid;

const SCOPES: &[&str] = &[
    "drive:read",
    "drive:write",
    "photos:read",
    "photos:write",
    "shares:read",
    "shares:write",
];

pub(crate) async fn documentation(Path(path): Path<String>) -> Response {
    if !path.ends_with(".md") {
        return crate::api::serve_frontend_index().await;
    }
    let text = match path.as_str() {
        "index.md" => include_str!("../frontend/public/docs/index.md"),
        "authentication.md" => include_str!("../frontend/public/docs/authentication.md"),
        "drive.md" => include_str!("../frontend/public/docs/drive.md"),
        "uploads.md" => include_str!("../frontend/public/docs/uploads.md"),
        "photos.md" => include_str!("../frontend/public/docs/photos.md"),
        "shares.md" => include_str!("../frontend/public/docs/shares.md"),
        "usage.md" => include_str!("../frontend/public/docs/usage.md"),
        "lesson-sync.md" => include_str!("../frontend/public/docs/lesson-sync.md"),
        _ => return error(StatusCode::NOT_FOUND, "not_found"),
    };
    ([("content-type", "text/markdown; charset=utf-8")], text).into_response()
}
type ApiResult = Result<Response, ApiError>;

struct ApiError {
    status: StatusCode,
    code: &'static str,
}

impl ApiError {
    fn new(status: StatusCode, code: &'static str) -> Self {
        Self { status, code }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        error(self.status, self.code)
    }
}
fn error(status: StatusCode, code: &str) -> Response {
    (status, Json(json!({"error":code}))).into_response()
}
fn db(error_value: sqlx::Error) -> ApiError {
    tracing::error!(error = %error_value, "developer API database operation failed");
    ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "service_unavailable")
}
fn output(value: Value) -> Response {
    let mut response = Json(value).into_response();
    response
        .headers_mut()
        .insert("cache-control", "no-store".parse().unwrap());
    response
}

pub(crate) fn router() -> Router<AppState> {
    let versioned = Router::new()
        .merge(crate::drive::router_at("/api/v1"))
        .merge(crate::transfers::router_at("/api/v1"))
        .merge(crate::library::router_at("/api/v1"))
        .merge(crate::shares::router_at("/api/v1"));
    // Versioned routes use the existing ownership checks and transfer pipeline.
    Router::new()
        .merge(versioned)
        .route("/api/developer/keys", get(keys).post(create_key))
        .route("/api/developer/keys/{id}/revoke", post(revoke_key))
        .route(
            "/api/developer/keys/{id}/shares/revoke",
            post(revoke_key_shares),
        )
        .route("/api/developer/usage", get(usage))
        .route("/api/developer/logs", get(logs))
        .layer(axum::extract::DefaultBodyLimit::max(16 * 1024))
}

fn scope_for(path: &str, method: &str) -> Option<&'static str> {
    let path = path.strip_prefix("/api/v1")?;
    let read = matches!(method, "GET" | "HEAD");
    if path.starts_with("/public/") || path.starts_with("/admin/") || path.starts_with("/faces/") {
        return None;
    }
    if path == "/photos"
        || path.starts_with("/albums")
        || path == "/library/photos-folder"
        || path == "/photos/uploads"
    {
        Some(if read { "photos:read" } else { "photos:write" })
    } else if path == "/shares" || path.starts_with("/shares/") {
        Some(if read { "shares:read" } else { "shares:write" })
    } else if path.starts_with("/drive")
        || path == "/folders"
        || path.starts_with("/entries/")
        || path.starts_with("/files/")
        || path.starts_with("/uploads")
        || path == "/storage"
    {
        Some(if read { "drive:read" } else { "drive:write" })
    } else {
        None
    }
}

#[derive(sqlx::FromRow)]
struct KeyAuth {
    id: Uuid,
    owner_id: Uuid,
    email: String,
    role: String,
    scopes: Vec<String>,
}
pub(crate) async fn authenticate(
    State(state): State<AppState>,
    mut request: Request<Body>,
    next: Next,
) -> Response {
    if !request.uri().path().starts_with("/api/v1/") {
        return next.run(request).await;
    }
    let Some(scope) = scope_for(request.uri().path(), request.method().as_str()) else {
        return error(StatusCode::NOT_FOUND, "not_found");
    };
    let Some(token) = request
        .headers()
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
    else {
        return error(StatusCode::UNAUTHORIZED, "invalid_api_key");
    };
    if token.len() != 47 || !token.starts_with("mdk_") {
        return error(StatusCode::UNAUTHORIZED, "invalid_api_key");
    }
    let key = match sqlx::query_as::<_, KeyAuth>("SELECT k.id, k.owner_id, u.email, u.role, k.scopes FROM api_keys k JOIN users u ON u.id=k.owner_id WHERE k.token_digest=$1 AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>now()) AND u.disabled_at IS NULL AND NOT u.must_change_password")
        .bind(Sha256::digest(token.as_bytes()).to_vec()).fetch_optional(&state.pool).await { Ok(Some(k)) => k, Ok(None) => return error(StatusCode::UNAUTHORIZED, "invalid_api_key"), Err(e) => return db(e).into_response() };
    let started = std::time::Instant::now();
    let method = request.method().to_string();
    let route = request
        .extensions()
        .get::<MatchedPath>()
        .map(|p| p.as_str().to_owned())
        .unwrap_or_else(|| "/api/v1/unknown".into());
    let consumed_bytes = Arc::new(AtomicU64::new(0));
    let meter = consumed_bytes.clone();
    request = request.map(|body| {
        Body::new(body.map_frame(move |frame| {
            if let Some(data) = frame.data_ref() {
                meter.fetch_add(data.len() as u64, Ordering::Relaxed);
            }
            frame
        }))
    });
    let count: Option<i32> = match sqlx::query_scalar("UPDATE api_keys SET last_used_at=now(), rate_count=CASE WHEN rate_window < now()-interval '1 minute' THEN 1 ELSE rate_count+1 END, rate_window=CASE WHEN rate_window < now()-interval '1 minute' THEN now() ELSE rate_window END WHERE id=$1 AND revoked_at IS NULL RETURNING rate_count").bind(key.id).fetch_optional(&state.pool).await { Ok(c)=>c, Err(e)=>return db(e).into_response() };
    let mut response = if count.is_none() {
        error(StatusCode::UNAUTHORIZED, "invalid_api_key")
    } else if count.is_some_and(|c| c > 120) {
        let mut r = error(StatusCode::TOO_MANY_REQUESTS, "rate_limit_exceeded");
        r.headers_mut().insert("retry-after", "60".parse().unwrap());
        r
    } else if !key.scopes.iter().any(|s| s == scope) {
        error(StatusCode::FORBIDDEN, "insufficient_scope")
    } else {
        request.extensions_mut().insert(AuthenticatedUser::from_api(
            key.owner_id,
            key.id,
            key.email,
            key.role,
        ));
        next.run(request).await
    };
    let request_bytes = consumed_bytes.load(Ordering::Relaxed).min(i64::MAX as u64) as i64;
    if let Err(e)=sqlx::query("INSERT INTO api_request_logs(owner_id,api_key_id,method,route,status,duration_ms,request_bytes) VALUES($1,$2,$3,$4,$5,$6,$7)")
        .bind(key.owner_id).bind(key.id).bind(method).bind(route).bind(i32::from(response.status().as_u16())).bind(started.elapsed().as_millis().min(i64::MAX as u128) as i64).bind(request_bytes).execute(&state.pool).await { tracing::error!(error=%e,"could not record API request"); }
    response
        .headers_mut()
        .insert("cache-control", "no-store".parse().unwrap());
    response
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct KeyPage {
    offset: Option<i64>,
}
async fn keys(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Query(page): Query<KeyPage>,
) -> ApiResult {
    let offset = page.offset.unwrap_or(0);
    if !(0..=1_000_000).contains(&offset) {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "invalid_request"));
    }
    let mut rows:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(k)-'token_digest'-'rate_window'-'rate_count' FROM api_keys k WHERE owner_id=$1 ORDER BY created_at DESC,id LIMIT 101 OFFSET $2").bind(user.id).bind(offset).fetch_all(&state.pool).await.map_err(db)?;
    let more = rows.len() > 100;
    if more {
        rows.pop();
    }
    Ok(output(
        json!({"keys":rows,"next_offset":more.then_some(offset+100)}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NewKey {
    name: String,
    scopes: Vec<String>,
    expires_at: Option<DateTime<Utc>>,
}
async fn create_key(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
    Json(input): Json<NewKey>,
) -> ApiResult {
    if !require_csrf(&headers, &user, state.auth_settings) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "csrf_failed"));
    }
    let name = input.name.trim();
    if name.is_empty()
        || name.chars().count() > 100
        || input.scopes.is_empty()
        || input.scopes.len() > 6
        || input.scopes.iter().any(|s| !SCOPES.contains(&s.as_str()))
        || input.expires_at.is_some_and(|d| d <= Utc::now())
    {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "invalid_request"));
    }
    let mut raw = [0u8; 32];
    OsRng
        .try_fill_bytes(&mut raw)
        .map_err(|_| ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "service_unavailable"))?;
    let token = format!("mdk_{}", URL_SAFE_NO_PAD.encode(raw));
    let id = Uuid::new_v4();
    let mut tx = state.pool.begin().await.map_err(db)?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))")
        .bind(user.id)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    let count:i64=sqlx::query_scalar("SELECT count(*) FROM api_keys WHERE owner_id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())").bind(user.id).fetch_one(&mut *tx).await.map_err(db)?;
    if count >= 50 {
        return Err(ApiError::new(StatusCode::CONFLICT, "key_limit_reached"));
    }
    sqlx::query("INSERT INTO api_keys(id,owner_id,name,token_digest,prefix,scopes,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)").bind(id).bind(user.id).bind(name).bind(Sha256::digest(token.as_bytes()).to_vec()).bind(&token[..12]).bind(input.scopes).bind(input.expires_at).execute(&mut *tx).await.map_err(db)?;
    sqlx::query(
        "INSERT INTO audit_events(event_type,actor_id,resource_id) VALUES('api_key_created',$1,$2)",
    )
    .bind(user.id)
    .bind(id)
    .execute(&mut *tx)
    .await
    .map_err(db)?;
    tx.commit().await.map_err(db)?;
    let mut response = output(json!({"id":id,"key":token}));
    *response.status_mut() = StatusCode::CREATED;
    Ok(response)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Revoke {
    revoke_shares: bool,
}
async fn revoke_key(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(input): Json<Revoke>,
) -> ApiResult {
    revoke(&state, &user, &headers, id, true, input.revoke_shares).await
}
async fn revoke_key_shares(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> ApiResult {
    revoke(&state, &user, &headers, id, false, true).await
}
async fn revoke(
    state: &AppState,
    user: &AuthenticatedUser,
    headers: &HeaderMap,
    id: Uuid,
    revoke_key: bool,
    revoke_shares: bool,
) -> ApiResult {
    if !require_csrf(headers, user, state.auth_settings) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "csrf_failed"));
    }
    let mut tx = state.pool.begin().await.map_err(db)?;
    let exists: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM api_keys WHERE id=$1 AND owner_id=$2 FOR UPDATE")
            .bind(id)
            .bind(user.id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?;
    if exists.is_none() {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "not_found"));
    }
    if revoke_key {
        sqlx::query("UPDATE api_keys SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
    }
    let mut affected = 0;
    if revoke_shares {
        affected=sqlx::query("UPDATE shares SET revoked_at=now() WHERE created_by_api_key_id=$1 AND owner_id=$2 AND revoked_at IS NULL").bind(id).bind(user.id).execute(&mut *tx).await.map_err(db)?.rows_affected();
        sqlx::query("DELETE FROM share_access_sessions WHERE share_id IN (SELECT id FROM shares WHERE created_by_api_key_id=$1 AND owner_id=$2)").bind(id).bind(user.id).execute(&mut *tx).await.map_err(db)?;
    }
    sqlx::query("INSERT INTO audit_events(event_type,actor_id,resource_id,details) VALUES('api_key_revocation',$1,$2,$3)").bind(user.id).bind(id).bind(json!({"revoke_key":revoke_key,"revoke_shares":revoke_shares,"shares_revoked":affected})).execute(&mut *tx).await.map_err(db)?;
    tx.commit().await.map_err(db)?;
    Ok(output(json!({"shares_revoked":affected})))
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct UsageQuery {
    all: Option<bool>,
    owner_id: Option<Uuid>,
    key_id: Option<Uuid>,
    days: Option<i32>,
    before_id: Option<i64>,
}
fn visibility(user: &AuthenticatedUser, q: &UsageQuery) -> Result<Option<Uuid>, StatusCode> {
    if q.all.unwrap_or(false) || q.owner_id.is_some_and(|id| id != user.id) {
        if !matches!(user.role.as_str(), "owner" | "admin") {
            return Err(StatusCode::FORBIDDEN);
        }
        Ok(q.owner_id)
    } else {
        Ok(Some(user.id))
    }
}
async fn usage(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Query(q): Query<UsageQuery>,
) -> ApiResult {
    let owner = visibility(&user, &q).map_err(|s| ApiError::new(s, "forbidden"))?;
    let days = q.days.unwrap_or(30);
    if !(1..=90).contains(&days) {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "invalid_request"));
    }
    let daily:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('day',to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD'),'requests',count(*),'errors',count(*) FILTER(WHERE status>=400),'request_bytes',sum(request_bytes),'avg_duration_ms',round(avg(duration_ms))) FROM api_request_logs WHERE ($1::uuid IS NULL OR owner_id=$1) AND ($2::uuid IS NULL OR api_key_id=$2) AND created_at >= now()-make_interval(days=>$3) GROUP BY to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD') ORDER BY to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD')")
        .bind(owner).bind(q.key_id).bind(days).fetch_all(&state.pool).await.map_err(db)?;
    let users:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('owner_id',l.owner_id,'email',u.email,'requests',count(*),'errors',count(*) FILTER(WHERE status>=400),'request_bytes',sum(l.request_bytes)) FROM api_request_logs l JOIN users u ON u.id=l.owner_id WHERE ($1::uuid IS NULL OR l.owner_id=$1) AND ($2::uuid IS NULL OR l.api_key_id=$2) AND l.created_at>=now()-make_interval(days=>$3) GROUP BY l.owner_id,u.email ORDER BY count(*) DESC LIMIT 500").bind(owner).bind(q.key_id).bind(days).fetch_all(&state.pool).await.map_err(db)?;
    Ok(output(json!({"daily":daily,"users":users,"days":days})))
}
async fn logs(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Query(q): Query<UsageQuery>,
) -> ApiResult {
    let owner = visibility(&user, &q).map_err(|s| ApiError::new(s, "forbidden"))?;
    let mut rows:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(l) FROM api_request_logs l WHERE ($1::uuid IS NULL OR owner_id=$1) AND ($2::uuid IS NULL OR api_key_id=$2) AND ($3::bigint IS NULL OR id<$3) ORDER BY id DESC LIMIT 101").bind(owner).bind(q.key_id).bind(q.before_id).fetch_all(&state.pool).await.map_err(db)?;
    let more = rows.len() > 100;
    if more {
        rows.pop();
    }
    let next = if more {
        rows.last().and_then(|v| v.get("id")).cloned()
    } else {
        None
    };
    Ok(output(json!({"logs":rows,"next_before_id":next})))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn compact_errors_preserve_status_and_hide_database_details() {
        assert!(std::mem::size_of::<ApiError>() < 128);
        for (failure, expected_status, expected_code) in [
            (
                ApiError::new(StatusCode::FORBIDDEN, "csrf_failed"),
                StatusCode::FORBIDDEN,
                "csrf_failed",
            ),
            (
                db(sqlx::Error::Protocol("private database details".into())),
                StatusCode::SERVICE_UNAVAILABLE,
                "service_unavailable",
            ),
        ] {
            let response = failure.into_response();
            assert_eq!(response.status(), expected_status);
            let body = response.into_body().collect().await.unwrap().to_bytes();
            let value: Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(value, json!({"error": expected_code}));
        }
    }

    #[test]
    fn scopes_do_not_expose_browser_or_admin_surfaces() {
        assert_eq!(
            scope_for("/api/v1/photos/uploads", "POST"),
            Some("photos:write")
        );
        assert_eq!(
            scope_for("/api/v1/uploads/any-id", "PATCH"),
            Some("drive:write")
        );
        assert_eq!(scope_for("/api/v1/shares", "GET"), Some("shares:read"));
        for path in [
            "/api/v1/admin/storage",
            "/api/v1/public/shares/token",
            "/api/v1/auth/password",
            "/api/v1/developer/keys",
            "/api/v1/faces/id/media",
            "/api/auth/me",
        ] {
            assert_eq!(scope_for(path, "GET"), None);
        }
    }
    #[test]
    fn member_statistics_are_always_owner_scoped() {
        let owner = Uuid::new_v4();
        let member = AuthenticatedUser::from_api(
            owner,
            Uuid::new_v4(),
            "member@example.test".into(),
            "member".into(),
        );
        assert_eq!(
            visibility(&member, &UsageQuery::default()).unwrap(),
            Some(owner)
        );
        assert!(
            visibility(
                &member,
                &UsageQuery {
                    all: Some(true),
                    ..Default::default()
                }
            )
            .is_err()
        );
        assert!(
            visibility(
                &member,
                &UsageQuery {
                    owner_id: Some(Uuid::new_v4()),
                    ..Default::default()
                }
            )
            .is_err()
        );
    }
}
