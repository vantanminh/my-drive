use std::{net::SocketAddr, path::Path};

use axum::{
    Router,
    body::Body,
    http::{
        Method, Request, StatusCode,
        header::{CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, COOKIE},
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
async fn streamed_upload_resumes_finalizes_and_supports_private_byte_ranges() {
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
    let parent_id = insert_folder(&pool, owner_id, "uploads").await;
    let other_owner = insert_owner(&pool).await;
    let other_session = insert_session(&pool, other_owner).await;
    let temporary_storage = tempfile::tempdir().expect("create temporary HDD storage");
    let mut app = make_app(pool.clone(), temporary_storage.path());

    let create_payload = json!({
        "filename": "résumé.bin",
        "expected_size": 10,
        "parent_id": parent_id
    });
    let unauthenticated_create = request(
        &app,
        Method::POST,
        "/api/uploads",
        None,
        None,
        Some("application/json"),
        &[],
        Body::from(create_payload.to_string()),
    )
    .await;
    assert_eq!(unauthenticated_create.status(), StatusCode::UNAUTHORIZED);

    let bad_csrf_create = request(
        &app,
        Method::POST,
        "/api/uploads",
        Some(&session),
        Some("invalid-csrf-token"),
        Some("application/json"),
        &[],
        Body::from(create_payload.to_string()),
    )
    .await;
    assert_eq!(bad_csrf_create.status(), StatusCode::FORBIDDEN);

    let created = request(
        &app,
        Method::POST,
        "/api/uploads",
        Some(&session),
        Some(&session.csrf_token),
        Some("application/json"),
        &[],
        Body::from(create_payload.to_string()),
    )
    .await;
    assert_eq!(created.status(), StatusCode::CREATED);
    assert_eq!(created.headers()["upload-offset"], "0");
    assert_eq!(created.headers()["upload-length"], "10");
    let create_body = response_json(created).await;
    let upload_id = create_body["id"]
        .as_str()
        .expect("created upload id")
        .parse::<Uuid>()
        .expect("upload id is a UUID");

    let over_quota = request(
        &app,
        Method::POST,
        "/api/uploads",
        Some(&session),
        Some(&session.csrf_token),
        Some("application/json"),
        &[],
        Body::from(json!({ "filename": "too-large.bin", "expected_size": 1015 }).to_string()),
    )
    .await;
    assert_eq!(over_quota.status(), StatusCode::INSUFFICIENT_STORAGE);

    let invalid_filename = request(
        &app,
        Method::POST,
        "/api/uploads",
        Some(&session),
        Some(&session.csrf_token),
        Some("application/json"),
        &[],
        Body::from(json!({ "filename": "../outside", "expected_size": 1 }).to_string()),
    )
    .await;
    assert_eq!(invalid_filename.status(), StatusCode::BAD_REQUEST);

    let unauthorized_patch = request(
        &app,
        Method::PATCH,
        &format!("/api/uploads/{upload_id}"),
        None,
        None,
        Some("application/offset+octet-stream"),
        &[("Upload-Offset", "0")],
        Body::from("0"),
    )
    .await;
    assert_eq!(unauthorized_patch.status(), StatusCode::UNAUTHORIZED);

    let bad_csrf_patch = request(
        &app,
        Method::PATCH,
        &format!("/api/uploads/{upload_id}"),
        Some(&session),
        Some("invalid-csrf-token"),
        Some("application/offset+octet-stream"),
        &[("Upload-Offset", "0")],
        Body::from("0"),
    )
    .await;
    assert_eq!(bad_csrf_patch.status(), StatusCode::FORBIDDEN);

    let wrong_offset = request(
        &app,
        Method::PATCH,
        &format!("/api/uploads/{upload_id}"),
        Some(&session),
        Some(&session.csrf_token),
        Some("application/offset+octet-stream"),
        &[("Upload-Offset", "1")],
        Body::from("X"),
    )
    .await;
    assert_eq!(wrong_offset.status(), StatusCode::CONFLICT);
    assert_eq!(wrong_offset.headers()["upload-offset"], "0");

    let foreign_head = request(
        &app,
        Method::HEAD,
        &format!("/api/uploads/{upload_id}"),
        Some(&other_session),
        None,
        None,
        &[],
        Body::empty(),
    )
    .await;
    assert_eq!(foreign_head.status(), StatusCode::NOT_FOUND);

    let bad_csrf_finalize = request(
        &app,
        Method::POST,
        &format!("/api/uploads/{upload_id}/finalize"),
        Some(&session),
        Some("invalid-csrf-token"),
        None,
        &[],
        Body::empty(),
    )
    .await;
    assert_eq!(bad_csrf_finalize.status(), StatusCode::FORBIDDEN);

    let bad_csrf_cancel = request(
        &app,
        Method::DELETE,
        &format!("/api/uploads/{upload_id}"),
        Some(&session),
        Some("invalid-csrf-token"),
        None,
        &[],
        Body::empty(),
    )
    .await;
    assert_eq!(bad_csrf_cancel.status(), StatusCode::FORBIDDEN);

    let first_chunk = request(
        &app,
        Method::PATCH,
        &format!("/api/uploads/{upload_id}"),
        Some(&session),
        Some(&session.csrf_token),
        Some("application/offset+octet-stream"),
        &[("Upload-Offset", "0")],
        Body::from(b"\x89PNG".to_vec()),
    )
    .await;
    assert_eq!(first_chunk.status(), StatusCode::NO_CONTENT);
    assert_eq!(first_chunk.headers()["upload-offset"], "4");

    drop(app);
    app = make_app(pool.clone(), temporary_storage.path());

    let resumed = request(
        &app,
        Method::HEAD,
        &format!("/api/uploads/{upload_id}"),
        Some(&session),
        None,
        None,
        &[],
        Body::empty(),
    )
    .await;
    assert_eq!(resumed.status(), StatusCode::NO_CONTENT);
    assert_eq!(resumed.headers()["upload-offset"], "4");
    assert_eq!(resumed.headers()["upload-length"], "10");

    let final_chunk = request(
        &app,
        Method::PATCH,
        &format!("/api/uploads/{upload_id}"),
        Some(&session),
        Some(&session.csrf_token),
        Some("application/offset+octet-stream"),
        &[("Upload-Offset", "4")],
        Body::from(b"\r\n\x1a\nxy".to_vec()),
    )
    .await;
    assert_eq!(final_chunk.status(), StatusCode::NO_CONTENT);
    assert_eq!(final_chunk.headers()["upload-offset"], "10");

    let finalize_path = format!("/api/uploads/{upload_id}/finalize");
    let (finalized, concurrent_finalize) = tokio::join!(
        request(
            &app,
            Method::POST,
            &finalize_path,
            Some(&session),
            Some(&session.csrf_token),
            None,
            &[],
            Body::empty(),
        ),
        request(
            &app,
            Method::POST,
            &finalize_path,
            Some(&session),
            Some(&session.csrf_token),
            None,
            &[],
            Body::empty(),
        ),
    );
    assert_eq!(finalized.status(), StatusCode::OK);
    assert_eq!(concurrent_finalize.status(), StatusCode::OK);
    let finalized_body = response_json(finalized).await;
    let concurrent_finalize_body = response_json(concurrent_finalize).await;
    let file_id = finalized_body["file_id"]
        .as_str()
        .expect("finalized file id")
        .parse::<Uuid>()
        .expect("file id is a UUID");
    assert_eq!(finalized_body["status"], "completed");
    assert_eq!(concurrent_finalize_body["file_id"], file_id.to_string());
    assert_eq!(concurrent_finalize_body["status"], "completed");

    let storage_object_id: Uuid = sqlx::query_scalar(
        "SELECT version.storage_object_id FROM files AS file \
           JOIN file_versions AS version ON version.id = file.current_version_id \
          WHERE file.id = $1",
    )
    .bind(file_id)
    .fetch_one(&pool)
    .await
    .expect("find finalized storage object");
    let (storage_key, staging_key): (String, Uuid) = sqlx::query_as(
        "SELECT object.storage_key, upload.staging_key \
           FROM upload_sessions AS upload \
           JOIN storage_objects AS object ON object.id = upload.storage_object_id \
          WHERE upload.id = $1",
    )
    .bind(upload_id)
    .fetch_one(&pool)
    .await
    .expect("inspect finalization recovery keys");
    let disk_path = storage_path(temporary_storage.path(), &storage_key);
    let staging_path = temporary_storage
        .path()
        .join("uploads")
        .join(format!("{staging_key}.part"));

    tokio::fs::rename(&disk_path, &staging_path)
        .await
        .expect("restore the pending staging object");
    simulate_finalization_crash(&pool, owner_id, upload_id, file_id, storage_object_id).await;
    let recovered_before_rename = request(
        &app,
        Method::POST,
        &format!("/api/uploads/{upload_id}/finalize"),
        Some(&session),
        Some(&session.csrf_token),
        None,
        &[],
        Body::empty(),
    )
    .await;
    assert_eq!(recovered_before_rename.status(), StatusCode::OK);
    assert_eq!(
        response_json(recovered_before_rename).await["file_id"],
        file_id.to_string()
    );

    simulate_finalization_crash(&pool, owner_id, upload_id, file_id, storage_object_id).await;
    let recovered_after_rename = request(
        &app,
        Method::POST,
        &format!("/api/uploads/{upload_id}/finalize"),
        Some(&session),
        Some(&session.csrf_token),
        None,
        &[],
        Body::empty(),
    )
    .await;
    assert_eq!(recovered_after_rename.status(), StatusCode::OK);
    assert_eq!(
        response_json(recovered_after_rename).await["file_id"],
        file_id.to_string()
    );

    let repeated_finalize = request(
        &app,
        Method::POST,
        &format!("/api/uploads/{upload_id}/finalize"),
        Some(&session),
        Some(&session.csrf_token),
        None,
        &[],
        Body::empty(),
    )
    .await;
    assert_eq!(repeated_finalize.status(), StatusCode::OK);
    assert_eq!(
        response_json(repeated_finalize).await["file_id"],
        file_id.to_string()
    );

    let (storage_key, checksum, object_state): (String, String, String) = sqlx::query_as(
        "SELECT object.storage_key, object.checksum_sha256, object.state \
           FROM files AS file \
           JOIN file_versions AS version ON version.id = file.current_version_id \
           JOIN storage_objects AS object ON object.id = version.storage_object_id \
          WHERE file.id = $1",
    )
    .bind(file_id)
    .fetch_one(&pool)
    .await
    .expect("inspect finalized storage object");
    assert_eq!(object_state, "ready");
    assert_eq!(checksum.len(), 64);
    assert!(!storage_key.contains("résumé"));
    let disk_path = storage_path(temporary_storage.path(), &storage_key);
    assert_eq!(
        tokio::fs::read(&disk_path).await.unwrap(),
        b"\x89PNG\r\n\x1a\nxy"
    );
    let stored_mime: Option<String> =
        sqlx::query_scalar("SELECT mime_detected FROM storage_objects WHERE storage_key = $1")
            .bind(&storage_key)
            .fetch_one(&pool)
            .await
            .expect("inspect media type detected during upload finalization");
    assert_eq!(stored_mime.as_deref(), Some("image/png"));
    let (queued_images, queued_state): (i64, Option<String>) = sqlx::query_as(
        "SELECT COUNT(*), MIN(state) FROM media_index_jobs AS job \
           JOIN file_versions AS version ON version.id = job.file_version_id \
          WHERE version.file_id = $1 AND job.task = 'image_preview' AND job.recipe_version = 1",
    )
    .bind(file_id)
    .fetch_one(&pool)
    .await
    .expect("inspect queued image-index job");
    assert_eq!(queued_images, 1);
    assert_eq!(queued_state.as_deref(), Some("queued"));

    let download = request(
        &app,
        Method::GET,
        &format!("/api/files/{file_id}/download"),
        Some(&session),
        None,
        None,
        &[],
        Body::empty(),
    )
    .await;
    assert_eq!(download.status(), StatusCode::OK);
    assert_eq!(download.headers()[CONTENT_TYPE], "application/octet-stream");
    assert_eq!(download.headers()[CONTENT_LENGTH], "10");
    assert_eq!(download.headers()["x-content-type-options"], "nosniff");
    assert!(
        download.headers()["content-disposition"]
            .to_str()
            .unwrap()
            .contains("filename*=UTF-8''r%C3%A9sum%C3%A9.bin")
    );
    assert_eq!(
        response_bytes(download).await.as_slice(),
        b"\x89PNG\r\n\x1a\nxy"
    );

    let inline_preview = request(
        &app,
        Method::GET,
        &format!("/api/files/{file_id}/preview"),
        Some(&session),
        None,
        None,
        &[],
        Body::empty(),
    )
    .await;
    assert_eq!(inline_preview.status(), StatusCode::OK);
    assert_eq!(inline_preview.headers()[CONTENT_TYPE], "image/png");
    assert!(
        inline_preview.headers()["content-disposition"]
            .to_str()
            .unwrap()
            .starts_with("inline;")
    );
    assert_eq!(
        response_bytes(inline_preview).await.as_slice(),
        b"\x89PNG\r\n\x1a\nxy"
    );

    let range_download = request(
        &app,
        Method::GET,
        &format!("/api/files/{file_id}/download"),
        Some(&session),
        None,
        None,
        &[("Range", "bytes=2-5")],
        Body::empty(),
    )
    .await;
    assert_eq!(range_download.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(range_download.headers()[CONTENT_RANGE], "bytes 2-5/10");
    assert_eq!(range_download.headers()[CONTENT_LENGTH], "4");
    assert_eq!(response_bytes(range_download).await.as_slice(), b"NG\r\n");

    let unsatisfiable = request(
        &app,
        Method::GET,
        &format!("/api/files/{file_id}/download"),
        Some(&session),
        None,
        None,
        &[("Range", "bytes=10-")],
        Body::empty(),
    )
    .await;
    assert_eq!(unsatisfiable.status(), StatusCode::RANGE_NOT_SATISFIABLE);
    assert_eq!(unsatisfiable.headers()[CONTENT_RANGE], "bytes */10");

    let head_file = request(
        &app,
        Method::HEAD,
        &format!("/api/files/{file_id}/download"),
        Some(&session),
        None,
        None,
        &[],
        Body::empty(),
    )
    .await;
    assert_eq!(head_file.status(), StatusCode::OK);
    assert_eq!(head_file.headers()[CONTENT_LENGTH], "10");
    assert!(response_bytes(head_file).await.is_empty());

    let cancelled_body = json!({ "filename": "cancel-me.bin", "expected_size": 2 });
    let cancelled = request(
        &app,
        Method::POST,
        "/api/uploads",
        Some(&session),
        Some(&session.csrf_token),
        Some("application/json"),
        &[],
        Body::from(cancelled_body.to_string()),
    )
    .await;
    assert_eq!(cancelled.status(), StatusCode::CREATED);
    let cancelled_id = response_json(cancelled).await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let cancelled_result = request(
        &app,
        Method::DELETE,
        &format!("/api/uploads/{cancelled_id}"),
        Some(&session),
        Some(&session.csrf_token),
        None,
        &[],
        Body::empty(),
    )
    .await;
    assert_eq!(cancelled_result.status(), StatusCode::NO_CONTENT);
    let cancelled_head = request(
        &app,
        Method::HEAD,
        &format!("/api/uploads/{cancelled_id}"),
        Some(&session),
        None,
        None,
        &[],
        Body::empty(),
    )
    .await;
    assert_eq!(cancelled_head.status(), StatusCode::GONE);

    let completed_upload_events: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events WHERE event_type = 'upload_completed' AND actor_id = $1 AND resource_id = $2",
    )
    .bind(owner_id)
    .bind(file_id)
    .fetch_one(&pool)
    .await
    .expect("inspect upload audit event");
    assert_eq!(completed_upload_events, 1);

    pool.close().await;
}

#[tokio::test]
#[ignore = "requires a disposable PostgreSQL database in TEST_DATABASE_URL"]
async fn inline_media_preview_sniffs_content_preserves_ranges_and_checks_owner() {
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
    let app = make_app(pool.clone(), temporary_storage.path());

    let image_id = seed_file(
        &pool,
        owner_id,
        temporary_storage.path(),
        "disguised.txt",
        b"\x89PNG\r\n\x1a\nabcdef",
    )
    .await;
    let image_preview = request(
        &app,
        Method::GET,
        &format!("/api/files/{image_id}/preview"),
        Some(&owner_session),
        None,
        None,
        &[],
        Body::empty(),
    )
    .await;
    assert_eq!(image_preview.status(), StatusCode::OK);
    assert_eq!(image_preview.headers()[CONTENT_TYPE], "image/png");
    assert!(
        image_preview.headers()["content-disposition"]
            .to_str()
            .unwrap()
            .starts_with("inline;")
    );
    assert_eq!(image_preview.headers()["x-content-type-options"], "nosniff");
    assert_eq!(
        image_preview.headers()["content-security-policy"],
        "default-src 'none'; sandbox"
    );
    let image_etag = image_preview.headers()["etag"].to_str().unwrap().to_owned();
    assert_eq!(
        response_bytes(image_preview).await.as_slice(),
        b"\x89PNG\r\n\x1a\nabcdef"
    );

    let image_range = request(
        &app,
        Method::GET,
        &format!("/api/files/{image_id}/preview"),
        Some(&owner_session),
        None,
        None,
        &[("Range", "bytes=1-3")],
        Body::empty(),
    )
    .await;
    assert_eq!(image_range.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(image_range.headers()[CONTENT_TYPE], "image/png");
    assert_eq!(image_range.headers()[CONTENT_RANGE], "bytes 1-3/14");
    assert_eq!(response_bytes(image_range).await.as_slice(), b"PNG");

    let matching_if_range = request(
        &app,
        Method::GET,
        &format!("/api/files/{image_id}/preview"),
        Some(&owner_session),
        None,
        None,
        &[("Range", "bytes=1-3"), ("If-Range", &image_etag)],
        Body::empty(),
    )
    .await;
    assert_eq!(matching_if_range.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(response_bytes(matching_if_range).await.as_slice(), b"PNG");

    let stale_if_range = request(
        &app,
        Method::GET,
        &format!("/api/files/{image_id}/preview"),
        Some(&owner_session),
        None,
        None,
        &[("Range", "bytes=1-3"), ("If-Range", "\"stale\"")],
        Body::empty(),
    )
    .await;
    assert_eq!(stale_if_range.status(), StatusCode::OK);
    assert_eq!(
        response_bytes(stale_if_range).await.as_slice(),
        b"\x89PNG\r\n\x1a\nabcdef"
    );

    let image_head = request(
        &app,
        Method::HEAD,
        &format!("/api/files/{image_id}/preview"),
        Some(&owner_session),
        None,
        None,
        &[],
        Body::empty(),
    )
    .await;
    assert_eq!(image_head.status(), StatusCode::OK);
    assert_eq!(image_head.headers()[CONTENT_TYPE], "image/png");
    assert!(response_bytes(image_head).await.is_empty());

    let foreign_preview = request(
        &app,
        Method::GET,
        &format!("/api/files/{image_id}/preview"),
        Some(&other_session),
        None,
        None,
        &[],
        Body::empty(),
    )
    .await;
    assert_eq!(foreign_preview.status(), StatusCode::NOT_FOUND);

    let video_id = seed_file(
        &pool,
        owner_id,
        temporary_storage.path(),
        "clip.bin",
        b"\x00\x00\x00\x18ftypisom1234video-data",
    )
    .await;
    let video_preview = request(
        &app,
        Method::GET,
        &format!("/api/files/{video_id}/preview"),
        Some(&owner_session),
        None,
        None,
        &[],
        Body::empty(),
    )
    .await;
    assert_eq!(video_preview.status(), StatusCode::OK);
    assert_eq!(video_preview.headers()[CONTENT_TYPE], "video/mp4");
    assert_eq!(video_preview.status(), StatusCode::OK);
    let _ = response_bytes(video_preview).await;

    let svg_id = seed_file(
        &pool,
        owner_id,
        temporary_storage.path(),
        "active.svg",
        b"<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>",
    )
    .await;
    let svg_preview = request(
        &app,
        Method::GET,
        &format!("/api/files/{svg_id}/preview"),
        Some(&owner_session),
        None,
        None,
        &[],
        Body::empty(),
    )
    .await;
    assert_eq!(svg_preview.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);

    let svg_download = request(
        &app,
        Method::GET,
        &format!("/api/files/{svg_id}/download"),
        Some(&owner_session),
        None,
        None,
        &[],
        Body::empty(),
    )
    .await;
    assert_eq!(svg_download.status(), StatusCode::OK);
    assert_eq!(
        svg_download.headers()[CONTENT_TYPE],
        "application/octet-stream"
    );
    assert!(
        svg_download.headers()["content-disposition"]
            .to_str()
            .unwrap()
            .starts_with("attachment;")
    );

    pool.close().await;
}

async fn seed_file(
    pool: &PgPool,
    owner_id: Uuid,
    storage_root: &Path,
    name: &str,
    payload: &[u8],
) -> Uuid {
    let file_id = Uuid::new_v4();
    let object_id = Uuid::new_v4();
    let version_id = Uuid::new_v4();
    let storage_key = LocalStorage::storage_key(object_id);
    let object_path = storage_path(storage_root, &storage_key);
    tokio::fs::create_dir_all(object_path.parent().unwrap())
        .await
        .expect("create object shard");
    tokio::fs::write(&object_path, payload)
        .await
        .expect("write fixture payload");
    let checksum = Sha256::digest(payload)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();

    sqlx::query("INSERT INTO drive_entries (id, owner_id, kind, name) VALUES ($1, $2, 'file', $3)")
        .bind(file_id)
        .bind(owner_id)
        .bind(name)
        .execute(pool)
        .await
        .expect("insert file entry");
    sqlx::query("INSERT INTO files (id) VALUES ($1)")
        .bind(file_id)
        .execute(pool)
        .await
        .expect("insert file record");
    sqlx::query(
        "INSERT INTO storage_objects (id, storage_key, size_bytes, checksum_sha256, state) \
         VALUES ($1, $2, $3, $4, 'ready')",
    )
    .bind(object_id)
    .bind(storage_key)
    .bind(i64::try_from(payload.len()).expect("fixture size fits i64"))
    .bind(checksum)
    .execute(pool)
    .await
    .expect("insert storage object");
    sqlx::query(
        "INSERT INTO file_versions (id, file_id, storage_object_id, size_bytes) \
         VALUES ($1, $2, $3, $4)",
    )
    .bind(version_id)
    .bind(file_id)
    .bind(object_id)
    .bind(i64::try_from(payload.len()).expect("fixture size fits i64"))
    .execute(pool)
    .await
    .expect("insert file version");
    sqlx::query("UPDATE files SET current_version_id = $1 WHERE id = $2")
        .bind(version_id)
        .bind(file_id)
        .execute(pool)
        .await
        .expect("set current file version");
    file_id
}

async fn simulate_finalization_crash(
    pool: &PgPool,
    owner_id: Uuid,
    upload_id: Uuid,
    file_id: Uuid,
    storage_object_id: Uuid,
) {
    sqlx::query(
        "UPDATE storage_objects SET state = 'pending', checksum_sha256 = NULL WHERE id = $1",
    )
    .bind(storage_object_id)
    .execute(pool)
    .await
    .expect("reset object to pending for recovery check");
    sqlx::query("UPDATE upload_sessions SET state = 'finalizing' WHERE id = $1 AND owner_id = $2")
        .bind(upload_id)
        .bind(owner_id)
        .execute(pool)
        .await
        .expect("reset upload to finalizing for recovery check");
    sqlx::query(
        "DELETE FROM audit_events \
          WHERE event_type = 'upload_completed' AND actor_id = $1 AND resource_id = $2",
    )
    .bind(owner_id)
    .bind(file_id)
    .execute(pool)
    .await
    .expect("reset completion event for recovery check");
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
        owner_quota_bytes: 1024,
        min_free_bytes: 0,
        min_free_percent: 0.0,
        upload_session_ttl_seconds: 3600,
        trash_retention_days: 30,
        session_ttl_seconds: 3600,
        bootstrap_owner: None,
        cookie_secure: false,
    };
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
    let email = format!("transfer-owner-{id}@example.test");
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
    (raw.clone(), URL_SAFE_NO_PAD.encode(raw))
}

async fn insert_folder(pool: &PgPool, owner_id: Uuid, name: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO drive_entries (id, owner_id, kind, name) VALUES ($1, $2, 'folder', $3)",
    )
    .bind(id)
    .bind(owner_id)
    .bind(name)
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

#[allow(clippy::too_many_arguments)]
async fn request(
    app: &Router,
    method: Method,
    uri: &str,
    session: Option<&TestSession>,
    csrf: Option<&str>,
    content_type: Option<&str>,
    extra_headers: &[(&str, &str)],
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
    for (name, value) in extra_headers {
        request = request.header(*name, *value);
    }
    app.clone()
        .oneshot(request.body(body).unwrap())
        .await
        .unwrap()
}

fn storage_path(root: &Path, storage_key: &str) -> std::path::PathBuf {
    storage_key
        .split('/')
        .fold(root.join("objects"), |path, component| path.join(component))
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
