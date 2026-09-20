#[test]
fn embedded_migration_contains_the_metadata_and_security_schema() {
    let migrator = sqlx::migrate!("./migrations");
    assert_eq!(migrator.iter().len(), 4);

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

    let upload_recovery = include_str!("../migrations/0002_upload_finalization.sql");
    assert!(upload_recovery.contains("storage_object_id"));
    assert!(upload_recovery.contains("final_file_id"));

    let share_access = include_str!("../migrations/0003_share_access_sessions.sql");
    assert!(share_access.contains("token_digest BYTEA PRIMARY KEY"));
    assert!(share_access.contains("REFERENCES shares(id) ON DELETE CASCADE"));

    let storage_maintenance = include_str!("../migrations/0004_storage_maintenance.sql");
    assert!(storage_maintenance.contains("staging_cleaned_at"));
    assert!(storage_maintenance.contains("last_checked_at"));
}
