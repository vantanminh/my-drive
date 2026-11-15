use std::{env, path::Path, time::Duration};

use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, HeaderValue, StatusCode, header::CACHE_CONTROL},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};
use thiserror::Error;
use tokio::time::{MissedTickBehavior, interval};

use crate::{auth::AuthenticatedUser, config::UpdateSettings, drive, health::AppState};

const WORKER_TICK_SECONDS: u64 = 60;
const AUTO_UPDATE_RETRY_COOLDOWN_HOURS: i64 = 6;
const MIN_CHECK_INTERVAL_MINUTES: i32 = 15;
const MAX_CHECK_INTERVAL_MINUTES: i32 = 10_080;
const MAX_RELEASE_NOTES_CHARS: usize = 4000;
const GITHUB_REQUEST_TIMEOUT_SECONDS: u64 = 15;
const UPDATER_REQUEST_TIMEOUT_SECONDS: u64 = 15;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/admin/updates", get(status))
        .route("/api/admin/updates/settings", patch(update_settings))
        .route("/api/admin/updates/check", post(check_now))
        .route("/api/admin/updates/apply", post(apply_update))
}

#[derive(Debug, Error)]
enum UpdateError {
    #[error("owner permission required")]
    Forbidden,
    #[error("CSRF validation failed")]
    Csrf,
    #[error("invalid request")]
    BadRequest(&'static str),
    #[error("host updater service is not connected")]
    UpdaterUnavailable,
    #[error("an update is already in progress")]
    UpdateInProgress,
    #[error("host updater rejected the request")]
    UpdaterRejected(String),
    #[error("database operation failed")]
    Database(#[source] sqlx::Error),
    #[error("GitHub release check failed")]
    GitHubCheck(String),
}

impl IntoResponse for UpdateError {
    fn into_response(self) -> Response {
        let (status, code, message) = match self {
            Self::Forbidden => (StatusCode::FORBIDDEN, "owner_required", None),
            Self::Csrf => (StatusCode::FORBIDDEN, "csrf_failed", None),
            Self::BadRequest(msg) => (
                StatusCode::BAD_REQUEST,
                "invalid_request",
                Some(msg.to_owned()),
            ),
            Self::UpdaterUnavailable => (
                StatusCode::SERVICE_UNAVAILABLE,
                "updater_unavailable",
                Some("VPS host updater service is not reachable.".to_owned()),
            ),
            Self::UpdateInProgress => (
                StatusCode::CONFLICT,
                "update_in_progress",
                Some("An update is already running on the host.".to_owned()),
            ),
            Self::UpdaterRejected(detail) => {
                (StatusCode::BAD_GATEWAY, "updater_error", Some(detail))
            }
            Self::Database(error) => {
                tracing::error!(error = %error, "system updates database operation failed");
                (StatusCode::SERVICE_UNAVAILABLE, "service_unavailable", None)
            }
            Self::GitHubCheck(detail) => {
                (StatusCode::BAD_GATEWAY, "github_check_failed", Some(detail))
            }
        };
        let mut response = (
            status,
            Json(ErrorBody {
                error: code,
                message,
            }),
        )
            .into_response();
        response
            .headers_mut()
            .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
        response
    }
}

#[derive(Serialize)]
struct ErrorBody {
    error: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CurrentBuildInfo {
    pub version: String,
    pub commit_sha: Option<String>,
    pub build_time: Option<String>,
    pub image: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateAutomationSettings {
    auto_check_enabled: bool,
    auto_update_enabled: bool,
    check_interval_minutes: i32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LatestReleaseSummary {
    tag: Option<String>,
    commit_sha: Option<String>,
    published_at: Option<DateTime<Utc>>,
    url: Option<String>,
    notes: Option<String>,
    update_available: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CheckSummary {
    last_checked_at: Option<DateTime<Utc>>,
    status: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostUpdaterStatus {
    pub connected: bool,
    pub status: String,
    pub phase: Option<String>,
    pub message: Option<String>,
    pub target_tag: Option<String>,
    pub image_track: Option<String>,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
    pub updated_at: Option<DateTime<Utc>>,
}

impl HostUpdaterStatus {
    fn unavailable() -> Self {
        Self {
            connected: false,
            status: "unavailable".to_owned(),
            phase: None,
            message: None,
            target_tag: None,
            image_track: None,
            started_at: None,
            finished_at: None,
            updated_at: None,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdatesStatusResponse {
    current: CurrentBuildInfo,
    github_repo: String,
    settings: UpdateAutomationSettings,
    latest: LatestReleaseSummary,
    check: CheckSummary,
    host_updater: HostUpdaterStatus,
    last_triggered_at: Option<DateTime<Utc>>,
    last_triggered_tag: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateSettingsRequest {
    auto_check_enabled: bool,
    auto_update_enabled: bool,
    check_interval_minutes: i32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApplyUpdateRequest {
    target_tag: Option<String>,
}

#[derive(FromRow)]
struct SystemUpdateRow {
    auto_check_enabled: bool,
    auto_update_enabled: bool,
    check_interval_minutes: i32,
    last_checked_at: Option<DateTime<Utc>>,
    last_check_status: Option<String>,
    last_check_error: Option<String>,
    latest_tag: Option<String>,
    latest_commit_sha: Option<String>,
    latest_published_at: Option<DateTime<Utc>>,
    latest_release_url: Option<String>,
    latest_release_notes: Option<String>,
    last_triggered_at: Option<DateTime<Utc>>,
    last_triggered_tag: Option<String>,
}

pub(crate) fn current_build_info(settings: &UpdateSettings) -> CurrentBuildInfo {
    let version = runtime_or_compile_env("MY_DRIVE_VERSION", option_env!("MY_DRIVE_VERSION"))
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_owned());
    let commit_sha = runtime_or_compile_env("MY_DRIVE_GIT_SHA", option_env!("MY_DRIVE_GIT_SHA"));
    let build_time =
        runtime_or_compile_env("MY_DRIVE_BUILD_TIME", option_env!("MY_DRIVE_BUILD_TIME"));
    CurrentBuildInfo {
        version,
        commit_sha,
        build_time,
        image: settings.current_image.clone(),
    }
}

fn runtime_or_compile_env(name: &str, compile_time: Option<&'static str>) -> Option<String> {
    if let Ok(value) = env::var(name) {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_owned());
        }
    }
    compile_time
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

async fn status(
    State(state): State<AppState>,
    user: AuthenticatedUser,
) -> Result<Response, UpdateError> {
    require_owner(&user)?;
    let row = load_settings_row(&state.pool).await?;
    let host_updater = fetch_host_updater_status(&state.update_settings).await;
    Ok(no_store_json(build_status_response(
        &state.update_settings,
        &row,
        host_updater,
    )))
}

async fn update_settings(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
    Json(request): Json<UpdateSettingsRequest>,
) -> Result<Response, UpdateError> {
    require_owner(&user)?;
    drive::require_request_csrf(&headers, &user, state.auth_settings)
        .map_err(|_| UpdateError::Csrf)?;
    if !(MIN_CHECK_INTERVAL_MINUTES..=MAX_CHECK_INTERVAL_MINUTES)
        .contains(&request.check_interval_minutes)
    {
        return Err(UpdateError::BadRequest(
            "checkIntervalMinutes must be between 15 and 10080",
        ));
    }

    let mut tx = state.pool.begin().await.map_err(UpdateError::Database)?;
    let row = sqlx::query_as::<_, SystemUpdateRow>(
        "UPDATE system_update_settings
            SET auto_check_enabled = $1,
                auto_update_enabled = $2,
                check_interval_minutes = $3,
                updated_at = now()
          WHERE singleton = TRUE
      RETURNING auto_check_enabled, auto_update_enabled, check_interval_minutes,
                last_checked_at, last_check_status, last_check_error,
                latest_tag, latest_commit_sha, latest_published_at,
                latest_release_url, latest_release_notes,
                last_triggered_at, last_triggered_tag",
    )
    .bind(request.auto_check_enabled)
    .bind(request.auto_update_enabled)
    .bind(request.check_interval_minutes)
    .fetch_one(&mut *tx)
    .await
    .map_err(UpdateError::Database)?;

    sqlx::query("INSERT INTO audit_events (event_type, actor_id) VALUES ($1, $2)")
        .bind("system_update_settings_updated")
        .bind(user.id)
        .execute(&mut *tx)
        .await
        .map_err(UpdateError::Database)?;
    tx.commit().await.map_err(UpdateError::Database)?;

    let host_updater = fetch_host_updater_status(&state.update_settings).await;
    Ok(no_store_json(build_status_response(
        &state.update_settings,
        &row,
        host_updater,
    )))
}

async fn check_now(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
) -> Result<Response, UpdateError> {
    require_owner(&user)?;
    drive::require_request_csrf(&headers, &user, state.auth_settings)
        .map_err(|_| UpdateError::Csrf)?;

    let check_result = run_github_check(&state.pool, &state.update_settings).await;
    if let Err(err_msg) = check_result {
        return Err(UpdateError::GitHubCheck(err_msg));
    }
    let row = load_settings_row(&state.pool).await?;
    let host_updater = fetch_host_updater_status(&state.update_settings).await;
    Ok(no_store_json(build_status_response(
        &state.update_settings,
        &row,
        host_updater,
    )))
}

async fn apply_update(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
    request: Option<Json<ApplyUpdateRequest>>,
) -> Result<Response, UpdateError> {
    require_owner(&user)?;
    drive::require_request_csrf(&headers, &user, state.auth_settings)
        .map_err(|_| UpdateError::Csrf)?;

    let row = load_settings_row(&state.pool).await?;
    let requested_tag = match request.and_then(|Json(body)| body.target_tag) {
        Some(raw) => {
            let trimmed = raw.trim().to_owned();
            if trimmed.is_empty() {
                None
            } else {
                if !valid_release_tag(&trimmed) {
                    return Err(UpdateError::BadRequest("invalid release tag format"));
                }
                Some(trimmed)
            }
        }
        None => row.latest_tag.clone().filter(|tag| valid_release_tag(tag)),
    };

    let current_host = fetch_host_updater_status(&state.update_settings).await;
    if !current_host.connected {
        return Err(UpdateError::UpdaterUnavailable);
    }
    if current_host.status == "running" {
        return Err(UpdateError::UpdateInProgress);
    }

    let host_updater = trigger_host_update(
        &state.pool,
        &state.update_settings,
        requested_tag.as_deref(),
        false,
        Some(user.id),
    )
    .await?;
    let updated_row = load_settings_row(&state.pool).await?;
    Ok(no_store_json(build_status_response(
        &state.update_settings,
        &updated_row,
        host_updater,
    )))
}

pub(crate) async fn run_worker(pool: PgPool, settings: UpdateSettings) {
    tokio::time::sleep(Duration::from_secs(30)).await;
    let mut cadence = interval(Duration::from_secs(WORKER_TICK_SECONDS));
    cadence.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        cadence.tick().await;
        if let Err(error) = worker_pass(&pool, &settings).await {
            tracing::warn!(error = %error, "background update worker pass failed");
        }
    }
}

async fn worker_pass(pool: &PgPool, settings: &UpdateSettings) -> Result<(), UpdateError> {
    let mut row = load_settings_row(pool).await?;
    let now = Utc::now();
    if row.auto_check_enabled {
        let interval = chrono::Duration::minutes(i64::from(row.check_interval_minutes));
        let due = row
            .last_checked_at
            .is_none_or(|checked_at| now.signed_duration_since(checked_at) >= interval);
        if due {
            let _ = run_github_check(pool, settings).await;
            row = load_settings_row(pool).await?;
        }
    }

    if !row.auto_update_enabled {
        return Ok(());
    }
    let Some(latest_tag) = row.latest_tag.as_deref() else {
        return Ok(());
    };
    let current = current_build_info(settings);
    if !is_update_available(
        &current.version,
        current.commit_sha.as_deref(),
        Some(latest_tag),
        row.latest_commit_sha.as_deref(),
    ) {
        return Ok(());
    }

    let recently_attempted_same_tag = row.last_triggered_tag.as_deref() == Some(latest_tag)
        && row.last_triggered_at.is_some_and(|triggered_at| {
            now.signed_duration_since(triggered_at)
                < chrono::Duration::hours(AUTO_UPDATE_RETRY_COOLDOWN_HOURS)
        });
    if recently_attempted_same_tag {
        return Ok(());
    }

    let host = fetch_host_updater_status(settings).await;
    if !host.connected || host.status == "running" {
        return Ok(());
    }

    let tag_arg = valid_release_tag(latest_tag).then_some(latest_tag);
    match trigger_host_update(pool, settings, tag_arg, true, None).await {
        Ok(_) => tracing::info!(
            tag = latest_tag,
            "automatic update triggered via host updater"
        ),
        Err(error) => {
            tracing::warn!(error = %error, tag = latest_tag, "automatic update trigger skipped or failed")
        }
    }
    Ok(())
}

async fn trigger_host_update(
    pool: &PgPool,
    settings: &UpdateSettings,
    target_tag: Option<&str>,
    auto: bool,
    actor_id: Option<uuid::Uuid>,
) -> Result<HostUpdaterStatus, UpdateError> {
    let payload = serde_json::json!({
        "targetTag": target_tag,
        "auto": auto,
    });
    let host_updater = send_updater_request(settings, "POST", "/update", Some(payload)).await?;

    let mut tx = pool.begin().await.map_err(UpdateError::Database)?;
    sqlx::query(
        "UPDATE system_update_settings
            SET last_triggered_at = now(),
                last_triggered_tag = COALESCE($1, latest_tag),
                updated_at = now()
          WHERE singleton = TRUE",
    )
    .bind(target_tag)
    .execute(&mut *tx)
    .await
    .map_err(UpdateError::Database)?;

    sqlx::query("INSERT INTO audit_events (event_type, actor_id) VALUES ($1, $2)")
        .bind(if auto {
            "system_auto_update_triggered"
        } else {
            "system_update_triggered"
        })
        .bind(actor_id)
        .execute(&mut *tx)
        .await
        .map_err(UpdateError::Database)?;
    tx.commit().await.map_err(UpdateError::Database)?;

    Ok(host_updater)
}

async fn load_settings_row(pool: &PgPool) -> Result<SystemUpdateRow, UpdateError> {
    sqlx::query_as::<_, SystemUpdateRow>(
        "SELECT auto_check_enabled, auto_update_enabled, check_interval_minutes,
                last_checked_at, last_check_status, last_check_error,
                latest_tag, latest_commit_sha, latest_published_at,
                latest_release_url, latest_release_notes,
                last_triggered_at, last_triggered_tag
           FROM system_update_settings
          WHERE singleton = TRUE",
    )
    .fetch_one(pool)
    .await
    .map_err(UpdateError::Database)
}

fn build_status_response(
    settings: &UpdateSettings,
    row: &SystemUpdateRow,
    host_updater: HostUpdaterStatus,
) -> UpdatesStatusResponse {
    let current = current_build_info(settings);
    let update_available = is_update_available(
        &current.version,
        current.commit_sha.as_deref(),
        row.latest_tag.as_deref(),
        row.latest_commit_sha.as_deref(),
    );
    UpdatesStatusResponse {
        current,
        github_repo: settings.github_repo.clone(),
        settings: UpdateAutomationSettings {
            auto_check_enabled: row.auto_check_enabled,
            auto_update_enabled: row.auto_update_enabled,
            check_interval_minutes: row.check_interval_minutes,
        },
        latest: LatestReleaseSummary {
            tag: row.latest_tag.clone(),
            commit_sha: row.latest_commit_sha.clone(),
            published_at: row.latest_published_at,
            url: row.latest_release_url.clone(),
            notes: row.latest_release_notes.clone(),
            update_available,
        },
        check: CheckSummary {
            last_checked_at: row.last_checked_at,
            status: row.last_check_status.clone(),
            error: row.last_check_error.clone(),
        },
        host_updater,
        last_triggered_at: row.last_triggered_at,
        last_triggered_tag: row.last_triggered_tag.clone(),
    }
}

#[derive(Debug, Clone)]
struct GitHubReleaseInfo {
    tag: String,
    commit_sha: Option<String>,
    published_at: Option<DateTime<Utc>>,
    url: String,
    notes: Option<String>,
}

#[derive(Deserialize)]
struct GitHubLatestReleasePayload {
    tag_name: String,
    target_commitish: Option<String>,
    published_at: Option<DateTime<Utc>>,
    html_url: String,
    body: Option<String>,
}

#[derive(Deserialize)]
struct GitHubTagListItem {
    name: String,
    commit: GitHubTagCommit,
}

#[derive(Deserialize)]
struct GitHubTagCommit {
    sha: String,
}

#[derive(Deserialize)]
struct GitHubRefPayload {
    object: GitHubRefObject,
}

#[derive(Deserialize)]
struct GitHubRefObject {
    #[serde(rename = "type")]
    object_type: String,
    sha: String,
}

async fn run_github_check(pool: &PgPool, settings: &UpdateSettings) -> Result<(), String> {
    match fetch_latest_github_release(settings).await {
        Ok(Some(release)) => {
            sqlx::query(
                "UPDATE system_update_settings
                    SET last_checked_at = now(),
                        last_check_status = 'ok',
                        last_check_error = NULL,
                        latest_tag = $1,
                        latest_commit_sha = $2,
                        latest_published_at = $3,
                        latest_release_url = $4,
                        latest_release_notes = $5,
                        updated_at = now()
                  WHERE singleton = TRUE",
            )
            .bind(&release.tag)
            .bind(&release.commit_sha)
            .bind(release.published_at)
            .bind(&release.url)
            .bind(&release.notes)
            .execute(pool)
            .await
            .map_err(|error| error.to_string())?;
            Ok(())
        }
        Ok(None) => {
            sqlx::query(
                "UPDATE system_update_settings
                    SET last_checked_at = now(),
                        last_check_status = 'ok',
                        last_check_error = NULL,
                        updated_at = now()
                  WHERE singleton = TRUE",
            )
            .execute(pool)
            .await
            .map_err(|error| error.to_string())?;
            Ok(())
        }
        Err(err_msg) => {
            let truncated = truncate_chars(&err_msg, 500);
            let _ = sqlx::query(
                "UPDATE system_update_settings
                    SET last_checked_at = now(),
                        last_check_status = 'error',
                        last_check_error = $1,
                        updated_at = now()
                  WHERE singleton = TRUE",
            )
            .bind(&truncated)
            .execute(pool)
            .await;
            Err(truncated)
        }
    }
}

async fn fetch_latest_github_release(
    settings: &UpdateSettings,
) -> Result<Option<GitHubReleaseInfo>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(GITHUB_REQUEST_TIMEOUT_SECONDS))
        .user_agent(concat!("my-drive/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| format!("failed to build HTTP client: {error}"))?;

    let base = settings.github_api_base_url.trim_end_matches('/');
    let release_url = format!("{base}/repos/{}/releases/latest", settings.github_repo);
    let response = client
        .get(&release_url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|error| format!("GitHub request failed: {error}"))?;

    if response.status() == StatusCode::OK {
        let payload: GitHubLatestReleasePayload = response
            .json()
            .await
            .map_err(|error| format!("invalid GitHub release response: {error}"))?;
        let commit_sha = resolve_tag_commit_sha(
            &client,
            base,
            &settings.github_repo,
            &payload.tag_name,
            payload.target_commitish.as_deref(),
        )
        .await;
        let notes = payload
            .body
            .map(|text| text.trim().to_owned())
            .filter(|text| !text.is_empty())
            .map(|text| truncate_chars(&text, MAX_RELEASE_NOTES_CHARS));
        return Ok(Some(GitHubReleaseInfo {
            tag: payload.tag_name,
            commit_sha,
            published_at: payload.published_at,
            url: payload.html_url,
            notes,
        }));
    }

    if response.status() != StatusCode::NOT_FOUND {
        return Err(format!("GitHub API returned HTTP {}", response.status()));
    }

    // No formal GitHub Release yet; inspect lightweight/annotated Git tags directly.
    let tags_url = format!("{base}/repos/{}/tags?per_page=20", settings.github_repo);
    let tags_response = client
        .get(&tags_url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|error| format!("GitHub tags request failed: {error}"))?;
    if !tags_response.status().is_success() {
        return Err(format!(
            "GitHub tags API returned HTTP {}",
            tags_response.status()
        ));
    }
    let tags: Vec<GitHubTagListItem> = tags_response
        .json()
        .await
        .map_err(|error| format!("invalid GitHub tags response: {error}"))?;
    let selected = tags
        .iter()
        .filter(|tag| parse_semver_tuple(&tag.name).is_some())
        .max_by_key(|tag| parse_semver_tuple(&tag.name))
        .or_else(|| tags.first());

    Ok(selected.map(|tag| GitHubReleaseInfo {
        tag: tag.name.clone(),
        commit_sha: Some(tag.commit.sha.clone()),
        published_at: None,
        url: format!(
            "https://github.com/{}/releases/tag/{}",
            settings.github_repo, tag.name
        ),
        notes: None,
    }))
}

async fn resolve_tag_commit_sha(
    client: &reqwest::Client,
    base: &str,
    repo: &str,
    tag: &str,
    target_commitish: Option<&str>,
) -> Option<String> {
    let encoded_tag = url_encode_segment(tag);
    let ref_url = format!("{base}/repos/{repo}/git/ref/tags/{encoded_tag}");
    if let Ok(resp) = client
        .get(&ref_url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        && resp.status() == StatusCode::OK
        && let Ok(git_ref) = resp.json::<GitHubRefPayload>().await
    {
        if git_ref.object.object_type == "commit" {
            return Some(git_ref.object.sha);
        }
        if git_ref.object.object_type == "tag" {
            let tag_obj_url = format!("{base}/repos/{repo}/git/tags/{}", git_ref.object.sha);
            if let Ok(tag_resp) = client
                .get(&tag_obj_url)
                .header("Accept", "application/vnd.github+json")
                .send()
                .await
                && tag_resp.status() == StatusCode::OK
                && let Ok(peeled) = tag_resp.json::<GitHubRefPayload>().await
            {
                return Some(peeled.object.sha);
            }
        }
    }
    target_commitish
        .map(str::trim)
        .filter(|value| is_hex_sha(value))
        .map(str::to_owned)
}

async fn fetch_host_updater_status(settings: &UpdateSettings) -> HostUpdaterStatus {
    match send_updater_request(settings, "GET", "/status", None).await {
        Ok(status) => status,
        Err(UpdateError::UpdaterUnavailable) => HostUpdaterStatus::unavailable(),
        Err(error) => HostUpdaterStatus {
            connected: false,
            status: "error".to_owned(),
            message: Some(error.to_string()),
            ..HostUpdaterStatus::unavailable()
        },
    }
}

async fn send_updater_request(
    settings: &UpdateSettings,
    method: &str,
    path: &str,
    body: Option<serde_json::Value>,
) -> Result<HostUpdaterStatus, UpdateError> {
    if let Some(base_url) = &settings.updater_url {
        return send_updater_http(
            base_url,
            settings.updater_token.as_deref(),
            method,
            path,
            body,
        )
        .await;
    }
    if let Some(socket_path) = &settings.updater_socket {
        return send_updater_unix(socket_path, method, path, body).await;
    }
    Err(UpdateError::UpdaterUnavailable)
}

async fn send_updater_http(
    base_url: &str,
    token: Option<&str>,
    method: &str,
    path: &str,
    body: Option<serde_json::Value>,
) -> Result<HostUpdaterStatus, UpdateError> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(UPDATER_REQUEST_TIMEOUT_SECONDS))
        .build()
        .map_err(|_| UpdateError::UpdaterUnavailable)?;
    let url = format!("{}{}", base_url.trim_end_matches('/'), path);
    let mut req = match method {
        "GET" => client.get(&url),
        "PUT" => client.put(&url),
        "POST" => client.post(&url),
        _ => return Err(UpdateError::BadRequest("unsupported updater method")),
    };
    if let Some(token) = token {
        req = req.bearer_auth(token);
    }
    if let Some(json_body) = body {
        req = req.json(&json_body);
    }
    let response = req
        .send()
        .await
        .map_err(|_| UpdateError::UpdaterUnavailable)?;
    parse_updater_response(
        response.status(),
        &response.bytes().await.unwrap_or_default(),
    )
}

#[cfg(unix)]
async fn send_updater_unix(
    socket_path: &Path,
    method: &str,
    path: &str,
    body: Option<serde_json::Value>,
) -> Result<HostUpdaterStatus, UpdateError> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::UnixStream;

    let mut stream = tokio::time::timeout(
        Duration::from_secs(UPDATER_REQUEST_TIMEOUT_SECONDS),
        UnixStream::connect(socket_path),
    )
    .await
    .map_err(|_| UpdateError::UpdaterUnavailable)?
    .map_err(|_| UpdateError::UpdaterUnavailable)?;

    let body_bytes = match body {
        Some(value) => serde_json::to_vec(&value)
            .map_err(|_| UpdateError::BadRequest("invalid JSON payload"))?,
        None => Vec::new(),
    };
    let mut request = format!(
        "{method} {path} HTTP/1.1\r\nHost: localhost\r\nAccept: application/json\r\nConnection: close\r\n"
    );
    if !body_bytes.is_empty() || method != "GET" {
        request.push_str("Content-Type: application/json\r\n");
        request.push_str(&format!("Content-Length: {}\r\n", body_bytes.len()));
    }
    request.push_str("\r\n");

    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|_| UpdateError::UpdaterUnavailable)?;
    if !body_bytes.is_empty() {
        stream
            .write_all(&body_bytes)
            .await
            .map_err(|_| UpdateError::UpdaterUnavailable)?;
    }
    stream
        .shutdown()
        .await
        .map_err(|_| UpdateError::UpdaterUnavailable)?;

    let mut raw = Vec::new();
    tokio::time::timeout(
        Duration::from_secs(UPDATER_REQUEST_TIMEOUT_SECONDS),
        stream.take(256 * 1024).read_to_end(&mut raw),
    )
    .await
    .map_err(|_| UpdateError::UpdaterUnavailable)?
    .map_err(|_| UpdateError::UpdaterUnavailable)?;

    let Some(split_pos) = raw.windows(4).position(|window| window == b"\r\n\r\n") else {
        return Err(UpdateError::UpdaterUnavailable);
    };
    let header_text = String::from_utf8_lossy(&raw[..split_pos]);
    let status_code = header_text
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .and_then(|code| StatusCode::from_u16(code).ok())
        .ok_or(UpdateError::UpdaterUnavailable)?;
    let resp_body = &raw[split_pos + 4..];
    parse_updater_response(status_code, resp_body)
}

#[cfg(not(unix))]
async fn send_updater_unix(
    _socket_path: &Path,
    _method: &str,
    _path: &str,
    _body: Option<serde_json::Value>,
) -> Result<HostUpdaterStatus, UpdateError> {
    Err(UpdateError::UpdaterUnavailable)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdaterErrorPayload {
    error: Option<String>,
    message: Option<String>,
}

fn parse_updater_response(
    status: StatusCode,
    body: &[u8],
) -> Result<HostUpdaterStatus, UpdateError> {
    if status.is_success() {
        return serde_json::from_slice::<HostUpdaterStatus>(body).map_err(|error| {
            UpdateError::UpdaterRejected(format!("invalid updater payload: {error}"))
        });
    }
    let parsed = serde_json::from_slice::<UpdaterErrorPayload>(body).ok();
    let code = parsed.as_ref().and_then(|item| item.error.as_deref());
    let detail = parsed
        .as_ref()
        .and_then(|item| item.message.clone())
        .unwrap_or_else(|| format!("host updater returned HTTP {status}"));
    match code {
        Some("update_in_progress") => Err(UpdateError::UpdateInProgress),
        Some("invalid_request") => Err(UpdateError::UpdaterRejected(detail)),
        _ => Err(UpdateError::UpdaterRejected(detail)),
    }
}

pub(crate) fn is_update_available(
    current_version: &str,
    current_sha: Option<&str>,
    latest_tag: Option<&str>,
    latest_sha: Option<&str>,
) -> bool {
    let Some(latest_tag) = latest_tag.map(str::trim).filter(|value| !value.is_empty()) else {
        return false;
    };
    if let (Some(cur_sha), Some(new_sha)) = (
        current_sha.map(str::trim).filter(|value| is_hex_sha(value)),
        latest_sha.map(str::trim).filter(|value| is_hex_sha(value)),
    ) && same_commit_sha(cur_sha, new_sha)
    {
        return false;
    }
    if let (Some(cur_ver), Some(new_ver)) = (
        parse_semver_tuple(current_version),
        parse_semver_tuple(latest_tag),
    ) {
        return new_ver > cur_ver;
    }
    normalize_version(current_version) != normalize_version(latest_tag)
}

fn parse_semver_tuple(raw: &str) -> Option<(u64, u64, u64)> {
    let stripped = raw.trim().strip_prefix('v').unwrap_or(raw.trim());
    let base = stripped.split(['-', '+']).next()?;
    let mut parts = base.split('.');
    let major = parts.next()?.parse::<u64>().ok()?;
    let minor = parts.next()?.parse::<u64>().ok()?;
    let patch = parts.next()?.parse::<u64>().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

fn normalize_version(raw: &str) -> String {
    raw.trim()
        .strip_prefix('v')
        .unwrap_or(raw.trim())
        .to_ascii_lowercase()
}

fn is_hex_sha(value: &str) -> bool {
    (7..=64).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn same_commit_sha(left: &str, right: &str) -> bool {
    let left_low = left.to_ascii_lowercase();
    let right_low = right.to_ascii_lowercase();
    left_low == right_low || left_low.starts_with(&right_low) || right_low.starts_with(&left_low)
}

fn valid_release_tag(tag: &str) -> bool {
    !tag.is_empty()
        && tag.len() <= 64
        && tag.starts_with('v')
        && parse_semver_tuple(tag).is_some()
        && tag
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_owned();
    }
    let mut out: String = text.chars().take(max_chars).collect();
    out.push('…');
    out
}

fn url_encode_segment(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn require_owner(user: &AuthenticatedUser) -> Result<(), UpdateError> {
    if user.role != "owner" {
        return Err(UpdateError::Forbidden);
    }
    Ok(())
}

fn no_store_json<T: Serialize>(body: T) -> Response {
    let mut response = Json(body).into_response();
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Router,
        routing::{get, post},
    };
    use tokio::net::TcpListener;

    #[test]
    fn compares_versions_and_commit_shas_accurately() {
        assert!(!is_update_available(
            "v0.1.2",
            Some("abc1234def5678"),
            Some("v0.1.3"),
            Some("abc1234def5678")
        ));
        assert!(is_update_available(
            "v0.1.2",
            Some("abc1234"),
            Some("v0.1.3"),
            Some("def9999")
        ));
        assert!(is_update_available("0.1.0", None, Some("v0.1.1"), None));
        assert!(!is_update_available("v0.2.0", None, Some("v0.1.9"), None));
        assert!(!is_update_available("v0.1.2", None, Some("v0.1.2"), None));
        assert!(!is_update_available("0.1.0", None, None, None));
    }

    #[test]
    fn validates_release_tag_format() {
        assert!(valid_release_tag("v0.1.0"));
        assert!(valid_release_tag("v1.2.3-rc1"));
        assert!(!valid_release_tag("latest"));
        assert!(!valid_release_tag("v1.2/../../bad"));
    }

    #[tokio::test]
    async fn fetches_latest_github_release_and_fallback_tags_from_mock_api() {
        let app = Router::new()
            .route(
                "/repos/owner/repo/releases/latest",
                get(|| async {
                    Json(serde_json::json!({
                        "tag_name": "v0.1.5",
                        "target_commitish": "master",
                        "published_at": "2026-11-14T10:00:00Z",
                        "html_url": "https://github.com/owner/repo/releases/tag/v0.1.5",
                        "body": "Added dashboard self-update."
                    }))
                }),
            )
            .route(
                "/repos/owner/repo/git/ref/tags/v0.1.5",
                get(|| async {
                    Json(serde_json::json!({
                        "object": { "type": "commit", "sha": "0123456789abcdef0123456789abcdef01234567" }
                    }))
                }),
            )
            .route(
                "/repos/owner/tags-only/releases/latest",
                get(|| async { StatusCode::NOT_FOUND }),
            )
            .route(
                "/repos/owner/tags-only/tags",
                get(|| async {
                    Json(serde_json::json!([
                        { "name": "v0.1.2", "commit": { "sha": "aaaaaaa1111111" } },
                        { "name": "v0.1.4", "commit": { "sha": "bbbbbbb2222222" } }
                    ]))
                }),
            );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let release = fetch_latest_github_release(&UpdateSettings {
            github_repo: "owner/repo".to_owned(),
            github_api_base_url: format!("http://{addr}"),
            ..Default::default()
        })
        .await
        .expect("release fetch succeeds")
        .expect("release exists");
        assert_eq!(release.tag, "v0.1.5");
        assert_eq!(
            release.commit_sha.as_deref(),
            Some("0123456789abcdef0123456789abcdef01234567")
        );
        assert_eq!(
            release.notes.as_deref(),
            Some("Added dashboard self-update.")
        );

        let fallback = fetch_latest_github_release(&UpdateSettings {
            github_repo: "owner/tags-only".to_owned(),
            github_api_base_url: format!("http://{addr}"),
            ..Default::default()
        })
        .await
        .expect("tag fallback succeeds")
        .expect("tag selected");
        assert_eq!(fallback.tag, "v0.1.4");
        assert_eq!(fallback.commit_sha.as_deref(), Some("bbbbbbb2222222"));
    }

    #[tokio::test]
    async fn talks_to_http_host_updater_bridge() {
        let app = Router::new()
            .route(
                "/status",
                get(|| async {
                    Json(serde_json::json!({
                        "connected": true,
                        "status": "idle",
                        "phase": null,
                        "message": null,
                        "targetTag": null,
                        "imageTrack": "ghcr.io/vantanminh/my-drive:latest"
                    }))
                }),
            )
            .route(
                "/update",
                post(|| async {
                    (
                        StatusCode::ACCEPTED,
                        Json(serde_json::json!({
                            "connected": true,
                            "status": "running",
                            "phase": "pulling",
                            "message": "Pulling container images",
                            "targetTag": "v0.1.5"
                        })),
                    )
                }),
            );

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let settings = UpdateSettings {
            updater_url: Some(format!("http://{addr}")),
            ..Default::default()
        };
        let initial = fetch_host_updater_status(&settings).await;
        assert!(initial.connected);
        assert_eq!(initial.status, "idle");

        let running = send_updater_request(
            &settings,
            "POST",
            "/update",
            Some(serde_json::json!({ "targetTag": "v0.1.5", "auto": false })),
        )
        .await
        .expect("trigger update");
        assert_eq!(running.status, "running");
        assert_eq!(running.target_tag.as_deref(), Some("v0.1.5"));
    }
}
