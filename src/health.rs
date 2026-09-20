use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};
use serde::Serialize;
use sqlx::PgPool;

use crate::storage::LocalStorage;

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub storage: LocalStorage,
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
