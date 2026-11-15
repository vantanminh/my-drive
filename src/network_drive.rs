//! Optional read-only WebDAV "network drive" for the private network.
//!
//! The owner enables it from the web UI (disabled by default). When enabled,
//! `/webdav/` serves each user's own drive to WebDAV clients (Windows "Map
//! network drive", macOS Finder, Linux GVFS/davfs2, iOS Files). Requests are
//! accepted only from private/loopback/link-local clients, authenticate with
//! HTTP Basic (username = account email, password = an API key that has the
//! `drive:read` scope) and can never modify files.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::SystemTime;

use axum::{
    Json, Router,
    body::Body,
    extract::{ConnectInfo, Path, State},
    http::{HeaderMap, Method, Request, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{any, get, put},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    auth::{self, AuthenticatedUser},
    drive,
    health::AppState,
    smb_share, transfers,
};

const MOUNT: &str = "/webdav/";
const MAX_DEPTH: usize = 64;
const MAX_LISTING: i64 = 10_000;
const ALLOW: &str = "OPTIONS, GET, HEAD, PROPFIND";

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/network-drive", get(status).patch(update))
        .route("/api/network-drive/smb-password", put(set_smb_password))
        .route("/webdav", any(webdav_root))
        .route("/webdav/", any(webdav_root))
        .route("/webdav/{*path}", any(webdav_path))
}

// ---------------------------------------------------------------- settings

#[derive(sqlx::FromRow, Default)]
struct NetworkDriveSettingsRow {
    webdav_enabled: bool,
    smb_enabled: bool,
}

async fn load_settings(state: &AppState) -> Result<NetworkDriveSettingsRow, sqlx::Error> {
    let row: Option<NetworkDriveSettingsRow> = sqlx::query_as(
        "SELECT webdav_enabled, smb_enabled FROM network_drive_settings WHERE singleton",
    )
    .fetch_optional(&state.pool)
    .await?;
    Ok(row.unwrap_or_default())
}

async fn is_enabled(state: &AppState) -> Result<bool, sqlx::Error> {
    let value: Option<bool> =
        sqlx::query_scalar("SELECT webdav_enabled FROM network_drive_settings WHERE singleton")
            .fetch_optional(&state.pool)
            .await?;
    Ok(value.unwrap_or(false))
}

fn json_error(status: StatusCode, code: &'static str) -> Response {
    (status, Json(json!({ "error": code }))).into_response()
}

async fn status(State(state): State<AppState>, user: AuthenticatedUser) -> Response {
    let settings = match load_settings(&state).await {
        Ok(settings) => settings,
        Err(error) => {
            tracing::error!(error = %error, "could not read network drive settings");
            return json_error(StatusCode::SERVICE_UNAVAILABLE, "service_unavailable");
        }
    };
    let smb_username: Option<String> =
        match sqlx::query_scalar("SELECT username FROM smb_accounts WHERE user_id = $1")
            .bind(user.id)
            .fetch_optional(&state.pool)
            .await
        {
            Ok(username) => username,
            Err(error) => {
                tracing::error!(error = %error, "could not read SMB account");
                return json_error(StatusCode::SERVICE_UNAVAILABLE, "service_unavailable");
            }
        };
    let mut response = Json(json!({
        "enabled": settings.webdav_enabled,
        "path": MOUNT,
        "lanOnly": true,
        "readOnly": true,
        "canManage": user.role == "owner",
        "smbEnabled": settings.smb_enabled,
        "smbAvailable": smb_share::available(),
        "smbUsername": smb_username,
    }))
    .into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateRequest {
    enabled: Option<bool>,
    smb_enabled: Option<bool>,
}

async fn update(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
    Json(input): Json<UpdateRequest>,
) -> Response {
    if user.role != "owner" {
        return json_error(StatusCode::FORBIDDEN, "owner_required");
    }
    if drive::require_request_csrf(&headers, &user, state.auth_settings).is_err() {
        return json_error(StatusCode::FORBIDDEN, "csrf_failed");
    }
    if input.enabled.is_none() && input.smb_enabled.is_none() {
        return json_error(StatusCode::BAD_REQUEST, "invalid_request");
    }
    let result = async {
        let mut tx = state.pool.begin().await?;
        sqlx::query(
            "UPDATE network_drive_settings \
                SET webdav_enabled = COALESCE($1, webdav_enabled), \
                    smb_enabled = COALESCE($2, smb_enabled), \
                    updated_by = $3, updated_at = now() \
              WHERE singleton",
        )
        .bind(input.enabled)
        .bind(input.smb_enabled)
        .bind(user.id)
        .execute(&mut *tx)
        .await?;
        if let Some(enabled) = input.enabled {
            sqlx::query("INSERT INTO audit_events (event_type, actor_id) VALUES ($1, $2)")
                .bind(if enabled {
                    "network_drive_enabled"
                } else {
                    "network_drive_disabled"
                })
                .bind(user.id)
                .execute(&mut *tx)
                .await?;
        }
        if let Some(smb_enabled) = input.smb_enabled {
            sqlx::query("INSERT INTO audit_events (event_type, actor_id) VALUES ($1, $2)")
                .bind(if smb_enabled {
                    "smb_network_drive_enabled"
                } else {
                    "smb_network_drive_disabled"
                })
                .bind(user.id)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await
    }
    .await;
    match result {
        Ok(()) => status(State(state), user).await,
        Err(error) => {
            tracing::error!(error = %error, "could not update network drive settings");
            json_error(StatusCode::SERVICE_UNAVAILABLE, "service_unavailable")
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SetSmbPasswordRequest {
    password: String,
}

fn is_unique_violation(error: &sqlx::Error) -> bool {
    matches!(error, sqlx::Error::Database(database) if database.code().as_deref() == Some("23505"))
}

async fn set_smb_password(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
    Json(input): Json<SetSmbPasswordRequest>,
) -> Response {
    if drive::require_request_csrf(&headers, &user, state.auth_settings).is_err() {
        return json_error(StatusCode::FORBIDDEN, "csrf_failed");
    }
    if !auth::valid_password(&input.password) {
        return json_error(StatusCode::BAD_REQUEST, "password_requirements");
    }
    let nt_hash = smb_share::nt_hash(&input.password);
    let result = async {
        let mut tx = state.pool.begin().await?;
        let existing: Option<String> = sqlx::query_scalar(
            "UPDATE smb_accounts \
                SET nt_hash = $2, updated_at = now() \
              WHERE user_id = $1 \
          RETURNING username",
        )
        .bind(user.id)
        .bind(nt_hash.as_slice())
        .fetch_optional(&mut *tx)
        .await?;

        if existing.is_none() {
            let mut inserted = false;
            for attempt in 0..1000u32 {
                let candidate = smb_share::username_candidate(&user.email, attempt);
                sqlx::query("SAVEPOINT smb_account_insert")
                    .execute(&mut *tx)
                    .await?;
                let attempt_result = sqlx::query(
                    "INSERT INTO smb_accounts (user_id, username, nt_hash) \
                     VALUES ($1, $2, $3) \
                     ON CONFLICT (user_id) DO UPDATE \
                         SET nt_hash = EXCLUDED.nt_hash, \
                             updated_at = now()",
                )
                .bind(user.id)
                .bind(&candidate)
                .bind(nt_hash.as_slice())
                .execute(&mut *tx)
                .await;
                match attempt_result {
                    Ok(_) => {
                        sqlx::query("RELEASE SAVEPOINT smb_account_insert")
                            .execute(&mut *tx)
                            .await?;
                        inserted = true;
                        break;
                    }
                    Err(error) if is_unique_violation(&error) => {
                        sqlx::query("ROLLBACK TO SAVEPOINT smb_account_insert")
                            .execute(&mut *tx)
                            .await?;
                    }
                    Err(error) => return Err(error),
                }
            }
            if !inserted {
                return Err(sqlx::Error::Protocol(
                    "could not allocate unique SMB username".into(),
                ));
            }
        }

        sqlx::query(
            "INSERT INTO audit_events (event_type, actor_id) VALUES ('smb_password_updated', $1)",
        )
        .bind(user.id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await
    }
    .await;

    match result {
        Ok(()) => status(State(state), user).await,
        Err(error) => {
            tracing::error!(error = %error, "could not update SMB password");
            json_error(StatusCode::SERVICE_UNAVAILABLE, "service_unavailable")
        }
    }
}

// ----------------------------------------------------------- LAN restriction

fn is_lan_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_lan_v4(v4),
        IpAddr::V6(v6) => {
            let first = v6.segments()[0];
            v6.is_loopback()
                || (first & 0xfe00) == 0xfc00 // unique local fc00::/7
                || (first & 0xffc0) == 0xfe80 // link local fe80::/10
                || v6.to_ipv4_mapped().is_some_and(is_lan_v4)
        }
    }
}

fn is_lan_v4(ip: Ipv4Addr) -> bool {
    ip.is_private() || ip.is_loopback() || ip.is_link_local()
}

/// Every address that identifies the client (the TCP peer plus anything a
/// reverse proxy reports) must be a private address. Missing information or an
/// unparsable value is treated as "not on the LAN".
fn request_is_lan(headers: &HeaderMap, peer: Option<IpAddr>) -> bool {
    let mut seen = Vec::new();
    if let Some(peer) = peer {
        seen.push(peer);
    }
    for name in ["x-forwarded-for", "cf-connecting-ip", "x-real-ip"] {
        for value in headers.get_all(name) {
            let Ok(text) = value.to_str() else {
                return false;
            };
            for part in text.split(',') {
                match part.trim().parse::<IpAddr>() {
                    Ok(ip) => seen.push(ip),
                    Err(_) => return false,
                }
            }
        }
    }
    !seen.is_empty() && seen.into_iter().all(is_lan_ip)
}

// ------------------------------------------------------------------ WebDAV

async fn webdav_root(State(state): State<AppState>, request: Request<Body>) -> Response {
    serve(state, String::new(), request).await
}

async fn webdav_path(
    State(state): State<AppState>,
    Path(path): Path<String>,
    request: Request<Body>,
) -> Response {
    serve(state, path, request).await
}

fn plain(status: StatusCode) -> Response {
    let mut response = status.into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
}

fn unauthorized() -> Response {
    let mut response = plain(StatusCode::UNAUTHORIZED);
    response.headers_mut().insert(
        header::WWW_AUTHENTICATE,
        "Basic realm=\"My Drive\", charset=\"UTF-8\""
            .parse()
            .unwrap(),
    );
    response
}

struct DavUser {
    id: Uuid,
}

async fn serve(state: AppState, path: String, request: Request<Body>) -> Response {
    let peer = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|info| info.0.ip());
    let headers = request.headers().clone();
    let method = request.method().clone();
    drop(request);

    match is_enabled(&state).await {
        Ok(true) => {}
        // Hide the endpoint completely while the feature is switched off.
        Ok(false) => return plain(StatusCode::NOT_FOUND),
        Err(error) => {
            tracing::error!(error = %error, "could not read network drive settings");
            return plain(StatusCode::SERVICE_UNAVAILABLE);
        }
    }
    if !request_is_lan(&headers, peer) {
        return plain(StatusCode::FORBIDDEN);
    }

    if method == Method::OPTIONS {
        let mut response = plain(StatusCode::OK);
        let h = response.headers_mut();
        h.insert("dav", "1".parse().unwrap());
        h.insert("ms-author-via", "DAV".parse().unwrap());
        h.insert(header::ALLOW, ALLOW.parse().unwrap());
        h.insert(header::CONTENT_LENGTH, "0".parse().unwrap());
        return response;
    }

    let user = match authenticate(&state, &headers).await {
        Ok(Some(user)) => user,
        Ok(None) => return unauthorized(),
        Err(error) => {
            tracing::error!(error = %error, "network drive authentication failed");
            return plain(StatusCode::SERVICE_UNAVAILABLE);
        }
    };

    let is_propfind = method.as_str() == "PROPFIND";
    if method != Method::GET && method != Method::HEAD && !is_propfind {
        let mut response = plain(StatusCode::METHOD_NOT_ALLOWED);
        response
            .headers_mut()
            .insert(header::ALLOW, ALLOW.parse().unwrap());
        return response;
    }

    let segments: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
    if segments.len() > MAX_DEPTH || segments.iter().any(|part| *part == "." || *part == "..") {
        return plain(StatusCode::NOT_FOUND);
    }
    let target = match resolve(&state, user.id, &segments).await {
        Ok(Some(target)) => target,
        Ok(None) => return plain(StatusCode::NOT_FOUND),
        Err(error) => {
            tracing::error!(error = %error, "network drive path lookup failed");
            return plain(StatusCode::SERVICE_UNAVAILABLE);
        }
    };

    if is_propfind {
        return propfind(&state, user.id, &segments, target, &headers).await;
    }

    match target {
        Target::Root => directory_page(),
        Target::Entry(id) => {
            let head = method == Method::HEAD;
            match transfers::download_response(&state, user.id, id, &headers, head).await {
                Ok(response) => response,
                Err(error) => error.into_response(),
            }
        }
    }
}

fn directory_page() -> Response {
    (
        [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        "My Drive WebDAV network drive (read-only). Connect with a WebDAV client.\n",
    )
        .into_response()
}

async fn authenticate(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<Option<DavUser>, sqlx::Error> {
    let Some(value) = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
    else {
        return Ok(None);
    };
    let Some(encoded) = value
        .strip_prefix("Basic ")
        .or_else(|| value.strip_prefix("basic "))
    else {
        return Ok(None);
    };
    let Some((email, token)) = STANDARD
        .decode(encoded.trim())
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .and_then(|text| {
            text.split_once(':')
                .map(|(a, b)| (a.trim().to_lowercase(), b.to_owned()))
        })
    else {
        return Ok(None);
    };
    if !(token.len() == 47 && token.starts_with("mdk_")) {
        return password_login(state, &email, token).await;
    }
    let row: Option<(Uuid, Uuid)> = sqlx::query_as(
        "SELECT k.id, k.owner_id FROM api_keys k JOIN users u ON u.id = k.owner_id \
          WHERE k.token_digest = $1 AND k.revoked_at IS NULL \
            AND (k.expires_at IS NULL OR k.expires_at > now()) \
            AND 'drive:read' = ANY(k.scopes) \
            AND lower(u.email) = $2 AND u.disabled_at IS NULL AND NOT u.must_change_password",
    )
    .bind(Sha256::digest(token.as_bytes()).to_vec())
    .bind(email)
    .fetch_optional(&state.pool)
    .await?;
    let Some((key_id, owner_id)) = row else {
        return Ok(None);
    };
    sqlx::query("UPDATE api_keys SET last_used_at = now() WHERE id = $1")
        .bind(key_id)
        .execute(&state.pool)
        .await?;
    Ok(Some(DavUser { id: owner_id }))
}

/// Recently verified credentials, so that a client issuing many requests does
/// not pay for an Argon2 verification each time. The digest covers the stored
/// password hash, so changing the password invalidates the entry at once.
static VERIFIED: std::sync::Mutex<Vec<([u8; 32], std::time::Instant)>> =
    std::sync::Mutex::new(Vec::new());
const VERIFIED_TTL: std::time::Duration = std::time::Duration::from_secs(300);
const VERIFIED_MAX: usize = 256;

async fn password_login(
    state: &AppState,
    email: &str,
    password: String,
) -> Result<Option<DavUser>, sqlx::Error> {
    if password.is_empty() || password.len() > crate::auth::MAX_PASSWORD_BYTES {
        return Ok(None);
    }
    let limiter_key = format!("webdav:{email}");
    if state
        .login_rate_limiter
        .retry_after_seconds(&limiter_key)
        .is_some()
    {
        return Ok(None);
    }
    let row: Option<(Uuid, String)> = sqlx::query_as(
        "SELECT id, password_hash FROM users \
          WHERE lower(email) = $1 AND disabled_at IS NULL AND NOT must_change_password",
    )
    .bind(email)
    .fetch_optional(&state.pool)
    .await?;
    let digest: [u8; 32] = {
        let mut hasher = Sha256::new();
        hasher.update(email.as_bytes());
        hasher.update([0]);
        hasher.update(password.as_bytes());
        hasher.update([0]);
        hasher.update(row.as_ref().map(|r| r.1.as_bytes()).unwrap_or_default());
        hasher.finalize().into()
    };
    let now = std::time::Instant::now();
    if row.is_some() {
        let cache = VERIFIED.lock().unwrap_or_else(|p| p.into_inner());
        if cache
            .iter()
            .any(|(d, at)| *d == digest && now.duration_since(*at) < VERIFIED_TTL)
        {
            return Ok(row.map(|r| DavUser { id: r.0 }));
        }
    }
    let hash = row.as_ref().map(|r| r.1.clone());
    let verified =
        tokio::task::spawn_blocking(move || crate::auth::verify_login_password(hash, &password))
            .await
            .unwrap_or(false);
    let Some((id, _)) = row.filter(|_| verified) else {
        state.login_rate_limiter.record_failure(&limiter_key);
        return Ok(None);
    };
    state.login_rate_limiter.clear(&limiter_key);
    let mut cache = VERIFIED.lock().unwrap_or_else(|p| p.into_inner());
    cache.retain(|(_, at)| now.duration_since(*at) < VERIFIED_TTL);
    if cache.len() >= VERIFIED_MAX {
        cache.remove(0);
    }
    cache.push((digest, now));
    Ok(Some(DavUser { id }))
}

#[derive(Clone, Copy)]
enum Target {
    Root,
    Entry(Uuid),
}

async fn resolve(
    state: &AppState,
    owner: Uuid,
    segments: &[&str],
) -> Result<Option<Target>, sqlx::Error> {
    let mut current: Option<Uuid> = None;
    for (index, name) in segments.iter().enumerate() {
        let row: Option<(Uuid, String)> = sqlx::query_as(
            "SELECT id, kind FROM drive_entries \
              WHERE owner_id = $1 AND deleted_at IS NULL \
                AND parent_id IS NOT DISTINCT FROM $2 AND lower(name) = lower($3)",
        )
        .bind(owner)
        .bind(current)
        .bind(*name)
        .fetch_optional(&state.pool)
        .await?;
        let Some((id, kind)) = row else {
            return Ok(None);
        };
        // Files cannot have children.
        if kind != "folder" && index + 1 < segments.len() {
            return Ok(None);
        }
        current = Some(id);
    }
    Ok(Some(current.map_or(Target::Root, Target::Entry)))
}

#[derive(sqlx::FromRow)]
struct Row {
    name: String,
    kind: String,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    size_bytes: Option<i64>,
    original_modified_at: Option<DateTime<Utc>>,
    version_created_at: Option<DateTime<Utc>>,
    mime_detected: Option<String>,
}

const SELECT: &str = "SELECT e.name, e.kind, e.created_at, e.updated_at, v.size_bytes, \
        v.original_modified_at, v.created_at AS version_created_at, o.mime_detected \
    FROM drive_entries e \
    LEFT JOIN files f ON f.id = e.id \
    LEFT JOIN file_versions v ON v.id = f.current_version_id \
    LEFT JOIN storage_objects o ON o.id = v.storage_object_id \
    WHERE e.owner_id = $1 AND e.deleted_at IS NULL AND (e.kind = 'folder' OR o.state = 'ready')";

struct Item {
    href: String,
    name: String,
    is_dir: bool,
    size: i64,
    modified: DateTime<Utc>,
    created: DateTime<Utc>,
    mime: String,
}

impl Item {
    fn from_row(row: Row, parent_href: &str) -> Self {
        let is_dir = row.kind == "folder";
        let mut href = format!("{parent_href}{}", encode_segment(&row.name));
        if is_dir {
            href.push('/');
        }
        Self {
            href,
            is_dir,
            size: row.size_bytes.unwrap_or(0),
            modified: row
                .original_modified_at
                .or(row.version_created_at)
                .unwrap_or(row.updated_at),
            created: row.created_at,
            mime: row
                .mime_detected
                .unwrap_or_else(|| "application/octet-stream".into()),
            name: row.name,
        }
    }
}

async fn propfind(
    state: &AppState,
    owner: Uuid,
    segments: &[&str],
    target: Target,
    headers: &HeaderMap,
) -> Response {
    let base = {
        let mut base = String::from(MOUNT);
        for segment in segments {
            base.push_str(&encode_segment(segment));
            base.push('/');
        }
        base
    };
    let depth_zero = headers
        .get("depth")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.trim() == "0");
    let result = async {
        let mut items = Vec::new();
        let parent_href = base
            .trim_end_matches('/')
            .rsplit_once('/')
            .map(|(head, _)| format!("{head}/"))
            .unwrap_or_else(|| MOUNT.to_owned());
        let folder_id = match target {
            Target::Root => {
                let now = Utc::now();
                items.push(Item {
                    href: MOUNT.to_owned(),
                    name: String::new(),
                    is_dir: true,
                    size: 0,
                    modified: now,
                    created: now,
                    mime: "httpd/unix-directory".into(),
                });
                None
            }
            Target::Entry(id) => {
                let row: Option<Row> = sqlx::query_as(&format!("{SELECT} AND e.id = $2"))
                    .bind(owner)
                    .bind(id)
                    .fetch_optional(&state.pool)
                    .await?;
                let Some(row) = row else {
                    return Ok(None);
                };
                let item = Item::from_row(row, &parent_href);
                let is_dir = item.is_dir;
                items.push(item);
                is_dir.then_some(id)
            }
        };
        let list_children = !depth_zero && (matches!(target, Target::Root) || folder_id.is_some());
        if list_children {
            let rows: Vec<Row> = sqlx::query_as(&format!(
                "{SELECT} AND e.parent_id IS NOT DISTINCT FROM $2 \
                  ORDER BY e.kind, lower(e.name) LIMIT $3"
            ))
            .bind(owner)
            .bind(folder_id)
            .bind(MAX_LISTING)
            .fetch_all(&state.pool)
            .await?;
            items.extend(rows.into_iter().map(|row| Item::from_row(row, &base)));
        }
        Ok::<_, sqlx::Error>(Some(items))
    }
    .await;
    match result {
        Ok(Some(items)) => {
            let mut response = Response::new(Body::from(multistatus(&items)));
            *response.status_mut() = StatusCode::MULTI_STATUS;
            let h = response.headers_mut();
            h.insert(
                header::CONTENT_TYPE,
                "application/xml; charset=utf-8".parse().unwrap(),
            );
            h.insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
            response
        }
        Ok(None) => plain(StatusCode::NOT_FOUND),
        Err(error) => {
            tracing::error!(error = %error, "network drive listing failed");
            plain(StatusCode::SERVICE_UNAVAILABLE)
        }
    }
}

fn multistatus(items: &[Item]) -> String {
    let mut xml = String::from(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<D:multistatus xmlns:D=\"DAV:\">",
    );
    for item in items {
        xml.push_str("<D:response><D:href>");
        xml.push_str(&xml_escape(&item.href));
        xml.push_str("</D:href><D:propstat><D:prop><D:displayname>");
        xml.push_str(&xml_escape(&item.name));
        xml.push_str("</D:displayname><D:resourcetype>");
        if item.is_dir {
            xml.push_str("<D:collection/>");
        }
        xml.push_str("</D:resourcetype><D:creationdate>");
        xml.push_str(&item.created.to_rfc3339_opts(SecondsFormat::Secs, true));
        xml.push_str("</D:creationdate><D:getlastmodified>");
        xml.push_str(&httpdate::fmt_http_date(SystemTime::from(item.modified)));
        xml.push_str("</D:getlastmodified>");
        if !item.is_dir {
            xml.push_str(&format!(
                "<D:getcontentlength>{}</D:getcontentlength><D:getcontenttype>{}</D:getcontenttype>",
                item.size,
                xml_escape(&item.mime)
            ));
        }
        xml.push_str("</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>");
    }
    xml.push_str("</D:multistatus>");
    xml
}

fn xml_escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c if (c as u32) < 0x20 => {}
            c => out.push(c),
        }
    }
    out
}

fn encode_segment(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (k, v) in pairs {
            map.append(*k, v.parse().unwrap());
        }
        map
    }

    #[test]
    fn private_ranges_are_lan() {
        for ip in [
            "10.1.2.3",
            "172.16.0.9",
            "192.168.1.50",
            "127.0.0.1",
            "169.254.1.1",
            "::1",
            "fd00::1",
            "fe80::1",
            "::ffff:192.168.0.2",
        ] {
            assert!(is_lan_ip(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["8.8.8.8", "172.32.0.1", "100.64.0.1", "2001:4860::1"] {
            assert!(!is_lan_ip(ip.parse().unwrap()), "{ip}");
        }
    }

    #[test]
    fn every_reported_client_address_must_be_private() {
        let peer = Some("172.18.0.2".parse().unwrap());
        assert!(request_is_lan(
            &headers(&[("x-forwarded-for", "192.168.1.9")]),
            peer
        ));
        assert!(!request_is_lan(
            &headers(&[("x-forwarded-for", "203.0.113.5")]),
            peer
        ));
        assert!(!request_is_lan(
            &headers(&[("x-forwarded-for", "192.168.1.9, 203.0.113.5")]),
            peer
        ));
        assert!(!request_is_lan(
            &headers(&[("cf-connecting-ip", "203.0.113.5")]),
            peer
        ));
        assert!(!request_is_lan(
            &headers(&[("x-forwarded-for", "garbage")]),
            peer
        ));
        assert!(!request_is_lan(&HeaderMap::new(), None));
        assert!(!request_is_lan(
            &headers(&[("x-forwarded-for", "192.168.1.9")]),
            Some("8.8.8.8".parse().unwrap())
        ));
    }

    #[test]
    fn xml_and_urls_are_escaped() {
        assert_eq!(xml_escape("a&b<c>\"'"), "a&amp;b&lt;c&gt;&quot;&apos;");
        assert_eq!(encode_segment("Ảnh 1+a.jpg"), "%E1%BA%A2nh%201%2Ba.jpg");
        let now = Utc::now();
        let xml = multistatus(&[Item {
            href: "/webdav/a%20b.txt".into(),
            name: "a b & c.txt".into(),
            is_dir: false,
            size: 5,
            modified: now,
            created: now,
            mime: "text/plain".into(),
        }]);
        assert!(xml.contains("<D:displayname>a b &amp; c.txt</D:displayname>"));
        assert!(xml.contains("<D:getcontentlength>5</D:getcontentlength>"));
        assert!(!xml.contains("<D:collection/>"));
    }

    #[test]
    fn update_request_accepts_partial_camel_case_flags() {
        let webdav_only: UpdateRequest = serde_json::from_str(r#"{"enabled":true}"#).unwrap();
        assert_eq!(webdav_only.enabled, Some(true));
        assert_eq!(webdav_only.smb_enabled, None);

        let smb_only: UpdateRequest = serde_json::from_str(r#"{"smbEnabled":true}"#).unwrap();
        assert_eq!(smb_only.enabled, None);
        assert_eq!(smb_only.smb_enabled, Some(true));

        let both: UpdateRequest =
            serde_json::from_str(r#"{"enabled":false,"smbEnabled":true}"#).unwrap();
        assert_eq!(both.enabled, Some(false));
        assert_eq!(both.smb_enabled, Some(true));

        assert!(serde_json::from_str::<UpdateRequest>(r#"{"unknown":true}"#).is_err());
        assert!(
            serde_json::from_str::<SetSmbPasswordRequest>(
                r#"{"password":"correct horse battery"}"#
            )
            .is_ok()
        );
    }
}
