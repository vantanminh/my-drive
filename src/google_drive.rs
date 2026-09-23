use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit, Payload},
};
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode, header::CACHE_CONTROL},
    response::{IntoResponse, Redirect, Response},
    routing::{get, post},
};
use base64::engine::{Engine, general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Utc};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgPool, Postgres, Transaction};
use thiserror::Error;
use tokio::{fs as tokio_fs, io::AsyncWriteExt, time::sleep};
use uuid::Uuid;

use crate::{
    auth::{AuthenticatedUser, require_csrf},
    config::GoogleDriveSettings,
    drive,
    health::{AppState, TransferSettings},
    storage::{LocalStorage, StorageError},
};

const WORKER_LOCK_ID: i64 = 4_831_170_923_640;
const IDLE_POLL: Duration = Duration::from_secs(3);
const DEFER_POLL: Duration = Duration::from_secs(2);
const RATE_LIMIT_POLL: Duration = Duration::from_secs(30);
const LIST_PAUSE: Duration = Duration::from_millis(200);
const FILE_PAUSE: Duration = Duration::from_millis(200);
const CHUNK_BYTES: usize = 256 * 1024;
const CHUNK_TIMEOUT: Duration = Duration::from_secs(45);
const IMAGE_INDEX_WATERMARK: i64 = 2;
const MAX_SOURCES: i64 = 20;
const MAX_NAME_ATTEMPTS: u32 = 40;
const FAILURE_LIMIT: i32 = 8;
const RESYNC_HOURS: i64 = 6;
const OAUTH_STATE_MINUTES: i64 = 10;
const TARGET_DUTY_NUMERATOR: u128 = 355;
const BUSY_DUTY_NUMERATOR: u128 = 1_150;
const PACE_MIN_MS: u128 = 40;
const PACE_MAX_MS: u128 = 700;
const BUSY_PACE_MAX_MS: u128 = 1_200;

const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const USERINFO_URL: &str = "https://www.googleapis.com/oauth2/v3/userinfo";
const DRIVE_FILES_URL: &str = "https://www.googleapis.com/drive/v3/files";
const LIST_FIELDS: &str = "nextPageToken,files(id,name,mimeType,size,md5Checksum,modifiedTime,shortcutDetails(targetId,targetMimeType))";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SyncClass {
    Image,
    Video,
    Other,
}

impl SyncClass {
    fn priority(self) -> i16 {
        match self {
            Self::Image => 0,
            Self::Video => 1,
            Self::Other => 2,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RemoteBody {
    Download,
    Export {
        mime: &'static str,
        extension: &'static str,
    },
    SkipNative,
}

pub(crate) fn pace_after(work: Duration, indexer_busy: bool) -> Duration {
    let work_ms = work.as_millis().min(10_000);
    let numerator = if indexer_busy {
        BUSY_DUTY_NUMERATOR
    } else {
        TARGET_DUTY_NUMERATOR
    };
    let pause = work_ms.saturating_mul(numerator) / 100;
    let max = if indexer_busy {
        BUSY_PACE_MAX_MS
    } else {
        PACE_MAX_MS
    };
    Duration::from_millis(u64::try_from(pause.clamp(PACE_MIN_MS, max)).unwrap_or(u64::MAX))
}

pub(crate) fn indexer_backpressure(
    queued_or_running_images: i64,
    indexer_running: bool,
    indexer_paused: bool,
) -> Option<&'static str> {
    if indexer_paused {
        return None;
    }
    if queued_or_running_images >= IMAGE_INDEX_WATERMARK {
        return Some("image_index");
    }
    if indexer_running {
        return Some("indexer_running");
    }
    None
}

pub(crate) fn remote_body(google_mime: &str) -> RemoteBody {
    match google_mime {
        "application/vnd.google-apps.document" => RemoteBody::Export {
            mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            extension: "docx",
        },
        "application/vnd.google-apps.spreadsheet" => RemoteBody::Export {
            mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            extension: "xlsx",
        },
        "application/vnd.google-apps.presentation" => RemoteBody::Export {
            mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            extension: "pptx",
        },
        "application/vnd.google-apps.drawing" => RemoteBody::Export {
            mime: "image/png",
            extension: "png",
        },
        mime if mime.starts_with("application/vnd.google-apps.") => RemoteBody::SkipNative,
        _ => RemoteBody::Download,
    }
}

pub(crate) fn sync_class(mime: &str, name: &str) -> SyncClass {
    if indexable_image_mime(Some(mime)) || image_extension(name) {
        SyncClass::Image
    } else if indexable_video_mime(Some(mime)) || video_extension(name) {
        SyncClass::Video
    } else {
        SyncClass::Other
    }
}

pub(crate) fn valid_google_id(id: &str) -> bool {
    id == "root"
        || ((1..=128).contains(&id.len())
            && id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'))
}

pub(crate) fn storage_entry_name(raw: &str, attempt: u32, extra_extension: Option<&str>) -> String {
    let raw = raw.rsplit(['/', '\\']).next().unwrap_or(raw);
    let mut cleaned = String::new();
    for character in raw.chars() {
        if character.is_control() || character == '/' || character == '\\' {
            cleaned.push('-');
        } else {
            cleaned.push(character);
        }
    }
    let mut name = cleaned.trim().trim_matches('.').trim().to_owned();
    if name.is_empty() || name == "." || name == ".." {
        name = "untitled".to_owned();
    }
    if let Some(extension) = extra_extension.filter(|extension| valid_extension(extension)) {
        let suffix = format!(".{extension}");
        if !name
            .to_ascii_lowercase()
            .ends_with(&suffix.to_ascii_lowercase())
        {
            name.push_str(&suffix);
        }
    }
    if attempt > 0 {
        name = insert_attempt(&name, attempt + 1);
    }
    limit_entry_name(&name)
}

pub(crate) fn content_unchanged(
    stored_md5: Option<&str>,
    stored_size: Option<i64>,
    stored_modified: Option<DateTime<Utc>>,
    remote_md5: Option<&str>,
    remote_size: Option<i64>,
    remote_modified: Option<DateTime<Utc>>,
) -> bool {
    match (stored_md5, remote_md5) {
        (Some(stored), Some(remote)) => stored.eq_ignore_ascii_case(remote),
        _ => {
            stored_size.is_some()
                && stored_size == remote_size
                && stored_modified.is_some()
                && stored_modified == remote_modified
        }
    }
}

fn indexable_image_mime(mime: Option<&str>) -> bool {
    matches!(
        mime,
        Some(
            "image/jpeg"
                | "image/png"
                | "image/gif"
                | "image/webp"
                | "image/avif"
                | "image/bmp"
                | "image/x-icon"
                | "image/tiff"
                | "image/heic"
                | "image/heif"
        )
    )
}

fn indexable_video_mime(mime: Option<&str>) -> bool {
    matches!(
        mime,
        Some(
            "video/mp4"
                | "video/webm"
                | "video/quicktime"
                | "video/x-matroska"
                | "video/x-msvideo"
                | "video/ogg"
                | "video/mpeg"
                | "video/mp2t"
                | "video/x-flv"
                | "video/x-ms-wmv"
                | "video/3gpp"
        )
    )
}

fn image_extension(name: &str) -> bool {
    let Some(extension) = extension_of(name) else {
        return false;
    };
    matches!(
        extension.to_ascii_lowercase().as_str(),
        "jpg"
            | "jpeg"
            | "png"
            | "gif"
            | "webp"
            | "avif"
            | "bmp"
            | "ico"
            | "tif"
            | "tiff"
            | "heic"
            | "heif"
    )
}

fn video_extension(name: &str) -> bool {
    let Some(extension) = extension_of(name) else {
        return false;
    };
    matches!(
        extension.to_ascii_lowercase().as_str(),
        "mp4"
            | "m4v"
            | "webm"
            | "mov"
            | "qt"
            | "mkv"
            | "avi"
            | "ogv"
            | "ogg"
            | "mpg"
            | "mpeg"
            | "ts"
            | "mts"
            | "m2ts"
            | "flv"
            | "wmv"
            | "3gp"
    )
}

fn extension_of(name: &str) -> Option<&str> {
    let (stem, extension) = name.rsplit_once('.')?;
    if stem.is_empty() || !valid_extension(extension) {
        None
    } else {
        Some(extension)
    }
}

fn valid_extension(extension: &str) -> bool {
    (1..=8).contains(&extension.len()) && extension.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

fn insert_attempt(name: &str, number: u32) -> String {
    let marker = format!(" ({number})");
    match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() && valid_extension(extension) => {
            format!("{stem}{marker}.{extension}")
        }
        _ => format!("{name}{marker}"),
    }
}

fn limit_entry_name(name: &str) -> String {
    if name.chars().count() <= 255 {
        return name.to_owned();
    }
    match name.rsplit_once('.') {
        Some((stem, extension)) if valid_extension(extension) => {
            let room = 255 - extension.chars().count() - 1;
            let stem: String = stem.chars().take(room.max(1)).collect();
            format!("{stem}.{extension}")
        }
        _ => name.chars().take(255).collect(),
    }
}

fn detected_index_mime(header: &[u8], google_mime: &str, name: &str) -> Option<&'static str> {
    sniff_media_type(header)
        .or_else(|| canonical_index_mime(google_mime))
        .or_else(|| mime_from_name(name))
}

fn canonical_index_mime(mime: &str) -> Option<&'static str> {
    if indexable_image_mime(Some(mime)) || indexable_video_mime(Some(mime)) {
        Some(match mime {
            "image/jpeg" => "image/jpeg",
            "image/png" => "image/png",
            "image/gif" => "image/gif",
            "image/webp" => "image/webp",
            "image/avif" => "image/avif",
            "image/bmp" => "image/bmp",
            "image/x-icon" => "image/x-icon",
            "image/tiff" => "image/tiff",
            "image/heic" => "image/heic",
            "image/heif" => "image/heif",
            "video/mp4" => "video/mp4",
            "video/webm" => "video/webm",
            "video/quicktime" => "video/quicktime",
            "video/x-matroska" => "video/x-matroska",
            "video/x-msvideo" => "video/x-msvideo",
            "video/ogg" => "video/ogg",
            "video/mpeg" => "video/mpeg",
            "video/mp2t" => "video/mp2t",
            "video/x-flv" => "video/x-flv",
            "video/x-ms-wmv" => "video/x-ms-wmv",
            "video/3gpp" => "video/3gpp",
            _ => return None,
        })
    } else {
        None
    }
}

fn mime_from_name(name: &str) -> Option<&'static str> {
    match extension_of(name)?.to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "avif" => Some("image/avif"),
        "bmp" => Some("image/bmp"),
        "ico" => Some("image/x-icon"),
        "tif" | "tiff" => Some("image/tiff"),
        "heic" => Some("image/heic"),
        "heif" => Some("image/heif"),
        "mp4" | "m4v" => Some("video/mp4"),
        "webm" => Some("video/webm"),
        "mov" | "qt" => Some("video/quicktime"),
        "mkv" => Some("video/x-matroska"),
        "avi" => Some("video/x-msvideo"),
        "ogv" | "ogg" => Some("video/ogg"),
        "mpg" | "mpeg" => Some("video/mpeg"),
        "ts" | "mts" | "m2ts" => Some("video/mp2t"),
        "flv" => Some("video/x-flv"),
        "wmv" => Some("video/x-ms-wmv"),
        "3gp" => Some("video/3gpp"),
        _ => None,
    }
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
    if header.get(4..8).is_some_and(|brand| brand == b"ftyp") {
        if header
            .windows(4)
            .any(|brand| brand == b"avif" || brand == b"avis")
        {
            return Some("image/avif");
        }
        if header
            .windows(4)
            .any(|brand| matches!(brand, b"heic" | b"heix" | b"hevc" | b"hevx"))
        {
            return Some("image/heic");
        }
        if header.windows(4).any(|brand| brand == b"qt  ") {
            return Some("video/quicktime");
        }
        if header.windows(4).any(|brand| {
            matches!(
                brand,
                b"isom" | b"iso2" | b"mp41" | b"mp42" | b"avc1" | b"M4V "
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

fn percent_encode(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut output = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            output.push(byte as char);
        } else {
            output.push('%');
            output.push(HEX[usize::from(byte >> 4)] as char);
            output.push(HEX[usize::from(byte & 0x0f)] as char);
        }
    }
    output
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[usize::from(byte >> 4)] as char);
        output.push(HEX[usize::from(byte & 0x0f)] as char);
    }
    output
}

fn seal_token(key: &[u8; 32], owner_id: Uuid, plaintext: &str) -> Result<(Vec<u8>, Vec<u8>), ()> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| ())?;
    let mut nonce = [0_u8; 12];
    OsRng.fill_bytes(&mut nonce);
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plaintext.as_bytes(),
                aad: owner_id.as_bytes(),
            },
        )
        .map_err(|_| ())?;
    Ok((nonce.to_vec(), ciphertext))
}

fn open_token(
    key: &[u8; 32],
    owner_id: Uuid,
    nonce: &[u8],
    ciphertext: &[u8],
) -> Result<String, ()> {
    if nonce.len() != 12 {
        return Err(());
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| ())?;
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad: owner_id.as_bytes(),
            },
        )
        .map_err(|_| ())?;
    String::from_utf8(plaintext).map_err(|_| ())
}

fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::limited(4))
            .pool_max_idle_per_host(1)
            .user_agent("MyDrive google-drive-sync")
            .build()
            .expect("google drive http client can be built")
    })
}

struct CachedAccess {
    token: String,
    expires_at: Instant,
}

fn token_cache() -> &'static Mutex<HashMap<Uuid, CachedAccess>> {
    static CACHE: OnceLock<Mutex<HashMap<Uuid, CachedAccess>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cached_access(connection_id: Uuid) -> Option<String> {
    let cache = token_cache()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    cache
        .get(&connection_id)
        .and_then(|entry| (entry.expires_at > Instant::now()).then(|| entry.token.clone()))
}

fn store_access(connection_id: Uuid, token: String, expires_in: u64) {
    let lifetime = expires_in.saturating_sub(60).max(30);
    let mut cache = token_cache()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    cache.insert(
        connection_id,
        CachedAccess {
            token,
            expires_at: Instant::now() + Duration::from_secs(lifetime),
        },
    );
}

fn clear_access(connection_id: Uuid) {
    let mut cache = token_cache()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    cache.remove(&connection_id);
}

#[derive(Debug, Error)]
enum GoogleApiError {
    #[error("invalid request")]
    BadRequest,
    #[error("not found")]
    NotFound,
    #[error("conflict")]
    Conflict,
    #[error("csrf")]
    Csrf,
    #[error("unconfigured")]
    Unconfigured,
    #[error("not connected")]
    NotConnected,
    #[error("reauth")]
    Reauth,
    #[error("too many folders")]
    TooManyFolders,
    #[error("already selected")]
    AlreadySelected,
    #[error("upstream")]
    Upstream,
    #[error("request failed")]
    RequestFailed,
    #[error("database")]
    Database(#[source] sqlx::Error),
}

impl IntoResponse for GoogleApiError {
    fn into_response(self) -> Response {
        let (status, code) = match self {
            Self::BadRequest => (StatusCode::BAD_REQUEST, "invalid_request"),
            Self::NotFound => (StatusCode::NOT_FOUND, "not_found"),
            Self::Conflict => (StatusCode::CONFLICT, "conflict"),
            Self::Csrf => (StatusCode::FORBIDDEN, "csrf_failed"),
            Self::Unconfigured => (StatusCode::SERVICE_UNAVAILABLE, "google_drive_unconfigured"),
            Self::NotConnected => (StatusCode::CONFLICT, "google_drive_not_connected"),
            Self::Reauth => (StatusCode::CONFLICT, "reauth_required"),
            Self::TooManyFolders => (StatusCode::CONFLICT, "too_many_folders"),
            Self::AlreadySelected => (StatusCode::CONFLICT, "already_selected"),
            Self::Upstream => (StatusCode::BAD_GATEWAY, "google_auth_failed"),
            Self::RequestFailed => (StatusCode::BAD_GATEWAY, "google_request_failed"),
            Self::Database(error) => {
                tracing::error!(error = %error, "google drive database operation failed");
                (StatusCode::SERVICE_UNAVAILABLE, "service_unavailable")
            }
        };
        no_store((status, Json(ErrorBody { error: code })).into_response())
    }
}

#[derive(Serialize)]
struct ErrorBody {
    error: &'static str,
}

fn no_store(mut response: Response) -> Response {
    response.headers_mut().insert(
        CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    response
}

fn require_settings(state: &AppState) -> Result<&GoogleDriveSettings, GoogleApiError> {
    state
        .google_drive
        .as_ref()
        .ok_or(GoogleApiError::Unconfigured)
}

fn require_change(
    headers: &HeaderMap,
    user: &AuthenticatedUser,
    state: &AppState,
) -> Result<(), GoogleApiError> {
    if require_csrf(headers, user, state.auth_settings) {
        Ok(())
    } else {
        Err(GoogleApiError::Csrf)
    }
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/google-drive", get(status))
        .route("/api/google-drive/connect", post(connect))
        .route("/api/google-drive/callback", get(callback))
        .route("/api/google-drive/disconnect", post(disconnect))
        .route("/api/google-drive/pause", post(set_pause))
        .route("/api/google-drive/folders", get(remote_folders))
        .route("/api/google-drive/sources", post(select_source))
        .route(
            "/api/google-drive/sources/{id}",
            axum::routing::delete(remove_source),
        )
        .route("/api/google-drive/sources/{id}/sync", post(sync_source))
        .layer(axum::extract::DefaultBodyLimit::max(8 * 1024))
}

#[derive(Serialize)]
struct StatusBody {
    configured: bool,
    connected: bool,
    email: Option<String>,
    paused: bool,
    reauth_required: bool,
    local_root_id: Option<Uuid>,
    images_indexed: i64,
    images_waiting: i64,
    videos_indexed: i64,
    videos_waiting: i64,
    sources: Vec<SourceStatus>,
}

#[derive(Serialize)]
struct SourceStatus {
    id: Uuid,
    google_folder_id: String,
    google_folder_name: String,
    local_folder_id: Option<Uuid>,
    run: Option<RunStatus>,
}

#[derive(Serialize)]
struct RunStatus {
    state: String,
    discovered_files: i64,
    discovered_folders: i64,
    discovered_bytes: i64,
    downloaded_files: i64,
    downloaded_bytes: i64,
    skipped_files: i64,
    failed_files: i64,
    pending_files: i64,
    current_name: Option<String>,
    current_bytes: i64,
    current_total_bytes: Option<i64>,
    throttle_reason: Option<String>,
    error_code: Option<String>,
}

#[derive(FromRow)]
struct ConnectionRow {
    id: Uuid,
    google_email: String,
    paused: bool,
    auth_state: String,
    local_root_id: Option<Uuid>,
}

#[derive(FromRow)]
struct SourceRow {
    id: Uuid,
    google_folder_id: String,
    google_folder_name: String,
    local_folder_id: Option<Uuid>,
    run_state: Option<String>,
    discovered_files: Option<i64>,
    discovered_folders: Option<i64>,
    discovered_bytes: Option<i64>,
    downloaded_files: Option<i64>,
    downloaded_bytes: Option<i64>,
    skipped_files: Option<i64>,
    failed_files: Option<i64>,
    pending_files: Option<i64>,
    current_name: Option<String>,
    current_bytes: Option<i64>,
    current_total_bytes: Option<i64>,
    throttle_reason: Option<String>,
    error_code: Option<String>,
}

async fn status(
    State(state): State<AppState>,
    user: AuthenticatedUser,
) -> Result<Response, GoogleApiError> {
    if state.google_drive.is_none() {
        return Ok(no_store(Json(empty_status(false)).into_response()));
    }
    let connection = fetch_connection(&state.pool, user.id).await?;
    let Some(connection) = connection else {
        return Ok(no_store(Json(empty_status(true)).into_response()));
    };
    let sources = sqlx::query_as::<_, SourceRow>(
        "SELECT source.id, source.google_folder_id, source.google_folder_name, source.local_folder_id, \
                run.state AS run_state, run.discovered_files, run.discovered_folders, run.discovered_bytes, \
                run.downloaded_files, run.downloaded_bytes, run.skipped_files, run.failed_files, \
                (SELECT COUNT(*) FROM google_drive_items AS item \
                  WHERE item.run_id = run.id AND item.state IN ('pending', 'downloading', 'committing')) AS pending_files, \
                run.current_name, run.current_bytes, run.current_total_bytes, run.throttle_reason, run.error_code \
           FROM google_drive_sources AS source \
           LEFT JOIN LATERAL ( \
                SELECT * FROM google_drive_runs \
                 WHERE source_id = source.id \
                 ORDER BY created_at DESC \
                 LIMIT 1 \
           ) AS run ON TRUE \
          WHERE source.owner_id = $1 AND source.enabled = TRUE \
          ORDER BY source.created_at, source.id",
    )
    .bind(user.id)
    .fetch_all(&state.pool)
    .await
    .map_err(GoogleApiError::Database)?;
    let index = index_counts(&state.pool, user.id).await?;
    let body = StatusBody {
        configured: true,
        connected: true,
        email: Some(connection.google_email),
        paused: connection.paused,
        reauth_required: connection.auth_state == "reauth_required",
        local_root_id: connection.local_root_id,
        images_indexed: index.0,
        images_waiting: index.1,
        videos_indexed: index.2,
        videos_waiting: index.3,
        sources: sources.into_iter().map(source_status).collect(),
    };
    Ok(no_store(Json(body).into_response()))
}

fn empty_status(configured: bool) -> StatusBody {
    StatusBody {
        configured,
        connected: false,
        email: None,
        paused: false,
        reauth_required: false,
        local_root_id: None,
        images_indexed: 0,
        images_waiting: 0,
        videos_indexed: 0,
        videos_waiting: 0,
        sources: Vec::new(),
    }
}

fn source_status(row: SourceRow) -> SourceStatus {
    let run = row.run_state.map(|state| RunStatus {
        state,
        discovered_files: row.discovered_files.unwrap_or(0),
        discovered_folders: row.discovered_folders.unwrap_or(0),
        discovered_bytes: row.discovered_bytes.unwrap_or(0),
        downloaded_files: row.downloaded_files.unwrap_or(0),
        downloaded_bytes: row.downloaded_bytes.unwrap_or(0),
        skipped_files: row.skipped_files.unwrap_or(0),
        failed_files: row.failed_files.unwrap_or(0),
        pending_files: row.pending_files.unwrap_or(0),
        current_name: row.current_name,
        current_bytes: row.current_bytes.unwrap_or(0),
        current_total_bytes: row.current_total_bytes,
        throttle_reason: row.throttle_reason,
        error_code: row.error_code,
    });
    SourceStatus {
        id: row.id,
        google_folder_id: row.google_folder_id,
        google_folder_name: row.google_folder_name,
        local_folder_id: row.local_folder_id,
        run,
    }
}

async fn index_counts(
    pool: &PgPool,
    owner_id: Uuid,
) -> Result<(i64, i64, i64, i64), GoogleApiError> {
    let row = sqlx::query_as::<_, (i64, i64, i64, i64)>(
        "SELECT \
            COUNT(*) FILTER (WHERE job.task = 'image_preview' AND job.state = 'completed')::BIGINT, \
            COUNT(*) FILTER (WHERE job.task = 'image_preview' AND job.state IN ('queued', 'running', 'retry_wait'))::BIGINT, \
            COUNT(*) FILTER (WHERE job.task = 'video_thumbnail' AND job.state = 'completed')::BIGINT, \
            COUNT(*) FILTER (WHERE job.task IN ('video_thumbnail', 'video_preview') AND job.state IN ('queued', 'running', 'retry_wait'))::BIGINT \
           FROM google_drive_links AS link \
           JOIN drive_entries AS entry ON entry.id = link.local_entry_id \
                AND entry.deleted_at IS NULL AND entry.kind = 'file' \
           JOIN files AS file ON file.id = entry.id \
           JOIN media_index_jobs AS job ON job.file_version_id = file.current_version_id \
          WHERE link.owner_id = $1",
    )
    .bind(owner_id)
    .fetch_one(pool)
    .await
    .map_err(GoogleApiError::Database)?;
    Ok(row)
}

async fn fetch_connection(
    pool: &PgPool,
    owner_id: Uuid,
) -> Result<Option<ConnectionRow>, GoogleApiError> {
    sqlx::query_as::<_, ConnectionRow>(
        "SELECT id, google_email, paused, auth_state, local_root_id \
           FROM google_drive_connections WHERE owner_id = $1",
    )
    .bind(owner_id)
    .fetch_optional(pool)
    .await
    .map_err(GoogleApiError::Database)
}

#[derive(Serialize)]
struct ConnectBody {
    authorize_url: String,
}

async fn connect(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
) -> Result<Response, GoogleApiError> {
    let settings = require_settings(&state)?;
    require_change(&headers, &user, &state)?;
    sqlx::query("DELETE FROM google_drive_oauth_states WHERE expires_at <= now()")
        .execute(&state.pool)
        .await
        .map_err(GoogleApiError::Database)?;
    let mut raw = [0_u8; 32];
    OsRng.fill_bytes(&mut raw);
    let digest = Sha256::digest(raw).to_vec();
    sqlx::query(
        "INSERT INTO google_drive_oauth_states (state_digest, owner_id, expires_at) \
         VALUES ($1, $2, now() + ($3::BIGINT * interval '1 minute'))",
    )
    .bind(digest)
    .bind(user.id)
    .bind(OAUTH_STATE_MINUTES)
    .execute(&state.pool)
    .await
    .map_err(GoogleApiError::Database)?;
    let state_token = URL_SAFE_NO_PAD.encode(raw);
    let scope = "https://www.googleapis.com/auth/drive.readonly openid email";
    let authorize_url = format!(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri={}&response_type=code&scope={}&access_type=offline&prompt=consent&include_granted_scopes=true&state={}",
        percent_encode(&settings.client_id),
        percent_encode(&settings.redirect_uri),
        percent_encode(scope),
        percent_encode(&state_token)
    );
    Ok(no_store(
        Json(ConnectBody { authorize_url }).into_response(),
    ))
}

#[derive(Deserialize)]
struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

async fn callback(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Query(query): Query<CallbackQuery>,
) -> Response {
    match finish_callback(&state, &user, query).await {
        Ok(()) => no_store(Redirect::to("/google-drive?google=connected").into_response()),
        Err(error) => {
            tracing::warn!(error = %error, "google drive connection was not completed");
            no_store(Redirect::to("/google-drive?google=error").into_response())
        }
    }
}

async fn finish_callback(
    state: &AppState,
    user: &AuthenticatedUser,
    query: CallbackQuery,
) -> Result<(), GoogleApiError> {
    let settings = require_settings(state)?;
    if query.error.is_some() {
        return Err(GoogleApiError::Upstream);
    }
    let code = query.code.ok_or(GoogleApiError::BadRequest)?;
    let oauth_state = query.state.ok_or(GoogleApiError::BadRequest)?;
    if code.len() > 2048 || oauth_state.len() > 128 {
        return Err(GoogleApiError::BadRequest);
    }
    let raw = URL_SAFE_NO_PAD
        .decode(oauth_state.as_bytes())
        .map_err(|_| GoogleApiError::BadRequest)?;
    if raw.len() != 32 {
        return Err(GoogleApiError::BadRequest);
    }
    let digest = Sha256::digest(&raw).to_vec();
    let deleted = sqlx::query(
        "DELETE FROM google_drive_oauth_states \
          WHERE state_digest = $1 AND owner_id = $2 AND expires_at > now()",
    )
    .bind(digest)
    .bind(user.id)
    .execute(&state.pool)
    .await
    .map_err(GoogleApiError::Database)?;
    if deleted.rows_affected() != 1 {
        return Err(GoogleApiError::BadRequest);
    }
    let tokens = exchange_code(settings, &code).await?;
    let refresh = tokens.refresh_token.ok_or(GoogleApiError::Upstream)?;
    let profile = fetch_profile(&tokens.access_token).await?;
    let email = profile.email.ok_or(GoogleApiError::Upstream)?;
    if !(3..=320).contains(&email.len()) || !(1..=255).contains(&profile.sub.len()) {
        return Err(GoogleApiError::Upstream);
    }
    let (nonce, ciphertext) =
        seal_token(&settings.token_key, user.id, &refresh).map_err(|_| GoogleApiError::Upstream)?;
    let connection_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO google_drive_connections \
            (id, owner_id, google_subject, google_email, refresh_nonce, refresh_token, paused, auth_state) \
         VALUES ($1, $2, $3, $4, $5, $6, FALSE, 'active') \
         ON CONFLICT (owner_id) DO UPDATE \
            SET google_subject = EXCLUDED.google_subject, \
                google_email = EXCLUDED.google_email, \
                refresh_nonce = EXCLUDED.refresh_nonce, \
                refresh_token = EXCLUDED.refresh_token, \
                paused = FALSE, \
                auth_state = 'active', \
                updated_at = now()",
    )
    .bind(connection_id)
    .bind(user.id)
    .bind(&profile.sub)
    .bind(email.trim())
    .bind(nonce)
    .bind(ciphertext)
    .execute(&state.pool)
    .await
    .map_err(GoogleApiError::Database)?;
    if let Some(connection) = fetch_connection(&state.pool, user.id).await? {
        clear_access(connection.id);
    }
    sqlx::query(
        "INSERT INTO audit_events (event_type, actor_id, details) \
         VALUES ('google_drive_connected', $1, jsonb_build_object('email', $2::text))",
    )
    .bind(user.id)
    .bind(email.trim())
    .execute(&state.pool)
    .await
    .map_err(GoogleApiError::Database)?;
    Ok(())
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    expires_in: Option<u64>,
    refresh_token: Option<String>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct Profile {
    sub: String,
    email: Option<String>,
}

struct ExchangedToken {
    access_token: String,
    refresh_token: Option<String>,
}

async fn exchange_code(
    settings: &GoogleDriveSettings,
    code: &str,
) -> Result<ExchangedToken, GoogleApiError> {
    let body = format!(
        "grant_type=authorization_code&code={}&client_id={}&client_secret={}&redirect_uri={}",
        percent_encode(code),
        percent_encode(&settings.client_id),
        percent_encode(&settings.client_secret),
        percent_encode(&settings.redirect_uri)
    );
    let response = http_client()
        .post(TOKEN_URL)
        .timeout(Duration::from_secs(20))
        .header("content-type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
        .map_err(|_| GoogleApiError::Upstream)?;
    let parsed = response
        .json::<TokenResponse>()
        .await
        .map_err(|_| GoogleApiError::Upstream)?;
    let Some(access_token) = parsed.access_token else {
        return Err(GoogleApiError::Upstream);
    };
    if parsed.error.is_some() {
        return Err(GoogleApiError::Upstream);
    }
    Ok(ExchangedToken {
        access_token,
        refresh_token: parsed.refresh_token,
    })
}

async fn fetch_profile(access_token: &str) -> Result<Profile, GoogleApiError> {
    http_client()
        .get(USERINFO_URL)
        .timeout(Duration::from_secs(20))
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|_| GoogleApiError::Upstream)?
        .error_for_status()
        .map_err(|_| GoogleApiError::Upstream)?
        .json::<Profile>()
        .await
        .map_err(|_| GoogleApiError::Upstream)
}

async fn disconnect(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
) -> Result<Response, GoogleApiError> {
    require_settings(&state)?;
    require_change(&headers, &user, &state)?;
    if let Some(connection) = fetch_connection(&state.pool, user.id).await? {
        clear_access(connection.id);
    }
    sqlx::query("DELETE FROM google_drive_connections WHERE owner_id = $1")
        .bind(user.id)
        .execute(&state.pool)
        .await
        .map_err(GoogleApiError::Database)?;
    sqlx::query(
        "INSERT INTO audit_events (event_type, actor_id) VALUES ('google_drive_disconnected', $1)",
    )
    .bind(user.id)
    .execute(&state.pool)
    .await
    .map_err(GoogleApiError::Database)?;
    Ok(no_store(StatusCode::NO_CONTENT.into_response()))
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PauseBody {
    paused: bool,
}

async fn set_pause(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
    Json(body): Json<PauseBody>,
) -> Result<Json<PauseBody>, GoogleApiError> {
    require_settings(&state)?;
    require_change(&headers, &user, &state)?;
    let updated = sqlx::query(
        "UPDATE google_drive_connections SET paused = $2, updated_at = now() WHERE owner_id = $1",
    )
    .bind(user.id)
    .bind(body.paused)
    .execute(&state.pool)
    .await
    .map_err(GoogleApiError::Database)?;
    if updated.rows_affected() != 1 {
        return Err(GoogleApiError::NotConnected);
    }
    Ok(Json(PauseBody {
        paused: body.paused,
    }))
}

#[derive(Deserialize)]
struct FolderQuery {
    parent_id: Option<String>,
}

#[derive(Serialize)]
struct RemoteFolderPage {
    parent_id: String,
    folders: Vec<RemoteFolder>,
}

#[derive(Serialize)]
struct RemoteFolder {
    id: String,
    name: String,
}

#[derive(Deserialize)]
struct RemoteList {
    #[serde(rename = "nextPageToken")]
    next_page_token: Option<String>,
    files: Option<Vec<RemoteFile>>,
}

#[derive(Deserialize)]
struct RemoteFile {
    id: String,
    name: Option<String>,
    #[serde(rename = "mimeType")]
    mime_type: Option<String>,
    size: Option<String>,
    #[serde(rename = "md5Checksum")]
    md5_checksum: Option<String>,
    #[serde(rename = "modifiedTime")]
    modified_time: Option<String>,
    #[serde(rename = "shortcutDetails")]
    shortcut_details: Option<ShortcutDetails>,
}

#[derive(Deserialize)]
struct ShortcutDetails {
    #[serde(rename = "targetId")]
    target_id: Option<String>,
    #[serde(rename = "targetMimeType")]
    target_mime_type: Option<String>,
}

async fn remote_folders(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Query(query): Query<FolderQuery>,
) -> Result<Response, GoogleApiError> {
    let settings = require_settings(&state)?;
    let parent_id = query.parent_id.unwrap_or_else(|| "root".to_owned());
    if !valid_google_id(&parent_id) {
        return Err(GoogleApiError::BadRequest);
    }
    let connection = fetch_connection(&state.pool, user.id)
        .await?
        .ok_or(GoogleApiError::NotConnected)?;
    if connection.auth_state != "active" {
        return Err(GoogleApiError::Reauth);
    }
    let token = worker_access_token(&state.pool, settings, connection.id, user.id)
        .await
        .map_err(|error| match error {
            SyncError::Reauth => GoogleApiError::Reauth,
            SyncError::Database(database) => GoogleApiError::Database(database),
            _ => GoogleApiError::RequestFailed,
        })?;
    let mut page_token = None;
    let mut folders = Vec::new();
    for _ in 0..20 {
        let list = drive_list(&token, &parent_id, page_token.as_deref())
            .await
            .map_err(|_| GoogleApiError::Upstream)?;
        for file in list.files.unwrap_or_default() {
            if file.mime_type.as_deref() == Some("application/vnd.google-apps.folder")
                && valid_google_id(&file.id)
            {
                folders.push(RemoteFolder {
                    id: file.id,
                    name: storage_entry_name(file.name.as_deref().unwrap_or("Untitled"), 0, None),
                });
            }
        }
        page_token = list.next_page_token.filter(|token| valid_page_token(token));
        if page_token.is_none() {
            break;
        }
    }
    folders.sort_by_key(|folder| folder.name.to_lowercase());
    Ok(no_store(
        Json(RemoteFolderPage { parent_id, folders }).into_response(),
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SelectSource {
    google_folder_id: String,
}

#[derive(Serialize)]
struct SourceCreated {
    id: Uuid,
    local_folder_id: Uuid,
}

async fn select_source(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
    Json(body): Json<SelectSource>,
) -> Result<Response, GoogleApiError> {
    let settings = require_settings(&state)?;
    require_change(&headers, &user, &state)?;
    if !valid_google_id(&body.google_folder_id) {
        return Err(GoogleApiError::BadRequest);
    }
    let connection = fetch_connection(&state.pool, user.id)
        .await?
        .ok_or(GoogleApiError::NotConnected)?;
    if connection.auth_state != "active" {
        return Err(GoogleApiError::Reauth);
    }
    let token = worker_access_token(&state.pool, settings, connection.id, user.id)
        .await
        .map_err(|error| match error {
            SyncError::Reauth => GoogleApiError::Reauth,
            SyncError::Database(database) => GoogleApiError::Database(database),
            _ => GoogleApiError::RequestFailed,
        })?;
    let folder = fetch_remote_metadata(&token, &body.google_folder_id)
        .await
        .map_err(|_| GoogleApiError::RequestFailed)?;
    if folder.mime_type.as_deref() != Some("application/vnd.google-apps.folder")
        && body.google_folder_id != "root"
    {
        return Err(GoogleApiError::BadRequest);
    }
    let folder_name = if body.google_folder_id == "root" {
        "My Drive".to_owned()
    } else {
        storage_entry_name(folder.name.as_deref().unwrap_or("Google folder"), 0, None)
    };
    let mut transaction = state.pool.begin().await.map_err(GoogleApiError::Database)?;
    let root_id = ensure_import_root(&mut transaction, user.id, connection.local_root_id)
        .await
        .map_err(map_sync_api)?;
    if connection.local_root_id != Some(root_id) {
        sqlx::query(
            "UPDATE google_drive_connections SET local_root_id = $2, updated_at = now() WHERE id = $1",
        )
        .bind(connection.id)
        .bind(root_id)
        .execute(&mut *transaction)
        .await
        .map_err(GoogleApiError::Database)?;
    }
    let existing = sqlx::query_as::<_, (Uuid, bool)>(
        "SELECT id, enabled FROM google_drive_sources WHERE owner_id = $1 AND google_folder_id = $2",
    )
    .bind(user.id)
    .bind(&body.google_folder_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(GoogleApiError::Database)?;
    if existing.as_ref().is_some_and(|(_, enabled)| *enabled) {
        return Err(GoogleApiError::AlreadySelected);
    }
    let enabled_count = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM google_drive_sources WHERE owner_id = $1 AND enabled = TRUE",
    )
    .bind(user.id)
    .fetch_one(&mut *transaction)
    .await
    .map_err(GoogleApiError::Database)?;
    if enabled_count >= MAX_SOURCES {
        return Err(GoogleApiError::TooManyFolders);
    }
    let local_folder_id =
        create_child_folder(&mut transaction, user.id, Some(root_id), &folder_name)
            .await
            .map_err(map_sync_api)?;
    let source_id = existing.map(|(id, _)| id).unwrap_or_else(Uuid::new_v4);
    if existing.is_some() {
        sqlx::query(
            "UPDATE google_drive_sources \
                SET enabled = TRUE, google_folder_name = $2, local_folder_id = $3, connection_id = $4 \
              WHERE id = $1",
        )
        .bind(source_id)
        .bind(&folder_name)
        .bind(local_folder_id)
        .bind(connection.id)
        .execute(&mut *transaction)
        .await
        .map_err(GoogleApiError::Database)?;
    } else {
        sqlx::query(
            "INSERT INTO google_drive_sources \
                (id, connection_id, owner_id, google_folder_id, google_folder_name, local_folder_id) \
             VALUES ($1, $2, $3, $4, $5, $6)",
        )
        .bind(source_id)
        .bind(connection.id)
        .bind(user.id)
        .bind(&body.google_folder_id)
        .bind(&folder_name)
        .bind(local_folder_id)
        .execute(&mut *transaction)
        .await
        .map_err(GoogleApiError::Database)?;
    }
    start_run(
        &mut transaction,
        source_id,
        user.id,
        &body.google_folder_id,
        local_folder_id,
    )
    .await
    .map_err(GoogleApiError::Database)?;
    sqlx::query(
        "INSERT INTO audit_events (event_type, actor_id, resource_id) \
         VALUES ('google_drive_source_added', $1, $2)",
    )
    .bind(user.id)
    .bind(source_id)
    .execute(&mut *transaction)
    .await
    .map_err(GoogleApiError::Database)?;
    transaction
        .commit()
        .await
        .map_err(GoogleApiError::Database)?;
    Ok(no_store(
        (
            StatusCode::CREATED,
            Json(SourceCreated {
                id: source_id,
                local_folder_id,
            }),
        )
            .into_response(),
    ))
}

async fn remove_source(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response, GoogleApiError> {
    require_settings(&state)?;
    require_change(&headers, &user, &state)?;
    let mut transaction = state.pool.begin().await.map_err(GoogleApiError::Database)?;
    let source = sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM google_drive_sources WHERE id = $1 AND owner_id = $2 AND enabled = TRUE",
    )
    .bind(id)
    .bind(user.id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(GoogleApiError::Database)?;
    if source.is_none() {
        return Err(GoogleApiError::NotFound);
    }
    sqlx::query(
        "UPDATE google_drive_runs SET state = 'cancelled', completed_at = now(), updated_at = now() \
          WHERE source_id = $1 AND state IN ('listing', 'downloading')",
    )
    .bind(id)
    .execute(&mut *transaction)
    .await
    .map_err(GoogleApiError::Database)?;
    sqlx::query("DELETE FROM google_drive_items WHERE source_id = $1 AND state = 'pending'")
        .bind(id)
        .execute(&mut *transaction)
        .await
        .map_err(GoogleApiError::Database)?;
    let committing = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM google_drive_items WHERE source_id = $1 AND state = 'committing'",
    )
    .bind(id)
    .fetch_one(&mut *transaction)
    .await
    .map_err(GoogleApiError::Database)?;
    if committing == 0 {
        sqlx::query("DELETE FROM google_drive_sources WHERE id = $1 AND owner_id = $2")
            .bind(id)
            .bind(user.id)
            .execute(&mut *transaction)
            .await
            .map_err(GoogleApiError::Database)?;
    } else {
        sqlx::query("UPDATE google_drive_sources SET enabled = FALSE WHERE id = $1")
            .bind(id)
            .execute(&mut *transaction)
            .await
            .map_err(GoogleApiError::Database)?;
    }
    transaction
        .commit()
        .await
        .map_err(GoogleApiError::Database)?;
    Ok(no_store(StatusCode::NO_CONTENT.into_response()))
}

#[derive(Serialize)]
struct SyncStarted {
    started: bool,
}

async fn sync_source(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<SyncStarted>, GoogleApiError> {
    require_settings(&state)?;
    require_change(&headers, &user, &state)?;
    let mut transaction = state.pool.begin().await.map_err(GoogleApiError::Database)?;
    let source = sqlx::query_as::<_, (String, Option<Uuid>)>(
        "SELECT google_folder_id, local_folder_id FROM google_drive_sources \
          WHERE id = $1 AND owner_id = $2 AND enabled = TRUE",
    )
    .bind(id)
    .bind(user.id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(GoogleApiError::Database)?;
    let Some((google_folder_id, local_folder_id)) = source else {
        return Err(GoogleApiError::NotFound);
    };
    let Some(local_folder_id) = local_folder_id else {
        return Err(GoogleApiError::Conflict);
    };
    let active = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS (SELECT 1 FROM google_drive_runs \
          WHERE source_id = $1 AND state IN ('listing', 'downloading'))",
    )
    .bind(id)
    .fetch_one(&mut *transaction)
    .await
    .map_err(GoogleApiError::Database)?;
    if active {
        transaction
            .rollback()
            .await
            .map_err(GoogleApiError::Database)?;
        return Ok(Json(SyncStarted { started: false }));
    }
    start_run(
        &mut transaction,
        id,
        user.id,
        &google_folder_id,
        local_folder_id,
    )
    .await
    .map_err(GoogleApiError::Database)?;
    transaction
        .commit()
        .await
        .map_err(GoogleApiError::Database)?;
    Ok(Json(SyncStarted { started: true }))
}

fn map_sync_api(error: SyncError) -> GoogleApiError {
    match error {
        SyncError::Database(database) => GoogleApiError::Database(database),
        _ => GoogleApiError::Conflict,
    }
}

async fn start_run(
    transaction: &mut Transaction<'_, Postgres>,
    source_id: Uuid,
    owner_id: Uuid,
    google_folder_id: &str,
    local_folder_id: Uuid,
) -> Result<(), sqlx::Error> {
    let run_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO google_drive_runs (id, source_id, owner_id, state) VALUES ($1, $2, $3, 'listing')",
    )
    .bind(run_id)
    .bind(source_id)
    .bind(owner_id)
    .execute(&mut **transaction)
    .await?;
    sqlx::query(
        "INSERT INTO google_drive_list_queue (run_id, google_folder_id, local_folder_id) \
         VALUES ($1, $2, $3)",
    )
    .bind(run_id)
    .bind(google_folder_id)
    .bind(local_folder_id)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

#[derive(Debug, Error)]
enum SyncError {
    #[error("database operation failed")]
    Database(#[from] sqlx::Error),
    #[error("storage operation failed")]
    Storage(#[from] StorageError),
    #[error("google drive request failed")]
    Network(#[from] reqwest::Error),
    #[error("google drive authorization expired")]
    Reauth,
    #[error("google drive rate limited")]
    RateLimited,
    #[error("file exceeds the size limit")]
    TooLarge,
    #[error("quota exceeded")]
    Quota,
    #[error("storage is low on free space")]
    LowSpace,
    #[error("google file is unavailable")]
    Missing,
    #[error("{0}")]
    Store(&'static str),
}

impl SyncError {
    fn code(&self) -> &'static str {
        match self {
            Self::Reauth => "reauth_required",
            Self::RateLimited => "rate_limited",
            Self::TooLarge => "payload_too_large",
            Self::Quota => "quota_exceeded",
            Self::LowSpace => "storage_low",
            Self::Missing => "not_found",
            Self::Network(_) => "download_failed",
            Self::Database(_) => "service_unavailable",
            Self::Storage(StorageError::LowSpace) => "storage_low",
            Self::Storage(_) => "storage_failed",
            Self::Store(code) => code,
        }
    }

    fn permanent(&self) -> bool {
        !matches!(self, Self::RateLimited)
    }
}

pub(crate) async fn run_worker(
    pool: PgPool,
    storage: LocalStorage,
    settings: GoogleDriveSettings,
    limits: TransferSettings,
) {
    loop {
        let mut lock_connection = match pool.acquire().await {
            Ok(connection) => connection,
            Err(error) => {
                tracing::warn!(error = %error, "google drive sync cannot connect to PostgreSQL");
                sleep(IDLE_POLL).await;
                continue;
            }
        };
        let locked = match sqlx::query_scalar::<_, bool>("SELECT pg_try_advisory_lock($1)")
            .bind(WORKER_LOCK_ID)
            .fetch_one(&mut *lock_connection)
            .await
        {
            Ok(locked) => locked,
            Err(error) => {
                tracing::warn!(error = %error, "google drive sync could not acquire its lock");
                drop(lock_connection);
                sleep(IDLE_POLL).await;
                continue;
            }
        };
        if !locked {
            drop(lock_connection);
            sleep(IDLE_POLL).await;
            continue;
        }
        tracing::info!("google drive sync worker acquired its singleton lock");
        let mut consecutive_failures = 0_i32;
        loop {
            if let Err(error) = sqlx::query_scalar::<_, i32>("SELECT 1")
                .fetch_one(&mut *lock_connection)
                .await
            {
                tracing::warn!(error = %error, "google drive sync lock connection was lost");
                break;
            }
            match sync_tick(&pool, &storage, &settings, limits).await {
                Ok(Tick::Idle) => {
                    consecutive_failures = 0;
                    sleep(IDLE_POLL).await;
                }
                Ok(Tick::Deferred) => sleep(DEFER_POLL).await,
                Ok(Tick::RateLimited) => sleep(RATE_LIMIT_POLL).await,
                Ok(Tick::Worked) => {
                    consecutive_failures = 0;
                    sleep(FILE_PAUSE).await;
                }
                Err(error) => {
                    tracing::warn!(error = %error, code = error.code(), "google drive sync tick failed");
                    consecutive_failures = consecutive_failures.saturating_add(1);
                    if consecutive_failures >= FAILURE_LIMIT {
                        let _ = fail_active_runs(&pool, "too_many_failures").await;
                        consecutive_failures = 0;
                    }
                    sleep(IDLE_POLL).await;
                }
            }
        }
        drop(lock_connection);
    }
}

enum Tick {
    Idle,
    Deferred,
    RateLimited,
    Worked,
}

async fn sync_tick(
    pool: &PgPool,
    storage: &LocalStorage,
    settings: &GoogleDriveSettings,
    limits: TransferSettings,
) -> Result<Tick, SyncError> {
    storage.ensure_mounted()?;
    recover_downloads(pool, storage).await?;
    if resume_commit(pool, storage).await? {
        return Ok(Tick::Worked);
    }
    ensure_scheduled_run(pool).await?;
    let pressure = indexer_pressure(pool).await?;
    if let Some(reason) = indexer_backpressure(pressure.0, pressure.1, pressure.2)
        && pending_download(pool).await?
    {
        mark_throttle(pool, reason).await?;
        return Ok(Tick::Deferred);
    }
    if let Some(item) = claim_item(pool).await? {
        return download_claimed(pool, storage, settings, limits, item, pressure.1).await;
    }
    if list_one_page(pool, settings).await? {
        return Ok(Tick::Worked);
    }
    finish_runs(pool).await?;
    Ok(Tick::Idle)
}

async fn indexer_pressure(pool: &PgPool) -> Result<(i64, bool, bool), SyncError> {
    sqlx::query_as::<_, (i64, bool, bool)>(
        "SELECT \
            (SELECT COUNT(*) FROM media_index_jobs \
              WHERE task = 'image_preview' AND state IN ('queued', 'running', 'retry_wait'))::BIGINT, \
            EXISTS (SELECT 1 FROM media_index_jobs WHERE state = 'running'), \
            COALESCE((SELECT paused FROM media_index_control WHERE singleton = TRUE), FALSE)",
    )
    .fetch_one(pool)
    .await
    .map_err(SyncError::from)
}

async fn pending_download(pool: &PgPool) -> Result<bool, SyncError> {
    sqlx::query_scalar(
        "SELECT EXISTS ( \
            SELECT 1 FROM google_drive_items AS item \
            JOIN google_drive_runs AS run ON run.id = item.run_id \
            WHERE item.state = 'pending' AND run.state IN ('listing', 'downloading') \
        )",
    )
    .fetch_one(pool)
    .await
    .map_err(SyncError::from)
}

async fn mark_throttle(pool: &PgPool, reason: &str) -> Result<(), SyncError> {
    sqlx::query(
        "UPDATE google_drive_runs SET throttle_reason = $1, updated_at = now() \
          WHERE state IN ('listing', 'downloading')",
    )
    .bind(reason)
    .execute(pool)
    .await?;
    Ok(())
}

async fn fail_active_runs(pool: &PgPool, code: &str) -> Result<(), SyncError> {
    sqlx::query(
        "UPDATE google_drive_runs \
            SET state = 'failed', error_code = $1, completed_at = now(), updated_at = now(), \
                current_name = NULL \
          WHERE state IN ('listing', 'downloading')",
    )
    .bind(code)
    .execute(pool)
    .await?;
    Ok(())
}

#[derive(FromRow)]
struct ClaimedItem {
    id: Uuid,
    run_id: Uuid,
    owner_id: Uuid,
    connection_id: Uuid,
    google_file_id: String,
    parent_local_id: Option<Uuid>,
    name: String,
    google_mime: String,
    size_bytes: Option<i64>,
    modified_at: Option<DateTime<Utc>>,
    export_mime: Option<String>,
}

async fn claim_item(pool: &PgPool) -> Result<Option<ClaimedItem>, SyncError> {
    sqlx::query_as::<_, ClaimedItem>(
        "UPDATE google_drive_items AS item \
            SET state = 'downloading', updated_at = now() \
          WHERE item.id = ( \
            SELECT candidate.id \
              FROM google_drive_items AS candidate \
              JOIN google_drive_runs AS run ON run.id = candidate.run_id \
              JOIN google_drive_sources AS source ON source.id = candidate.source_id \
              JOIN google_drive_connections AS connection ON connection.id = source.connection_id \
              JOIN users ON users.id = candidate.owner_id \
             WHERE candidate.state = 'pending' \
               AND run.state IN ('listing', 'downloading') \
               AND source.enabled = TRUE \
               AND connection.paused = FALSE \
               AND connection.auth_state = 'active' \
               AND users.disabled_at IS NULL \
             ORDER BY candidate.priority, COALESCE(candidate.size_bytes, 9223372036854775807), \
                      candidate.created_at, candidate.id \
             LIMIT 1 \
             FOR UPDATE OF candidate SKIP LOCKED \
          ) \
         RETURNING item.id, item.run_id, item.owner_id, \
            (SELECT connection.id FROM google_drive_sources AS source \
              JOIN google_drive_connections AS connection ON connection.id = source.connection_id \
              WHERE source.id = item.source_id) AS connection_id, \
            item.google_file_id, item.parent_local_id, item.name, item.google_mime, item.size_bytes, \
            item.modified_at, item.export_mime",
    )
    .fetch_optional(pool)
    .await
    .map_err(SyncError::from)
}

struct StagedFile {
    staging_key: Uuid,
    size: i64,
    checksum: String,
    index_mime: Option<String>,
}

async fn download_claimed(
    pool: &PgPool,
    storage: &LocalStorage,
    settings: &GoogleDriveSettings,
    limits: TransferSettings,
    item: ClaimedItem,
    indexer_busy: bool,
) -> Result<Tick, SyncError> {
    sqlx::query(
        "UPDATE google_drive_runs \
            SET current_name = $2, current_bytes = 0, current_total_bytes = $3, \
                throttle_reason = NULL, updated_at = now() \
          WHERE id = $1",
    )
    .bind(item.run_id)
    .bind(&item.name)
    .bind(item.size_bytes)
    .execute(pool)
    .await?;
    let parent = match item.parent_local_id {
        Some(parent) => parent,
        None => {
            fail_item(pool, storage, &item, "parent_missing").await?;
            return Ok(Tick::Worked);
        }
    };
    let room = match quota_room(pool, item.owner_id, limits.owner_quota_bytes).await {
        Ok(room) => room,
        Err(error) => {
            fail_item(pool, storage, &item, error.code()).await?;
            return Ok(Tick::Worked);
        }
    };
    let cap = room.min(limits.max_file_size);
    if item
        .size_bytes
        .is_some_and(|size| u64::try_from(size).unwrap_or(u64::MAX) > cap)
    {
        let code = if item
            .size_bytes
            .is_some_and(|size| u64::try_from(size).unwrap_or(u64::MAX) > limits.max_file_size)
        {
            "payload_too_large"
        } else {
            "quota_exceeded"
        };
        fail_item(pool, storage, &item, code).await?;
        return Ok(Tick::Worked);
    }
    let staged = match stage_download(
        pool,
        storage,
        settings,
        &item,
        cap,
        limits.max_file_size,
        indexer_busy,
    )
    .await
    {
        Ok(staged) => staged,
        Err(SyncError::RateLimited) => {
            release_item(pool, item.id).await?;
            mark_throttle(pool, "rate_limit").await?;
            return Ok(Tick::RateLimited);
        }
        Err(error) if error.permanent() => {
            if matches!(
                error,
                SyncError::LowSpace | SyncError::Storage(StorageError::LowSpace)
            ) {
                let _ = fail_active_runs(pool, "storage_low").await;
            }
            fail_item(pool, storage, &item, error.code()).await?;
            return Ok(Tick::Worked);
        }
        Err(error) => return Err(error),
    };
    if let Err(error) = commit_staged(pool, &item, parent, &staged, limits.owner_quota_bytes).await
    {
        let _ = storage.remove_staging_file(staged.staging_key).await;
        if error.permanent() {
            fail_item(pool, storage, &item, error.code()).await?;
            return Ok(Tick::Worked);
        }
        return Err(error);
    }
    if let Err(error) = promote_and_finish(pool, storage, &item, &staged).await {
        tracing::warn!(
            item_id = %item.id,
            error = %error,
            "google drive file is staged and will finish on the next pass"
        );
    }
    Ok(Tick::Worked)
}

async fn stage_download(
    pool: &PgPool,
    storage: &LocalStorage,
    settings: &GoogleDriveSettings,
    item: &ClaimedItem,
    cap: u64,
    max_file_size: u64,
    mut indexer_busy: bool,
) -> Result<StagedFile, SyncError> {
    let url = match item.export_mime.as_deref() {
        Some(mime) => format!(
            "{DRIVE_FILES_URL}/{}/export?mimeType={}",
            percent_encode(&item.google_file_id),
            percent_encode(mime)
        ),
        None => format!(
            "{DRIVE_FILES_URL}/{}?alt=media",
            percent_encode(&item.google_file_id)
        ),
    };
    let mut response =
        authorized_request(pool, settings, item.connection_id, item.owner_id, &url).await?;
    let status = response.status().as_u16();
    if status == 429 {
        return Err(SyncError::RateLimited);
    }
    if status == 404 {
        return Err(SyncError::Missing);
    }
    if !(200..300).contains(&status) {
        return Err(SyncError::Store("download_failed"));
    }
    let staging_key = Uuid::new_v4();
    storage.create_staging_file(staging_key).await?;
    sqlx::query("UPDATE google_drive_items SET staging_key = $2, updated_at = now() WHERE id = $1")
        .bind(item.id)
        .bind(staging_key)
        .execute(pool)
        .await?;
    let mut file = tokio_fs::OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(storage.staging_path(staging_key))
        .await
        .map_err(|error| SyncError::Storage(StorageError::Io(error)))?;
    let mut hasher = Sha256::new();
    let mut size = 0_u64;
    let mut header = Vec::new();
    let mut window_started = Instant::now();
    let mut window_bytes = 0_usize;
    loop {
        let chunk = match tokio::time::timeout(CHUNK_TIMEOUT, response.chunk()).await {
            Ok(Ok(Some(chunk))) => chunk,
            Ok(Ok(None)) => break,
            Ok(Err(error)) => {
                let _ = storage.remove_staging_file(staging_key).await;
                return Err(SyncError::Network(error));
            }
            Err(_) => {
                let _ = storage.remove_staging_file(staging_key).await;
                return Err(SyncError::Store("download_stalled"));
            }
        };
        if header.len() < 512 {
            let take = (512 - header.len()).min(chunk.len());
            header.extend_from_slice(&chunk[..take]);
        }
        let Some(next_size) = size.checked_add(u64::try_from(chunk.len()).unwrap_or(u64::MAX))
        else {
            let _ = storage.remove_staging_file(staging_key).await;
            return Err(SyncError::TooLarge);
        };
        size = next_size;
        if size > cap {
            let _ = storage.remove_staging_file(staging_key).await;
            return Err(if size > max_file_size {
                SyncError::TooLarge
            } else {
                SyncError::Quota
            });
        }
        if let Err(error) =
            storage.check_write_capacity(u64::try_from(chunk.len()).unwrap_or(u64::MAX))
        {
            let _ = storage.remove_staging_file(staging_key).await;
            return Err(match error {
                StorageError::LowSpace => SyncError::LowSpace,
                other => SyncError::Storage(other),
            });
        }
        if let Err(error) = file.write_all(&chunk).await {
            let _ = storage.remove_staging_file(staging_key).await;
            return Err(SyncError::Storage(StorageError::Io(error)));
        }
        hasher.update(&chunk);
        window_bytes = window_bytes.saturating_add(chunk.len());
        if window_bytes >= CHUNK_BYTES {
            indexer_busy = indexer_pressure(pool)
                .await
                .map(|row| row.1)
                .unwrap_or(true);
            let _ = sqlx::query(
                "UPDATE google_drive_runs SET current_bytes = $2, updated_at = now() WHERE id = $1",
            )
            .bind(item.run_id)
            .bind(i64::try_from(size).unwrap_or(i64::MAX))
            .execute(pool)
            .await;
            sleep(pace_after(window_started.elapsed(), indexer_busy)).await;
            window_started = Instant::now();
            window_bytes = 0;
        }
    }
    if window_bytes > 0 {
        sleep(pace_after(window_started.elapsed(), indexer_busy)).await;
    }
    if let Err(error) = file.sync_all().await {
        let _ = storage.remove_staging_file(staging_key).await;
        return Err(SyncError::Storage(StorageError::Io(error)));
    }
    let index_mime = detected_index_mime(&header, &item.google_mime, &item.name).map(str::to_owned);
    Ok(StagedFile {
        staging_key,
        size: i64::try_from(size).map_err(|_| SyncError::TooLarge)?,
        checksum: hex_encode(&hasher.finalize()),
        index_mime,
    })
}

async fn commit_staged(
    pool: &PgPool,
    item: &ClaimedItem,
    parent_id: Uuid,
    staged: &StagedFile,
    owner_quota: u64,
) -> Result<(), SyncError> {
    let mut transaction = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))")
        .bind(item.owner_id)
        .execute(&mut *transaction)
        .await?;
    let room = quota_room_tx(&mut transaction, item.owner_id, owner_quota).await?;
    if u64::try_from(staged.size).unwrap_or(u64::MAX) > room {
        return Err(SyncError::Quota);
    }
    let parent_ok = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS (SELECT 1 FROM drive_entries \
          WHERE id = $1 AND owner_id = $2 AND kind = 'folder' AND deleted_at IS NULL)",
    )
    .bind(parent_id)
    .bind(item.owner_id)
    .fetch_one(&mut *transaction)
    .await?;
    if !parent_ok {
        return Err(SyncError::Store("parent_missing"));
    }
    let object_id = Uuid::new_v4();
    let storage_key = LocalStorage::storage_key(object_id);
    sqlx::query(
        "INSERT INTO storage_objects (id, storage_key, size_bytes, state) VALUES ($1, $2, $3, 'pending')",
    )
    .bind(object_id)
    .bind(&storage_key)
    .bind(staged.size)
    .execute(&mut *transaction)
    .await?;
    let existing = sqlx::query_as::<_, (Uuid, Option<DateTime<Utc>>)>(
        "SELECT link.local_entry_id, entry.deleted_at \
           FROM google_drive_links AS link \
           JOIN drive_entries AS entry ON entry.id = link.local_entry_id \
          WHERE link.owner_id = $1 AND link.google_file_id = $2 AND entry.kind = 'file'",
    )
    .bind(item.owner_id)
    .bind(&item.google_file_id)
    .fetch_optional(&mut *transaction)
    .await?;
    let file_id =
        if let Some((file_id, _deleted_at)) = existing.filter(|(_, deleted)| deleted.is_none()) {
            file_id
        } else {
            let file_id = Uuid::new_v4();
            insert_named_entry(
                &mut transaction,
                file_id,
                item.owner_id,
                Some(parent_id),
                "file",
                &item.name,
            )
            .await?;
            sqlx::query("INSERT INTO files (id) VALUES ($1)")
                .bind(file_id)
                .execute(&mut *transaction)
                .await?;
            file_id
        };
    let version_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO file_versions (id, file_id, storage_object_id, size_bytes, original_modified_at) \
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(version_id)
    .bind(file_id)
    .bind(object_id)
    .bind(staged.size)
    .bind(item.modified_at)
    .execute(&mut *transaction)
    .await?;
    sqlx::query("UPDATE files SET current_version_id = $1 WHERE id = $2")
        .bind(version_id)
        .bind(file_id)
        .execute(&mut *transaction)
        .await?;
    sqlx::query(
        "UPDATE google_drive_items \
            SET state = 'committing', storage_object_id = $2, local_file_id = $3, \
                checksum_sha256 = $4, index_mime = $5, bytes_downloaded = $6, updated_at = now() \
          WHERE id = $1 AND state = 'downloading'",
    )
    .bind(item.id)
    .bind(object_id)
    .bind(file_id)
    .bind(&staged.checksum)
    .bind(staged.index_mime.as_deref())
    .bind(staged.size)
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(())
}

async fn promote_and_finish(
    pool: &PgPool,
    storage: &LocalStorage,
    item: &ClaimedItem,
    staged: &StagedFile,
) -> Result<(), SyncError> {
    let object = sqlx::query_as::<_, (Uuid, String)>(
        "SELECT object.id, object.storage_key \
           FROM google_drive_items AS item \
           JOIN storage_objects AS object ON object.id = item.storage_object_id \
          WHERE item.id = $1",
    )
    .bind(item.id)
    .fetch_one(pool)
    .await?;
    storage
        .promote_staging_file(staged.staging_key, &object.1)
        .await?;
    finish_ready(
        pool,
        item.id,
        object.0,
        &staged.checksum,
        staged.index_mime.as_deref(),
        staged.size,
    )
    .await
}

async fn finish_ready(
    pool: &PgPool,
    item_id: Uuid,
    object_id: Uuid,
    checksum: &str,
    index_mime: Option<&str>,
    size: i64,
) -> Result<(), SyncError> {
    let mut transaction = pool.begin().await?;
    let version_id = sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM file_versions WHERE storage_object_id = $1 ORDER BY created_at DESC LIMIT 1",
    )
    .bind(object_id)
    .fetch_optional(&mut *transaction)
    .await?;
    sqlx::query(
        "UPDATE storage_objects \
            SET checksum_sha256 = $2, mime_detected = $3, size_bytes = $4, state = 'ready' \
          WHERE id = $1 AND state IN ('pending', 'ready')",
    )
    .bind(object_id)
    .bind(checksum)
    .bind(index_mime)
    .bind(size)
    .execute(&mut *transaction)
    .await?;
    sqlx::query(
        "INSERT INTO google_drive_links \
            (owner_id, google_file_id, local_entry_id, md5_checksum, size_bytes, modified_at) \
         SELECT item.owner_id, item.google_file_id, item.local_file_id, item.md5_checksum, $2, \
                item.modified_at \
           FROM google_drive_items AS item \
          WHERE item.id = $1 AND item.local_file_id IS NOT NULL \
         ON CONFLICT (owner_id, google_file_id) DO UPDATE \
            SET local_entry_id = EXCLUDED.local_entry_id, \
                md5_checksum = EXCLUDED.md5_checksum, \
                size_bytes = EXCLUDED.size_bytes, \
                modified_at = EXCLUDED.modified_at, \
                updated_at = now()",
    )
    .bind(item_id)
    .bind(size)
    .execute(&mut *transaction)
    .await?;
    if let (Some(version_id), Some(mime)) = (version_id, index_mime) {
        for (task, recipe) in index_tasks(mime) {
            sqlx::query(
                "INSERT INTO media_index_jobs (file_version_id, task, recipe_version) \
                 VALUES ($1, $2, $3) \
                 ON CONFLICT (file_version_id, task, recipe_version) DO NOTHING",
            )
            .bind(version_id)
            .bind(task)
            .bind(recipe)
            .execute(&mut *transaction)
            .await?;
        }
    }
    let stored = sqlx::query(
        "UPDATE google_drive_items \
            SET state = 'stored', staging_key = NULL, error_code = NULL, updated_at = now() \
          WHERE id = $1 AND state = 'committing'",
    )
    .bind(item_id)
    .execute(&mut *transaction)
    .await?;
    if stored.rows_affected() == 1 {
        sqlx::query(
            "UPDATE google_drive_runs AS run \
                SET downloaded_files = run.downloaded_files + 1, \
                    downloaded_bytes = run.downloaded_bytes + $2, \
                    current_bytes = $2, \
                    updated_at = now() \
              FROM google_drive_items AS item \
             WHERE item.id = $1 AND run.id = item.run_id",
        )
        .bind(item_id)
        .bind(size)
        .execute(&mut *transaction)
        .await?;
    }
    transaction.commit().await?;
    Ok(())
}

fn index_tasks(mime: &str) -> &'static [(&'static str, i16)] {
    if indexable_image_mime(Some(mime)) {
        &[("image_preview", 1)]
    } else if indexable_video_mime(Some(mime)) {
        &[("video_thumbnail", 1), ("video_preview", 1)]
    } else {
        &[]
    }
}

async fn recover_downloads(pool: &PgPool, storage: &LocalStorage) -> Result<(), SyncError> {
    let staging_keys = sqlx::query_scalar::<_, Option<Uuid>>(
        "WITH stuck AS ( \
             SELECT id, staging_key FROM google_drive_items \
              WHERE state = 'downloading' \
              FOR UPDATE \
         ) \
         UPDATE google_drive_items AS item \
            SET state = 'pending', staging_key = NULL, bytes_downloaded = 0, updated_at = now() \
           FROM stuck \
          WHERE item.id = stuck.id \
         RETURNING stuck.staging_key",
    )
    .fetch_all(pool)
    .await?;
    for staging_key in staging_keys.into_iter().flatten() {
        let _ = storage.remove_staging_file(staging_key).await;
    }
    Ok(())
}

async fn resume_commit(pool: &PgPool, storage: &LocalStorage) -> Result<bool, SyncError> {
    let item = sqlx::query_as::<
        _,
        (
            Uuid,
            Option<Uuid>,
            Option<Uuid>,
            Option<String>,
            Option<String>,
            i64,
        ),
    >(
        "SELECT id, storage_object_id, staging_key, checksum_sha256, index_mime, bytes_downloaded \
           FROM google_drive_items WHERE state = 'committing' ORDER BY updated_at, id LIMIT 1",
    )
    .fetch_optional(pool)
    .await?;
    let Some((item_id, object_id, staging_key, checksum, index_mime, size)) = item else {
        return Ok(false);
    };
    let Some(object_id) = object_id else {
        let _ = abandon_commit(pool, storage, item_id, staging_key, None).await;
        return Ok(true);
    };
    let storage_key =
        sqlx::query_scalar::<_, String>("SELECT storage_key FROM storage_objects WHERE id = $1")
            .bind(object_id)
            .fetch_optional(pool)
            .await?;
    let Some(storage_key) = storage_key else {
        let _ = abandon_commit(pool, storage, item_id, staging_key, None).await;
        return Ok(true);
    };
    let dest_exists = storage.object_exists(&storage_key).await?;
    if dest_exists {
        if let Some(staging_key) = staging_key {
            let _ = storage.remove_staging_file(staging_key).await;
        }
    } else if let Some(staging_key) = staging_key {
        storage
            .promote_staging_file(staging_key, &storage_key)
            .await?;
    } else {
        abandon_commit(pool, storage, item_id, None, Some(object_id)).await?;
        return Ok(true);
    }
    let Some(checksum) = checksum else {
        abandon_commit(pool, storage, item_id, None, Some(object_id)).await?;
        return Ok(true);
    };
    finish_ready(
        pool,
        item_id,
        object_id,
        checksum.trim(),
        index_mime.as_deref(),
        size,
    )
    .await?;
    Ok(true)
}

async fn abandon_commit(
    pool: &PgPool,
    storage: &LocalStorage,
    item_id: Uuid,
    staging_key: Option<Uuid>,
    object_id: Option<Uuid>,
) -> Result<(), SyncError> {
    if let Some(staging_key) = staging_key {
        let _ = storage.remove_staging_file(staging_key).await;
    }
    let mut transaction = pool.begin().await?;
    if let Some(object_id) = object_id {
        let file_id = sqlx::query_scalar::<_, Uuid>(
            "SELECT file_id FROM file_versions WHERE storage_object_id = $1 LIMIT 1",
        )
        .bind(object_id)
        .fetch_optional(&mut *transaction)
        .await?;
        if let Some(file_id) = file_id {
            let previous = sqlx::query_scalar::<_, Uuid>(
                "SELECT id FROM file_versions \
                  WHERE file_id = $1 AND storage_object_id IS DISTINCT FROM $2 \
                  ORDER BY created_at DESC, id DESC \
                  LIMIT 1",
            )
            .bind(file_id)
            .bind(object_id)
            .fetch_optional(&mut *transaction)
            .await?;
            if let Some(previous) = previous {
                sqlx::query("UPDATE files SET current_version_id = $1 WHERE id = $2")
                    .bind(previous)
                    .bind(file_id)
                    .execute(&mut *transaction)
                    .await?;
            } else {
                sqlx::query("UPDATE files SET current_version_id = NULL WHERE id = $1")
                    .bind(file_id)
                    .execute(&mut *transaction)
                    .await?;
                sqlx::query("DELETE FROM files WHERE id = $1")
                    .bind(file_id)
                    .execute(&mut *transaction)
                    .await?;
                sqlx::query("DELETE FROM drive_entries WHERE id = $1")
                    .bind(file_id)
                    .execute(&mut *transaction)
                    .await?;
            }
            sqlx::query("DELETE FROM file_versions WHERE storage_object_id = $1")
                .bind(object_id)
                .execute(&mut *transaction)
                .await?;
        }
    }
    let failed = sqlx::query(
        "UPDATE google_drive_items \
            SET state = 'failed', error_code = 'payload_missing', staging_key = NULL, updated_at = now() \
          WHERE id = $1 AND state = 'committing'",
    )
    .bind(item_id)
    .execute(&mut *transaction)
    .await?;
    if failed.rows_affected() == 1 {
        sqlx::query(
            "UPDATE google_drive_runs AS run \
                SET failed_files = run.failed_files + 1, updated_at = now() \
              FROM google_drive_items AS item \
             WHERE item.id = $1 AND run.id = item.run_id",
        )
        .bind(item_id)
        .execute(&mut *transaction)
        .await?;
    }
    transaction.commit().await?;
    Ok(())
}

async fn fail_item(
    pool: &PgPool,
    storage: &LocalStorage,
    item: &ClaimedItem,
    code: &str,
) -> Result<(), SyncError> {
    if let Some(staging_key) = sqlx::query_scalar::<_, Option<Uuid>>(
        "SELECT staging_key FROM google_drive_items WHERE id = $1",
    )
    .bind(item.id)
    .fetch_optional(pool)
    .await?
    .flatten()
    {
        let _ = storage.remove_staging_file(staging_key).await;
    }
    let failed = sqlx::query(
        "UPDATE google_drive_items \
            SET state = 'failed', error_code = $2, staging_key = NULL, updated_at = now() \
          WHERE id = $1 AND state IN ('pending', 'downloading')",
    )
    .bind(item.id)
    .bind(code)
    .execute(pool)
    .await?;
    if failed.rows_affected() == 1 {
        sqlx::query(
            "UPDATE google_drive_runs SET failed_files = failed_files + 1, current_name = NULL, updated_at = now() \
              WHERE id = $1",
        )
        .bind(item.run_id)
        .execute(pool)
        .await?;
    }
    Ok(())
}

async fn release_item(pool: &PgPool, item_id: Uuid) -> Result<(), SyncError> {
    sqlx::query(
        "UPDATE google_drive_items \
            SET state = 'pending', staging_key = NULL, bytes_downloaded = 0, updated_at = now() \
          WHERE id = $1 AND state = 'downloading'",
    )
    .bind(item_id)
    .execute(pool)
    .await?;
    Ok(())
}

async fn quota_room(pool: &PgPool, owner_id: Uuid, owner_quota: u64) -> Result<u64, SyncError> {
    let mut transaction = pool.begin().await?;
    let room = quota_room_tx(&mut transaction, owner_id, owner_quota).await?;
    transaction.rollback().await?;
    Ok(room)
}

async fn quota_room_tx(
    transaction: &mut Transaction<'_, Postgres>,
    owner_id: Uuid,
    owner_quota: u64,
) -> Result<u64, SyncError> {
    let account = sqlx::query_as::<_, (String, Option<i64>, bool)>(
        "SELECT role, quota_bytes, disabled_at IS NULL FROM users WHERE id = $1",
    )
    .bind(owner_id)
    .fetch_one(&mut **transaction)
    .await?;
    if !account.2 {
        return Err(SyncError::Store("account_disabled"));
    }
    let limit = if account.0 == "member" {
        u64::try_from(account.1.ok_or(SyncError::Store("account_disabled"))?).unwrap_or(0)
    } else {
        owner_quota
    };
    let usage = sqlx::query_as::<_, (i64, i64)>(
        "SELECT \
            (SELECT COALESCE(SUM(version.size_bytes), 0)::BIGINT \
               FROM drive_entries AS entry \
               JOIN files AS file ON file.id = entry.id \
               JOIN file_versions AS version ON version.id = file.current_version_id \
               JOIN storage_objects AS object ON object.id = version.storage_object_id \
                    AND object.state = 'ready' \
              WHERE entry.owner_id = $1), \
            (SELECT COALESCE(SUM(expected_size), 0)::BIGINT \
               FROM upload_sessions \
              WHERE owner_id = $1 \
                AND (state = 'finalizing' OR (state = 'active' AND expires_at > now()))) \
            + (SELECT COALESCE(SUM(bytes_downloaded), 0)::BIGINT \
                 FROM google_drive_items \
                WHERE owner_id = $1 AND state = 'committing')",
    )
    .bind(owner_id)
    .fetch_one(&mut **transaction)
    .await?;
    let used = u64::try_from(usage.0.max(0))
        .unwrap_or(u64::MAX)
        .saturating_add(u64::try_from(usage.1.max(0)).unwrap_or(u64::MAX));
    Ok(limit.saturating_sub(used))
}

async fn ensure_scheduled_run(pool: &PgPool) -> Result<(), SyncError> {
    let source = sqlx::query_as::<_, (Uuid, Uuid, String, Option<Uuid>)>(
        "SELECT source.id, source.owner_id, source.google_folder_id, source.local_folder_id \
           FROM google_drive_sources AS source \
           JOIN google_drive_connections AS connection ON connection.id = source.connection_id \
           JOIN users ON users.id = source.owner_id \
          WHERE source.enabled = TRUE \
            AND source.local_folder_id IS NOT NULL \
            AND connection.paused = FALSE \
            AND connection.auth_state = 'active' \
            AND users.disabled_at IS NULL \
            AND NOT EXISTS ( \
                SELECT 1 FROM google_drive_runs AS run \
                 WHERE run.source_id = source.id \
                   AND (run.state IN ('listing', 'downloading') \
                        OR run.created_at > now() - ($1::BIGINT * interval '1 hour')) \
            ) \
          ORDER BY source.created_at \
          LIMIT 1",
    )
    .bind(RESYNC_HOURS)
    .fetch_optional(pool)
    .await?;
    if let Some((source_id, owner_id, google_folder_id, Some(local_folder_id))) = source {
        let mut transaction = pool.begin().await?;
        start_run(
            &mut transaction,
            source_id,
            owner_id,
            &google_folder_id,
            local_folder_id,
        )
        .await?;
        transaction.commit().await?;
    }
    Ok(())
}

#[derive(FromRow)]
struct ListPage {
    id: i64,
    run_id: Uuid,
    source_id: Uuid,
    owner_id: Uuid,
    connection_id: Uuid,
    google_folder_id: String,
    local_folder_id: Option<Uuid>,
    page_token: Option<String>,
}

async fn list_one_page(pool: &PgPool, settings: &GoogleDriveSettings) -> Result<bool, SyncError> {
    let page = sqlx::query_as::<_, ListPage>(
        "SELECT queue.id, queue.run_id, run.source_id, run.owner_id, connection.id AS connection_id, \
                queue.google_folder_id, queue.local_folder_id, queue.page_token \
           FROM google_drive_list_queue AS queue \
           JOIN google_drive_runs AS run ON run.id = queue.run_id \
           JOIN google_drive_sources AS source ON source.id = run.source_id \
           JOIN google_drive_connections AS connection ON connection.id = source.connection_id \
           JOIN users ON users.id = run.owner_id \
          WHERE queue.done = FALSE \
            AND run.state IN ('listing', 'downloading') \
            AND source.enabled = TRUE \
            AND connection.paused = FALSE \
            AND connection.auth_state = 'active' \
            AND users.disabled_at IS NULL \
          ORDER BY queue.id \
          LIMIT 1",
    )
    .fetch_optional(pool)
    .await?;
    let Some(page) = page else {
        return Ok(false);
    };
    let started = Instant::now();
    let token = worker_access_token(pool, settings, page.connection_id, page.owner_id).await?;
    let list = match drive_list(&token, &page.google_folder_id, page.page_token.as_deref()).await {
        Ok(list) => list,
        Err(SyncError::RateLimited) => return Err(SyncError::RateLimited),
        Err(SyncError::Reauth) => {
            clear_access(page.connection_id);
            return Ok(false);
        }
        Err(error) => return Err(error),
    };
    let local_folder = match page.local_folder_id {
        Some(folder) => folder,
        None => return Err(SyncError::Store("parent_missing")),
    };
    for file in list.files.unwrap_or_default() {
        record_remote(pool, &page, local_folder, file).await?;
    }
    let next = list.next_page_token.filter(|token| valid_page_token(token));
    sqlx::query("UPDATE google_drive_list_queue SET page_token = $2, done = $3 WHERE id = $1")
        .bind(page.id)
        .bind(next.as_deref())
        .bind(next.is_none())
        .execute(pool)
        .await?;
    sleep(pace_after(started.elapsed(), false).max(LIST_PAUSE)).await;
    Ok(true)
}

async fn record_remote(
    pool: &PgPool,
    page: &ListPage,
    parent_local_id: Uuid,
    file: RemoteFile,
) -> Result<(), SyncError> {
    let mime = file
        .mime_type
        .unwrap_or_else(|| "application/octet-stream".to_owned());
    if mime == "application/vnd.google-apps.shortcut" {
        let target_id = file
            .shortcut_details
            .as_ref()
            .and_then(|details| details.target_id.clone());
        let target_mime = file
            .shortcut_details
            .as_ref()
            .and_then(|details| details.target_mime_type.clone())
            .unwrap_or_default();
        if let Some(target_id) = target_id.filter(|id| valid_google_id(id)) {
            if target_mime == "application/vnd.google-apps.folder" {
                remember_folder(
                    pool,
                    page,
                    parent_local_id,
                    &target_id,
                    file.name.as_deref().unwrap_or("Folder"),
                )
                .await?;
            } else {
                remember_file(
                    pool,
                    page,
                    parent_local_id,
                    ListedFile {
                        id: &target_id,
                        name: file.name,
                        mime: &target_mime,
                        size: file.size,
                        md5: file.md5_checksum,
                        modified: file.modified_time,
                    },
                )
                .await?;
            }
        }
        return Ok(());
    }
    if mime == "application/vnd.google-apps.folder" && valid_google_id(&file.id) {
        remember_folder(
            pool,
            page,
            parent_local_id,
            &file.id,
            file.name.as_deref().unwrap_or("Folder"),
        )
        .await?;
        return Ok(());
    }
    if valid_google_id(&file.id) {
        remember_file(
            pool,
            page,
            parent_local_id,
            ListedFile {
                id: &file.id,
                name: file.name,
                mime: &mime,
                size: file.size,
                md5: file.md5_checksum,
                modified: file.modified_time,
            },
        )
        .await?;
    }
    Ok(())
}

async fn remember_folder(
    pool: &PgPool,
    page: &ListPage,
    parent_local_id: Uuid,
    google_folder_id: &str,
    name: &str,
) -> Result<(), SyncError> {
    let mut transaction = pool.begin().await?;
    let local_id = ensure_linked_folder(
        &mut transaction,
        page.owner_id,
        Some(parent_local_id),
        google_folder_id,
        name,
    )
    .await?;
    let inserted = sqlx::query(
        "INSERT INTO google_drive_list_queue (run_id, google_folder_id, local_folder_id) \
         VALUES ($1, $2, $3) ON CONFLICT (run_id, google_folder_id) DO NOTHING",
    )
    .bind(page.run_id)
    .bind(google_folder_id)
    .bind(local_id)
    .execute(&mut *transaction)
    .await?;
    if inserted.rows_affected() == 1 {
        sqlx::query(
            "UPDATE google_drive_runs SET discovered_folders = discovered_folders + 1, updated_at = now() \
              WHERE id = $1",
        )
        .bind(page.run_id)
        .execute(&mut *transaction)
        .await?;
    }
    transaction.commit().await?;
    Ok(())
}

struct ListedFile<'a> {
    id: &'a str,
    name: Option<String>,
    mime: &'a str,
    size: Option<String>,
    md5: Option<String>,
    modified: Option<String>,
}

async fn remember_file(
    pool: &PgPool,
    page: &ListPage,
    parent_local_id: Uuid,
    file: ListedFile<'_>,
) -> Result<(), SyncError> {
    let google_file_id = file.id;
    let google_mime = file.mime;
    let name = file.name;
    let size = file.size;
    let md5 = file.md5;
    let modified = file.modified;
    let body = remote_body(google_mime);
    let (state, export_mime, extension, error_code) = match body {
        RemoteBody::SkipNative => ("skipped", None, None, Some("google_native_skipped")),
        RemoteBody::Download => ("pending", None, None, None),
        RemoteBody::Export { mime, extension } => ("pending", Some(mime), Some(extension), None),
    };
    let display_name = storage_entry_name(name.as_deref().unwrap_or("untitled"), 0, extension);
    let class_mime = export_mime.unwrap_or(google_mime);
    let priority = sync_class(class_mime, &display_name).priority();
    let size_bytes = size
        .as_deref()
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|size| *size >= 0);
    let md5_checksum = md5.as_deref().and_then(normalized_md5);
    let modified_at = modified.as_deref().and_then(parse_time);
    let mut transaction = pool.begin().await?;
    let link = sqlx::query_as::<_, (Option<String>, Option<i64>, Option<DateTime<Utc>>)>(
        "SELECT md5_checksum, size_bytes, modified_at FROM google_drive_links \
          WHERE owner_id = $1 AND google_file_id = $2",
    )
    .bind(page.owner_id)
    .bind(google_file_id)
    .fetch_optional(&mut *transaction)
    .await?;
    let skip = state == "pending"
        && link.as_ref().is_some_and(|link| {
            content_unchanged(
                link.0.as_deref(),
                link.1,
                link.2,
                md5_checksum.as_deref(),
                size_bytes,
                modified_at,
            )
        });
    let state = if skip { "skipped" } else { state };
    let error_code = if skip { None } else { error_code };
    let inserted = sqlx::query_scalar::<_, String>(
        "INSERT INTO google_drive_items \
            (id, run_id, source_id, owner_id, google_file_id, parent_local_id, name, google_mime, \
             size_bytes, md5_checksum, modified_at, priority, state, export_mime, error_code) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) \
         ON CONFLICT (run_id, google_file_id) DO NOTHING \
         RETURNING state",
    )
    .bind(Uuid::new_v4())
    .bind(page.run_id)
    .bind(page.source_id)
    .bind(page.owner_id)
    .bind(google_file_id)
    .bind(parent_local_id)
    .bind(&display_name)
    .bind(if (1..=255).contains(&google_mime.len()) {
        google_mime
    } else {
        "application/octet-stream"
    })
    .bind(size_bytes)
    .bind(md5_checksum.as_deref())
    .bind(modified_at)
    .bind(priority)
    .bind(state)
    .bind(export_mime)
    .bind(error_code)
    .fetch_optional(&mut *transaction)
    .await?;
    if let Some(state) = inserted {
        sqlx::query(
            "UPDATE google_drive_runs \
                SET discovered_files = discovered_files + 1, \
                    discovered_bytes = discovered_bytes + COALESCE($2, 0), \
                    skipped_files = skipped_files + CASE WHEN $3 = 'skipped' THEN 1 ELSE 0 END, \
                    updated_at = now() \
              WHERE id = $1",
        )
        .bind(page.run_id)
        .bind(size_bytes)
        .bind(state)
        .execute(&mut *transaction)
        .await?;
    }
    transaction.commit().await?;
    Ok(())
}

async fn finish_runs(pool: &PgPool) -> Result<(), SyncError> {
    sqlx::query(
        "UPDATE google_drive_runs AS run \
            SET state = CASE \
                    WHEN EXISTS (SELECT 1 FROM google_drive_items AS item \
                                  WHERE item.run_id = run.id AND item.state IN ('pending', 'downloading', 'committing')) \
                    THEN 'downloading' ELSE 'completed' END, \
                completed_at = CASE \
                    WHEN EXISTS (SELECT 1 FROM google_drive_items AS item \
                                  WHERE item.run_id = run.id AND item.state IN ('pending', 'downloading', 'committing')) \
                    THEN NULL ELSE now() END, \
                current_name = NULL, \
                throttle_reason = NULL, \
                updated_at = now() \
          WHERE run.state IN ('listing', 'downloading') \
            AND NOT EXISTS (SELECT 1 FROM google_drive_list_queue AS queue \
                             WHERE queue.run_id = run.id AND queue.done = FALSE)",
    )
    .execute(pool)
    .await?;
    Ok(())
}

async fn ensure_import_root(
    transaction: &mut Transaction<'_, Postgres>,
    owner_id: Uuid,
    existing: Option<Uuid>,
) -> Result<Uuid, SyncError> {
    if let Some(existing) = existing {
        let active = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS (SELECT 1 FROM drive_entries \
              WHERE id = $1 AND owner_id = $2 AND kind = 'folder' AND deleted_at IS NULL)",
        )
        .bind(existing)
        .bind(owner_id)
        .fetch_one(&mut **transaction)
        .await?;
        if active {
            return Ok(existing);
        }
    }
    let id = Uuid::new_v4();
    insert_named_entry(transaction, id, owner_id, None, "folder", "Google Drive").await?;
    sqlx::query("INSERT INTO folders (id) VALUES ($1)")
        .bind(id)
        .execute(&mut **transaction)
        .await?;
    Ok(id)
}

async fn ensure_linked_folder(
    transaction: &mut Transaction<'_, Postgres>,
    owner_id: Uuid,
    parent_id: Option<Uuid>,
    google_folder_id: &str,
    name: &str,
) -> Result<Uuid, SyncError> {
    let existing = sqlx::query_scalar::<_, Uuid>(
        "SELECT entry.id \
           FROM google_drive_links AS link \
           JOIN drive_entries AS entry ON entry.id = link.local_entry_id \
          WHERE link.owner_id = $1 AND link.google_file_id = $2 \
            AND entry.kind = 'folder' AND entry.deleted_at IS NULL",
    )
    .bind(owner_id)
    .bind(google_folder_id)
    .fetch_optional(&mut **transaction)
    .await?;
    if let Some(existing) = existing {
        return Ok(existing);
    }
    let id = create_child_folder(transaction, owner_id, parent_id, name).await?;
    sqlx::query(
        "INSERT INTO google_drive_links (owner_id, google_file_id, local_entry_id) \
         VALUES ($1, $2, $3) \
         ON CONFLICT (owner_id, google_file_id) DO UPDATE \
            SET local_entry_id = EXCLUDED.local_entry_id, updated_at = now()",
    )
    .bind(owner_id)
    .bind(google_folder_id)
    .bind(id)
    .execute(&mut **transaction)
    .await?;
    Ok(id)
}

async fn create_child_folder(
    transaction: &mut Transaction<'_, Postgres>,
    owner_id: Uuid,
    parent_id: Option<Uuid>,
    name: &str,
) -> Result<Uuid, SyncError> {
    let id = Uuid::new_v4();
    insert_named_entry(transaction, id, owner_id, parent_id, "folder", name).await?;
    sqlx::query("INSERT INTO folders (id) VALUES ($1)")
        .bind(id)
        .execute(&mut **transaction)
        .await?;
    Ok(id)
}

async fn insert_named_entry(
    transaction: &mut Transaction<'_, Postgres>,
    id: Uuid,
    owner_id: Uuid,
    parent_id: Option<Uuid>,
    kind: &str,
    base_name: &str,
) -> Result<(), SyncError> {
    sqlx::query("SAVEPOINT entry_name")
        .execute(&mut **transaction)
        .await?;
    for attempt in 0..MAX_NAME_ATTEMPTS {
        let name = storage_entry_name(base_name, attempt, None);
        if drive::normalize_name(&name).is_err() {
            continue;
        }
        let inserted = sqlx::query(
            "INSERT INTO drive_entries (id, owner_id, parent_id, kind, name) VALUES ($1, $2, $3, $4, $5)",
        )
        .bind(id)
        .bind(owner_id)
        .bind(parent_id)
        .bind(kind)
        .bind(&name)
        .execute(&mut **transaction)
        .await;
        match inserted {
            Ok(_) => {
                sqlx::query("RELEASE SAVEPOINT entry_name")
                    .execute(&mut **transaction)
                    .await?;
                return Ok(());
            }
            Err(error) if unique_violation(&error) => {
                sqlx::query("ROLLBACK TO SAVEPOINT entry_name")
                    .execute(&mut **transaction)
                    .await?;
            }
            Err(error) => return Err(SyncError::Database(error)),
        }
    }
    Err(SyncError::Store("name_conflict"))
}

fn unique_violation(error: &sqlx::Error) -> bool {
    matches!(error, sqlx::Error::Database(database) if database.code().as_deref() == Some("23505"))
}

async fn worker_access_token(
    pool: &PgPool,
    settings: &GoogleDriveSettings,
    connection_id: Uuid,
    owner_id: Uuid,
) -> Result<String, SyncError> {
    if let Some(token) = cached_access(connection_id) {
        return Ok(token);
    }
    let row = sqlx::query_as::<_, (Vec<u8>, Vec<u8>, String)>(
        "SELECT refresh_nonce, refresh_token, auth_state FROM google_drive_connections WHERE id = $1",
    )
    .bind(connection_id)
    .fetch_optional(pool)
    .await?;
    let Some((nonce, ciphertext, auth_state)) = row else {
        return Err(SyncError::Reauth);
    };
    if auth_state != "active" {
        return Err(SyncError::Reauth);
    }
    let refresh = match open_token(&settings.token_key, owner_id, &nonce, &ciphertext) {
        Ok(refresh) => refresh,
        Err(()) => {
            mark_reauth(pool, connection_id).await?;
            return Err(SyncError::Reauth);
        }
    };
    let refreshed = match refresh_access(settings, &refresh).await {
        Ok(refreshed) => refreshed,
        Err(SyncError::Reauth) => {
            mark_reauth(pool, connection_id).await?;
            return Err(SyncError::Reauth);
        }
        Err(error) => return Err(error),
    };
    store_access(connection_id, refreshed.0.clone(), refreshed.1);
    Ok(refreshed.0)
}

async fn refresh_access(
    settings: &GoogleDriveSettings,
    refresh_token: &str,
) -> Result<(String, u64), SyncError> {
    let body = format!(
        "grant_type=refresh_token&refresh_token={}&client_id={}&client_secret={}",
        percent_encode(refresh_token),
        percent_encode(&settings.client_id),
        percent_encode(&settings.client_secret)
    );
    let response = http_client()
        .post(TOKEN_URL)
        .timeout(Duration::from_secs(20))
        .header("content-type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await?;
    let parsed = response.json::<TokenResponse>().await?;
    if parsed.error.as_deref() == Some("invalid_grant") {
        return Err(SyncError::Reauth);
    }
    let Some(access) = parsed.access_token else {
        return Err(SyncError::Store("download_failed"));
    };
    Ok((access, parsed.expires_in.unwrap_or(3600)))
}

async fn authorized_request(
    pool: &PgPool,
    settings: &GoogleDriveSettings,
    connection_id: Uuid,
    owner_id: Uuid,
    url: &str,
) -> Result<reqwest::Response, SyncError> {
    for attempt in 0..2 {
        let token = worker_access_token(pool, settings, connection_id, owner_id).await?;
        let response = http_client().get(url).bearer_auth(&token).send().await?;
        if response.status().as_u16() == 401 && attempt == 0 {
            clear_access(connection_id);
            continue;
        }
        if response.status().as_u16() == 401 {
            mark_reauth(pool, connection_id).await?;
            return Err(SyncError::Reauth);
        }
        if response.status().as_u16() == 429 {
            return Err(SyncError::RateLimited);
        }
        return Ok(response);
    }
    Err(SyncError::Reauth)
}

async fn mark_reauth(pool: &PgPool, connection_id: Uuid) -> Result<(), SyncError> {
    clear_access(connection_id);
    sqlx::query(
        "UPDATE google_drive_connections SET auth_state = 'reauth_required', updated_at = now() WHERE id = $1",
    )
    .bind(connection_id)
    .execute(pool)
    .await?;
    Ok(())
}

async fn drive_list(
    token: &str,
    parent_id: &str,
    page_token: Option<&str>,
) -> Result<RemoteList, SyncError> {
    let mut url = format!(
        "{DRIVE_FILES_URL}?pageSize=40&spaces=drive&fields={}&q={}",
        percent_encode(LIST_FIELDS),
        percent_encode(&format!("'{parent_id}' in parents and trashed = false"))
    );
    if let Some(page_token) = page_token {
        url.push_str("&pageToken=");
        url.push_str(&percent_encode(page_token));
    }
    let response = http_client()
        .get(url)
        .timeout(Duration::from_secs(30))
        .bearer_auth(token)
        .send()
        .await?;
    if response.status().as_u16() == 429 {
        return Err(SyncError::RateLimited);
    }
    if response.status().as_u16() == 401 {
        return Err(SyncError::Reauth);
    }
    if !response.status().is_success() {
        return Err(SyncError::Store("download_failed"));
    }
    Ok(response.json::<RemoteList>().await?)
}

async fn fetch_remote_metadata(token: &str, id: &str) -> Result<RemoteFile, SyncError> {
    let url = format!(
        "{DRIVE_FILES_URL}/{}?fields=id,name,mimeType",
        percent_encode(id)
    );
    let response = http_client()
        .get(url)
        .timeout(Duration::from_secs(20))
        .bearer_auth(token)
        .send()
        .await?;
    if !response.status().is_success() {
        return Err(SyncError::Missing);
    }
    Ok(response.json::<RemoteFile>().await?)
}

fn valid_page_token(token: &str) -> bool {
    (1..=1024).contains(&token.len()) && !token.chars().any(char::is_control)
}

fn normalized_md5(value: &str) -> Option<String> {
    let value = value.trim().to_ascii_lowercase();
    (value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit())).then_some(value)
}

fn parse_time(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|value| value.with_timezone(&Utc))
}

#[cfg(test)]
mod tests {
    use super::{
        RemoteBody, SyncClass, content_unchanged, indexer_backpressure, open_token, pace_after,
        remote_body, seal_token, storage_entry_name, sync_class, valid_google_id,
    };
    use chrono::{TimeZone, Utc};
    use std::time::Duration;
    use uuid::Uuid;

    #[test]
    fn pacing_keeps_a_low_duty_cycle_and_slows_further_while_indexing() {
        assert_eq!(
            pace_after(Duration::from_millis(0), false),
            Duration::from_millis(40)
        );
        assert_eq!(
            pace_after(Duration::from_millis(100), false),
            Duration::from_millis(355)
        );
        assert_eq!(
            pace_after(Duration::from_millis(100), true),
            Duration::from_millis(1150)
        );
        assert_eq!(
            pace_after(Duration::from_secs(2), false),
            Duration::from_millis(700)
        );
        assert_eq!(
            pace_after(Duration::from_secs(2), true),
            Duration::from_millis(1200)
        );
    }

    #[test]
    fn downloads_wait_for_image_indexing_before_other_work() {
        assert_eq!(indexer_backpressure(2, false, false), Some("image_index"));
        assert_eq!(
            indexer_backpressure(0, true, false),
            Some("indexer_running")
        );
        assert_eq!(indexer_backpressure(5, true, true), None);
        assert_eq!(indexer_backpressure(0, false, false), None);
    }

    #[test]
    fn images_are_queued_ahead_of_videos_and_other_files() {
        assert_eq!(sync_class("image/jpeg", "notes.txt"), SyncClass::Image);
        assert_eq!(
            sync_class("application/octet-stream", "clip.MP4"),
            SyncClass::Video
        );
        assert_eq!(sync_class("application/pdf", "notes.pdf"), SyncClass::Other);
        assert_eq!(SyncClass::Image.priority(), 0);
        assert_eq!(SyncClass::Video.priority(), 1);
        assert!(SyncClass::Image.priority() < SyncClass::Video.priority());
    }

    #[test]
    fn google_native_files_export_or_skip_and_drawings_stay_images() {
        assert!(matches!(
            remote_body("application/vnd.google-apps.document"),
            RemoteBody::Export {
                extension: "docx",
                ..
            }
        ));
        assert!(matches!(
            remote_body("application/vnd.google-apps.drawing"),
            RemoteBody::Export {
                mime: "image/png",
                ..
            }
        ));
        assert_eq!(
            remote_body("application/vnd.google-apps.form"),
            RemoteBody::SkipNative
        );
        assert_eq!(remote_body("image/jpeg"), RemoteBody::Download);
    }

    #[test]
    fn entry_names_are_safe_and_collisions_keep_the_extension() {
        assert_eq!(
            storage_entry_name("  ../album/photo.jpg ", 0, None),
            "photo.jpg"
        );
        assert_eq!(storage_entry_name("photo.jpg", 1, None), "photo (2).jpg");
        assert_eq!(storage_entry_name("budget", 0, Some("xlsx")), "budget.xlsx");
        assert_eq!(storage_entry_name("..", 0, None), "untitled");
        assert!(
            storage_entry_name(&"a".repeat(400), 0, Some("png"))
                .chars()
                .count()
                <= 255
        );
        assert!(!valid_google_id("folder/id"));
        assert!(valid_google_id("root"));
        assert!(valid_google_id("1Ab_c-9"));
    }

    #[test]
    fn unchanged_files_skip_when_the_checksum_or_revision_matches() {
        let modified = Utc.with_ymd_and_hms(2026, 1, 2, 3, 4, 5).single();
        assert!(content_unchanged(
            Some("abc"),
            Some(10),
            modified,
            Some("ABC"),
            Some(11),
            None
        ));
        assert!(!content_unchanged(
            Some("abc"),
            Some(10),
            modified,
            Some("def"),
            Some(10),
            modified
        ));
        assert!(content_unchanged(
            None,
            Some(10),
            modified,
            None,
            Some(10),
            modified
        ));
        assert!(!content_unchanged(None, None, None, None, None, None));
    }

    #[test]
    fn refresh_tokens_round_trip_only_for_the_owning_account() {
        let key = [7_u8; 32];
        let owner = Uuid::new_v4();
        let (nonce, ciphertext) = seal_token(&key, owner, "refresh-token").unwrap();
        assert_eq!(
            open_token(&key, owner, &nonce, &ciphertext).unwrap(),
            "refresh-token"
        );
        assert!(open_token(&key, Uuid::new_v4(), &nonce, &ciphertext).is_err());
        assert!(open_token(&[8_u8; 32], owner, &nonce, &ciphertext).is_err());
    }
}
