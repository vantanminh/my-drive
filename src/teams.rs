use axum::{
    Json, Router,
    body::Body,
    extract::{FromRequestParts, Path, State},
    http::{HeaderMap, HeaderValue, Request, StatusCode, header::CACHE_CONTROL},
    middleware::Next,
    response::{IntoResponse, Response},
    routing::{get, patch, post},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use thiserror::Error;
use uuid::Uuid;

use crate::{
    auth::{self, AuthenticatedUser},
    health::AppState,
};

const MAX_TEAM_NAME_CHARS: usize = 80;
const MAX_TEAM_DESCRIPTION_CHARS: usize = 500;
const MAX_TEAM_QUOTA_BYTES: u64 = 8_000_000_000_000_000;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/teams", get(list_teams).post(create_team))
        .route(
            "/api/teams/{id}",
            get(get_team).patch(update_team).delete(delete_team),
        )
        .route("/api/teams/{id}/members", post(add_member))
        .route(
            "/api/teams/{id}/members/{user_id}",
            patch(update_member).delete(remove_member),
        )
}

#[derive(Debug, Error)]
enum TeamError {
    #[error("permission denied")]
    Forbidden,
    #[error("owner permission required")]
    OwnerRequired,
    #[error("CSRF validation failed")]
    Csrf,
    #[error("invalid request")]
    BadRequest(&'static str),
    #[error("team or member was not found")]
    NotFound,
    #[error("team conflict")]
    Conflict(&'static str),
    #[error("database operation failed")]
    Database(#[source] sqlx::Error),
}

impl IntoResponse for TeamError {
    fn into_response(self) -> Response {
        let (status, code) = match self {
            Self::Forbidden => (StatusCode::FORBIDDEN, "forbidden"),
            Self::OwnerRequired => (StatusCode::FORBIDDEN, "owner_required"),
            Self::Csrf => (StatusCode::FORBIDDEN, "csrf_failed"),
            Self::BadRequest(code) => (StatusCode::BAD_REQUEST, code),
            Self::NotFound => (StatusCode::NOT_FOUND, "not_found"),
            Self::Conflict(code) => (StatusCode::CONFLICT, code),
            Self::Database(error) => {
                tracing::error!(error = %error, "team operation database query failed");
                (StatusCode::SERVICE_UNAVAILABLE, "service_unavailable")
            }
        };
        let mut response = (status, Json(ErrorBody { error: code })).into_response();
        response
            .headers_mut()
            .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
        response
    }
}

#[derive(Serialize)]
struct ErrorBody {
    error: &'static str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateTeamRequest {
    name: String,
    #[serde(default)]
    description: String,
    quota_bytes: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateTeamRequest {
    name: Option<String>,
    description: Option<String>,
    quota_bytes: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AddMemberRequest {
    user_id: Option<Uuid>,
    email: Option<String>,
    role: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateMemberRequest {
    role: String,
}

#[derive(FromRow)]
struct TeamRow {
    id: Uuid,
    name: String,
    slug: String,
    description: String,
    quota_bytes: i64,
    used_bytes: i64,
    reserved_bytes: i64,
    member_count: i64,
    my_role: String,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TeamSummary {
    id: Uuid,
    name: String,
    slug: String,
    description: String,
    quota_bytes: i64,
    used_bytes: i64,
    reserved_bytes: i64,
    member_count: i64,
    my_role: String,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

impl From<TeamRow> for TeamSummary {
    fn from(row: TeamRow) -> Self {
        Self {
            id: row.id,
            name: row.name,
            slug: row.slug,
            description: row.description,
            quota_bytes: row.quota_bytes,
            used_bytes: row.used_bytes,
            reserved_bytes: row.reserved_bytes,
            member_count: row.member_count,
            my_role: row.my_role,
            created_at: row.created_at,
            updated_at: row.updated_at,
        }
    }
}

#[derive(FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
struct TeamMemberSummary {
    user_id: Uuid,
    email: String,
    account_role: String,
    role: String,
    disabled_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TeamsResponse {
    teams: Vec<TeamSummary>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TeamDetailResponse {
    team: TeamSummary,
    members: Vec<TeamMemberSummary>,
}

pub(crate) fn slugify_team_name(name: &str) -> String {
    let mut slug = String::new();
    let mut last_dash = false;
    for ch in name.trim().chars() {
        let lower = ch.to_ascii_lowercase();
        if lower.is_ascii_alphanumeric() {
            slug.push(lower);
            last_dash = false;
        } else if !last_dash && !slug.is_empty() {
            slug.push('-');
            last_dash = true;
        }
    }
    let trimmed = slug.trim_matches('-');
    if trimmed.is_empty() {
        "team".to_owned()
    } else {
        trimmed.chars().take(48).collect()
    }
}

pub(crate) fn parse_team_member_role(raw: &str) -> Option<&'static str> {
    match raw.trim() {
        "admin" => Some("admin"),
        "member" => Some("member"),
        _ => None,
    }
}

fn team_query_param(query: Option<&str>) -> Option<&str> {
    let query = query?;
    for pair in query.split('&') {
        if let Some(value) = pair.strip_prefix("team_id=")
            && !value.is_empty()
        {
            return Some(value);
        }
    }
    None
}

pub(crate) fn extract_team_id_hint(headers: &HeaderMap, query: Option<&str>) -> Option<String> {
    if let Some(value) = headers
        .get("x-mydrive-team")
        .and_then(|value| value.to_str().ok())
    {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_owned());
        }
    }
    team_query_param(query).map(str::to_owned)
}

fn path_supports_team_workspace(path: &str) -> bool {
    path.starts_with("/api/drive")
        || path.starts_with("/api/folders")
        || path.starts_with("/api/entries")
        || path.starts_with("/api/uploads")
        || path.starts_with("/api/files")
        || path == "/api/storage"
}

pub(crate) async fn scope_team_workspace(
    State(state): State<AppState>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let (mut parts, body) = request.into_parts();
    let Some(raw_team_id) = extract_team_id_hint(&parts.headers, parts.uri.query()) else {
        return next.run(Request::from_parts(parts, body)).await;
    };

    if !path_supports_team_workspace(parts.uri.path()) {
        return TeamError::Forbidden.into_response();
    }

    let Ok(team_id) = Uuid::parse_str(&raw_team_id) else {
        return TeamError::BadRequest("invalid_team_id").into_response();
    };

    let user = match AuthenticatedUser::from_request_parts(&mut parts, &state).await {
        Ok(user) => user,
        Err(response) => return response,
    };

    if user.device_id.is_some() || user.api_key_id.is_some() {
        return TeamError::Forbidden.into_response();
    }

    let workspace_user_id: Option<Uuid> = match sqlx::query_scalar(
        "SELECT t.workspace_user_id \
           FROM teams AS t \
           LEFT JOIN team_members AS tm \
             ON tm.team_id = t.id AND tm.user_id = $2 \
          WHERE t.id = $1 AND ($3 OR tm.user_id IS NOT NULL)",
    )
    .bind(team_id)
    .bind(user.id)
    .bind(user.role == "owner")
    .fetch_optional(&state.pool)
    .await
    {
        Ok(id) => id,
        Err(error) => return TeamError::Database(error).into_response(),
    };

    let Some(workspace_user_id) = workspace_user_id else {
        return TeamError::Forbidden.into_response();
    };

    let mut scoped_user = user;
    scoped_user.id = workspace_user_id;
    scoped_user.role = "member".to_owned();
    parts.extensions.insert(scoped_user);

    next.run(Request::from_parts(parts, body)).await
}

fn ensure_personal_session(user: &AuthenticatedUser) -> Result<(), TeamError> {
    if user.device_id.is_some() || user.api_key_id.is_some() {
        return Err(TeamError::Forbidden);
    }
    Ok(())
}

fn require_csrf(
    headers: &HeaderMap,
    user: &AuthenticatedUser,
    settings: auth::AuthSettings,
) -> Result<(), TeamError> {
    if auth::require_csrf(headers, user, settings) {
        Ok(())
    } else {
        Err(TeamError::Csrf)
    }
}

fn no_store(response: impl IntoResponse) -> Response {
    let mut response = response.into_response();
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn validate_team_name(raw: &str) -> Result<String, TeamError> {
    let trimmed = raw.trim();
    let len = trimmed.chars().count();
    if len == 0 || len > MAX_TEAM_NAME_CHARS {
        return Err(TeamError::BadRequest("invalid_team_name"));
    }
    Ok(trimmed.to_owned())
}

fn validate_team_description(raw: &str) -> Result<String, TeamError> {
    let trimmed = raw.trim();
    if trimmed.chars().count() > MAX_TEAM_DESCRIPTION_CHARS {
        return Err(TeamError::BadRequest("invalid_team_description"));
    }
    Ok(trimmed.to_owned())
}

async fn fetch_team_summary(
    pool: &sqlx::PgPool,
    team_id: Uuid,
    user: &AuthenticatedUser,
) -> Result<Option<TeamRow>, TeamError> {
    sqlx::query_as::<_, TeamRow>(
        "SELECT t.id, t.name, t.slug, t.description, t.quota_bytes, t.created_at, t.updated_at, \
                CASE WHEN $3 THEN 'owner' ELSE tm.role END AS my_role, \
                (SELECT COUNT(*)::BIGINT FROM team_members WHERE team_id = t.id) AS member_count, \
                (SELECT COALESCE(SUM(version.size_bytes), 0)::BIGINT \
                   FROM drive_entries AS entry \
                   JOIN files AS file ON file.id = entry.id \
                   JOIN file_versions AS version ON version.id = file.current_version_id \
                   JOIN storage_objects AS object ON object.id = version.storage_object_id \
                        AND object.state = 'ready' \
                  WHERE entry.owner_id = t.workspace_user_id) AS used_bytes, \
                (SELECT COALESCE(SUM(expected_size), 0)::BIGINT \
                   FROM upload_sessions \
                  WHERE owner_id = t.workspace_user_id \
                    AND (state = 'finalizing' OR (state = 'active' AND expires_at > now()))) AS reserved_bytes \
           FROM teams AS t \
           LEFT JOIN team_members AS tm ON tm.team_id = t.id AND tm.user_id = $2 \
          WHERE t.id = $1 AND ($3 OR tm.user_id IS NOT NULL)",
    )
    .bind(team_id)
    .bind(user.id)
    .bind(user.role == "owner")
    .fetch_optional(pool)
    .await
    .map_err(TeamError::Database)
}

async fn require_team_manager(
    pool: &sqlx::PgPool,
    team_id: Uuid,
    user: &AuthenticatedUser,
) -> Result<Uuid, TeamError> {
    let row: Option<(Uuid, Option<String>)> = sqlx::query_as(
        "SELECT t.workspace_user_id, tm.role \
           FROM teams AS t \
           LEFT JOIN team_members AS tm ON tm.team_id = t.id AND tm.user_id = $2 \
          WHERE t.id = $1",
    )
    .bind(team_id)
    .bind(user.id)
    .fetch_optional(pool)
    .await
    .map_err(TeamError::Database)?;

    let Some((workspace_user_id, member_role)) = row else {
        return Err(TeamError::NotFound);
    };
    if user.role == "owner" || member_role.as_deref() == Some("admin") {
        Ok(workspace_user_id)
    } else {
        Err(TeamError::Forbidden)
    }
}

async fn list_teams(
    State(state): State<AppState>,
    user: AuthenticatedUser,
) -> Result<Response, TeamError> {
    ensure_personal_session(&user)?;
    let rows = sqlx::query_as::<_, TeamRow>(
        "SELECT t.id, t.name, t.slug, t.description, t.quota_bytes, t.created_at, t.updated_at, \
                CASE WHEN $2 THEN COALESCE(tm.role, 'owner') ELSE tm.role END AS my_role, \
                (SELECT COUNT(*)::BIGINT FROM team_members WHERE team_id = t.id) AS member_count, \
                (SELECT COALESCE(SUM(version.size_bytes), 0)::BIGINT \
                   FROM drive_entries AS entry \
                   JOIN files AS file ON file.id = entry.id \
                   JOIN file_versions AS version ON version.id = file.current_version_id \
                   JOIN storage_objects AS object ON object.id = version.storage_object_id \
                        AND object.state = 'ready' \
                  WHERE entry.owner_id = t.workspace_user_id) AS used_bytes, \
                (SELECT COALESCE(SUM(expected_size), 0)::BIGINT \
                   FROM upload_sessions \
                  WHERE owner_id = t.workspace_user_id \
                    AND (state = 'finalizing' OR (state = 'active' AND expires_at > now()))) AS reserved_bytes \
           FROM teams AS t \
           LEFT JOIN team_members AS tm ON tm.team_id = t.id AND tm.user_id = $1 \
          WHERE ($2 OR tm.user_id IS NOT NULL) \
          ORDER BY lower(t.name) ASC, t.created_at DESC",
    )
    .bind(user.id)
    .bind(user.role == "owner")
    .fetch_all(&state.pool)
    .await
    .map_err(TeamError::Database)?;

    let teams = rows.into_iter().map(TeamSummary::from).collect();
    Ok(no_store(Json(TeamsResponse { teams })))
}

async fn create_team(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
    Json(request): Json<CreateTeamRequest>,
) -> Result<Response, TeamError> {
    ensure_personal_session(&user)?;
    if user.role != "owner" {
        return Err(TeamError::OwnerRequired);
    }
    require_csrf(&headers, &user, state.auth_settings)?;
    let name = validate_team_name(&request.name)?;
    let description = validate_team_description(&request.description)?;
    if request.quota_bytes > MAX_TEAM_QUOTA_BYTES {
        return Err(TeamError::BadRequest("invalid_quota"));
    }
    let quota_bytes =
        i64::try_from(request.quota_bytes).map_err(|_| TeamError::BadRequest("invalid_quota"))?;

    let team_id = Uuid::new_v4();
    let workspace_user_id = Uuid::new_v4();
    let short_suffix = &team_id.simple().to_string()[..6];
    let slug = format!("{}-{short_suffix}", slugify_team_name(&name));
    let service_email = format!("team-workspace+{}@system.local", team_id.simple());

    let mut transaction = state.pool.begin().await.map_err(TeamError::Database)?;
    sqlx::query(
        "INSERT INTO users (id, email, password_hash, role, managed_by, quota_bytes, must_change_password, is_workspace_service) \
         VALUES ($1, $2, '!', 'member', $3, $4, FALSE, TRUE)",
    )
    .bind(workspace_user_id)
    .bind(service_email)
    .bind(user.id)
    .bind(quota_bytes)
    .execute(&mut *transaction)
    .await
    .map_err(TeamError::Database)?;

    sqlx::query(
        "INSERT INTO teams (id, name, slug, description, quota_bytes, workspace_user_id, created_by) \
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(team_id)
    .bind(&name)
    .bind(&slug)
    .bind(&description)
    .bind(quota_bytes)
    .bind(workspace_user_id)
    .bind(user.id)
    .execute(&mut *transaction)
    .await
    .map_err(TeamError::Database)?;

    sqlx::query(
        "INSERT INTO team_members (team_id, user_id, role, added_by) \
         VALUES ($1, $2, 'admin', $2)",
    )
    .bind(team_id)
    .bind(user.id)
    .execute(&mut *transaction)
    .await
    .map_err(TeamError::Database)?;

    sqlx::query(
        "INSERT INTO audit_events (event_type, actor_id, resource_id, details) \
         VALUES ('team_created', $1, $2, jsonb_build_object('name', $3, 'quota_bytes', $4))",
    )
    .bind(user.id)
    .bind(team_id)
    .bind(&name)
    .bind(quota_bytes)
    .execute(&mut *transaction)
    .await
    .map_err(TeamError::Database)?;

    transaction.commit().await.map_err(TeamError::Database)?;

    let team = fetch_team_summary(&state.pool, team_id, &user)
        .await?
        .map(TeamSummary::from)
        .ok_or(TeamError::NotFound)?;

    Ok(no_store((StatusCode::CREATED, Json(team))))
}

async fn get_team(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Path(team_id): Path<Uuid>,
) -> Result<Response, TeamError> {
    ensure_personal_session(&user)?;
    let team = fetch_team_summary(&state.pool, team_id, &user)
        .await?
        .map(TeamSummary::from)
        .ok_or(TeamError::NotFound)?;
    let members = sqlx::query_as::<_, TeamMemberSummary>(
        "SELECT u.id AS user_id, u.email, u.role AS account_role, tm.role, u.disabled_at, tm.created_at \
           FROM team_members AS tm \
           JOIN users AS u ON u.id = tm.user_id \
          WHERE tm.team_id = $1 AND u.is_workspace_service = FALSE \
          ORDER BY (tm.role = 'admin') DESC, lower(u.email) ASC",
    )
    .bind(team_id)
    .fetch_all(&state.pool)
    .await
    .map_err(TeamError::Database)?;

    Ok(no_store(Json(TeamDetailResponse { team, members })))
}

async fn update_team(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
    Path(team_id): Path<Uuid>,
    Json(request): Json<UpdateTeamRequest>,
) -> Result<Response, TeamError> {
    ensure_personal_session(&user)?;
    require_csrf(&headers, &user, state.auth_settings)?;
    if request.name.is_none() && request.description.is_none() && request.quota_bytes.is_none() {
        return Err(TeamError::BadRequest("empty_update"));
    }
    if request.quota_bytes.is_some() && user.role != "owner" {
        return Err(TeamError::OwnerRequired);
    }
    let workspace_user_id = require_team_manager(&state.pool, team_id, &user).await?;
    let name = request
        .name
        .as_deref()
        .map(validate_team_name)
        .transpose()?;
    let description = request
        .description
        .as_deref()
        .map(validate_team_description)
        .transpose()?;
    let quota_bytes = request
        .quota_bytes
        .map(|quota| {
            if quota > MAX_TEAM_QUOTA_BYTES {
                return Err(TeamError::BadRequest("invalid_quota"));
            }
            i64::try_from(quota).map_err(|_| TeamError::BadRequest("invalid_quota"))
        })
        .transpose()?;

    let mut transaction = state.pool.begin().await.map_err(TeamError::Database)?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))")
        .bind(workspace_user_id)
        .execute(&mut *transaction)
        .await
        .map_err(TeamError::Database)?;

    if let Some(quota_bytes) = quota_bytes {
        let (used_bytes, reserved_bytes): (i64, i64) = sqlx::query_as(
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
        .bind(workspace_user_id)
        .fetch_one(&mut *transaction)
        .await
        .map_err(TeamError::Database)?;

        if i128::from(used_bytes.max(0)) + i128::from(reserved_bytes.max(0))
            > i128::from(quota_bytes)
        {
            return Err(TeamError::Conflict("quota_below_current_usage"));
        }

        sqlx::query("UPDATE users SET quota_bytes = $2, updated_at = now() WHERE id = $1")
            .bind(workspace_user_id)
            .bind(quota_bytes)
            .execute(&mut *transaction)
            .await
            .map_err(TeamError::Database)?;
    }

    sqlx::query(
        "UPDATE teams \
            SET name = COALESCE($2, name), \
                description = COALESCE($3, description), \
                quota_bytes = COALESCE($4, quota_bytes), \
                updated_at = now() \
          WHERE id = $1",
    )
    .bind(team_id)
    .bind(name.as_deref())
    .bind(description.as_deref())
    .bind(quota_bytes)
    .execute(&mut *transaction)
    .await
    .map_err(TeamError::Database)?;

    sqlx::query(
        "INSERT INTO audit_events (event_type, actor_id, resource_id, details) \
         VALUES ('team_updated', $1, $2, jsonb_build_object('quota_bytes', $3))",
    )
    .bind(user.id)
    .bind(team_id)
    .bind(quota_bytes)
    .execute(&mut *transaction)
    .await
    .map_err(TeamError::Database)?;

    transaction.commit().await.map_err(TeamError::Database)?;
    let updated = fetch_team_summary(&state.pool, team_id, &user)
        .await?
        .map(TeamSummary::from)
        .ok_or(TeamError::NotFound)?;
    Ok(no_store(Json(updated)))
}

async fn delete_team(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
    Path(team_id): Path<Uuid>,
) -> Result<Response, TeamError> {
    ensure_personal_session(&user)?;
    if user.role != "owner" {
        return Err(TeamError::OwnerRequired);
    }
    require_csrf(&headers, &user, state.auth_settings)?;

    let mut transaction = state.pool.begin().await.map_err(TeamError::Database)?;
    let workspace_user_id: Option<Uuid> =
        sqlx::query_scalar("SELECT workspace_user_id FROM teams WHERE id = $1 FOR UPDATE")
            .bind(team_id)
            .fetch_optional(&mut *transaction)
            .await
            .map_err(TeamError::Database)?;
    let workspace_user_id = workspace_user_id.ok_or(TeamError::NotFound)?;

    let has_files: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM drive_entries WHERE owner_id = $1 AND kind = 'file')",
    )
    .bind(workspace_user_id)
    .fetch_one(&mut *transaction)
    .await
    .map_err(TeamError::Database)?;
    if has_files {
        return Err(TeamError::Conflict("team_has_files"));
    }

    sqlx::query("DELETE FROM upload_sessions WHERE owner_id = $1")
        .bind(workspace_user_id)
        .execute(&mut *transaction)
        .await
        .map_err(TeamError::Database)?;
    sqlx::query("DELETE FROM shares WHERE owner_id = $1")
        .bind(workspace_user_id)
        .execute(&mut *transaction)
        .await
        .map_err(TeamError::Database)?;
    sqlx::query(
        "DELETE FROM folders WHERE id IN (SELECT id FROM drive_entries WHERE owner_id = $1)",
    )
    .bind(workspace_user_id)
    .execute(&mut *transaction)
    .await
    .map_err(TeamError::Database)?;
    sqlx::query("UPDATE drive_entries SET parent_id = NULL WHERE owner_id = $1")
        .bind(workspace_user_id)
        .execute(&mut *transaction)
        .await
        .map_err(TeamError::Database)?;
    sqlx::query("DELETE FROM drive_entries WHERE owner_id = $1")
        .bind(workspace_user_id)
        .execute(&mut *transaction)
        .await
        .map_err(TeamError::Database)?;

    sqlx::query("DELETE FROM teams WHERE id = $1")
        .bind(team_id)
        .execute(&mut *transaction)
        .await
        .map_err(TeamError::Database)?;
    sqlx::query("DELETE FROM users WHERE id = $1 AND is_workspace_service = TRUE")
        .bind(workspace_user_id)
        .execute(&mut *transaction)
        .await
        .map_err(TeamError::Database)?;

    sqlx::query(
        "INSERT INTO audit_events (event_type, actor_id, resource_id) VALUES ('team_deleted', $1, $2)",
    )
    .bind(user.id)
    .bind(team_id)
    .execute(&mut *transaction)
    .await
    .map_err(TeamError::Database)?;

    transaction.commit().await.map_err(TeamError::Database)?;
    Ok(no_store(StatusCode::NO_CONTENT))
}

async fn add_member(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
    Path(team_id): Path<Uuid>,
    Json(request): Json<AddMemberRequest>,
) -> Result<Response, TeamError> {
    ensure_personal_session(&user)?;
    require_csrf(&headers, &user, state.auth_settings)?;
    require_team_manager(&state.pool, team_id, &user).await?;

    let member_role = request
        .role
        .as_deref()
        .map(|raw| parse_team_member_role(raw).ok_or(TeamError::BadRequest("invalid_role")))
        .transpose()?
        .unwrap_or("member");

    let target_user_id: Option<Uuid> = if let Some(user_id) = request.user_id {
        sqlx::query_scalar(
            "SELECT id FROM users WHERE id = $1 AND disabled_at IS NULL AND is_workspace_service = FALSE",
        )
        .bind(user_id)
        .fetch_optional(&state.pool)
        .await
        .map_err(TeamError::Database)?
    } else if let Some(email) = request.email.as_deref() {
        let email = email.trim().to_lowercase();
        if !auth::valid_email(&email) {
            return Err(TeamError::BadRequest("invalid_email"));
        }
        sqlx::query_scalar(
            "SELECT id FROM users WHERE lower(email) = $1 AND disabled_at IS NULL AND is_workspace_service = FALSE",
        )
        .bind(email)
        .fetch_optional(&state.pool)
        .await
        .map_err(TeamError::Database)?
    } else {
        return Err(TeamError::BadRequest("target_user_required"));
    };

    let target_user_id = target_user_id.ok_or(TeamError::NotFound)?;

    let mut transaction = state.pool.begin().await.map_err(TeamError::Database)?;
    let inserted = sqlx::query(
        "INSERT INTO team_members (team_id, user_id, role, added_by) \
         VALUES ($1, $2, $3, $4) \
         ON CONFLICT (team_id, user_id) DO NOTHING",
    )
    .bind(team_id)
    .bind(target_user_id)
    .bind(member_role)
    .bind(user.id)
    .execute(&mut *transaction)
    .await
    .map_err(TeamError::Database)?;

    if inserted.rows_affected() == 0 {
        return Err(TeamError::Conflict("member_already_exists"));
    }

    sqlx::query(
        "INSERT INTO audit_events (event_type, actor_id, resource_id, details) \
         VALUES ('team_member_added', $1, $2, jsonb_build_object('member_id', $3, 'role', $4))",
    )
    .bind(user.id)
    .bind(team_id)
    .bind(target_user_id)
    .bind(member_role)
    .execute(&mut *transaction)
    .await
    .map_err(TeamError::Database)?;

    transaction.commit().await.map_err(TeamError::Database)?;

    let member = sqlx::query_as::<_, TeamMemberSummary>(
        "SELECT u.id AS user_id, u.email, u.role AS account_role, tm.role, u.disabled_at, tm.created_at \
           FROM team_members AS tm \
           JOIN users AS u ON u.id = tm.user_id \
          WHERE tm.team_id = $1 AND tm.user_id = $2",
    )
    .bind(team_id)
    .bind(target_user_id)
    .fetch_one(&state.pool)
    .await
    .map_err(TeamError::Database)?;

    Ok(no_store((StatusCode::CREATED, Json(member))))
}

async fn update_member(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
    Path((team_id, target_user_id)): Path<(Uuid, Uuid)>,
    Json(request): Json<UpdateMemberRequest>,
) -> Result<Response, TeamError> {
    ensure_personal_session(&user)?;
    require_csrf(&headers, &user, state.auth_settings)?;
    require_team_manager(&state.pool, team_id, &user).await?;

    let role =
        parse_team_member_role(&request.role).ok_or(TeamError::BadRequest("invalid_role"))?;

    let mut transaction = state.pool.begin().await.map_err(TeamError::Database)?;
    let existing_role: Option<String> = sqlx::query_scalar(
        "SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2 FOR UPDATE",
    )
    .bind(team_id)
    .bind(target_user_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(TeamError::Database)?;
    let existing_role = existing_role.ok_or(TeamError::NotFound)?;

    if existing_role == "admin" && role != "admin" {
        let admin_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*)::BIGINT FROM team_members WHERE team_id = $1 AND role = 'admin'",
        )
        .bind(team_id)
        .fetch_one(&mut *transaction)
        .await
        .map_err(TeamError::Database)?;
        if admin_count <= 1 && user.role != "owner" {
            return Err(TeamError::Conflict("last_team_admin"));
        }
    }

    sqlx::query("UPDATE team_members SET role = $3 WHERE team_id = $1 AND user_id = $2")
        .bind(team_id)
        .bind(target_user_id)
        .bind(role)
        .execute(&mut *transaction)
        .await
        .map_err(TeamError::Database)?;

    sqlx::query(
        "INSERT INTO audit_events (event_type, actor_id, resource_id, details) \
         VALUES ('team_member_updated', $1, $2, jsonb_build_object('member_id', $3, 'role', $4))",
    )
    .bind(user.id)
    .bind(team_id)
    .bind(target_user_id)
    .bind(role)
    .execute(&mut *transaction)
    .await
    .map_err(TeamError::Database)?;

    transaction.commit().await.map_err(TeamError::Database)?;
    Ok(no_store(StatusCode::NO_CONTENT))
}

async fn remove_member(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
    Path((team_id, target_user_id)): Path<(Uuid, Uuid)>,
) -> Result<Response, TeamError> {
    ensure_personal_session(&user)?;
    require_csrf(&headers, &user, state.auth_settings)?;
    if target_user_id != user.id {
        require_team_manager(&state.pool, team_id, &user).await?;
    }

    let mut transaction = state.pool.begin().await.map_err(TeamError::Database)?;
    let existing_role: Option<String> = sqlx::query_scalar(
        "SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2 FOR UPDATE",
    )
    .bind(team_id)
    .bind(target_user_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(TeamError::Database)?;
    let existing_role = existing_role.ok_or(TeamError::NotFound)?;

    if existing_role == "admin" && user.role != "owner" {
        let admin_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*)::BIGINT FROM team_members WHERE team_id = $1 AND role = 'admin'",
        )
        .bind(team_id)
        .fetch_one(&mut *transaction)
        .await
        .map_err(TeamError::Database)?;
        if admin_count <= 1 {
            return Err(TeamError::Conflict("last_team_admin"));
        }
    }

    sqlx::query("DELETE FROM team_members WHERE team_id = $1 AND user_id = $2")
        .bind(team_id)
        .bind(target_user_id)
        .execute(&mut *transaction)
        .await
        .map_err(TeamError::Database)?;

    sqlx::query(
        "INSERT INTO audit_events (event_type, actor_id, resource_id, details) \
         VALUES ('team_member_removed', $1, $2, jsonb_build_object('member_id', $3))",
    )
    .bind(user.id)
    .bind(team_id)
    .bind(target_user_id)
    .execute(&mut *transaction)
    .await
    .map_err(TeamError::Database)?;

    transaction.commit().await.map_err(TeamError::Database)?;
    Ok(no_store(StatusCode::NO_CONTENT))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_team_name_produces_safe_slugs() {
        assert_eq!(
            slugify_team_name("Design & Media Team"),
            "design-media-team"
        );
        assert_eq!(slugify_team_name("   ---   "), "team");
        assert_eq!(slugify_team_name("Engineering 2026!"), "engineering-2026");
    }

    #[test]
    fn parse_team_member_role_accepts_admin_and_member_only() {
        assert_eq!(parse_team_member_role("admin"), Some("admin"));
        assert_eq!(parse_team_member_role(" member "), Some("member"));
        assert_eq!(parse_team_member_role("owner"), None);
        assert_eq!(parse_team_member_role(""), None);
    }

    #[test]
    fn extract_team_id_reads_header_or_query_param() {
        let mut headers = HeaderMap::new();
        assert_eq!(extract_team_id_hint(&headers, None), None);
        assert_eq!(
            extract_team_id_hint(&headers, Some("foo=bar&team_id=abc-123")),
            Some("abc-123".to_owned())
        );

        headers.insert(
            "x-mydrive-team",
            HeaderValue::from_static("11111111-1111-1111-1111-111111111111"),
        );
        assert_eq!(
            extract_team_id_hint(&headers, Some("team_id=other")),
            Some("11111111-1111-1111-1111-111111111111".to_owned())
        );
    }

    #[test]
    fn path_supports_team_workspace_is_strictly_scoped() {
        assert!(path_supports_team_workspace("/api/drive"));
        assert!(path_supports_team_workspace("/api/folders"));
        assert!(path_supports_team_workspace("/api/uploads/123"));
        assert!(path_supports_team_workspace("/api/files/123/download"));
        assert!(path_supports_team_workspace("/api/storage"));
        assert!(!path_supports_team_workspace("/api/admin/storage"));
        assert!(!path_supports_team_workspace("/api/auth/me"));
        assert!(!path_supports_team_workspace("/api/teams"));
    }
}
