#[test]
fn embedded_migration_contains_the_metadata_and_security_schema() {
    let migrator = sqlx::migrate!("./migrations");
    assert_eq!(migrator.iter().len(), 1);

    let migration = include_str!("../migrations/0001_initial.sql");
    for table in [
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
            migration.contains(&format!("CREATE TABLE {table}")),
            "missing table {table}"
        );
    }
    assert!(migration.contains("token_digest BYTEA NOT NULL UNIQUE"));
    assert!(migration.contains("storage_key TEXT NOT NULL UNIQUE"));
    assert!(!migration.contains("payload BYTEA"));
}
