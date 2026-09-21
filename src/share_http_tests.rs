use std::{net::SocketAddr, path::Path};

use axum::{
    Router,
    body::Body,
    http::{
        HeaderName, Method, Request, StatusCode,
        header::{CONTENT_TYPE, COOKIE, RANGE, SET_COOKIE},
    },
    response::Response,
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Utc};
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
async fn shares_enforce_owner_scope_password_expiry_download_limits_and_revoke() {
    let database_url = std::env::var("TEST_DATABASE_URL")
        .expect("set TEST_DATABASE_URL to a disposable PostgreSQL database");
    let pool = PgPoolOptions::new()
        .max_connections(8)
        .connect(&database_url)
        .await
        .expect("connect to disposable PostgreSQL");
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("apply migrations");

    let owner_id = insert_owner(&pool).await;
    let owner_session = insert_session(&pool, owner_id).await;
    let other_owner_id = insert_owner(&pool).await;
    let other_session = insert_session(&pool, other_owner_id).await;
    let temporary_storage = tempfile::tempdir().expect("create temporary HDD storage");
    let storage = LocalStorage::initialize(&config(temporary_storage.path())).unwrap();

    let root_folder = insert_folder(&pool, owner_id, None, "shared root").await;
    let nested_folder = insert_folder(&pool, owner_id, Some(root_folder), "nested").await;
    let (shared_file, storage_key) = insert_file(
        &pool,
        &storage,
        owner_id,
        Some(nested_folder),
        "shared.txt",
        b"share content",
    )
    .await;
    let (outside_file, _) =
        insert_file(&pool, &storage, owner_id, None, "outside.txt", b"outside").await;
    let app = make_app(pool.clone(), temporary_storage.path());

    let create_payload = json!({
        "resource_type": "folder",
        "resource_id": root_folder,
        "password": "correct horse battery staple",
        "expires_at": (Utc::now() + chrono::Duration::hours(1)).to_rfc3339(),
        "allow_download": true,
        "max_downloads": 1
    });
    let unauthenticated = request(
        &app,
        Method::POST,
        "/api/shares",
        None,
        None,
        Some("application/json"),
        Body::from(create_payload.to_string()),
    )
    .await;
    assert_eq!(unauthenticated.status(), StatusCode::UNAUTHORIZED);

    let bad_csrf = request(
        &app,
        Method::POST,
        "/api/shares",
        Some(&owner_session),
        Some("wrong-csrf"),
        Some("application/json"),
        Body::from(create_payload.to_string()),
    )
    .await;
    assert_eq!(bad_csrf.status(), StatusCode::FORBIDDEN);

    let created = request(
        &app,
        Method::POST,
        "/api/shares",
        Some(&owner_session),
        Some(&owner_session.csrf_token),
        Some("application/json"),
        Body::from(create_payload.to_string()),
    )
    .await;
    assert_eq!(created.status(), StatusCode::CREATED);
    assert_eq!(created.headers()["cache-control"], "no-store");
    let created_body = response_json(created).await;
    let share_id = created_body["id"]
        .as_str()
        .unwrap()
        .parse::<Uuid>()
        .unwrap();
    let share_url = created_body["share_url"].as_str().unwrap();
    assert!(share_url.starts_with("/s/"));
    let token = share_url.trim_start_matches("/s/");
    let raw_token = URL_SAFE_NO_PAD.decode(token).unwrap();
    assert_eq!(raw_token.len(), 32);
    let token_digest: Vec<u8> = sqlx::query_scalar("SELECT token_digest FROM shares WHERE id = $1")
        .bind(share_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(token_digest, Sha256::digest(&raw_token).to_vec());
    assert_ne!(token_digest, raw_token);

    let owner_list = request(
        &app,
        Method::GET,
        "/api/shares",
        Some(&owner_session),
        None,
        None,
        Body::empty(),
    )
    .await;
    assert_eq!(owner_list.status(), StatusCode::OK);
    let owner_list_body = response_json(owner_list).await;
    assert_eq!(owner_list_body["shares"][0]["resource_name"], "shared root");
    assert_eq!(owner_list_body["shares"][0]["password_protected"], true);

    let foreign_list = request(
        &app,
        Method::GET,
        "/api/shares",
        Some(&other_session),
        None,
        None,
        Body::empty(),
    )
    .await;
    assert_eq!(response_json(foreign_list).await["shares"], json!([]));
    let foreign_revoke = request(
        &app,
        Method::POST,
        &format!("/api/shares/{share_id}/revoke"),
        Some(&other_session),
        Some(&other_session.csrf_token),
        None,
        Body::empty(),
    )
    .await;
    assert_eq!(foreign_revoke.status(), StatusCode::NOT_FOUND);

    let public_url = format!("/api/public/shares/{token}");
    let password_required = request(
        &app,
        Method::GET,
        &public_url,
        None,
        None,
        None,
        Body::empty(),
    )
    .await;
    assert_eq!(password_required.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        response_json(password_required).await["error"],
        "password_required"
    );

    for attempt in 1..=PASSWORD_FAILURE_LIMIT_FOR_TEST {
        let failed = request(
            &app,
            Method::POST,
            &format!("{public_url}/unlock"),
            None,
            None,
            Some("application/json"),
            Body::from(json!({ "password": "a wrong password" }).to_string()),
        )
        .await;
        if attempt < PASSWORD_FAILURE_LIMIT_FOR_TEST {
            assert_eq!(failed.status(), StatusCode::UNAUTHORIZED);
            assert_eq!(response_json(failed).await["error"], "invalid_password");
        } else {
            assert_eq!(failed.status(), StatusCode::TOO_MANY_REQUESTS);
            assert!(failed.headers().contains_key("retry-after"));
        }
    }
    let locked = request(
        &app,
        Method::POST,
        &format!("{public_url}/unlock"),
        None,
        None,
        Some("application/json"),
        Body::from(json!({ "password": "correct horse battery staple" }).to_string()),
    )
    .await;
    assert_eq!(locked.status(), StatusCode::TOO_MANY_REQUESTS);
    let failure_events: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events WHERE event_type = 'share_password_failure' AND resource_id = $1",
    )
    .bind(root_folder)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(failure_events, i64::from(PASSWORD_FAILURE_LIMIT_FOR_TEST));
    let share_audit_details: Vec<String> = sqlx::query_scalar(
        "SELECT details::text FROM audit_events WHERE resource_id = $1 AND event_type LIKE 'share_%' ORDER BY id",
    )
    .bind(root_folder)
    .fetch_all(&pool)
    .await
    .unwrap();
    for details in share_audit_details {
        assert!(!details.contains(token));
        assert!(!details.contains("correct horse battery staple"));
    }

    sqlx::query(
        "UPDATE shares SET failed_password_attempts = 0, password_locked_until = now() - interval '1 second' WHERE id = $1",
    )
    .bind(share_id)
    .execute(&pool)
    .await
    .unwrap();
    let unlocked = request(
        &app,
        Method::POST,
        &format!("{public_url}/unlock"),
        None,
        None,
        Some("application/json"),
        Body::from(json!({ "password": "correct horse battery staple" }).to_string()),
    )
    .await;
    assert_eq!(unlocked.status(), StatusCode::NO_CONTENT);
    let grant_cookie = unlocked.headers()[SET_COOKIE].to_str().unwrap().to_owned();
    assert!(grant_cookie.contains("HttpOnly"));
    assert!(grant_cookie.contains("SameSite=Strict"));
    assert!(grant_cookie.contains(&format!("Path=/api/public/shares/{token}")));
    let grant_cookie = grant_cookie.split(';').next().unwrap().to_owned();
    let stored_grants: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM share_access_sessions WHERE share_id = $1 AND expires_at > now()",
    )
    .bind(share_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(stored_grants, 1);

    let folder_view = request(
        &app,
        Method::GET,
        &public_url,
        None,
        None,
        None,
        Body::empty(),
    )
    .await;
    assert_eq!(folder_view.status(), StatusCode::UNAUTHORIZED);
    let folder_view =
        request_with_cookie(&app, Method::GET, &public_url, &grant_cookie, None).await;
    assert_eq!(folder_view.status(), StatusCode::OK);
    let folder_view = response_json(folder_view).await;
    assert_eq!(folder_view["resource"]["id"], root_folder.to_string());
    assert_eq!(folder_view["entries"].as_array().unwrap().len(), 1);
    assert_eq!(folder_view["entries"][0]["name"], "nested");

    let nested_view = request_with_cookie(
        &app,
        Method::GET,
        &format!("{public_url}?folder_id={nested_folder}"),
        &grant_cookie,
        None,
    )
    .await;
    assert_eq!(nested_view.status(), StatusCode::OK);
    assert_eq!(
        response_json(nested_view).await["entries"][0]["id"],
        shared_file.to_string()
    );

    let outside_download = request_with_cookie(
        &app,
        Method::GET,
        &format!("{public_url}/download/{outside_file}"),
        &grant_cookie,
        None,
    )
    .await;
    assert_eq!(outside_download.status(), StatusCode::NOT_FOUND);

    let range_download = request_with_cookie(
        &app,
        Method::GET,
        &format!("{public_url}/download/{shared_file}"),
        &grant_cookie,
        Some((RANGE, "bytes=0-4")),
    )
    .await;
    assert_eq!(range_download.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(response_bytes(range_download).await, b"share".to_vec());
    let maxed_out = request_with_cookie(
        &app,
        Method::GET,
        &format!("{public_url}/download/{shared_file}"),
        &grant_cookie,
        None,
    )
    .await;
    assert_eq!(maxed_out.status(), StatusCode::GONE);

    let revoked = request(
        &app,
        Method::POST,
        &format!("/api/shares/{share_id}/revoke"),
        Some(&owner_session),
        Some(&owner_session.csrf_token),
        None,
        Body::empty(),
    )
    .await;
    assert_eq!(revoked.status(), StatusCode::NO_CONTENT);
    let no_longer_public =
        request_with_cookie(&app, Method::GET, &public_url, &grant_cookie, None).await;
    assert_eq!(no_longer_public.status(), StatusCode::NOT_FOUND);
    let remaining_grants: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM share_access_sessions WHERE share_id = $1")
            .bind(share_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(remaining_grants, 0);

    let disabled_share = create_share(
        &app,
        &owner_session,
        json!({
            "resource_type": "file",
            "resource_id": shared_file,
            "allow_download": false,
            "expires_at": (Utc::now() + chrono::Duration::hours(1)).to_rfc3339()
        }),
    )
    .await;
    let disabled_id = disabled_share["id"]
        .as_str()
        .unwrap()
        .parse::<Uuid>()
        .unwrap();
    let disabled_token = disabled_share["share_url"]
        .as_str()
        .unwrap()
        .trim_start_matches("/s/");
    let disabled_url = format!("/api/public/shares/{disabled_token}");
    assert_eq!(
        request(
            &app,
            Method::GET,
            &disabled_url,
            None,
            None,
            None,
            Body::empty()
        )
        .await
        .status(),
        StatusCode::OK
    );
    let disabled_download = request(
        &app,
        Method::GET,
        &format!("{disabled_url}/download/{shared_file}"),
        None,
        None,
        None,
        Body::empty(),
    )
    .await;
    assert_eq!(disabled_download.status(), StatusCode::FORBIDDEN);

    sqlx::query("UPDATE shares SET expires_at = now() - interval '1 second' WHERE id = $1")
        .bind(disabled_id)
        .execute(&pool)
        .await
        .unwrap();
    let expired = request(
        &app,
        Method::GET,
        &disabled_url,
        None,
        None,
        None,
        Body::empty(),
    )
    .await;
    assert_eq!(expired.status(), StatusCode::NOT_FOUND);

    let nested_share = create_share(
        &app,
        &owner_session,
        json!({
            "resource_type": "folder",
            "resource_id": nested_folder,
            "password": "nested folder secret"
        }),
    )
    .await;
    let nested_share_id = nested_share["id"]
        .as_str()
        .unwrap()
        .parse::<Uuid>()
        .unwrap();
    let nested_token = nested_share["share_url"]
        .as_str()
        .unwrap()
        .trim_start_matches("/s/");
    let nested_unlock = request(
        &app,
        Method::POST,
        &format!("/api/public/shares/{nested_token}/unlock"),
        None,
        None,
        Some("application/json"),
        Body::from(json!({ "password": "nested folder secret" }).to_string()),
    )
    .await;
    assert_eq!(nested_unlock.status(), StatusCode::NO_CONTENT);
    let nested_grants_before_trash: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM share_access_sessions WHERE share_id = $1")
            .bind(nested_share_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(nested_grants_before_trash, 1);
    let trashed = request(
        &app,
        Method::DELETE,
        &format!("/api/entries/{root_folder}"),
        Some(&owner_session),
        Some(&owner_session.csrf_token),
        None,
        Body::empty(),
    )
    .await;
    assert_eq!(trashed.status(), StatusCode::NO_CONTENT);
    let subtree_share = request(
        &app,
        Method::GET,
        &format!("/api/public/shares/{nested_token}"),
        None,
        None,
        None,
        Body::empty(),
    )
    .await;
    assert_eq!(subtree_share.status(), StatusCode::NOT_FOUND);
    let subtree_revoked: Option<DateTime<Utc>> =
        sqlx::query_scalar("SELECT revoked_at FROM shares WHERE id = $1")
            .bind(nested_share_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(subtree_revoked.is_some());
    let nested_grants_after_trash: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM share_access_sessions WHERE share_id = $1")
            .bind(nested_share_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(nested_grants_after_trash, 0);

    let (stored_name, stored_checksum): (String, String) = sqlx::query_as(
        "SELECT object.storage_key, object.checksum_sha256 FROM storage_objects AS object WHERE object.storage_key = $1",
    )
    .bind(storage_key)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(!stored_name.contains("shared.txt"));
    assert_eq!(stored_checksum.len(), 64);
}

const PASSWORD_FAILURE_LIMIT_FOR_TEST: i32 = 5;

async fn create_share(app: &Router, session: &TestSession, payload: Value) -> Value {
    let response = request(
        app,
        Method::POST,
        "/api/shares",
        Some(session),
        Some(&session.csrf_token),
        Some("application/json"),
        Body::from(payload.to_string()),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    response_json(response).await
}

fn config(storage_root: &Path) -> Config {
    Config {
        database_url: "postgres://localhost/my-drive-test".to_owned(),
        bind_addr: "127.0.0.1:3000".parse::<SocketAddr>().unwrap(),
        storage_root: storage_root.to_path_buf(),
        expected_mount: storage_root.to_path_buf(),
        require_mount: false,
        require_device_match: false,
        expected_device: None,
        media_preview: None,
        max_file_size: 1024 * 1024,
        owner_quota_bytes: 1024 * 1024,
        min_free_bytes: 0,
        min_free_percent: 0.0,
        upload_session_ttl_seconds: 3600,
        trash_retention_days: 30,
        session_ttl_seconds: 3600,
        bootstrap_owner: None,
        cookie_secure: false,
    }
}

fn make_app(pool: PgPool, storage_root: &Path) -> Router {
    let config = config(storage_root);
    let storage = LocalStorage::initialize(&config).expect("initialize test storage");
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

async fn insert_owner(pool: &PgPool) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'test-only-hash', 'owner')",
    )
    .bind(id)
    .bind(format!("share-owner-{id}@example.test"))
    .execute(pool)
    .await
    .expect("insert test owner");
    id
}

async fn insert_session(pool: &PgPool, owner_id: Uuid) -> TestSession {
    let session_id = Uuid::new_v4();
    let session_raw = random_token_bytes();
    let csrf_raw = random_token_bytes();
    let session_token = URL_SAFE_NO_PAD.encode(&session_raw);
    let csrf_token = URL_SAFE_NO_PAD.encode(&csrf_raw);
    sqlx::query(
        "INSERT INTO sessions (id, user_id, token_digest, csrf_token_digest, expires_at) VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(session_id)
    .bind(owner_id)
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

fn random_token_bytes() -> Vec<u8> {
    let mut raw = Vec::with_capacity(32);
    raw.extend_from_slice(Uuid::new_v4().as_bytes());
    raw.extend_from_slice(Uuid::new_v4().as_bytes());
    raw
}

async fn insert_folder(pool: &PgPool, owner_id: Uuid, parent_id: Option<Uuid>, name: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO drive_entries (id, owner_id, parent_id, kind, name) VALUES ($1, $2, $3, 'folder', $4)",
    )
    .bind(id)
    .bind(owner_id)
    .bind(parent_id)
    .bind(name)
    .execute(pool)
    .await
    .expect("insert folder entry");
    sqlx::query("INSERT INTO folders (id) VALUES ($1)")
        .bind(id)
        .execute(pool)
        .await
        .expect("insert folder projection");
    id
}

async fn insert_file(
    pool: &PgPool,
    storage: &LocalStorage,
    owner_id: Uuid,
    parent_id: Option<Uuid>,
    name: &str,
    content: &[u8],
) -> (Uuid, String) {
    let entry_id = Uuid::new_v4();
    let object_id = Uuid::new_v4();
    let version_id = Uuid::new_v4();
    let storage_key = LocalStorage::storage_key(object_id);
    let checksum = format!("{:x}", Sha256::digest(content));
    sqlx::query(
        "INSERT INTO drive_entries (id, owner_id, parent_id, kind, name) VALUES ($1, $2, $3, 'file', $4)",
    )
    .bind(entry_id)
    .bind(owner_id)
    .bind(parent_id)
    .bind(name)
    .execute(pool)
    .await
    .expect("insert file entry");
    sqlx::query("INSERT INTO files (id) VALUES ($1)")
        .bind(entry_id)
        .execute(pool)
        .await
        .expect("insert file projection");
    sqlx::query(
        "INSERT INTO storage_objects (id, storage_key, size_bytes, checksum_sha256, state) VALUES ($1, $2, $3, $4, 'ready')",
    )
    .bind(object_id)
    .bind(&storage_key)
    .bind(i64::try_from(content.len()).unwrap())
    .bind(&checksum)
    .execute(pool)
    .await
    .expect("insert storage object");
    sqlx::query(
        "INSERT INTO file_versions (id, file_id, storage_object_id, size_bytes) VALUES ($1, $2, $3, $4)",
    )
    .bind(version_id)
    .bind(entry_id)
    .bind(object_id)
    .bind(i64::try_from(content.len()).unwrap())
    .execute(pool)
    .await
    .expect("insert file version");
    sqlx::query("UPDATE files SET current_version_id = $1 WHERE id = $2")
        .bind(version_id)
        .bind(entry_id)
        .execute(pool)
        .await
        .expect("select current version");
    let path = storage.object_path(&storage_key).unwrap();
    tokio::fs::create_dir_all(path.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(path, content).await.unwrap();
    (entry_id, storage_key)
}

async fn request(
    app: &Router,
    method: Method,
    uri: &str,
    session: Option<&TestSession>,
    csrf: Option<&str>,
    content_type: Option<&str>,
    body: Body,
) -> Response {
    let mut request = Request::builder().method(method).uri(uri);
    if let Some(session) = session {
        request = request.header(COOKIE, &session.cookie_header);
    }
    if let Some(csrf) = csrf {
        request = request.header("x-csrf-token", csrf);
    }
    if let Some(content_type) = content_type {
        request = request.header(CONTENT_TYPE, content_type);
    }
    app.clone()
        .oneshot(request.body(body).unwrap())
        .await
        .unwrap()
}

async fn request_with_cookie(
    app: &Router,
    method: Method,
    uri: &str,
    cookie: &str,
    extra_header: Option<(HeaderName, &str)>,
) -> Response {
    let mut request = Request::builder()
        .method(method)
        .uri(uri)
        .header(COOKIE, cookie);
    if let Some((name, value)) = extra_header {
        request = request.header(name, value);
    }
    app.clone()
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap()
}

async fn response_json(response: Response) -> Value {
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).expect("JSON response body")
}

async fn response_bytes(response: Response) -> Vec<u8> {
    response
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes()
        .to_vec()
}
