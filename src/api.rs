use std::time::Instant;

use axum::{
    Router,
    body::Body,
    http::{HeaderValue, Request, header::HeaderName},
    middleware::{self, Next},
    response::Response,
    routing::get,
};
use tracing::Instrument;
use uuid::Uuid;

use crate::health::{self, AppState};

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health/live", get(health::live))
        .route("/health/ready", get(health::ready))
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
