use std::{fs, net::SocketAddr, path::Path};

use chrono::{Duration, Utc};
use sqlx::{PgPool, postgres::PgPoolOptions};
use uuid::Uuid;

use crate::{
    Config,
    maintenance::{self, Settings},
    storage::LocalStorage,
};

const MAINTENANCE_TEST_LOCK: i64 = 0x4d59_4452_4956_4501;

struct UploadFixture<'a> {
    id: Uuid,
    staging_key: Uuid,
    filename: &'a str,
    state: &'a str,
    expires_at: chrono::DateTime<Utc>,
    storage_object_id: Option<Uuid>,
    final_file_id: Option<Uuid>,
}

#[tokio::test]
#[ignore = "requires a disposable PostgreSQL database in TEST_DATABASE_URL"]
async fn maintenance_cleans_expired_staging_and_preserves_finalization_sessions() {
    let pool = test_pool().await;
    let _guard = maintenance_test_lock(&pool).await;
    let temporary_storage = tempfile::tempdir().expect("create temporary HDD storage");
    let storage = make_storage(temporary_storage.path());
    let owner_id = insert_owner(&pool).await;

    let expired_id = Uuid::new_v4();
    let expired_key = Uuid::new_v4();
    write_staging_file(&storage, expired_key);
    insert_upload(
        &pool,
        owner_id,
        UploadFixture {
            id: expired_id,
            staging_key: expired_key,
            filename: "expired.bin",
            state: "active",
            expires_at: Utc::now() - Duration::minutes(1),
            storage_object_id: None,
            final_file_id: None,
        },
    )
    .await;

    let cancelled_id = Uuid::new_v4();
    let cancelled_key = Uuid::new_v4();
    write_staging_file(&storage, cancelled_key);
    insert_upload(
        &pool,
        owner_id,
        UploadFixture {
            id: cancelled_id,
            staging_key: cancelled_key,
            filename: "cancelled.bin",
            state: "expired",
            expires_at: Utc::now() + Duration::hours(1),
            storage_object_id: None,
            final_file_id: None,
        },
    )
    .await;

    let active_id = Uuid::new_v4();
    let active_key = Uuid::new_v4();
    write_staging_file(&storage, active_key);
    insert_upload(
        &pool,
        owner_id,
        UploadFixture {
            id: active_id,
            staging_key: active_key,
            filename: "active.bin",
            state: "active",
            expires_at: Utc::now() + Duration::hours(1),
            storage_object_id: None,
            final_file_id: None,
        },
    )
    .await;

    let finalizing_file_id = insert_entry(&pool, owner_id, None, "file", "finalizing.bin").await;
    let finalizing_object_id = Uuid::new_v4();
    let finalizing_object_key = LocalStorage::storage_key(finalizing_object_id);
    insert_storage_object(
        &pool,
        finalizing_object_id,
        &finalizing_object_key,
        "pending",
        0,
        Utc::now(),
    )
    .await;
    let finalizing_id = Uuid::new_v4();
    let finalizing_key = Uuid::new_v4();
    write_staging_file(&storage, finalizing_key);
    insert_upload(
        &pool,
        owner_id,
        UploadFixture {
            id: finalizing_id,
            staging_key: finalizing_key,
            filename: "finalizing.bin",
            state: "finalizing",
            expires_at: Utc::now() - Duration::hours(2),
            storage_object_id: Some(finalizing_object_id),
            final_file_id: Some(finalizing_file_id),
        },
    )
    .await;

    let settings = Settings {
        trash_retention_days: 30,
        upload_session_ttl_seconds: 60 * 60,
    };
    maintenance::run_once(&pool, &storage, settings)
        .await
        .expect("run expired upload cleanup");

    assert!(!storage.staging_path(expired_key).exists());
    assert!(!storage.staging_path(cancelled_key).exists());
    assert!(storage.staging_path(active_key).exists());
    assert!(storage.staging_path(finalizing_key).exists());

    let expired_state: (String, Option<chrono::DateTime<Utc>>) =
        sqlx::query_as("SELECT state, staging_cleaned_at FROM upload_sessions WHERE id = $1")
            .bind(expired_id)
            .fetch_one(&pool)
            .await
            .expect("read expired session state");
    assert_eq!(expired_state.0, "expired");
    assert!(expired_state.1.is_some());

    let cancelled_cleaned: Option<chrono::DateTime<Utc>> =
        sqlx::query_scalar("SELECT staging_cleaned_at FROM upload_sessions WHERE id = $1")
            .bind(cancelled_id)
            .fetch_one(&pool)
            .await
            .expect("read cancelled session cleanup state");
    assert!(cancelled_cleaned.is_some());

    let active_cleaned: Option<chrono::DateTime<Utc>> =
        sqlx::query_scalar("SELECT staging_cleaned_at FROM upload_sessions WHERE id = $1")
            .bind(active_id)
            .fetch_one(&pool)
            .await
            .expect("read active session cleanup state");
    assert!(active_cleaned.is_none());

    let finalizing_state: (String, Option<chrono::DateTime<Utc>>) =
        sqlx::query_as("SELECT state, staging_cleaned_at FROM upload_sessions WHERE id = $1")
            .bind(finalizing_id)
            .fetch_one(&pool)
            .await
            .expect("read finalizing session state");
    assert_eq!(finalizing_state.0, "finalizing");
    assert!(finalizing_state.1.is_none());
    let object_state: String =
        sqlx::query_scalar("SELECT state FROM storage_objects WHERE id = $1")
            .bind(finalizing_object_id)
            .fetch_one(&pool)
            .await
            .expect("ensure finalizing object metadata remains");
    assert_eq!(object_state, "pending");

    maintenance::run_once(&pool, &storage, settings)
        .await
        .expect("repeat cleanup safely");
    let cleaned_again: Option<chrono::DateTime<Utc>> =
        sqlx::query_scalar("SELECT staging_cleaned_at FROM upload_sessions WHERE id = $1")
            .bind(expired_id)
            .fetch_one(&pool)
            .await
            .expect("read repeated cleanup marker");
    assert_eq!(cleaned_again, expired_state.1);
    drop(_guard);
    pool.close().await;
}

#[tokio::test]
#[ignore = "requires a disposable PostgreSQL database in TEST_DATABASE_URL"]
async fn maintenance_purges_only_expired_trash_and_retains_shared_payloads() {
    let pool = test_pool().await;
    let _guard = maintenance_test_lock(&pool).await;
    let temporary_storage = tempfile::tempdir().expect("create temporary HDD storage");
    let storage = make_storage(temporary_storage.path());
    let owner_id = insert_owner(&pool).await;

    let old_root_id = insert_entry(&pool, owner_id, None, "folder", "old-folder").await;
    let nested_folder_id = insert_entry(
        &pool,
        owner_id,
        Some(old_root_id),
        "folder",
        "nested-folder",
    )
    .await;
    let shared_trashed_file = insert_entry(
        &pool,
        owner_id,
        Some(nested_folder_id),
        "file",
        "shared-old.bin",
    )
    .await;
    let unshared_trashed_file = insert_entry(
        &pool,
        owner_id,
        Some(old_root_id),
        "file",
        "unshared-old.bin",
    )
    .await;
    let active_file_id = insert_entry(&pool, owner_id, None, "file", "active.bin").await;

    let shared_object_id = Uuid::new_v4();
    let shared_object_key = LocalStorage::storage_key(shared_object_id);
    insert_storage_object(
        &pool,
        shared_object_id,
        &shared_object_key,
        "ready",
        7,
        Utc::now() - Duration::days(2),
    )
    .await;
    write_object_file(&storage, &shared_object_key, b"shared!");
    insert_version(&pool, shared_trashed_file, shared_object_id, 7).await;
    insert_version(&pool, active_file_id, shared_object_id, 7).await;

    let unshared_object_id = Uuid::new_v4();
    let unshared_object_key = LocalStorage::storage_key(unshared_object_id);
    insert_storage_object(
        &pool,
        unshared_object_id,
        &unshared_object_key,
        "ready",
        9,
        Utc::now() - Duration::days(2),
    )
    .await;
    write_object_file(&storage, &unshared_object_key, b"unshared!");
    insert_version(&pool, unshared_trashed_file, unshared_object_id, 9).await;

    let recent_root_id = insert_entry(&pool, owner_id, None, "folder", "recent-folder").await;
    sqlx::query("UPDATE drive_entries SET deleted_at = now() - interval '40 days' WHERE id = $1")
        .bind(old_root_id)
        .execute(&pool)
        .await
        .expect("age the trash subtree");
    sqlx::query("UPDATE drive_entries SET deleted_at = now() - interval '1 day' WHERE id = $1")
        .bind(recent_root_id)
        .execute(&pool)
        .await
        .expect("create a recent trash entry");

    let summary = maintenance::run_once(
        &pool,
        &storage,
        Settings {
            trash_retention_days: 30,
            upload_session_ttl_seconds: 60 * 60,
        },
    )
    .await
    .expect("purge retained trash");
    assert!(summary.entries_purged >= 4);

    let remaining_old_entries: i64 =
        sqlx::query_scalar("SELECT count(*) FROM drive_entries WHERE id = ANY($1)")
            .bind(vec![
                old_root_id,
                nested_folder_id,
                shared_trashed_file,
                unshared_trashed_file,
            ])
            .fetch_one(&pool)
            .await
            .expect("check purged subtree metadata");
    assert_eq!(remaining_old_entries, 0);
    let recent_exists: bool =
        sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM drive_entries WHERE id = $1)")
            .bind(recent_root_id)
            .fetch_one(&pool)
            .await
            .expect("check recent trash retention");
    assert!(recent_exists);
    let active_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM drive_entries WHERE id = $1 AND deleted_at IS NULL)",
    )
    .bind(active_file_id)
    .fetch_one(&pool)
    .await
    .expect("check active entry preservation");
    assert!(active_exists);

    let shared_object_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM storage_objects WHERE id = $1 AND state = 'ready')",
    )
    .bind(shared_object_id)
    .fetch_one(&pool)
    .await
    .expect("check shared object remains ready");
    assert!(shared_object_exists);
    assert!(storage.object_exists(&shared_object_key).await.unwrap());
    let unshared_object_exists: bool =
        sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM storage_objects WHERE id = $1)")
            .bind(unshared_object_id)
            .fetch_one(&pool)
            .await
            .expect("check unreferenced object metadata removal");
    assert!(!unshared_object_exists);
    assert!(!storage.object_exists(&unshared_object_key).await.unwrap());

    let purge_audit_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events \
          WHERE event_type = 'entry_purged' AND resource_id = $1 \
            AND details ->> 'entry_count' = '4'",
    )
    .bind(old_root_id)
    .fetch_one(&pool)
    .await
    .expect("check trash purge audit record");
    assert_eq!(purge_audit_count, 1);
    drop(_guard);
    pool.close().await;
}

#[tokio::test]
#[ignore = "requires a disposable PostgreSQL database in TEST_DATABASE_URL"]
async fn maintenance_retries_failed_object_deletion_and_reports_missing_payloads() {
    let pool = test_pool().await;
    let _guard = maintenance_test_lock(&pool).await;
    let temporary_storage = tempfile::tempdir().expect("create temporary HDD storage");
    let storage = make_storage(temporary_storage.path());
    let owner_id = insert_owner(&pool).await;

    let file_id = insert_entry(&pool, owner_id, None, "file", "missing-payload.bin").await;
    let missing_object_id = Uuid::new_v4();
    let missing_object_key = LocalStorage::storage_key(missing_object_id);
    insert_storage_object(
        &pool,
        missing_object_id,
        &missing_object_key,
        "ready",
        10,
        Utc::now(),
    )
    .await;
    insert_version(&pool, file_id, missing_object_id, 10).await;

    let unreferenced_object_id = Uuid::new_v4();
    let unreferenced_object_key = LocalStorage::storage_key(unreferenced_object_id);
    insert_storage_object(
        &pool,
        unreferenced_object_id,
        &unreferenced_object_key,
        "ready",
        0,
        Utc::now() - Duration::days(2),
    )
    .await;
    let obstructing_directory = storage.object_path(&unreferenced_object_key).unwrap();
    fs::create_dir_all(&obstructing_directory).expect("create an unlink failure fixture");

    let settings = Settings {
        trash_retention_days: 30,
        upload_session_ttl_seconds: 60 * 60,
    };
    let first = maintenance::run_once(&pool, &storage, settings)
        .await
        .expect("run maintenance with an unlink failure");
    assert!(first.storage_object_cleanup_failures >= 1);
    assert!(first.missing_payloads >= 1);
    let retry_state: String = sqlx::query_scalar("SELECT state FROM storage_objects WHERE id = $1")
        .bind(unreferenced_object_id)
        .fetch_one(&pool)
        .await
        .expect("ensure failed object remains retryable");
    assert_eq!(retry_state, "deleting");
    let missing_state: (String, bool) = sqlx::query_as(
        "SELECT object.state, EXISTS ( \
             SELECT 1 FROM file_versions AS version \
              WHERE version.storage_object_id = object.id \
         ) \
          FROM storage_objects AS object WHERE object.id = $1",
    )
    .bind(missing_object_id)
    .fetch_one(&pool)
    .await
    .expect("ensure missing-payload metadata and reference remain");
    assert_eq!(missing_state.0, "ready");
    assert!(missing_state.1);

    fs::remove_dir(&obstructing_directory).expect("remove the temporary unlink obstruction");
    maintenance::run_once(&pool, &storage, settings)
        .await
        .expect("retry object deletion idempotently");
    let removed: bool =
        sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM storage_objects WHERE id = $1)")
            .bind(unreferenced_object_id)
            .fetch_one(&pool)
            .await
            .expect("check retried object row removal");
    assert!(!removed);
    let missing_still_exists: bool =
        sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM storage_objects WHERE id = $1)")
            .bind(missing_object_id)
            .fetch_one(&pool)
            .await
            .expect("check missing payload row remains available for repair");
    assert!(missing_still_exists);
    drop(_guard);
    pool.close().await;
}

async fn test_pool() -> PgPool {
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
    pool
}

async fn maintenance_test_lock(pool: &PgPool) -> sqlx::Transaction<'_, sqlx::Postgres> {
    let mut transaction = pool.begin().await.expect("begin test lock transaction");
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(MAINTENANCE_TEST_LOCK)
        .execute(&mut *transaction)
        .await
        .expect("serialize storage maintenance integration tests");
    transaction
}

fn make_storage(storage_root: &Path) -> LocalStorage {
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
        upload_session_ttl_seconds: 60 * 60,
        trash_retention_days: 30,
        session_ttl_seconds: 3600,
        bootstrap_owner: None,
        cookie_secure: false,
    };
    LocalStorage::initialize(&config).expect("initialize test storage")
}

async fn insert_owner(pool: &PgPool) -> Uuid {
    let owner_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO users (id, email, password_hash, role) \
         VALUES ($1, $2, 'test-only-hash', 'owner')",
    )
    .bind(owner_id)
    .bind(format!("maintenance-{owner_id}@example.test"))
    .execute(pool)
    .await
    .expect("insert test owner");
    owner_id
}

async fn insert_entry(
    pool: &PgPool,
    owner_id: Uuid,
    parent_id: Option<Uuid>,
    kind: &str,
    name: &str,
) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO drive_entries (id, owner_id, parent_id, kind, name) \
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(id)
    .bind(owner_id)
    .bind(parent_id)
    .bind(kind)
    .bind(name)
    .execute(pool)
    .await
    .expect("insert test drive entry");
    let table = match kind {
        "folder" => "folders",
        "file" => "files",
        _ => unreachable!(),
    };
    sqlx::query(&format!("INSERT INTO {table} (id) VALUES ($1)"))
        .bind(id)
        .execute(pool)
        .await
        .expect("insert test entry projection");
    id
}

async fn insert_storage_object(
    pool: &PgPool,
    id: Uuid,
    storage_key: &str,
    state: &str,
    size_bytes: i64,
    created_at: chrono::DateTime<Utc>,
) {
    sqlx::query(
        "INSERT INTO storage_objects (id, storage_key, size_bytes, state, created_at) \
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(id)
    .bind(storage_key)
    .bind(size_bytes)
    .bind(state)
    .bind(created_at)
    .execute(pool)
    .await
    .expect("insert test storage object");
}

async fn insert_version(pool: &PgPool, file_id: Uuid, object_id: Uuid, size_bytes: i64) {
    let version_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO file_versions (id, file_id, storage_object_id, size_bytes) \
         VALUES ($1, $2, $3, $4)",
    )
    .bind(version_id)
    .bind(file_id)
    .bind(object_id)
    .bind(size_bytes)
    .execute(pool)
    .await
    .expect("insert test file version");
    sqlx::query("UPDATE files SET current_version_id = $1 WHERE id = $2")
        .bind(version_id)
        .bind(file_id)
        .execute(pool)
        .await
        .expect("set test current version");
}

async fn insert_upload(pool: &PgPool, owner_id: Uuid, upload: UploadFixture<'_>) {
    sqlx::query(
        "INSERT INTO upload_sessions ( \
             id, owner_id, filename, expected_size, received_size, staging_key, state, expires_at, \
             storage_object_id, final_file_id \
         ) VALUES ($1, $2, $3, 4, 0, $4, $5, $6, $7, $8)",
    )
    .bind(upload.id)
    .bind(owner_id)
    .bind(upload.filename)
    .bind(upload.staging_key)
    .bind(upload.state)
    .bind(upload.expires_at)
    .bind(upload.storage_object_id)
    .bind(upload.final_file_id)
    .execute(pool)
    .await
    .expect("insert test upload session");
}

fn write_staging_file(storage: &LocalStorage, staging_key: Uuid) {
    fs::write(storage.staging_path(staging_key), b"stage").expect("write test staging file");
}

fn write_object_file(storage: &LocalStorage, storage_key: &str, contents: &[u8]) {
    let path = storage
        .object_path(storage_key)
        .expect("validate test storage key");
    fs::create_dir_all(path.parent().expect("get object parent"))
        .expect("create sharded object path");
    fs::write(path, contents).expect("write test payload");
}
