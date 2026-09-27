use std::{net::SocketAddr, path::PathBuf};

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
async fn drive_routes_enforce_owner_scope_csrf_and_folder_lifecycle() {
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
    let session = insert_session(&pool, owner_id).await;
    let root_id = insert_folder(&pool, owner_id, None, "root", false).await;
    let nested_id = insert_folder(&pool, owner_id, Some(root_id), "nested", false).await;
    let destination_id = insert_folder(&pool, owner_id, None, "destination", false).await;
    let movable_id = insert_folder(&pool, owner_id, None, "movable", false).await;
    let trashed_fixture_id =
        insert_folder(&pool, owner_id, None, "csrf-restore-fixture", true).await;

    let other_owner_id = insert_owner(&pool).await;
    let foreign_folder_id = insert_folder(&pool, other_owner_id, None, "foreign", false).await;
    let (app, _temporary_storage) = make_app(pool.clone());

    let mutation_cases = [
        (
            Method::POST,
            "/api/folders".to_owned(),
            Some(json!({ "name": "unauthorized folder" })),
        ),
        (
            Method::PATCH,
            format!("/api/entries/{movable_id}/rename"),
            Some(json!({ "name": "unauthorized rename" })),
        ),
        (
            Method::POST,
            format!("/api/entries/{movable_id}/move"),
            Some(json!({ "parent_id": destination_id })),
        ),
        (Method::DELETE, format!("/api/entries/{movable_id}"), None),
        (
            Method::POST,
            format!("/api/entries/{trashed_fixture_id}/restore"),
            None,
        ),
    ];
    for (method, uri, body) in mutation_cases {
        let unauthenticated = send(&app, method.clone(), &uri, None, None, body.clone()).await;
        assert_eq!(
            unauthenticated.status(),
            StatusCode::UNAUTHORIZED,
            "authentication is required for {method} {uri}"
        );

        let bad_csrf = send(
            &app,
            method,
            &uri,
            Some(&session),
            Some("invalid-csrf-token"),
            body,
        )
        .await;
        assert_eq!(
            bad_csrf.status(),
            StatusCode::FORBIDDEN,
            "CSRF validation is required for {uri}"
        );
    }

    let foreign_get = send(
        &app,
        Method::GET,
        &format!("/api/entries/{foreign_folder_id}"),
        Some(&session),
        None,
        None,
    )
    .await;
    assert_eq!(foreign_get.status(), StatusCode::NOT_FOUND);

    let foreign_parent_create = send(
        &app,
        Method::POST,
        "/api/folders",
        Some(&session),
        Some(&session.csrf_token),
        Some(json!({ "name": "forbidden child", "parent_id": foreign_folder_id })),
    )
    .await;
    assert_eq!(foreign_parent_create.status(), StatusCode::NOT_FOUND);

    let foreign_parent_move = send(
        &app,
        Method::POST,
        &format!("/api/entries/{movable_id}/move"),
        Some(&session),
        Some(&session.csrf_token),
        Some(json!({ "parent_id": foreign_folder_id })),
    )
    .await;
    assert_eq!(foreign_parent_move.status(), StatusCode::NOT_FOUND);

    let invalid_name = send(
        &app,
        Method::POST,
        "/api/folders",
        Some(&session),
        Some(&session.csrf_token),
        Some(json!({ "name": "../outside" })),
    )
    .await;
    assert_eq!(invalid_name.status(), StatusCode::BAD_REQUEST);

    let duplicate_folder = send(
        &app,
        Method::POST,
        "/api/folders",
        Some(&session),
        Some(&session.csrf_token),
        Some(json!({ "name": "ROOT" })),
    )
    .await;
    assert_eq!(duplicate_folder.status(), StatusCode::CONFLICT);

    let duplicate_rename = send(
        &app,
        Method::PATCH,
        &format!("/api/entries/{movable_id}/rename"),
        Some(&session),
        Some(&session.csrf_token),
        Some(json!({ "name": "Destination" })),
    )
    .await;
    assert_eq!(duplicate_rename.status(), StatusCode::CONFLICT);

    let cycle_move = send(
        &app,
        Method::POST,
        &format!("/api/entries/{root_id}/move"),
        Some(&session),
        Some(&session.csrf_token),
        Some(json!({ "parent_id": nested_id })),
    )
    .await;
    assert_eq!(cycle_move.status(), StatusCode::CONFLICT);

    let created = send(
        &app,
        Method::POST,
        "/api/folders",
        Some(&session),
        Some(&session.csrf_token),
        Some(json!({ "name": "fresh", "parent_id": root_id })),
    )
    .await;
    assert_eq!(created.status(), StatusCode::CREATED);
    let created_body = response_json(created).await;
    let created_id = created_body["id"]
        .as_str()
        .expect("created entry id")
        .parse::<Uuid>()
        .expect("created id is a UUID");

    let inspected = send(
        &app,
        Method::GET,
        &format!("/api/entries/{created_id}"),
        Some(&session),
        None,
        None,
    )
    .await;
    assert_eq!(inspected.status(), StatusCode::OK);
    assert_eq!(response_json(inspected).await["name"], "fresh");

    let page = send(
        &app,
        Method::GET,
        "/api/drive?limit=1&sort_by=name&order=asc",
        Some(&session),
        None,
        None,
    )
    .await;
    assert_eq!(page.status(), StatusCode::OK);
    let page_body = response_json(page).await;
    assert_eq!(page_body["entries"].as_array().unwrap().len(), 1);
    assert!(page_body["next_offset"].as_u64().is_some());

    let search = send(
        &app,
        Method::GET,
        "/api/drive/search?q=fresh",
        Some(&session),
        None,
        None,
    )
    .await;
    assert_eq!(search.status(), StatusCode::OK);
    assert_eq!(
        response_json(search).await["entries"][0]["id"],
        created_id.to_string()
    );

    let renamed = send(
        &app,
        Method::PATCH,
        &format!("/api/entries/{movable_id}/rename"),
        Some(&session),
        Some(&session.csrf_token),
        Some(json!({ "name": "Renamed" })),
    )
    .await;
    assert_eq!(renamed.status(), StatusCode::OK);
    assert_eq!(response_json(renamed).await["name"], "Renamed");

    let moved = send(
        &app,
        Method::POST,
        &format!("/api/entries/{movable_id}/move"),
        Some(&session),
        Some(&session.csrf_token),
        Some(json!({ "parent_id": destination_id })),
    )
    .await;
    assert_eq!(moved.status(), StatusCode::OK);
    assert_eq!(
        response_json(moved).await["parent_id"],
        destination_id.to_string()
    );

    insert_share(&pool, owner_id, root_id).await;
    insert_share(&pool, owner_id, nested_id).await;
    let trashed = send(
        &app,
        Method::DELETE,
        &format!("/api/entries/{root_id}"),
        Some(&session),
        Some(&session.csrf_token),
        None,
    )
    .await;
    assert_eq!(trashed.status(), StatusCode::NO_CONTENT);

    let revoked_shares: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM shares WHERE owner_id = $1 AND resource_id IN ($2, $3) AND revoked_at IS NOT NULL",
    )
    .bind(owner_id)
    .bind(root_id)
    .bind(nested_id)
    .fetch_one(&pool)
    .await
    .expect("inspect revoked subtree shares");
    assert_eq!(revoked_shares, 2);

    let hidden_child = send(
        &app,
        Method::GET,
        &format!("/api/entries/{nested_id}"),
        Some(&session),
        None,
        None,
    )
    .await;
    assert_eq!(hidden_child.status(), StatusCode::NOT_FOUND);

    let trash = send(
        &app,
        Method::GET,
        "/api/drive/trash",
        Some(&session),
        None,
        None,
    )
    .await;
    assert_eq!(trash.status(), StatusCode::OK);
    let trash_body = response_json(trash).await;
    assert!(
        trash_body["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["id"] == root_id.to_string())
    );

    let restored = send(
        &app,
        Method::POST,
        &format!("/api/entries/{root_id}/restore"),
        Some(&session),
        Some(&session.csrf_token),
        None,
    )
    .await;
    assert_eq!(restored.status(), StatusCode::OK);
    let audit_events: Vec<String> = sqlx::query_scalar(
        "SELECT event_type FROM audit_events WHERE actor_id = $1 AND resource_id = $2 ORDER BY id",
    )
    .bind(owner_id)
    .bind(root_id)
    .fetch_all(&pool)
    .await
    .expect("inspect trash and restore audit events");
    assert_eq!(audit_events, ["entry_trashed", "entry_restored"]);

    let visible_child = send(
        &app,
        Method::GET,
        &format!("/api/entries/{nested_id}"),
        Some(&session),
        None,
        None,
    )
    .await;
    assert_eq!(visible_child.status(), StatusCode::OK);

    pool.close().await;
}

fn make_app(pool: PgPool) -> (Router, tempfile::TempDir) {
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
    };
    let storage = LocalStorage::initialize(&config).expect("initialize test storage");
    let app = api::router(AppState {
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
            max_file_size: 1024,
            owner_quota_bytes: 4096,
            upload_session_ttl_seconds: 3600,
        },
        login_rate_limiter: LoginRateLimiter::default(),
    });
    (app, temporary_storage)
}

async fn insert_owner(pool: &PgPool) -> Uuid {
    let id = Uuid::new_v4();
    let email = format!("drive-owner-{id}@example.test");
    sqlx::query(
        "INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'test-only-hash', 'owner')",
    )
    .bind(id)
    .bind(email)
    .execute(pool)
    .await
    .expect("insert test owner");
    id
}

async fn insert_session(pool: &PgPool, owner_id: Uuid) -> TestSession {
    let session_id = Uuid::new_v4();
    let (session_raw, session_token) = random_token();
    let (csrf_raw, csrf_token) = random_token();
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

fn random_token() -> (Vec<u8>, String) {
    let mut raw = Vec::with_capacity(32);
    raw.extend_from_slice(Uuid::new_v4().as_bytes());
    raw.extend_from_slice(Uuid::new_v4().as_bytes());
    let encoded = URL_SAFE_NO_PAD.encode(&raw);
    (raw, encoded)
}

async fn insert_folder(
    pool: &PgPool,
    owner_id: Uuid,
    parent_id: Option<Uuid>,
    name: &str,
    deleted: bool,
) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO drive_entries (id, owner_id, parent_id, kind, name, deleted_at) VALUES ($1, $2, $3, 'folder', $4, CASE WHEN $5 THEN now() ELSE NULL END)",
    )
    .bind(id)
    .bind(owner_id)
    .bind(parent_id)
    .bind(name)
    .bind(deleted)
    .execute(pool)
    .await
    .expect("insert test folder entry");
    sqlx::query("INSERT INTO folders (id) VALUES ($1)")
        .bind(id)
        .execute(pool)
        .await
        .expect("insert test folder projection");
    id
}

async fn insert_share(pool: &PgPool, owner_id: Uuid, resource_id: Uuid) {
    let digest = Sha256::digest(Uuid::new_v4().as_bytes()).to_vec();
    sqlx::query(
        "INSERT INTO shares (id, owner_id, resource_type, resource_id, token_digest) VALUES ($1, $2, 'folder', $3, $4)",
    )
    .bind(Uuid::new_v4())
    .bind(owner_id)
    .bind(resource_id)
    .bind(digest)
    .execute(pool)
    .await
    .expect("insert test share");
}

async fn send(
    app: &Router,
    method: Method,
    uri: &str,
    session: Option<&TestSession>,
    csrf_header: Option<&str>,
    body: Option<Value>,
) -> Response {
    let mut request = Request::builder().method(method).uri(uri);
    if let Some(session) = session {
        request = request.header(COOKIE, &session.cookie_header);
    }
    if let Some(csrf_header) = csrf_header {
        request = request.header("x-csrf-token", csrf_header);
    }
    if body.is_some() {
        request = request.header(CONTENT_TYPE, "application/json");
    }
    app.clone()
        .oneshot(
            request
                .body(body.map_or_else(Body::empty, |value| Body::from(value.to_string())))
                .unwrap(),
        )
        .await
        .unwrap()
}

async fn response_json(response: Response) -> Value {
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).expect("JSON response body")
}

async fn api_send(
    app: &Router,
    method: Method,
    uri: &str,
    key: &str,
    body: Option<Value>,
) -> Response {
    let mut request = Request::builder()
        .method(method)
        .uri(uri)
        .header("authorization", format!("Bearer {key}"));
    if body.is_some() {
        request = request.header(CONTENT_TYPE, "application/json");
    }
    app.clone()
        .oneshot(
            request
                .body(body.map_or_else(Body::empty, |v| Body::from(v.to_string())))
                .unwrap(),
        )
        .await
        .unwrap()
}

async fn developer_key(app: &Router, session: &TestSession, scopes: &[&str]) -> Value {
    let response = send(
        app,
        Method::POST,
        "/api/developer/keys",
        Some(session),
        Some(&session.csrf_token),
        Some(json!({"name":"lesson integration","scopes":scopes})),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    response_json(response).await
}

#[tokio::test]
#[ignore = "requires a disposable PostgreSQL database in TEST_DATABASE_URL"]
async fn developer_api_keys_scope_upload_logs_and_independent_share_lifecycle() {
    let pool = PgPoolOptions::new()
        .max_connections(8)
        .connect(&std::env::var("TEST_DATABASE_URL").unwrap())
        .await
        .unwrap();
    sqlx::migrate!("./migrations").run(&pool).await.unwrap();
    let owner = insert_owner(&pool).await;
    let session = insert_session(&pool, owner).await;
    let other = insert_owner(&pool).await;
    let other_session = insert_session(&pool, other).await;
    let foreign = insert_folder(&pool, other, None, "foreign", false).await;
    let (app, _storage) = make_app(pool.clone());

    let denied = send(
        &app,
        Method::POST,
        "/api/developer/keys",
        Some(&session),
        None,
        Some(json!({"name":"bad","scopes":["drive:write"]})),
    )
    .await;
    assert_eq!(denied.status(), StatusCode::FORBIDDEN);
    let key = developer_key(
        &app,
        &session,
        &[
            "drive:read",
            "drive:write",
            "shares:read",
            "shares:write",
            "photos:write",
            "photos:read",
        ],
    )
    .await;
    let token = key["key"].as_str().unwrap();
    let key_id: Uuid = key["id"].as_str().unwrap().parse().unwrap();
    let listing = response_json(
        send(
            &app,
            Method::GET,
            "/api/developer/keys",
            Some(&session),
            None,
            None,
        )
        .await,
    )
    .await;
    assert!(!listing.to_string().contains(token));
    assert!(!listing.to_string().contains("token_digest"));
    let digest: Vec<u8> = sqlx::query_scalar("SELECT token_digest FROM api_keys WHERE id=$1")
        .bind(key_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(digest, Sha256::digest(token.as_bytes()).to_vec());
    assert_eq!(
        send(
            &app,
            Method::GET,
            "/api/v1/drive",
            Some(&session),
            None,
            None
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED,
        "v1 cannot fall back to browser cookies"
    );
    assert_eq!(
        api_send(&app, Method::GET, "/api/v1/admin/storage", token, None)
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        api_send(&app, Method::GET, "/api/developer/keys", token, None)
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        api_send(
            &app,
            Method::GET,
            &format!("/api/v1/entries/{foreign}"),
            token,
            None
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );

    let read_only = developer_key(&app, &session, &["drive:read"]).await;
    assert_eq!(
        api_send(
            &app,
            Method::POST,
            "/api/v1/folders",
            read_only["key"].as_str().unwrap(),
            Some(json!({"name":"denied"}))
        )
        .await
        .status(),
        StatusCode::FORBIDDEN
    );
    let folder_response = api_send(
        &app,
        Method::POST,
        "/api/v1/folders",
        token,
        Some(json!({"name":"Lessons"})),
    )
    .await;
    assert_eq!(folder_response.status(), StatusCode::CREATED);
    let folder = response_json(folder_response).await;
    let folder_id = folder["id"].as_str().unwrap();
    assert_eq!(
        api_send(&app, Method::GET, "/api/v1/storage", token, None)
            .await
            .status(),
        StatusCode::OK
    );

    let upload_response = api_send(
        &app,
        Method::POST,
        "/api/v1/uploads",
        token,
        Some(json!({"filename":"lesson.pdf","expected_size":8,"parent_id":folder_id})),
    )
    .await;
    assert_eq!(upload_response.status(), StatusCode::CREATED);
    let upload = response_json(upload_response).await;
    let upload_id = upload["id"].as_str().unwrap();
    let chunk = Request::builder()
        .method(Method::PATCH)
        .uri(format!("/api/v1/uploads/{upload_id}"))
        .header("authorization", format!("Bearer {token}"))
        .header(CONTENT_TYPE, "application/offset+octet-stream")
        .header("upload-offset", "0")
        .body(Body::from("%PDF-1.7"))
        .unwrap();
    assert_eq!(
        app.clone().oneshot(chunk).await.unwrap().status(),
        StatusCode::NO_CONTENT
    );
    let head = api_send(
        &app,
        Method::HEAD,
        &format!("/api/v1/uploads/{upload_id}"),
        token,
        None,
    )
    .await;
    assert_eq!(head.headers()["upload-offset"], "8");
    let finalized = api_send(
        &app,
        Method::POST,
        &format!("/api/v1/uploads/{upload_id}/finalize"),
        token,
        None,
    )
    .await;
    assert_eq!(finalized.status(), StatusCode::OK);
    let file = response_json(finalized).await;
    assert!(file["file_id"].as_str().is_some());

    let photo = api_send(
        &app,
        Method::POST,
        "/api/v1/photos/uploads",
        token,
        Some(json!({"filename":"photo.png","expected_size":68})),
    )
    .await;
    assert_eq!(photo.status(), StatusCode::CREATED);
    let photo_id = response_json(photo).await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let png=base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=").unwrap();
    assert_eq!(png.len(), 68);
    let chunk = Request::builder()
        .method(Method::PATCH)
        .uri(format!("/api/v1/uploads/{photo_id}"))
        .header("authorization", format!("Bearer {token}"))
        .header(CONTENT_TYPE, "application/offset+octet-stream")
        .header("upload-offset", "0")
        .body(Body::from(png))
        .unwrap();
    assert_eq!(
        app.clone().oneshot(chunk).await.unwrap().status(),
        StatusCode::NO_CONTENT
    );
    let photo_file = response_json(
        api_send(
            &app,
            Method::POST,
            &format!("/api/v1/uploads/{photo_id}/finalize"),
            token,
            None,
        )
        .await,
    )
    .await;
    let jobs:i64=sqlx::query_scalar("SELECT count(*) FROM media_index_jobs j JOIN file_versions v ON v.id=j.file_version_id WHERE v.file_id=$1").bind(photo_file["file_id"].as_str().unwrap().parse::<Uuid>().unwrap()).fetch_one(&pool).await.unwrap();
    assert!(jobs > 0, "API uploads must enqueue media indexing");
    let timeline =
        response_json(api_send(&app, Method::GET, "/api/v1/photos", token, None).await).await;
    assert!(
        timeline["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["id"] == photo_file["file_id"])
    );
    let photos_parent: Uuid =
        sqlx::query_scalar("SELECT target_parent_id FROM upload_sessions WHERE id=$1")
            .bind(photo_id.parse::<Uuid>().unwrap())
            .fetch_one(&pool)
            .await
            .unwrap();
    let role: String = sqlx::query_scalar("SELECT system_role FROM drive_entries WHERE id=$1")
        .bind(photos_parent)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(role, "photos");
    assert_eq!(
        api_send(
            &app,
            Method::POST,
            "/api/v1/photos/uploads",
            token,
            Some(json!({"filename":"not-photo.pdf","expected_size":1}))
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );

    let shared = response_json(
        api_send(
            &app,
            Method::POST,
            "/api/v1/shares",
            token,
            Some(json!({"resource_type":"folder","resource_id":folder_id})),
        )
        .await,
    )
    .await;
    let share_id: Uuid = shared["id"].as_str().unwrap().parse().unwrap();
    let share_token = shared["share_url"]
        .as_str()
        .unwrap()
        .strip_prefix("/s/")
        .unwrap();
    let public_uri = format!("/api/public/shares/{share_token}");
    assert_eq!(
        send(&app, Method::GET, &public_uri, None, None, None)
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        send(
            &app,
            Method::POST,
            &format!("/api/developer/keys/{key_id}/revoke"),
            Some(&other_session),
            Some(&other_session.csrf_token),
            Some(json!({"revoke_shares":true}))
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    let response = send(
        &app,
        Method::POST,
        &format!("/api/developer/keys/{key_id}/revoke"),
        Some(&session),
        Some(&session.csrf_token),
        Some(json!({"revoke_shares":false})),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        api_send(&app, Method::GET, "/api/v1/drive", token, None)
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        send(&app, Method::GET, &public_uri, None, None, None)
            .await
            .status(),
        StatusCode::OK,
        "revoking key must keep existing links"
    );
    let response = send(
        &app,
        Method::POST,
        &format!("/api/developer/keys/{key_id}/shares/revoke"),
        Some(&session),
        Some(&session.csrf_token),
        None,
    )
    .await;
    assert_eq!(response_json(response).await["shares_revoked"], 1);
    assert_eq!(
        send(&app, Method::GET, &public_uri, None, None, None)
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    let provenance: Uuid =
        sqlx::query_scalar("SELECT created_by_api_key_id FROM shares WHERE id=$1")
            .bind(share_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(provenance, key_id);

    let key2 = developer_key(&app, &session, &["shares:write", "drive:read"]).await;
    let token2 = key2["key"].as_str().unwrap();
    let shared2 = response_json(
        api_send(
            &app,
            Method::POST,
            "/api/v1/shares",
            token2,
            Some(json!({"resource_type":"folder","resource_id":folder_id})),
        )
        .await,
    )
    .await;
    let response = send(
        &app,
        Method::POST,
        &format!(
            "/api/developer/keys/{}/revoke",
            key2["id"].as_str().unwrap()
        ),
        Some(&session),
        Some(&session.csrf_token),
        Some(json!({"revoke_shares":true})),
    )
    .await;
    assert_eq!(response_json(response).await["shares_revoked"], 1);
    assert_eq!(
        send(
            &app,
            Method::GET,
            &format!(
                "/api/public/shares/{}",
                shared2["share_url"]
                    .as_str()
                    .unwrap()
                    .strip_prefix("/s/")
                    .unwrap()
            ),
            None,
            None,
            None
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );

    let usage = send(
        &app,
        Method::GET,
        "/api/developer/usage?all=true&days=30",
        Some(&session),
        None,
        None,
    )
    .await;
    assert_eq!(usage.status(), StatusCode::OK);
    assert!(
        !response_json(usage).await["daily"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let logged = response_json(
        send(
            &app,
            Method::GET,
            "/api/developer/logs",
            Some(&session),
            None,
            None,
        )
        .await,
    )
    .await;
    assert!(!logged.to_string().contains(token));
    assert!(
        logged["logs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|l| l["route"] == "/api/v1/uploads/{id}"
                && l["method"] == "PATCH"
                && l["request_bytes"] == 68),
        "streamed payload traffic is measured even without Content-Length"
    );

    let read_id = read_only["id"].as_str().unwrap().parse::<Uuid>().unwrap();
    sqlx::query("UPDATE api_keys SET rate_window=now(),rate_count=120 WHERE id=$1")
        .bind(read_id)
        .execute(&pool)
        .await
        .unwrap();
    let limited = api_send(
        &app,
        Method::GET,
        "/api/v1/drive",
        read_only["key"].as_str().unwrap(),
        None,
    )
    .await;
    assert_eq!(limited.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(limited.headers()["retry-after"], "60");
    sqlx::query("UPDATE api_keys SET expires_at=now()-interval '1 second' WHERE id=$1")
        .bind(read_id)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        api_send(
            &app,
            Method::GET,
            "/api/v1/drive",
            read_only["key"].as_str().unwrap(),
            None
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    sqlx::query("UPDATE users SET role='member',managed_by=$2,quota_bytes=4096 WHERE id=$1")
        .bind(other)
        .bind(owner)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        send(
            &app,
            Method::GET,
            "/api/developer/usage?all=true",
            Some(&other_session),
            None,
            None
        )
        .await
        .status(),
        StatusCode::FORBIDDEN
    );
    sqlx::query("INSERT INTO api_keys(id,owner_id,name,token_digest,prefix,scopes,revoked_at) SELECT gen_random_uuid(),$1,'historical key',decode(md5($1::text||n::text)||md5(n::text||$1::text),'hex'),'mdk_history',ARRAY['drive:read'],now() FROM generate_series(1,105) n").bind(owner).execute(&pool).await.unwrap();
    let history = response_json(
        send(
            &app,
            Method::GET,
            "/api/developer/keys",
            Some(&session),
            None,
            None,
        )
        .await,
    )
    .await;
    assert_eq!(history["keys"].as_array().unwrap().len(), 100);
    assert_eq!(history["next_offset"], 100);
    let older = response_json(
        send(
            &app,
            Method::GET,
            "/api/developer/keys?offset=100",
            Some(&session),
            None,
            None,
        )
        .await,
    )
    .await;
    assert!(!older["keys"].as_array().unwrap().is_empty());
    assert!(older["next_offset"].is_null());
    let docs = send(&app, Method::GET, "/docs/index.md", None, None, None).await;
    assert_eq!(docs.status(), StatusCode::OK);
    assert_eq!(
        docs.headers()["content-type"],
        "text/markdown; charset=utf-8"
    );
}
