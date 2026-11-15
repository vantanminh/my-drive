use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header::CACHE_CONTROL},
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

const DEFAULT_PAGE_SIZE: u8 = 50;
const MAX_PAGE_SIZE: u8 = 100;
const MAX_ACCOUNT_QUOTA_BYTES: u64 = 8_000_000_000_000_000;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/admin/accounts",
            get(list_accounts).post(create_account),
        )
        .route(
            "/api/admin/accounts/{id}",
            patch(update_account).delete(delete_account),
        )
        .route(
            "/api/admin/accounts/{id}/reset-password",
            post(reset_password),
        )
}

#[derive(Debug, Error)]
enum AdminAccountError {
    #[error("owner permission required")]
    Forbidden,
    #[error("CSRF validation failed")]
    Csrf,
    #[error("invalid request")]
    BadRequest,
    #[error("email address already exists")]
    EmailExists,
    #[error("child account was not found")]
    NotFound,
    #[error("quota is below current usage and active reservations")]
    QuotaBelowCurrentUsage,
    #[error("account still owns files; move or delete them before removing the account")]
    AccountHasFiles,
    #[error("database operation failed")]
    Database(#[source] sqlx::Error),
    #[error("password operation failed")]
    PasswordOperation,
}

impl IntoResponse for AdminAccountError {
    fn into_response(self) -> Response {
        let (status, code) = match self {
            Self::Forbidden => (StatusCode::FORBIDDEN, "owner_required"),
            Self::Csrf => (StatusCode::FORBIDDEN, "csrf_failed"),
            Self::BadRequest => (StatusCode::BAD_REQUEST, "invalid_request"),
            Self::EmailExists => (StatusCode::CONFLICT, "email_exists"),
            Self::NotFound => (StatusCode::NOT_FOUND, "not_found"),
            Self::QuotaBelowCurrentUsage => (StatusCode::CONFLICT, "quota_below_current_usage"),
            Self::AccountHasFiles => (StatusCode::CONFLICT, "account_has_files"),
            Self::Database(error) => {
                tracing::error!(error = %error, "account administration query failed");
                (StatusCode::SERVICE_UNAVAILABLE, "service_unavailable")
            }
            Self::PasswordOperation => {
                tracing::error!("account password operation failed");
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
struct AccountsQuery {
    offset: Option<u32>,
    limit: Option<u8>,
    q: Option<String>,
    role: Option<String>,
    status: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateAccountRequest {
    email: String,
    quota_bytes: u64,
    role: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateAccountRequest {
    quota_bytes: Option<u64>,
    disabled: Option<bool>,
    role: Option<String>,
}

#[derive(FromRow)]
struct AccountRow {
    id: Uuid,
    email: String,
    role: String,
    quota_bytes: i64,
    used_bytes: i64,
    reserved_bytes: i64,
    disabled_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountSummary {
    id: Uuid,
    email: String,
    role: String,
    quota_bytes: i64,
    used_bytes: i64,
    reserved_bytes: i64,
    disabled_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountsResponse {
    accounts: Vec<AccountSummary>,
    next_offset: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CreatedAccount {
    account: AccountSummary,
    temporary_password: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TemporaryPasswordResponse {
    temporary_password: String,
}

pub(crate) fn parse_child_account_role(raw: &str) -> Option<&'static str> {
    match raw.trim() {
        "admin" => Some("admin"),
        "member" => Some("member"),
        _ => None,
    }
}

pub(crate) fn parse_account_status_filter(raw: &str) -> Option<&'static str> {
    match raw.trim() {
        "" | "all" => Some("all"),
        "active" => Some("active"),
        "disabled" => Some("disabled"),
        _ => None,
    }
}

async fn list_accounts(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Query(query): Query<AccountsQuery>,
) -> Result<Response, AdminAccountError> {
    require_owner(&user)?;
    let limit = query.limit.unwrap_or(DEFAULT_PAGE_SIZE);
    let offset = query.offset.unwrap_or_default();
    if limit == 0 || limit > MAX_PAGE_SIZE || offset > 100_000 {
        return Err(AdminAccountError::BadRequest);
    }
    let search_pattern = query
        .q
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!("%{}%", value.to_lowercase()));
    let role_filter = match query.role.as_deref().map(str::trim) {
        None | Some("" | "all") => None,
        Some(raw) => Some(parse_child_account_role(raw).ok_or(AdminAccountError::BadRequest)?),
    };
    let status_filter = parse_account_status_filter(query.status.as_deref().unwrap_or("all"))
        .ok_or(AdminAccountError::BadRequest)?;

    let mut rows = sqlx::query_as::<_, AccountRow>(
        "SELECT account.id, account.email, account.role, account.quota_bytes, account.disabled_at, account.created_at, \
            (SELECT COALESCE(SUM(version.size_bytes), 0)::BIGINT \
               FROM drive_entries AS entry \
               JOIN files AS file ON file.id = entry.id \
               JOIN file_versions AS version ON version.id = file.current_version_id \
               JOIN storage_objects AS object ON object.id = version.storage_object_id \
                    AND object.state = 'ready' \
              WHERE entry.owner_id = account.id) AS used_bytes, \
            (SELECT COALESCE(SUM(expected_size), 0)::BIGINT \
               FROM upload_sessions \
              WHERE owner_id = account.id \
                AND (state = 'finalizing' OR (state = 'active' AND expires_at > now()))) \
                AS reserved_bytes \
           FROM users AS account \
          WHERE account.managed_by = $1 \
            AND account.role IN ('admin', 'member') \
            AND account.is_workspace_service = FALSE \
            AND ($4::TEXT IS NULL OR lower(account.email) LIKE $4) \
            AND ($5::TEXT IS NULL OR account.role = $5) \
            AND ($6 = 'all' OR ($6 = 'active' AND account.disabled_at IS NULL) OR ($6 = 'disabled' AND account.disabled_at IS NOT NULL)) \
          ORDER BY account.created_at DESC, account.id ASC LIMIT $2 OFFSET $3",
    )
    .bind(user.id)
    .bind(i64::from(limit) + 1)
    .bind(i64::from(offset))
    .bind(search_pattern.as_deref())
    .bind(role_filter)
    .bind(status_filter)
    .fetch_all(&state.pool)
    .await
    .map_err(AdminAccountError::Database)?;
    let has_more = rows.len() > usize::from(limit);
    rows.truncate(usize::from(limit));
    let next_offset = has_more.then(|| offset.saturating_add(u32::from(limit)));

    let accounts = rows
        .into_iter()
        .map(|row| AccountSummary {
            used_bytes: row.used_bytes,
            reserved_bytes: row.reserved_bytes,
            id: row.id,
            email: row.email,
            role: row.role,
            quota_bytes: row.quota_bytes,
            disabled_at: row.disabled_at,
            created_at: row.created_at,
        })
        .collect();
    Ok(no_store(Json(AccountsResponse {
        accounts,
        next_offset,
    })))
}

async fn create_account(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
    Json(request): Json<CreateAccountRequest>,
) -> Result<Response, AdminAccountError> {
    require_owner(&user)?;
    require_csrf(&headers, &user, state.auth_settings)?;
    let email = request.email.trim().to_lowercase();
    if !auth::valid_email(&email) || request.quota_bytes > MAX_ACCOUNT_QUOTA_BYTES {
        return Err(AdminAccountError::BadRequest);
    }
    let role = match request.role.as_deref() {
        None => "member",
        Some(raw) => parse_child_account_role(raw).ok_or(AdminAccountError::BadRequest)?,
    };
    let quota_bytes =
        i64::try_from(request.quota_bytes).map_err(|_| AdminAccountError::BadRequest)?;
    let (temporary_password, password_hash) = create_temporary_password_hash().await?;
    let account_id = Uuid::new_v4();
    let mut transaction = state
        .pool
        .begin()
        .await
        .map_err(AdminAccountError::Database)?;
    let inserted = sqlx::query(
        "INSERT INTO users (id, email, password_hash, role, managed_by, quota_bytes, must_change_password) \
         VALUES ($1, $2, $3, $4, $5, $6, TRUE)",
    )
    .bind(account_id)
    .bind(&email)
    .bind(password_hash)
    .bind(role)
    .bind(user.id)
    .bind(quota_bytes)
    .execute(&mut *transaction)
    .await;
    if let Err(error) = inserted {
        if is_unique_violation(&error) {
            return Err(AdminAccountError::EmailExists);
        }
        return Err(AdminAccountError::Database(error));
    }
    sqlx::query(
        "INSERT INTO audit_events (event_type, actor_id, resource_id, details) \
         VALUES ('child_account_created', $1, $2, jsonb_build_object('quota_bytes', $3, 'role', $4))",
    )
    .bind(user.id)
    .bind(account_id)
    .bind(quota_bytes)
    .bind(role)
    .execute(&mut *transaction)
    .await
    .map_err(AdminAccountError::Database)?;
    transaction
        .commit()
        .await
        .map_err(AdminAccountError::Database)?;

    let response = CreatedAccount {
        account: AccountSummary {
            id: account_id,
            email,
            role: role.to_owned(),
            quota_bytes,
            used_bytes: 0,
            reserved_bytes: 0,
            disabled_at: None,
            created_at: Utc::now(),
        },
        temporary_password,
    };
    Ok(no_store((StatusCode::CREATED, Json(response))))
}

async fn update_account(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
    Path(account_id): Path<Uuid>,
    Json(request): Json<UpdateAccountRequest>,
) -> Result<Response, AdminAccountError> {
    require_owner(&user)?;
    require_csrf(&headers, &user, state.auth_settings)?;
    if request.quota_bytes.is_none() && request.disabled.is_none() && request.role.is_none() {
        return Err(AdminAccountError::BadRequest);
    }
    let updating_self = account_id == user.id;
    if updating_self
        && (request.disabled.is_some() || request.role.is_some() || request.quota_bytes.is_none())
    {
        return Err(AdminAccountError::BadRequest);
    }
    let next_role = request
        .role
        .as_deref()
        .map(|raw| parse_child_account_role(raw).ok_or(AdminAccountError::BadRequest))
        .transpose()?;
    let quota_bytes = request
        .quota_bytes
        .map(|quota| {
            if quota > MAX_ACCOUNT_QUOTA_BYTES {
                return Err(AdminAccountError::BadRequest);
            }
            i64::try_from(quota).map_err(|_| AdminAccountError::BadRequest)
        })
        .transpose()?;
    let mut transaction = state
        .pool
        .begin()
        .await
        .map_err(AdminAccountError::Database)?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))")
        .bind(account_id)
        .execute(&mut *transaction)
        .await
        .map_err(AdminAccountError::Database)?;
    let existing_disabled: Option<bool> = if updating_self {
        sqlx::query_scalar(
            "SELECT disabled_at IS NOT NULL FROM users \
              WHERE id = $1 AND role = 'owner' FOR UPDATE",
        )
        .bind(account_id)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(AdminAccountError::Database)?
    } else {
        sqlx::query_scalar(
            "SELECT disabled_at IS NOT NULL FROM users \
              WHERE id = $1 AND managed_by = $2 AND role IN ('admin', 'member') AND is_workspace_service = FALSE FOR UPDATE",
        )
        .bind(account_id)
        .bind(user.id)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(AdminAccountError::Database)?
    };
    let existing_disabled = existing_disabled.ok_or(AdminAccountError::NotFound)?;

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
                    AND (state = 'finalizing' OR (state = 'active' AND expires_at > now()))) \
                    AS reserved_bytes",
        )
        .bind(account_id)
        .fetch_one(&mut *transaction)
        .await
        .map_err(AdminAccountError::Database)?;
        if i128::from(used_bytes.max(0)) + i128::from(reserved_bytes.max(0))
            > i128::from(quota_bytes)
        {
            return Err(AdminAccountError::QuotaBelowCurrentUsage);
        }
    }

    if updating_self {
        sqlx::query(
            "UPDATE users \
                SET quota_bytes = COALESCE($2, quota_bytes), \
                    updated_at = now() \
              WHERE id = $1 AND role = 'owner'",
        )
        .bind(account_id)
        .bind(quota_bytes)
        .execute(&mut *transaction)
        .await
        .map_err(AdminAccountError::Database)?;

        sqlx::query(
            "INSERT INTO audit_events (event_type, actor_id, resource_id, details) \
             VALUES ('owner_quota_updated', $1, $2, jsonb_build_object('quota_bytes', $3))",
        )
        .bind(user.id)
        .bind(account_id)
        .bind(quota_bytes)
        .execute(&mut *transaction)
        .await
        .map_err(AdminAccountError::Database)?;
    } else {
        sqlx::query(
            "UPDATE users \
                SET quota_bytes = COALESCE($3, quota_bytes), \
                    role = COALESCE($5, role), \
                    disabled_at = CASE \
                        WHEN $4::BOOLEAN IS NULL THEN disabled_at \
                        WHEN $4 THEN COALESCE(disabled_at, now()) \
                        ELSE NULL \
                    END, \
                    updated_at = now() \
              WHERE id = $1 AND managed_by = $2 AND role IN ('admin', 'member') AND is_workspace_service = FALSE",
        )
        .bind(account_id)
        .bind(user.id)
        .bind(quota_bytes)
        .bind(request.disabled)
        .bind(next_role)
        .execute(&mut *transaction)
        .await
        .map_err(AdminAccountError::Database)?;

        if request.disabled == Some(true) || (existing_disabled && request.disabled.is_none()) {
            sqlx::query(
                "UPDATE sessions SET revoked_at = now() \
                  WHERE user_id = $1 AND revoked_at IS NULL",
            )
            .bind(account_id)
            .execute(&mut *transaction)
            .await
            .map_err(AdminAccountError::Database)?;
        }
        sqlx::query(
            "INSERT INTO audit_events (event_type, actor_id, resource_id, details) \
             VALUES ('child_account_updated', $1, $2, jsonb_build_object('quota_bytes', $3, 'disabled', $4, 'role', $5))",
        )
        .bind(user.id)
        .bind(account_id)
        .bind(quota_bytes)
        .bind(request.disabled)
        .bind(next_role)
        .execute(&mut *transaction)
        .await
        .map_err(AdminAccountError::Database)?;
    }
    transaction
        .commit()
        .await
        .map_err(AdminAccountError::Database)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn delete_account(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
    Path(account_id): Path<Uuid>,
) -> Result<Response, AdminAccountError> {
    require_owner(&user)?;
    require_csrf(&headers, &user, state.auth_settings)?;
    if account_id == user.id {
        return Err(AdminAccountError::BadRequest);
    }

    let mut transaction = state
        .pool
        .begin()
        .await
        .map_err(AdminAccountError::Database)?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))")
        .bind(account_id)
        .execute(&mut *transaction)
        .await
        .map_err(AdminAccountError::Database)?;

    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS ( \
            SELECT 1 FROM users \
             WHERE id = $1 AND managed_by = $2 AND role IN ('admin', 'member') AND is_workspace_service = FALSE \
             FOR UPDATE \
        )",
    )
    .bind(account_id)
    .bind(user.id)
    .fetch_one(&mut *transaction)
    .await
    .map_err(AdminAccountError::Database)?;
    if !exists {
        return Err(AdminAccountError::NotFound);
    }

    let has_files: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM drive_entries WHERE owner_id = $1 AND kind = 'file')",
    )
    .bind(account_id)
    .fetch_one(&mut *transaction)
    .await
    .map_err(AdminAccountError::Database)?;
    if has_files {
        return Err(AdminAccountError::AccountHasFiles);
    }

    sqlx::query("DELETE FROM upload_sessions WHERE owner_id = $1")
        .bind(account_id)
        .execute(&mut *transaction)
        .await
        .map_err(AdminAccountError::Database)?;
    sqlx::query("DELETE FROM shares WHERE owner_id = $1")
        .bind(account_id)
        .execute(&mut *transaction)
        .await
        .map_err(AdminAccountError::Database)?;
    sqlx::query(
        "DELETE FROM folders WHERE id IN (SELECT id FROM drive_entries WHERE owner_id = $1)",
    )
    .bind(account_id)
    .execute(&mut *transaction)
    .await
    .map_err(AdminAccountError::Database)?;
    sqlx::query("UPDATE drive_entries SET parent_id = NULL WHERE owner_id = $1")
        .bind(account_id)
        .execute(&mut *transaction)
        .await
        .map_err(AdminAccountError::Database)?;
    sqlx::query("DELETE FROM drive_entries WHERE owner_id = $1")
        .bind(account_id)
        .execute(&mut *transaction)
        .await
        .map_err(AdminAccountError::Database)?;
    sqlx::query("DELETE FROM team_members WHERE user_id = $1")
        .bind(account_id)
        .execute(&mut *transaction)
        .await
        .map_err(AdminAccountError::Database)?;
    sqlx::query("DELETE FROM sessions WHERE user_id = $1")
        .bind(account_id)
        .execute(&mut *transaction)
        .await
        .map_err(AdminAccountError::Database)?;
    sqlx::query(
        "DELETE FROM users WHERE id = $1 AND managed_by = $2 AND role IN ('admin', 'member') AND is_workspace_service = FALSE",
    )
    .bind(account_id)
    .bind(user.id)
    .execute(&mut *transaction)
    .await
    .map_err(AdminAccountError::Database)?;

    sqlx::query(
        "INSERT INTO audit_events (event_type, actor_id, resource_id) \
         VALUES ('child_account_deleted', $1, $2)",
    )
    .bind(user.id)
    .bind(account_id)
    .execute(&mut *transaction)
    .await
    .map_err(AdminAccountError::Database)?;

    transaction
        .commit()
        .await
        .map_err(AdminAccountError::Database)?;
    Ok(no_store(StatusCode::NO_CONTENT))
}

async fn reset_password(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
    Path(account_id): Path<Uuid>,
) -> Result<Response, AdminAccountError> {
    require_owner(&user)?;
    require_csrf(&headers, &user, state.auth_settings)?;
    let (temporary_password, password_hash) = create_temporary_password_hash().await?;
    let mut transaction = state
        .pool
        .begin()
        .await
        .map_err(AdminAccountError::Database)?;
    let updated = sqlx::query(
        "UPDATE users SET password_hash = $1, must_change_password = TRUE, updated_at = now() \
          WHERE id = $2 AND managed_by = $3 AND role IN ('admin', 'member') AND is_workspace_service = FALSE",
    )
    .bind(password_hash)
    .bind(account_id)
    .bind(user.id)
    .execute(&mut *transaction)
    .await
    .map_err(AdminAccountError::Database)?;
    if updated.rows_affected() == 0 {
        return Err(AdminAccountError::NotFound);
    }
    sqlx::query(
        "UPDATE sessions SET revoked_at = now() \
          WHERE user_id = $1 AND revoked_at IS NULL",
    )
    .bind(account_id)
    .execute(&mut *transaction)
    .await
    .map_err(AdminAccountError::Database)?;
    sqlx::query(
        "INSERT INTO audit_events (event_type, actor_id, resource_id) \
         VALUES ('child_account_password_reset', $1, $2)",
    )
    .bind(user.id)
    .bind(account_id)
    .execute(&mut *transaction)
    .await
    .map_err(AdminAccountError::Database)?;
    transaction
        .commit()
        .await
        .map_err(AdminAccountError::Database)?;
    Ok(no_store(Json(TemporaryPasswordResponse {
        temporary_password,
    })))
}

async fn create_temporary_password_hash() -> Result<(String, String), AdminAccountError> {
    let password =
        auth::new_temporary_password().map_err(|_| AdminAccountError::PasswordOperation)?;
    let password_to_hash = password.clone();
    let hash = tokio::task::spawn_blocking(move || auth::password_hash(&password_to_hash))
        .await
        .map_err(|_| AdminAccountError::PasswordOperation)?
        .map_err(|_| AdminAccountError::PasswordOperation)?;
    Ok((password, hash))
}

fn require_owner(user: &AuthenticatedUser) -> Result<(), AdminAccountError> {
    if user.role == "owner" {
        Ok(())
    } else {
        Err(AdminAccountError::Forbidden)
    }
}

fn require_csrf(
    headers: &HeaderMap,
    user: &AuthenticatedUser,
    settings: crate::auth::AuthSettings,
) -> Result<(), AdminAccountError> {
    if auth::require_csrf(headers, user, settings) {
        Ok(())
    } else {
        Err(AdminAccountError::Csrf)
    }
}

fn no_store(response: impl IntoResponse) -> Response {
    let mut response = response.into_response();
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn is_unique_violation(error: &sqlx::Error) -> bool {
    matches!(error, sqlx::Error::Database(database) if database.code().as_deref() == Some("23505"))
}

#[cfg(test)]
mod tests {
    use super::{parse_account_status_filter, parse_child_account_role};

    #[test]
    fn parse_child_account_role_allows_admin_and_member_only() {
        assert_eq!(parse_child_account_role("admin"), Some("admin"));
        assert_eq!(parse_child_account_role(" member "), Some("member"));
        assert_eq!(parse_child_account_role("owner"), None);
        assert_eq!(parse_child_account_role("guest"), None);
    }

    #[test]
    fn parse_account_status_filter_validates_known_values() {
        assert_eq!(parse_account_status_filter(""), Some("all"));
        assert_eq!(parse_account_status_filter("all"), Some("all"));
        assert_eq!(parse_account_status_filter("active"), Some("active"));
        assert_eq!(parse_account_status_filter("disabled"), Some("disabled"));
        assert_eq!(parse_account_status_filter("deleted"), None);
    }
}
