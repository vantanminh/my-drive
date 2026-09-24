use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};
use serde::Serialize;
use sqlx::PgPool;

use crate::{
    auth::{AuthSettings, LoginRateLimiter},
    config::GoogleDriveSettings,
    storage::{LocalStorage, PreviewStorage},
};

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub storage: LocalStorage,
    pub media_preview: Option<PreviewStorage>,
    pub google_drive: Option<GoogleDriveSettings>,
    pub auth_settings: AuthSettings,
    pub transfer_settings: TransferSettings,
    pub login_rate_limiter: LoginRateLimiter,
}

#[derive(Clone, Copy)]
pub struct TransferSettings {
    pub max_file_size: u64,
    pub owner_quota_bytes: u64,
    pub upload_session_ttl_seconds: u64,
}

#[derive(Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
}

pub async fn live() -> impl IntoResponse {
    (StatusCode::OK, Json(HealthResponse { status: "live" }))
}

pub async fn ready(State(state): State<AppState>) -> impl IntoResponse {
    let database_ok = sqlx::query("SELECT 1").execute(&state.pool).await.is_ok();
    let storage = state.storage.health();
    if let Some(preview_storage) = &state.media_preview
        && let Err(error) = preview_storage.health()
    {
        tracing::warn!(
            error = %error,
            "media preview cache unavailable; indexing and preview delivery are degraded"
        );
    }
    match (database_ok, storage) {
        (true, Ok(())) => (StatusCode::OK, Json(HealthResponse { status: "ready" })),
        (false, _) => {
            tracing::warn!("readiness check failed: PostgreSQL unavailable");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(HealthResponse {
                    status: "not_ready",
                }),
            )
        }
        (true, Err(error)) => {
            tracing::warn!(error = %error, "readiness check failed: storage unavailable");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(HealthResponse {
                    status: "not_ready",
                }),
            )
        }
    }
}
