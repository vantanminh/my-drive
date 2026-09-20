use std::time::Instant;

use axum::{
    Router,
    body::Body,
    extract::DefaultBodyLimit,
    http::{HeaderValue, Request, header::HeaderName},
    middleware::{self, Next},
    response::Response,
    routing::{get, post},
};
use tracing::Instrument;
use uuid::Uuid;

use crate::health::{self, AppState};

pub(crate) fn router(state: AppState) -> Router {
    Router::new()
        .route("/health/live", get(health::live))
        .route("/health/ready", get(health::ready))
        .route(
            "/api/auth/login",
            post(crate::auth::login).layer(DefaultBodyLimit::max(16 * 1024)),
        )
        .route("/api/auth/me", get(crate::auth::me))
        .route("/api/auth/logout", post(crate::auth::logout))
        .merge(crate::drive::router())
        .merge(crate::transfers::router())
        .merge(crate::shares::router())
        .layer(middleware::from_fn(request_id_and_trace))
        .with_state(state)
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
