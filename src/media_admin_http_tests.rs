use std::{net::SocketAddr, path::Path};

use axum::{
    Router,
    body::Body,
    http::{
        Method, Request, StatusCode,
        header::{CONTENT_TYPE, COOKIE},
    },
    response::Response,
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::Utc;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, postgres::PgPoolOptions};
use tower::ServiceExt;
use uuid::Uuid;

use crate::{
    Config, api,
    auth::{AuthSettings, LoginRateLimiter},
    health::{AppState, TransferSettings},
    storage::LocalStorage,
};

struct TestSession {
    cookie_header: String,
    csrf_token: String,
}

#[tokio::test]
#[ignore = "requires a disposable PostgreSQL database in TEST_DATABASE_URL"]
async fn owner_can_inspect_and_control_media_index_jobs() {
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

    let owner_id = insert_user(&pool, "owner").await;
    let owner_session = insert_session(&pool, owner_id).await;
    let admin_id = insert_user(&pool, "admin").await;
    let admin_session = insert_session(&pool, admin_id).await;
    let job_id = insert_failed_image_job(&pool, owner_id).await;
    let temporary_storage = tempfile::tempdir().expect("create temporary HDD storage");
    let app = make_app(pool.clone(), temporary_storage.path());

    assert_eq!(
        request(
            &app,
            Method::GET,
            "/api/admin/media-index",
            None,
            None,
            None
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(
            &app,
            Method::GET,
            "/api/admin/media-index",
            Some(&admin_session),
            None,
            None,
        )
        .await
        .status(),
        StatusCode::FORBIDDEN
    );

    let status = request(
        &app,
        Method::GET,
        "/api/admin/media-index?limit=10",
        Some(&owner_session),
        None,
        None,
    )
    .await;
    assert_eq!(status.status(), StatusCode::OK);
    assert_eq!(status.headers()["cache-control"], "no-store");
    let status = response_json(status).await;
    assert_eq!(status["previewStorageAvailable"], false);
    assert_eq!(status["paused"], false);
    assert_eq!(status["counts"]["failed"], 1);
    assert_eq!(status["pendingBytes"], 8);
    assert_eq!(status["processedBytes"], 0);
    assert_eq!(status["taskMetrics"][0]["task"], "image_preview");
    assert_eq!(status["taskMetrics"][0]["counts"]["failed"], 1);
    assert_eq!(status["taskMetrics"][0]["pendingBytes"], 8);
    assert_eq!(status["jobs"][0]["id"], job_id);
    assert_eq!(status["jobs"][0]["fileName"], "owner-image.jpg");
    assert_eq!(status["jobs"][0]["task"], "image_preview");
    assert_eq!(status["jobs"][0]["totalBytes"], 8);
    assert_eq!(status["jobs"][0]["errorCode"], "processing_failed");

    assert_eq!(
        request(
            &app,
            Method::POST,
            "/api/admin/media-index/pause",
            Some(&owner_session),
            Some("wrong-token"),
            Some(json!({ "paused": true })),
        )
        .await
        .status(),
        StatusCode::FORBIDDEN
    );
    let paused = request(
        &app,
        Method::POST,
        "/api/admin/media-index/pause",
        Some(&owner_session),
        Some(&owner_session.csrf_token),
        Some(json!({ "paused": true })),
    )
    .await;
    assert_eq!(paused.status(), StatusCode::OK);
    assert_eq!(response_json(paused).await["paused"], true);
    let status = request(
        &app,
        Method::GET,
        "/api/admin/media-index",
        Some(&owner_session),
        None,
        None,
    )
    .await;
    assert_eq!(response_json(status).await["paused"], true);

    let resumed = request(
        &app,
        Method::POST,
        "/api/admin/media-index/pause",
        Some(&owner_session),
        Some(&owner_session.csrf_token),
        Some(json!({ "paused": false })),
    )
    .await;
    assert_eq!(resumed.status(), StatusCode::OK);
    assert_eq!(response_json(resumed).await["paused"], false);

    let retried = request(
        &app,
        Method::POST,
        "/api/admin/media-index/retry",
        Some(&owner_session),
        Some(&owner_session.csrf_token),
        Some(json!({ "jobId": job_id })),
    )
    .await;
    assert_eq!(retried.status(), StatusCode::OK);
    assert_eq!(response_json(retried).await["retried"], 1);
    let (state, attempts, error_code): (String, i32, Option<String>) =
        sqlx::query_as("SELECT state, attempts, error_code FROM media_index_jobs WHERE id = $1")
            .bind(job_id)
            .fetch_one(&pool)
            .await
            .expect("fetch retried indexing job");
    assert_eq!(state, "queued");
    assert_eq!(attempts, 0);
    assert_eq!(error_code, None);

    sqlx::query(
        "UPDATE drive_entries SET deleted_at = now() \
          WHERE id = (SELECT version.file_id \
                       FROM media_index_jobs AS job \
                       JOIN file_versions AS version ON version.id = job.file_version_id \
                      WHERE job.id = $1)",
    )
    .bind(job_id)
    .execute(&pool)
    .await
    .expect("deactivate file created by media-admin test");
    sqlx::query("DELETE FROM media_index_jobs WHERE id = $1")
        .bind(job_id)
        .execute(&pool)
        .await
        .expect("remove job created by media-admin test");
}

fn make_app(pool: PgPool, storage_root: &Path) -> Router {
    let config = Config {
        database_url: "postgres://not-used-in-test".to_owned(),
        bind_addr: "127.0.0.1:3000".parse::<SocketAddr>().unwrap(),
        storage_root: storage_root.to_path_buf(),
        expected_mount: storage_root.to_path_buf(),
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
        cookie_secure: false,
    };
    let storage = LocalStorage::initialize(&config).expect("initialize temporary storage");
    api::router(AppState {
        pool,
        storage,
        media_preview: None,
        auth_settings: AuthSettings {
            cookie_secure: false,
            session_ttl_seconds: 3600,
        },
        transfer_settings: TransferSettings {
            max_file_size: config.max_file_size,
            owner_quota_bytes: config.owner_quota_bytes,
            upload_session_ttl_seconds: config.upload_session_ttl_seconds,
        },
        login_rate_limiter: LoginRateLimiter::default(),
    })
}

async fn insert_user(pool: &PgPool, role: &str) -> Uuid {
    let id = Uuid::new_v4();
    let email = format!("media-admin-{id}@example.test");
    sqlx::query(
        "INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'test-only-hash', $3)",
    )
    .bind(id)
    .bind(email)
    .bind(role)
    .execute(pool)
    .await
    .expect("insert test user");
    id
}

async fn insert_session(pool: &PgPool, user_id: Uuid) -> TestSession {
    let session_id = Uuid::new_v4();
    let (session_raw, session_token) = random_token();
    let (csrf_raw, csrf_token) = random_token();
    sqlx::query(
        "INSERT INTO sessions (id, user_id, token_digest, csrf_token_digest, expires_at) \
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(session_id)
    .bind(user_id)
    .bind(Sha256::digest(session_raw).to_vec())
    .bind(Sha256::digest(csrf_raw).to_vec())
    .bind(Utc::now() + chrono::Duration::hours(1))
    .execute(pool)
    .await
    .expect("insert test session");
    TestSession {
        cookie_header: format!("my_drive_session={session_token}; my_drive_csrf={csrf_token}"),
        csrf_token,
    }
}

async fn insert_failed_image_job(pool: &PgPool, owner_id: Uuid) -> i64 {
    let file_id = Uuid::new_v4();
    let object_id = Uuid::new_v4();
    let version_id = Uuid::new_v4();
    let storage_key = LocalStorage::storage_key(object_id);
    let checksum = "a".repeat(64);
    sqlx::query("INSERT INTO drive_entries (id, owner_id, kind, name) VALUES ($1, $2, 'file', 'owner-image.jpg')")
        .bind(file_id)
        .bind(owner_id)
        .execute(pool)
        .await
        .expect("insert file entry");
    sqlx::query("INSERT INTO files (id) VALUES ($1)")
        .bind(file_id)
        .execute(pool)
        .await
        .expect("insert file metadata");
    sqlx::query(
        "INSERT INTO storage_objects \
             (id, storage_key, size_bytes, checksum_sha256, mime_detected, state) \
         VALUES ($1, $2, 8, $3, 'image/jpeg', 'ready')",
    )
    .bind(object_id)
    .bind(storage_key)
    .bind(checksum)
    .execute(pool)
    .await
    .expect("insert storage object");
    sqlx::query(
        "INSERT INTO file_versions (id, file_id, storage_object_id, size_bytes) \
         VALUES ($1, $2, $3, 8)",
    )
    .bind(version_id)
    .bind(file_id)
    .bind(object_id)
    .execute(pool)
    .await
    .expect("insert file version");
    sqlx::query("UPDATE files SET current_version_id = $1 WHERE id = $2")
        .bind(version_id)
        .bind(file_id)
        .execute(pool)
        .await
        .expect("set current version");
    sqlx::query_scalar(
        "INSERT INTO media_index_jobs \
             (file_version_id, task, recipe_version, state, attempts, processed_bytes, error_code) \
         VALUES ($1, 'image_preview', 1, 'failed', 2, 6, '/private/path/decoder-error') \
         RETURNING id",
    )
    .bind(version_id)
    .fetch_one(pool)
    .await
    .expect("insert failed image indexing job")
}

fn random_token() -> (Vec<u8>, String) {
    let mut raw = Vec::with_capacity(32);
    raw.extend_from_slice(Uuid::new_v4().as_bytes());
    raw.extend_from_slice(Uuid::new_v4().as_bytes());
    (raw.clone(), URL_SAFE_NO_PAD.encode(raw))
}

async fn request(
    app: &Router,
    method: Method,
    uri: &str,
    session: Option<&TestSession>,
    csrf: Option<&str>,
    body: Option<Value>,
) -> Response {
    let mut request = Request::builder().method(method).uri(uri);
    if let Some(session) = session {
        request = request.header(COOKIE, &session.cookie_header);
    }
    if let Some(csrf) = csrf {
        request = request.header("x-csrf-token", csrf);
    }
    let body = if let Some(body) = body {
        request = request.header(CONTENT_TYPE, "application/json");
        Body::from(body.to_string())
    } else {
        Body::empty()
    };
    app.clone()
        .oneshot(request.body(body).unwrap())
        .await
        .unwrap()
}

async fn response_json(response: Response) -> Value {
    let body = response.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&body).expect("JSON response body")
}
