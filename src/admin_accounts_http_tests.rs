use std::net::SocketAddr;
use std::time::Duration;

use axum::{
    Router,
    body::Body,
    http::{
        Method, Request, StatusCode,
        header::{CONTENT_TYPE, COOKIE, SET_COOKIE},
    },
    response::Response,
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::Utc;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, postgres::PgPoolOptions};
use tokio::{task::JoinHandle, time::timeout};
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
async fn owner_managed_account_lifecycle_enforces_password_rotation_and_disablement() {
    let (pool, app, storage) = setup().await;
    let owner_id = insert_user(&pool, "owner", None, None, false).await;
    let owner_session = insert_session(&pool, owner_id).await;
    let other_owner_id = insert_user(&pool, "owner", None, None, false).await;
    let other_owner_session = insert_session(&pool, other_owner_id).await;
    let admin_id = insert_user(&pool, "admin", None, None, false).await;
    let admin_session = insert_session(&pool, admin_id).await;
    let email = format!("member-{}@example.test", Uuid::new_v4());

    let unauthenticated = request(&app, Method::GET, "/api/admin/accounts", None, None, None).await;
    assert_eq!(unauthenticated.status(), StatusCode::UNAUTHORIZED);
    let non_owner = request(
        &app,
        Method::GET,
        "/api/admin/accounts",
        Some(&admin_session),
        None,
        None,
    )
    .await;
    assert_eq!(non_owner.status(), StatusCode::FORBIDDEN);
    let other_owner_accounts = request(
        &app,
        Method::GET,
        "/api/admin/accounts",
        Some(&other_owner_session),
        None,
        None,
    )
    .await;
    assert_eq!(
        response_json(other_owner_accounts).await["accounts"],
        json!([])
    );

    let create_payload = json!({"email": email, "quotaBytes": 100});
    let missing_csrf = request(
        &app,
        Method::POST,
        "/api/admin/accounts",
        Some(&owner_session),
        None,
        Some(create_payload.clone()),
    )
    .await;
    assert_eq!(missing_csrf.status(), StatusCode::FORBIDDEN);
    let created = request(
        &app,
        Method::POST,
        "/api/admin/accounts",
        Some(&owner_session),
        Some(&owner_session.csrf_token),
        Some(create_payload),
    )
    .await;
    assert_eq!(created.status(), StatusCode::CREATED);
    assert_eq!(created.headers()["cache-control"], "no-store");
    let created_body = response_json(created).await;
    let member_id = Uuid::parse_str(created_body["account"]["id"].as_str().unwrap()).unwrap();
    let temporary_password = created_body["temporaryPassword"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(created_body["account"]["quotaBytes"], 100);
    assert_eq!(temporary_password.len(), 43);

    let signup = request(
        &app,
        Method::POST,
        "/api/auth/signup",
        None,
        None,
        Some(json!({"email": "public@example.test"})),
    )
    .await;
    assert_eq!(
        signup.status(),
        StatusCode::NOT_FOUND,
        "public signup route must not exist"
    );
    assert_eq!(
        request(
            &app,
            Method::PATCH,
            &format!("/api/admin/accounts/{member_id}"),
            Some(&other_owner_session),
            Some(&other_owner_session.csrf_token),
            Some(json!({"disabled": true}))
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );

    let (member_session, login_body) = login(&app, &email, &temporary_password).await;
    assert_eq!(login_body["user"]["must_change_password"], true);
    let me = request(
        &app,
        Method::GET,
        "/api/auth/me",
        Some(&member_session),
        None,
        None,
    )
    .await;
    assert_eq!(response_json(me).await["must_change_password"], true);
    let blocked_drive = request(
        &app,
        Method::GET,
        "/api/drive",
        Some(&member_session),
        None,
        None,
    )
    .await;
    assert_eq!(blocked_drive.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        response_json(blocked_drive).await["error"],
        "password_change_required"
    );

    let second_session = login(&app, &email, &temporary_password).await.0;
    let new_password = "member secure password 2026";
    let bad_csrf = request(
        &app,
        Method::POST,
        "/api/auth/password",
        Some(&member_session),
        Some("wrong"),
        Some(json!({"current_password": temporary_password, "new_password": new_password})),
    )
    .await;
    assert_eq!(bad_csrf.status(), StatusCode::FORBIDDEN);
    let changed = request(
        &app,
        Method::POST,
        "/api/auth/password",
        Some(&member_session),
        Some(&member_session.csrf_token),
        Some(json!({"current_password": temporary_password, "new_password": new_password})),
    )
    .await;
    assert_eq!(changed.status(), StatusCode::NO_CONTENT);
    assert_eq!(changed.headers()["cache-control"], "no-store");
    let me_after_rotation = request(
        &app,
        Method::GET,
        "/api/auth/me",
        Some(&member_session),
        None,
        None,
    )
    .await;
    assert_eq!(
        response_json(me_after_rotation).await["must_change_password"],
        false
    );
    assert_eq!(
        request(
            &app,
            Method::GET,
            "/api/drive",
            Some(&member_session),
            None,
            None
        )
        .await
        .status(),
        StatusCode::OK
    );
    assert_eq!(
        request(
            &app,
            Method::GET,
            "/api/auth/me",
            Some(&second_session),
            None,
            None
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED,
        "changing a password revokes the other sessions"
    );

    let demotion = sqlx::query("UPDATE users SET role = 'admin' WHERE id = $1")
        .bind(owner_id)
        .execute(&pool)
        .await;
    assert!(
        matches!(demotion, Err(sqlx::Error::Database(error)) if error.code().as_deref() == Some("23514")),
        "an owner with managed members must not be demoted"
    );

    let disabled = request(
        &app,
        Method::PATCH,
        &format!("/api/admin/accounts/{member_id}"),
        Some(&owner_session),
        Some(&owner_session.csrf_token),
        Some(json!({"disabled": true})),
    )
    .await;
    assert_eq!(disabled.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        request(
            &app,
            Method::GET,
            "/api/auth/me",
            Some(&member_session),
            None,
            None
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        login(&app, &email, new_password).await.1["error"],
        "invalid_credentials"
    );

    assert_eq!(
        request(
            &app,
            Method::PATCH,
            &format!("/api/admin/accounts/{member_id}"),
            Some(&owner_session),
            Some(&owner_session.csrf_token),
            Some(json!({"disabled": false}))
        )
        .await
        .status(),
        StatusCode::NO_CONTENT
    );
    let reset = request(
        &app,
        Method::POST,
        &format!("/api/admin/accounts/{member_id}/reset-password"),
        Some(&owner_session),
        Some(&owner_session.csrf_token),
        None,
    )
    .await;
    assert_eq!(reset.status(), StatusCode::OK);
    assert_eq!(reset.headers()["cache-control"], "no-store");
    let reset_password = response_json(reset).await["temporaryPassword"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_ne!(reset_password, temporary_password);
    assert_eq!(
        login(&app, &email, new_password).await.1["error"],
        "invalid_credentials"
    );
    let (_, reset_login) = login(&app, &email, &reset_password).await;
    assert_eq!(reset_login["user"]["must_change_password"], true);

    let leaked_secret: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM audit_events WHERE details::text LIKE '%' || $1 || '%')",
    )
    .bind(&reset_password)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(
        !leaked_secret,
        "temporary password must not appear in audit details"
    );

    cleanup_users(&pool, &[member_id, admin_id, other_owner_id, owner_id]).await;
    drop(storage);
    pool.close().await;
}

#[tokio::test]
#[ignore = "requires a disposable PostgreSQL database in TEST_DATABASE_URL"]
async fn member_creation_and_owner_demotion_are_serialized() {
    let (pool, _, storage) = setup().await;
    let insert_first_owner = insert_user(&pool, "owner", None, None, false).await;
    let first_member_id = Uuid::new_v4();

    // Hold the demotion transaction open after its trigger checked for members.
    // The member insert must wait on the manager row and then observe the demotion.
    let mut demotion_tx = pool.begin().await.unwrap();
    sqlx::query("UPDATE users SET role = 'admin' WHERE id = $1")
        .bind(insert_first_owner)
        .execute(&mut *demotion_tx)
        .await
        .unwrap();
    let (insert_pid, insert_task) =
        spawn_member_insert(pool.clone(), insert_first_owner, first_member_id).await;
    let insert_waited = backend_is_waiting_on_lock(&pool, insert_pid).await;
    demotion_tx.commit().await.unwrap();
    let insert_result = timeout(Duration::from_secs(5), insert_task)
        .await
        .expect("member insert should finish after the demotion commits")
        .expect("member insert task should not panic");

    // Hold the member insert open after its trigger shared-locks the owner row.
    // Demotion must wait, then observe the committed member and fail.
    let demotion_second_owner = insert_user(&pool, "owner", None, None, false).await;
    let second_member_id = Uuid::new_v4();
    let mut member_tx = pool.begin().await.unwrap();
    insert_member(&mut member_tx, demotion_second_owner, second_member_id)
        .await
        .unwrap();
    let (demotion_pid, demotion_task) =
        spawn_owner_demotion(pool.clone(), demotion_second_owner).await;
    let demotion_waited = backend_is_waiting_on_lock(&pool, demotion_pid).await;
    member_tx.commit().await.unwrap();
    let demotion_result = timeout(Duration::from_secs(5), demotion_task)
        .await
        .expect("demotion should finish after the member insert commits")
        .expect("demotion task should not panic");

    // Clean up before asserting so a failed race check does not leave fixtures behind.
    cleanup_users(
        &pool,
        &[
            first_member_id,
            second_member_id,
            insert_first_owner,
            demotion_second_owner,
        ],
    )
    .await;
    drop(storage);
    pool.close().await;

    assert!(
        insert_waited,
        "member creation must wait for an in-flight owner demotion"
    );
    assert!(
        is_check_violation(&insert_result),
        "member creation must fail after its manager is demoted"
    );
    assert!(
        demotion_waited,
        "owner demotion must wait for an in-flight member creation"
    );
    assert!(
        is_check_violation(&demotion_result),
        "owner demotion must fail after a member is committed"
    );
}

#[tokio::test]
#[ignore = "requires a disposable PostgreSQL database in TEST_DATABASE_URL"]
async fn member_quota_counts_used_bytes_and_serializes_concurrent_upload_reservations() {
    let (pool, app, storage) = setup().await;
    let owner_id = insert_user(&pool, "owner", None, None, false).await;
    let owner_session = insert_session(&pool, owner_id).await;
    let member_id = insert_user(&pool, "member", Some(owner_id), Some(10), false).await;
    let member_session = insert_session(&pool, member_id).await;
    seed_used_file(&pool, member_id, 4).await;

    let first_request = request(
        &app,
        Method::POST,
        "/api/uploads",
        Some(&member_session),
        Some(&member_session.csrf_token),
        Some(json!({"filename": "first.bin", "expected_size": 4, "parent_id": null})),
    );
    let second_request = request(
        &app,
        Method::POST,
        "/api/uploads",
        Some(&member_session),
        Some(&member_session.csrf_token),
        Some(json!({"filename": "second.bin", "expected_size": 4, "parent_id": null})),
    );
    let (first, second) = tokio::join!(first_request, second_request);
    let statuses = [first.status(), second.status()];
    assert_eq!(
        statuses
            .iter()
            .filter(|status| **status == StatusCode::CREATED)
            .count(),
        1
    );
    assert_eq!(
        statuses
            .iter()
            .filter(|status| **status == StatusCode::INSUFFICIENT_STORAGE)
            .count(),
        1
    );
    let upload_id = if first.status() == StatusCode::CREATED {
        Uuid::parse_str(response_json(first).await["id"].as_str().unwrap()).unwrap()
    } else {
        Uuid::parse_str(response_json(second).await["id"].as_str().unwrap()).unwrap()
    };

    let partial_upload = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::PATCH)
                .uri(format!("/api/uploads/{upload_id}"))
                .header(COOKIE, &member_session.cookie_header)
                .header("x-csrf-token", &member_session.csrf_token)
                .header("upload-offset", "0")
                .header(CONTENT_TYPE, "application/offset+octet-stream")
                .body(Body::from("x"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(partial_upload.status(), StatusCode::NO_CONTENT);
    let over_quota_with_partial_upload = request(
        &app,
        Method::POST,
        "/api/uploads",
        Some(&member_session),
        Some(&member_session.csrf_token),
        Some(json!({ "filename": "third.bin", "expected_size": 3, "parent_id": null })),
    )
    .await;
    assert_eq!(
        over_quota_with_partial_upload.status(),
        StatusCode::INSUFFICIENT_STORAGE,
        "quota must include bytes already uploaded to an active staging file"
    );

    let accounts = request(
        &app,
        Method::GET,
        "/api/admin/accounts",
        Some(&owner_session),
        None,
        None,
    )
    .await;
    let account = response_json(accounts).await["accounts"][0].clone();
    assert_eq!(account["id"], member_id.to_string());
    assert_eq!(account["usedBytes"], 4);
    assert_eq!(
        account["reservedBytes"], 4,
        "reservation stays at the full upload size after a chunk arrives"
    );

    let quota_too_low = request(
        &app,
        Method::PATCH,
        &format!("/api/admin/accounts/{member_id}"),
        Some(&owner_session),
        Some(&owner_session.csrf_token),
        Some(json!({"quotaBytes": 7})),
    )
    .await;
    assert_eq!(quota_too_low.status(), StatusCode::CONFLICT);
    assert_eq!(
        response_json(quota_too_low).await["error"],
        "quota_below_current_usage"
    );
    let quota_at_usage = request(
        &app,
        Method::PATCH,
        &format!("/api/admin/accounts/{member_id}"),
        Some(&owner_session),
        Some(&owner_session.csrf_token),
        Some(json!({"quotaBytes": 8})),
    )
    .await;
    assert_eq!(quota_at_usage.status(), StatusCode::NO_CONTENT);

    let cancel = request(
        &app,
        Method::DELETE,
        &format!("/api/uploads/{upload_id}"),
        Some(&member_session),
        Some(&member_session.csrf_token),
        None,
    )
    .await;
    assert_eq!(cancel.status(), StatusCode::NO_CONTENT);
    let summary = response_json(
        request(
            &app,
            Method::GET,
            "/api/admin/accounts",
            Some(&owner_session),
            None,
            None,
        )
        .await,
    )
    .await;
    assert_eq!(summary["accounts"][0]["reservedBytes"], 0);
    let quota_below_used = request(
        &app,
        Method::PATCH,
        &format!("/api/admin/accounts/{member_id}"),
        Some(&owner_session),
        Some(&owner_session.csrf_token),
        Some(json!({"quotaBytes": 3})),
    )
    .await;
    assert_eq!(quota_below_used.status(), StatusCode::CONFLICT);

    let quota_with_room = request(
        &app,
        Method::PATCH,
        &format!("/api/admin/accounts/{member_id}"),
        Some(&owner_session),
        Some(&owner_session.csrf_token),
        Some(json!({"quotaBytes": 20})),
    )
    .await;
    assert_eq!(quota_with_room.status(), StatusCode::NO_CONTENT);
    let finalizing_upload_id = seed_finalizing_upload_file(&pool, member_id, 10).await;
    let finalizing_summary = response_json(
        request(
            &app,
            Method::GET,
            "/api/admin/accounts",
            Some(&owner_session),
            None,
            None,
        )
        .await,
    )
    .await;
    assert_eq!(finalizing_summary["accounts"][0]["usedBytes"], 4);
    assert_eq!(finalizing_summary["accounts"][0]["reservedBytes"], 10);

    let quota_below_finalizing_reservation = request(
        &app,
        Method::PATCH,
        &format!("/api/admin/accounts/{member_id}"),
        Some(&owner_session),
        Some(&owner_session.csrf_token),
        Some(json!({"quotaBytes": 13})),
    )
    .await;
    assert_eq!(
        quota_below_finalizing_reservation.status(),
        StatusCode::CONFLICT,
        "quota edits must include finalizing reservations"
    );

    let upload_during_finalization = request(
        &app,
        Method::POST,
        "/api/uploads",
        Some(&member_session),
        Some(&member_session.csrf_token),
        Some(json!({"filename": "during-finalize.bin", "expected_size": 5, "parent_id": null})),
    )
    .await;
    assert_eq!(
        upload_during_finalization.status(),
        StatusCode::CREATED,
        "pending finalizing bytes must not be counted as both used bytes and a reservation"
    );
    let additional_upload_id = Uuid::parse_str(
        response_json(upload_during_finalization).await["id"]
            .as_str()
            .unwrap(),
    )
    .unwrap();

    let cancel_additional_upload = request(
        &app,
        Method::DELETE,
        &format!("/api/uploads/{additional_upload_id}"),
        Some(&member_session),
        Some(&member_session.csrf_token),
        None,
    )
    .await;
    assert_eq!(cancel_additional_upload.status(), StatusCode::NO_CONTENT);
    cleanup_finalizing_upload_file(&pool, finalizing_upload_id).await;
    let quota_below_used_after_finalization = request(
        &app,
        Method::PATCH,
        &format!("/api/admin/accounts/{member_id}"),
        Some(&owner_session),
        Some(&owner_session.csrf_token),
        Some(json!({"quotaBytes": 3})),
    )
    .await;
    assert_eq!(
        quota_below_used_after_finalization.status(),
        StatusCode::CONFLICT
    );

    cleanup_seed_file(&pool, member_id).await;
    cleanup_users(&pool, &[member_id, owner_id]).await;
    drop(storage);
    pool.close().await;
}

async fn setup() -> (PgPool, Router, tempfile::TempDir) {
    let database_url = std::env::var("TEST_DATABASE_URL")
        .expect("set TEST_DATABASE_URL to a disposable PostgreSQL database");
    let pool = PgPoolOptions::new()
        .max_connections(12)
        .connect(&database_url)
        .await
        .expect("connect to disposable PostgreSQL");
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("apply migrations");
    let storage = tempfile::tempdir().expect("create temporary storage");
    let config = Config {
        database_url: "postgres://not-used-in-test".to_owned(),
        bind_addr: "127.0.0.1:3000".parse::<SocketAddr>().unwrap(),
        storage_root: storage.path().to_path_buf(),
        expected_mount: storage.path().to_path_buf(),
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
        google_drive: None,
    };
    let local_storage = LocalStorage::initialize(&config).expect("initialize test storage");
    let app = api::router(AppState {
        pool: pool.clone(),
        storage: local_storage,
        media_preview: None,
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
    (pool, app, storage)
}

async fn insert_user(
    pool: &PgPool,
    role: &str,
    managed_by: Option<Uuid>,
    quota_bytes: Option<i64>,
    must_change_password: bool,
) -> Uuid {
    let id = Uuid::new_v4();
    let email = format!("{role}-{id}@example.test");
    sqlx::query("INSERT INTO users (id, email, password_hash, role, managed_by, quota_bytes, must_change_password) VALUES ($1, $2, 'test-only-hash', $3, $4, $5, $6)")
        .bind(id).bind(email).bind(role).bind(managed_by).bind(quota_bytes).bind(must_change_password)
        .execute(pool).await.expect("insert test user");
    id
}

async fn insert_session(pool: &PgPool, user_id: Uuid) -> TestSession {
    let session_id = Uuid::new_v4();
    let (session_raw, session_token) = random_token();
    let (csrf_raw, csrf_token) = random_token();
    sqlx::query("INSERT INTO sessions (id, user_id, token_digest, csrf_token_digest, expires_at) VALUES ($1, $2, $3, $4, $5)")
        .bind(session_id).bind(user_id).bind(Sha256::digest(session_raw).to_vec()).bind(Sha256::digest(csrf_raw).to_vec()).bind(Utc::now() + chrono::Duration::hours(1))
        .execute(pool).await.expect("insert test session");
    TestSession {
        cookie_header: format!("my_drive_session={session_token}; my_drive_csrf={csrf_token}"),
        csrf_token,
    }
}

async fn insert_member(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    manager_id: Uuid,
    member_id: Uuid,
) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT INTO users (id, email, password_hash, role, managed_by, quota_bytes) VALUES ($1, $2, 'test-only-hash', 'member', $3, 0)")
        .bind(member_id)
        .bind(format!("member-{member_id}@example.test"))
        .bind(manager_id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

async fn spawn_member_insert(
    pool: PgPool,
    manager_id: Uuid,
    member_id: Uuid,
) -> (i32, JoinHandle<Result<(), sqlx::Error>>) {
    let (pid_sender, pid_receiver) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        let mut tx = pool.begin().await?;
        let pid = sqlx::query_scalar::<_, i32>("SELECT pg_backend_pid()")
            .fetch_one(&mut *tx)
            .await?;
        let _ = pid_sender.send(pid);
        insert_member(&mut tx, manager_id, member_id).await?;
        tx.commit().await
    });
    let pid = timeout(Duration::from_secs(5), pid_receiver)
        .await
        .expect("member insert should acquire a database connection")
        .expect("member insert task should report its backend PID");
    (pid, task)
}

async fn spawn_owner_demotion(
    pool: PgPool,
    owner_id: Uuid,
) -> (i32, JoinHandle<Result<(), sqlx::Error>>) {
    let (pid_sender, pid_receiver) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        let mut connection = pool.acquire().await?;
        let pid = sqlx::query_scalar::<_, i32>("SELECT pg_backend_pid()")
            .fetch_one(&mut *connection)
            .await?;
        let _ = pid_sender.send(pid);
        sqlx::query("UPDATE users SET role = 'admin' WHERE id = $1")
            .bind(owner_id)
            .execute(&mut *connection)
            .await?;
        Ok(())
    });
    let pid = timeout(Duration::from_secs(5), pid_receiver)
        .await
        .expect("demotion should acquire a database connection")
        .expect("demotion task should report its backend PID");
    (pid, task)
}

async fn backend_is_waiting_on_lock(pool: &PgPool, pid: i32) -> bool {
    timeout(Duration::from_secs(5), async {
        loop {
            let waiting = sqlx::query_scalar::<_, bool>(
                "SELECT COALESCE((SELECT wait_event_type = 'Lock' FROM pg_stat_activity WHERE pid = $1), FALSE)",
            )
            .bind(pid)
            .fetch_one(pool)
            .await
            .unwrap();
            if waiting {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .is_ok()
}

fn is_check_violation(result: &Result<(), sqlx::Error>) -> bool {
    matches!(result, Err(sqlx::Error::Database(error)) if error.code().as_deref() == Some("23514"))
}

async fn login(app: &Router, email: &str, password: &str) -> (TestSession, Value) {
    let response = request(
        app,
        Method::POST,
        "/api/auth/login",
        None,
        None,
        Some(json!({"email": email, "password": password})),
    )
    .await;
    let status = response.status();
    let cookies = response
        .headers()
        .get_all(SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok().map(str::to_owned))
        .collect::<Vec<_>>();
    let body = response_json(response).await;
    if status != StatusCode::OK {
        return (
            TestSession {
                cookie_header: String::new(),
                csrf_token: String::new(),
            },
            body,
        );
    }
    let session_cookie = cookies
        .iter()
        .find(|cookie| cookie.starts_with("my_drive_session="))
        .and_then(|cookie| cookie.split(';').next())
        .expect("session cookie");
    let csrf_cookie = cookies
        .iter()
        .find(|cookie| cookie.starts_with("my_drive_csrf="))
        .and_then(|cookie| cookie.split(';').next())
        .expect("CSRF cookie");
    let csrf_token = body["csrf_token"]
        .as_str()
        .expect("CSRF response token")
        .to_owned();
    (
        TestSession {
            cookie_header: format!("{session_cookie}; {csrf_cookie}"),
            csrf_token,
        },
        body,
    )
}

async fn request(
    app: &Router,
    method: Method,
    uri: &str,
    session: Option<&TestSession>,
    csrf: Option<&str>,
    body: Option<Value>,
) -> Response {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(session) = session {
        builder = builder.header(COOKIE, &session.cookie_header);
    }
    if let Some(csrf) = csrf {
        builder = builder.header("x-csrf-token", csrf);
    }
    if body.is_some() {
        builder = builder.header(CONTENT_TYPE, "application/json");
    }
    app.clone()
        .oneshot(
            builder
                .body(body.map_or_else(Body::empty, |value| Body::from(value.to_string())))
                .unwrap(),
        )
        .await
        .unwrap()
}

async fn response_json(response: Response) -> Value {
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
        .expect("JSON response")
}

fn random_token() -> (Vec<u8>, String) {
    let first = Uuid::new_v4();
    let second = Uuid::new_v4();
    let mut raw = Vec::with_capacity(32);
    raw.extend_from_slice(first.as_bytes());
    raw.extend_from_slice(second.as_bytes());
    (raw.clone(), URL_SAFE_NO_PAD.encode(raw))
}

async fn seed_used_file(pool: &PgPool, owner_id: Uuid, size: i64) {
    let id = Uuid::new_v4();
    let object_id = Uuid::new_v4();
    let version_id = Uuid::new_v4();
    let key = format!("aa/bb/{}", Uuid::new_v4());
    sqlx::query(
        "INSERT INTO drive_entries (id, owner_id, kind, name) VALUES ($1, $2, 'file', 'used.bin')",
    )
    .bind(id)
    .bind(owner_id)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO files (id) VALUES ($1)")
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO storage_objects (id, storage_key, size_bytes, checksum_sha256, state) VALUES ($1, $2, $3, repeat('a', 64), 'ready')").bind(object_id).bind(key).bind(size).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO file_versions (id, file_id, storage_object_id, size_bytes) VALUES ($1, $2, $3, $4)").bind(version_id).bind(id).bind(object_id).bind(size).execute(pool).await.unwrap();
    sqlx::query("UPDATE files SET current_version_id = $1 WHERE id = $2")
        .bind(version_id)
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
}

async fn seed_finalizing_upload_file(pool: &PgPool, owner_id: Uuid, size: i64) -> Uuid {
    let upload_id = Uuid::new_v4();
    let staging_key = Uuid::new_v4();
    let file_id = Uuid::new_v4();
    let object_id = Uuid::new_v4();
    let version_id = Uuid::new_v4();
    let object_key = LocalStorage::storage_key(object_id);
    sqlx::query("INSERT INTO storage_objects (id, storage_key, size_bytes, state) VALUES ($1, $2, $3, 'pending')")
        .bind(object_id).bind(object_key).bind(size).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO drive_entries (id, owner_id, kind, name) VALUES ($1, $2, 'file', 'finalizing.bin')")
        .bind(file_id).bind(owner_id).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO files (id) VALUES ($1)")
        .bind(file_id)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO file_versions (id, file_id, storage_object_id, size_bytes) VALUES ($1, $2, $3, $4)")
        .bind(version_id).bind(file_id).bind(object_id).bind(size).execute(pool).await.unwrap();
    sqlx::query("UPDATE files SET current_version_id = $1 WHERE id = $2")
        .bind(version_id)
        .bind(file_id)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO upload_sessions (id, owner_id, filename, expected_size, received_size, staging_key, state, expires_at, storage_object_id, final_file_id) VALUES ($1, $2, 'finalizing.bin', $3, $3, $4, 'finalizing', now() - interval '1 hour', $5, $6)")
        .bind(upload_id).bind(owner_id).bind(size).bind(staging_key).bind(object_id).bind(file_id).execute(pool).await.unwrap();
    upload_id
}

async fn cleanup_finalizing_upload_file(pool: &PgPool, upload_id: Uuid) {
    let (file_id, object_id): (Uuid, Uuid) = sqlx::query_as(
        "SELECT final_file_id, storage_object_id FROM upload_sessions WHERE id = $1",
    )
    .bind(upload_id)
    .fetch_one(pool)
    .await
    .unwrap();
    sqlx::query("DELETE FROM upload_sessions WHERE id = $1")
        .bind(upload_id)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("UPDATE files SET current_version_id = NULL WHERE id = $1")
        .bind(file_id)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM file_versions WHERE file_id = $1")
        .bind(file_id)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM files WHERE id = $1")
        .bind(file_id)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM storage_objects WHERE id = $1")
        .bind(object_id)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM drive_entries WHERE id = $1")
        .bind(file_id)
        .execute(pool)
        .await
        .unwrap();
}

async fn cleanup_seed_file(pool: &PgPool, owner_id: Uuid) {
    let entries = sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM drive_entries WHERE owner_id = $1 AND name = 'used.bin'",
    )
    .bind(owner_id)
    .fetch_all(pool)
    .await
    .unwrap();
    for id in entries {
        sqlx::query("UPDATE files SET current_version_id = NULL WHERE id = $1")
            .bind(id)
            .execute(pool)
            .await
            .unwrap();
        let objects = sqlx::query_scalar::<_, Uuid>(
            "SELECT storage_object_id FROM file_versions WHERE file_id = $1",
        )
        .bind(id)
        .fetch_all(pool)
        .await
        .unwrap();
        sqlx::query("DELETE FROM file_versions WHERE file_id = $1")
            .bind(id)
            .execute(pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM files WHERE id = $1")
            .bind(id)
            .execute(pool)
            .await
            .unwrap();
        for object in objects {
            sqlx::query("DELETE FROM storage_objects WHERE id = $1")
                .bind(object)
                .execute(pool)
                .await
                .unwrap();
        }
        sqlx::query("DELETE FROM drive_entries WHERE id = $1")
            .bind(id)
            .execute(pool)
            .await
            .unwrap();
    }
}

async fn cleanup_users(pool: &PgPool, user_ids: &[Uuid]) {
    sqlx::query("DELETE FROM audit_events WHERE actor_id = ANY($1)")
        .bind(user_ids)
        .execute(pool)
        .await
        .unwrap();
    for user_id in user_ids {
        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user_id)
            .execute(pool)
            .await
            .unwrap();
    }
}
