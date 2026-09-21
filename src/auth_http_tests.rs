use std::{net::SocketAddr, path::PathBuf};

use axum::{
    body::Body,
    http::{
        Request, StatusCode,
        header::{CONTENT_TYPE, COOKIE, SET_COOKIE},
    },
};
use http_body_util::BodyExt;
use sqlx::postgres::PgPoolOptions;
use tower::ServiceExt;
use uuid::Uuid;

use crate::{
    Config, api,
    auth::{self, AuthSettings, LoginRateLimiter},
    health::{AppState, TransferSettings},
    storage::LocalStorage,
};

#[tokio::test]
#[ignore = "requires a disposable PostgreSQL database in TEST_DATABASE_URL"]
async fn browser_login_csrf_and_session_revocation_flow() {
    let database_url = std::env::var("TEST_DATABASE_URL")
        .expect("set TEST_DATABASE_URL to a disposable PostgreSQL database");
    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect(&database_url)
        .await
        .expect("connect to disposable PostgreSQL");
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("apply migrations");

    let email = format!("owner-{}@example.test", Uuid::new_v4());
    let password = "test-only browser password 2026";
    let password_hash = auth::password_hash(password).expect("hash test password");
    let user_id = Uuid::new_v4();
    sqlx::query("INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, $3, 'owner')")
        .bind(user_id)
        .bind(&email)
        .bind(password_hash)
        .execute(&pool)
        .await
        .expect("insert test owner");

    let temporary_storage = tempfile::tempdir().expect("create temporary test storage");
    let config = Config {
        database_url: "postgres://not-used-in-test".to_owned(),
        bind_addr: "127.0.0.1:3000".parse::<SocketAddr>().unwrap(),
        storage_root: PathBuf::from(temporary_storage.path()),
        expected_mount: PathBuf::from(temporary_storage.path()),
        require_mount: false,
        require_device_match: false,
        expected_device: None,
        media_preview: None,
        max_file_size: 1024,
        owner_quota_bytes: 4096,
        min_free_bytes: 0,
        min_free_percent: 0.0,
        upload_session_ttl_seconds: 3600,
        trash_retention_days: 30,
        session_ttl_seconds: 3600,
        bootstrap_owner: None,
        cookie_secure: true,
    };
    let storage = LocalStorage::initialize(&config).expect("initialize test storage");
    let app = api::router(AppState {
        pool: pool.clone(),
        storage,
        media_preview: None,
        auth_settings: AuthSettings {
            cookie_secure: true,
            session_ttl_seconds: 3600,
        },
        transfer_settings: TransferSettings {
            max_file_size: 1024,
            owner_quota_bytes: 4096,
            upload_session_ttl_seconds: 3600,
        },
        login_rate_limiter: LoginRateLimiter::default(),
    });

    let wrong_password = post_login(&app, &email, "wrong password").await;
    assert_eq!(wrong_password.status(), StatusCode::UNAUTHORIZED);
    let wrong_body = response_json(wrong_password).await;

    let unknown_user = post_login(&app, "missing@example.test", "wrong password").await;
    assert_eq!(unknown_user.status(), StatusCode::UNAUTHORIZED);
    let unknown_body = response_json(unknown_user).await;
    assert_eq!(
        wrong_body, unknown_body,
        "credential errors must not reveal account existence"
    );

    let limited_email = format!("rate-limit-{}@example.test", Uuid::new_v4());
    for _ in 0..10 {
        assert_eq!(
            post_login(&app, &limited_email, "wrong password")
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
    }
    let limited = post_login(&app, &limited_email, "wrong password").await;
    assert_eq!(limited.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(limited.headers().contains_key("retry-after"));

    let login = post_login(&app, &email, password).await;
    assert_eq!(login.status(), StatusCode::OK);
    let session_cookie = set_cookie_pair(&login, "__Host-my_drive_session");
    let csrf_cookie = set_cookie_pair(&login, "__Host-my_drive_csrf");
    let set_cookies = login
        .headers()
        .get_all(SET_COOKIE)
        .iter()
        .map(|value| value.to_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    assert!(set_cookies[0].contains("HttpOnly"));
    assert!(set_cookies[0].contains("Secure"));
    assert!(set_cookies[0].contains("SameSite=Lax"));
    assert!(set_cookies[1].contains("Secure"));
    assert!(set_cookies[1].contains("SameSite=Strict"));
    assert!(!set_cookies[1].contains("HttpOnly"));

    let login_body = response_json(login).await;
    let csrf_token = login_body["csrf_token"]
        .as_str()
        .expect("CSRF token in login response");
    assert!(
        !login_body
            .to_string()
            .contains(session_cookie.split_once('=').unwrap().1)
    );
    assert_eq!(login_body["user"]["id"], user_id.to_string());

    let cookie_header = format!("{session_cookie}; {csrf_cookie}");
    let me = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/api/auth/me")
                .header(COOKIE, &cookie_header)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(me.status(), StatusCode::OK);
    let me_body = response_json(me).await;
    assert_eq!(me_body["email"], email);

    let bad_csrf = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/auth/logout")
                .header(COOKIE, &cookie_header)
                .header("x-csrf-token", "wrong-token")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(bad_csrf.status(), StatusCode::FORBIDDEN);

    let logout = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/auth/logout")
                .header(COOKIE, &cookie_header)
                .header("x-csrf-token", csrf_token)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(logout.status(), StatusCode::NO_CONTENT);

    let after_logout = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/api/auth/me")
                .header(COOKIE, &cookie_header)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(after_logout.status(), StatusCode::UNAUTHORIZED);

    let (digest_length, revoked): (i32, bool) = sqlx::query_as(
        "SELECT octet_length(token_digest), revoked_at IS NOT NULL FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1",
    )
    .bind(user_id)
    .fetch_one(&pool)
    .await
    .expect("inspect revoked session digest");
    assert_eq!(
        digest_length, 32,
        "only the SHA-256 session digest is stored"
    );
    assert!(revoked, "logout revokes the server-side session");

    pool.close().await;
}

async fn post_login(app: &axum::Router, email: &str, password: &str) -> axum::response::Response {
    let body = serde_json::json!({ "email": email, "password": password });
    app.clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/auth/login")
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap()
}

async fn response_json(response: axum::response::Response) -> serde_json::Value {
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).expect("JSON response body")
}

fn set_cookie_pair(response: &axum::response::Response, name: &str) -> String {
    response
        .headers()
        .get_all(SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .find(|cookie| cookie.starts_with(&format!("{name}=")))
        .and_then(|cookie| cookie.split(';').next())
        .expect("expected cookie")
        .to_owned()
}
