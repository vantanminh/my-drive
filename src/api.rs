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
    apply_security_headers(&mut response);
    response
}

fn apply_security_headers(response: &mut Response) {
    let headers = response.headers_mut();
    if !headers.contains_key("content-security-policy") {
        headers.insert(
            HeaderName::from_static("content-security-policy"),
            HeaderValue::from_static(
                "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; font-src 'self' data:",
            ),
        );
    }
    headers.insert(
        HeaderName::from_static("permissions-policy"),
        HeaderValue::from_static("camera=(), geolocation=(), microphone=(), payment=()"),
    );
    headers.insert(
        HeaderName::from_static("referrer-policy"),
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        HeaderName::from_static("x-frame-options"),
        HeaderValue::from_static("DENY"),
    );
    headers.insert(
        HeaderName::from_static("cross-origin-opener-policy"),
        HeaderValue::from_static("same-origin"),
    );
    headers.insert(
        HeaderName::from_static("cross-origin-resource-policy"),
        HeaderValue::from_static("same-origin"),
    );
}

#[cfg(test)]
mod tests {
    use axum::{body::Body, http::StatusCode, response::Response};

    use super::apply_security_headers;

    #[test]
    fn security_headers_protect_browser_responses_without_disabling_media() {
        let mut response = Response::builder()
            .status(StatusCode::OK)
            .body(Body::empty())
            .expect("response builder should accept an empty body");
        apply_security_headers(&mut response);

        let headers = response.headers();
        assert_eq!(headers["x-content-type-options"], "nosniff");
        assert_eq!(headers["x-frame-options"], "DENY");
        assert_eq!(headers["referrer-policy"], "no-referrer");
        assert_eq!(headers["cross-origin-opener-policy"], "same-origin");
        assert_eq!(headers["cross-origin-resource-policy"], "same-origin");
        assert_eq!(
            headers["permissions-policy"],
            "camera=(), geolocation=(), microphone=(), payment=()"
        );
        let csp = headers["content-security-policy"].to_str().unwrap();
        assert!(csp.contains("media-src 'self' blob:"));
        assert!(csp.contains("object-src 'none'"));
        assert!(csp.contains("frame-ancestors 'none'"));
    }
}
