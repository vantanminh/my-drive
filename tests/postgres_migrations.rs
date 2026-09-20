use sqlx::{PgPool, postgres::PgPoolOptions};
use uuid::Uuid;

#[tokio::test]
#[ignore = "requires a disposable PostgreSQL database in TEST_DATABASE_URL"]
async fn postgres_applies_schema_and_rejects_ambiguous_or_cyclic_entries() {
    let database_url = std::env::var("TEST_DATABASE_URL")
        .expect("set TEST_DATABASE_URL to a disposable PostgreSQL database");
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(&database_url)
        .await
        .expect("connect to disposable PostgreSQL");

    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("apply migrations");
    assert_schema(&pool).await;

    let owner_id = insert_owner(&pool, "owner@example.test").await;
    let root_folder = Uuid::new_v4();
    insert_folder(&pool, root_folder, owner_id, None, "Photos").await;

    let child_folder = Uuid::new_v4();
    insert_folder(&pool, child_folder, owner_id, Some(root_folder), "2026").await;

    let duplicate_name = sqlx::query(
        "INSERT INTO drive_entries (id, owner_id, parent_id, kind, name) VALUES ($1, $2, NULL, 'file', 'photos')",
    )
    .bind(Uuid::new_v4())
    .bind(owner_id)
    .execute(&pool)
    .await;
    assert!(
        duplicate_name.is_err(),
        "file and folder names share one namespace"
    );

    let cycle = sqlx::query("UPDATE drive_entries SET parent_id = $1 WHERE id = $2")
        .bind(child_folder)
        .bind(root_folder)
        .execute(&pool)
        .await;
    assert!(cycle.is_err(), "folder moves must not create cycles");

    let other_owner = insert_owner(&pool, "second@example.test").await;
    let cross_owner_parent = sqlx::query(
        "INSERT INTO drive_entries (id, owner_id, parent_id, kind, name) VALUES ($1, $2, $3, 'folder', 'foreign')",
    )
    .bind(Uuid::new_v4())
    .bind(other_owner)
    .bind(root_folder)
    .execute(&pool)
    .await;
    assert!(
        cross_owner_parent.is_err(),
        "folders cannot cross owner boundaries"
    );

    pool.close().await;
}

async fn assert_schema(pool: &PgPool) {
    let tables: Vec<String> = sqlx::query_scalar(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    )
    .fetch_all(pool)
    .await
    .expect("inspect migrated schema");

    for expected in [
        "users",
        "drive_entries",
        "folders",
        "files",
        "storage_objects",
        "file_versions",
        "upload_sessions",
        "shares",
        "sessions",
        "audit_events",
    ] {
        assert!(
            tables.iter().any(|table| table == expected),
            "missing table {expected}"
        );
    }

    let payload_column: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'payload')",
    )
    .fetch_one(pool)
    .await
    .expect("check that file payloads are not stored in PostgreSQL");
    assert!(
        !payload_column,
        "file payloads belong on HDD storage, not PostgreSQL"
    );
}

async fn insert_owner(pool: &PgPool, email: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'test-only-hash', 'owner')")
        .bind(id)
        .bind(email)
        .execute(pool)
        .await
        .expect("insert test owner");
    id
}

async fn insert_folder(
    pool: &PgPool,
    id: Uuid,
    owner_id: Uuid,
    parent_id: Option<Uuid>,
    name: &str,
) {
    sqlx::query(
        "INSERT INTO drive_entries (id, owner_id, parent_id, kind, name) VALUES ($1, $2, $3, 'folder', $4)",
    )
    .bind(id)
    .bind(owner_id)
    .bind(parent_id)
    .bind(name)
    .execute(pool)
    .await
    .expect("insert logical folder entry");
    sqlx::query("INSERT INTO folders (id) VALUES ($1)")
        .bind(id)
        .execute(pool)
        .await
        .expect("insert folder projection");
}
