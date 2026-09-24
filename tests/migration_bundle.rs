#[test]
fn embedded_migration_contains_the_metadata_and_security_schema() {
    let migrator = sqlx::migrate!("./migrations");
    assert_eq!(migrator.iter().len(), 11);

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

    let media_indexing = include_str!("../migrations/0005_media_indexing.sql");
    assert!(media_indexing.contains("CREATE TABLE media_index_jobs"));
    assert!(media_indexing.contains("UNIQUE (file_version_id, task, recipe_version)"));
    assert!(media_indexing.contains("CREATE TABLE media_derivatives"));
    assert!(media_indexing.contains("CREATE TABLE media_index_control"));
    assert!(media_indexing.contains("INSERT INTO media_index_control (singleton) VALUES (TRUE)"));

    let managed_accounts = include_str!("../migrations/0006_managed_accounts.sql");
    assert!(managed_accounts.contains("managed_by UUID"));
    assert!(managed_accounts.contains("quota_bytes BIGINT"));
    assert!(managed_accounts.contains("disabled_at TIMESTAMPTZ"));
    assert!(managed_accounts.contains("must_change_password BOOLEAN"));
    assert!(managed_accounts.contains("validate_member_manager"));

    let face_indexing = include_str!("../migrations/0007_face_indexing.sql");
    assert!(face_indexing.contains("CREATE TABLE face_clusters"));
    assert!(face_indexing.contains("CREATE TABLE face_observations"));
    assert!(face_indexing.contains("face_observation_owner_guard"));

    let face_descriptors = include_str!("../migrations/0008_face_descriptor_matching.sql");
    assert!(face_descriptors.contains("descriptor BYTEA"));
    assert!(face_descriptors.contains("face_observations_descriptor_idx"));

    let browser_video_previews = include_str!("../migrations/0009_browser_video_previews.sql");
    assert!(browser_video_previews.contains("'video_preview'"));
    assert!(browser_video_previews.contains("video/mp4"));

    let google_drive = include_str!("../migrations/0010_google_drive_sync.sql");
    assert!(google_drive.contains("CREATE TABLE google_drive_connections"));
    assert!(google_drive.contains("CREATE TABLE google_drive_sources"));
    assert!(google_drive.contains("CREATE TABLE google_drive_runs"));
    assert!(google_drive.contains("CREATE TABLE google_drive_items"));
    assert!(google_drive.contains("CREATE TABLE google_drive_links"));
    assert!(google_drive.contains("refresh_token BYTEA NOT NULL"));

    let library = include_str!("../migrations/0011_library.sql");
    assert!(library.contains("CREATE TABLE entry_index"));
    assert!(library.contains("CREATE TABLE folder_stats"));
    assert!(library.contains("CREATE TABLE albums"));
    assert!(library.contains("CREATE TABLE album_items"));
    assert!(library.contains("resource_type = 'album'"));
}
