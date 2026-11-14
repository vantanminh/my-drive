use std::{
    net::SocketAddr,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use axum::{
    Json, Router,
    body::Body,
    extract::State as AxumState,
    http::{
        Method, Request, StatusCode,
        header::{CONTENT_TYPE, COOKIE},
    },
    response::Response,
    routing::{get, post, put},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::Utc;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, postgres::PgPoolOptions};
use tokio::net::TcpListener;
use tower::ServiceExt;
use uuid::Uuid;

use crate::{
    Config, api,
    auth::{AuthSettings, LoginRateLimiter},
    config::UpdateSettings,
    health::{AppState, TransferSettings},
    storage::LocalStorage,
};

struct TestSession {
    cookie_header: String,
    csrf_token: String,
}

#[derive(Clone)]
struct MockUpdaterState {
    backup_configured: Arc<AtomicBool>,
    triggered: Arc<AtomicBool>,
}

#[tokio::test]
#[ignore = "requires a disposable PostgreSQL database in TEST_DATABASE_URL"]
async fn owner_can_check_configure_and_apply_system_updates() {
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

    let github_mock = Router::new()
        .route(
            "/repos/vantanminh/my-drive/releases/latest",
            get(|| async {
                Json(json!({
                    "tag_name": "v9.9.9",
                    "target_commitish": "master",
                    "published_at": "2026-11-14T12:00:00Z",
                    "html_url": "https://github.com/vantanminh/my-drive/releases/tag/v9.9.9",
                    "body": "Dashboard update release notes."
                }))
            }),
        )
        .route(
            "/repos/vantanminh/my-drive/git/ref/tags/v9.9.9",
            get(|| async {
                Json(json!({
                    "object": { "type": "commit", "sha": "fedcba9876543210fedcba9876543210fedcba98" }
                }))
            }),
        );
    let github_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let github_addr = github_listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(github_listener, github_mock).await;
    });

    let mock_updater_state = MockUpdaterState {
        backup_configured: Arc::new(AtomicBool::new(false)),
        triggered: Arc::new(AtomicBool::new(false)),
    };
    let updater_mock = Router::new()
        .route(
            "/status",
            get(|AxumState(st): AxumState<MockUpdaterState>| async move {
                let configured = st.backup_configured.load(Ordering::SeqCst);
                let running = st.triggered.load(Ordering::SeqCst);
                Json(json!({
                    "connected": true,
                    "status": if running { "running" } else { "idle" },
                    "phase": if running { json!("pulling") } else { Value::Null },
                    "message": if running { json!("Pulling v9.9.9") } else { Value::Null },
                    "targetTag": if running { json!("v9.9.9") } else { Value::Null },
                    "backupConfigured": configured,
                    "backupRootHint": if configured { json!("/mnt/backup/my-drive") } else { Value::Null },
                }))
            }),
        )
        .route(
            "/backup-config",
            put(|AxumState(st): AxumState<MockUpdaterState>| async move {
                st.backup_configured.store(true, Ordering::SeqCst);
                Json(json!({
                    "connected": true,
                    "status": "idle",
                    "backupConfigured": true,
                    "backupRootHint": "/mnt/backup/my-drive"
                }))
            }),
        )
        .route(
            "/update",
            post(|AxumState(st): AxumState<MockUpdaterState>| async move {
                st.triggered.store(true, Ordering::SeqCst);
                (
                    StatusCode::ACCEPTED,
                    Json(json!({
                        "connected": true,
                        "status": "running",
                        "phase": "pulling",
                        "message": "Starting host update to v9.9.9",
                        "targetTag": "v9.9.9",
                        "backupConfigured": true,
                        "backupRootHint": "/mnt/backup/my-drive"
                    })),
                )
            }),
        )
        .with_state(mock_updater_state.clone());
    let updater_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let updater_addr = updater_listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(updater_listener, updater_mock).await;
    });

    let owner_id = insert_user(&pool, "owner").await;
    let owner_session = insert_session(&pool, owner_id).await;
    let admin_id = insert_user(&pool, "admin").await;
    let admin_session = insert_session(&pool, admin_id).await;
    let temporary_storage = tempfile::tempdir().expect("create temporary storage");

    let app = make_app(
        pool.clone(),
        temporary_storage.path(),
        UpdateSettings {
            github_repo: "vantanminh/my-drive".to_owned(),
            github_api_base_url: format!("http://{github_addr}"),
            updater_socket: None,
            updater_url: Some(format!("http://{updater_addr}")),
            updater_token: None,
            current_image: Some("ghcr.io/vantanminh/my-drive:latest".to_owned()),
        },
    );

    assert_eq!(
        request(&app, Method::GET, "/api/admin/updates", None, None, None)
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(
            &app,
            Method::GET,
            "/api/admin/updates",
            Some(&admin_session),
            None,
            None,
        )
        .await
        .status(),
        StatusCode::FORBIDDEN
    );

    assert_eq!(
        request(
            &app,
            Method::POST,
            "/api/admin/updates/check",
            Some(&owner_session),
            Some("wrong-csrf"),
            None,
        )
        .await
        .status(),
        StatusCode::FORBIDDEN
    );

    let checked = request(
        &app,
        Method::POST,
        "/api/admin/updates/check",
        Some(&owner_session),
        Some(&owner_session.csrf_token),
        None,
    )
    .await;
    assert_eq!(checked.status(), StatusCode::OK);
    let checked_json = response_json(checked).await;
    assert_eq!(checked_json["latest"]["tag"], "v9.9.9");
    assert_eq!(checked_json["latest"]["updateAvailable"], true);
    assert_eq!(checked_json["hostUpdater"]["connected"], true);
    assert_eq!(checked_json["hostUpdater"]["backupConfigured"], false);

    // Updating before backup is configured must fail closed.
    assert_eq!(
        request(
            &app,
            Method::POST,
            "/api/admin/updates/apply",
            Some(&owner_session),
            Some(&owner_session.csrf_token),
            Some(json!({ "targetTag": "v9.9.9" })),
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );

    let settings = request(
        &app,
        Method::PATCH,
        "/api/admin/updates/settings",
        Some(&owner_session),
        Some(&owner_session.csrf_token),
        Some(json!({
            "autoCheckEnabled": true,
            "autoUpdateEnabled": true,
            "checkIntervalMinutes": 30
        })),
    )
    .await;
    assert_eq!(settings.status(), StatusCode::OK);
    let settings_json = response_json(settings).await;
    assert_eq!(settings_json["settings"]["autoUpdateEnabled"], true);
    assert_eq!(settings_json["settings"]["checkIntervalMinutes"], 30);

    let configured = request(
        &app,
        Method::POST,
        "/api/admin/updates/backup-config",
        Some(&owner_session),
        Some(&owner_session.csrf_token),
        Some(json!({
            "backupRoot": "/mnt/backup/my-drive",
            "ageRecipient": "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p"
        })),
    )
    .await;
    assert_eq!(configured.status(), StatusCode::OK);
    assert_eq!(
        response_json(configured).await["hostUpdater"]["backupConfigured"],
        true
    );

    let applied = request(
        &app,
        Method::POST,
        "/api/admin/updates/apply",
        Some(&owner_session),
        Some(&owner_session.csrf_token),
        Some(json!({ "targetTag": "v9.9.9" })),
    )
    .await;
    assert_eq!(applied.status(), StatusCode::OK);
    let applied_json = response_json(applied).await;
    assert_eq!(applied_json["hostUpdater"]["status"], "running");
    assert_eq!(applied_json["lastTriggeredTag"], "v9.9.9");
    assert!(mock_updater_state.triggered.load(Ordering::SeqCst));
}

fn make_app(pool: PgPool, storage_root: &Path, update_settings: UpdateSettings) -> Router {
    let config = Config {
        database_url: "postgres://not-used-in-test".to_owned(),
        bind_addr: "127.0.0.1:3000".parse::<SocketAddr>().unwrap(),
        storage_root: storage_root.to_path_buf(),
        expected_mount: storage_root.to_path_buf(),
        require_mount: false,
        require_device_match: false,
        expected_device: None,
        media_preview: None,
        document_preview_url: None,
        max_file_size: 1024,
        owner_quota_bytes: 4096,
        min_free_bytes: 0,
        min_free_percent: 0.0,
        upload_session_ttl_seconds: 3600,
        trash_retention_days: 30,
        session_ttl_seconds: 3600,
        bootstrap_owner: None,
        cookie_secure: false,
        google_drive: None,
        update_settings: update_settings.clone(),
    };
    let storage = LocalStorage::initialize(&config).expect("initialize temporary storage");
    api::router(AppState {
        pool,
        storage,
        media_preview: None,
        document_preview_url: None,
        google_drive: None,
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
        update_settings,
    })
}

async fn insert_user(pool: &PgPool, role: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO users (id, email, password_hash, role, quota_bytes) \
         VALUES ($1, $2, 'not-used-in-session-tests', $3, 4096)",
    )
    .bind(id)
    .bind(format!("{role}-{id}@example.test"))
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
