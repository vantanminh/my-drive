use std::time::Instant;

use axum::{
    Router,
    body::Body,
    extract::DefaultBodyLimit,
    http::{HeaderValue, Request, StatusCode, header::HeaderName},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{any, get, post},
};
use std::path::PathBuf;
use tower_http::services::{ServeDir, ServeFile};
use tracing::Instrument;
use uuid::Uuid;

use crate::health::{self, AppState};

pub(crate) fn router(state: AppState) -> Router {
    let static_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("frontend/dist");
    let static_files = ServeDir::new(&static_root)
        .append_index_html_on_directories(true)
        .not_found_service(ServeFile::new(static_root.join("index.html")));
    Router::new()
        .route("/health/live", get(health::live))
        .route("/health/ready", get(health::ready))
        .route(
            "/api/auth/login",
            post(crate::auth::login).layer(DefaultBodyLimit::max(16 * 1024)),
        )
        .route("/api/auth/me", get(crate::auth::me))
        .route("/api/auth/logout", post(crate::auth::logout))
        .route(
            "/api/auth/password",
            post(crate::auth::change_password).layer(DefaultBodyLimit::max(16 * 1024)),
        )
        .merge(crate::drive::router())
        .merge(crate::faces::router())
        .merge(crate::transfers::router())
        .merge(crate::shares::router())
        .merge(crate::media_admin::router())
        .merge(crate::admin_accounts::router())
        .route("/api", any(api_not_found))
        .route("/api/{*path}", any(api_not_found))
        .route("/s/{token}", get(serve_frontend_index))
        .fallback_service(static_files)
        .layer(middleware::from_fn(request_id_and_trace))
        .with_state(state)
}

async fn api_not_found() -> (StatusCode, axum::Json<serde_json::Value>) {
    (
        StatusCode::NOT_FOUND,
        axum::Json(serde_json::json!({ "error": "not_found" })),
    )
}

async fn serve_frontend_index() -> Response {
    let index_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("frontend/dist/index.html");
    match tokio::fs::read(index_path).await {
        Ok(contents) => {
            let mut response = Response::new(Body::from(contents));
            response.headers_mut().insert(
                axum::http::header::CONTENT_TYPE,
                HeaderValue::from_static("text/html; charset=utf-8"),
            );
            response
        }
        Err(error) => {
            tracing::error!(error = %error, "could not read the frontend index");
            StatusCode::SERVICE_UNAVAILABLE.into_response()
        }
    }
}

async fn request_id_and_trace(request: Request<Body>, next: Next) -> Response {
    let request_id = Uuid::new_v4().to_string();
    let method = request.method().clone();
    let span = tracing::info_span!("http_request", request_id = %request_id, method = %method);
    let started = Instant::now();
    let mut response = next.run(request).instrument(span.clone()).await;
    let status = response.status();
    tracing::info!(
        parent: &span,
        status = status.as_u16(),
        elapsed_ms = started.elapsed().as_millis(),
        "request finished"
    );
    if let Ok(value) = HeaderValue::from_str(&request_id) {
        response
            .headers_mut()
            .insert(HeaderName::from_static("x-request-id"), value);
    }
    response
}
