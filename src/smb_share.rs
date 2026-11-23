//! Read-write SMB view of every user's drive.
//!
//! Drive contents are stored under content-addressed keys (`<data>/objects/<key>`)
//! and the folder tree lives in PostgreSQL, so Samba cannot share the storage
//! directory directly. While the owner has SMB enabled, this worker:
//! 1. Materialises a tree of symlinks (`<view>/tree/<smb user>/Folder/file ->
//!    <data>/objects/<storage key>`) and `users.list` with NT hashes.
//! 2. Watches for client-side SMB changes (new folders, uploaded/modified files,
//!    renamed/moved symlinks, and deletions) and syncs them back into PostgreSQL
//!    and `LocalStorage` (deletions move entries to Trash).
//! 3. Writes per-user capacity files (`<view>/quota/<smb user>`) so Samba's
//!    `dfree command` reports accurate mapped-drive total and free space.

use std::{
    collections::{HashMap, HashSet},
    io::Read,
    path::{Path, PathBuf},
    sync::OnceLock,
    time::{Duration, UNIX_EPOCH},
};

use chrono::{DateTime, Utc};
use md4::{Digest, Md4};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use sqlx::PgPool;
use uuid::Uuid;

use crate::{
    auth, drive,
    health::TransferSettings,
    storage::{FilesystemUsage, LocalStorage},
};

pub(crate) static VIEW_DIR: OnceLock<PathBuf> = OnceLock::new();

const INTERVAL: Duration = Duration::from_secs(2);
const MAX_ENTRIES_PER_USER: i64 = 500_000;

pub(crate) fn available() -> bool {
    VIEW_DIR.get().is_some()
}

/// Compute accurate `(total_bytes, free_bytes)` for a mapped network drive (SMB / WebDAV).
///
/// - When the user has a finite quota, reports their quota and remaining space,
///   clamped by actual underlying HDD free space so OS copy dialogs never think
///   there is more free space than the physical disk can hold.
/// - When the user has unlimited quota, reports the real HDD filesystem total
///   and free space rather than the Docker `smb-view` volume.
pub(crate) fn compute_mapped_drive_space(
    quota_bytes: Option<i64>,
    used_bytes: i64,
    disk: Option<FilesystemUsage>,
) -> (u64, u64) {
    let used = u64::try_from(used_bytes.max(0)).unwrap_or(0);
    match quota_bytes {
        Some(quota) if quota > 0 => {
            let quota_u64 = quota as u64;
            let quota_free = quota_u64.saturating_sub(used);
            match disk {
                Some(d) => {
                    let free = quota_free.min(d.free_bytes);
                    let total = quota_u64
                        .min(used.saturating_add(d.free_bytes))
                        .max(used);
                    (total, free)
                }
                None => (quota_u64.max(used), quota_free),
            }
        }
        _ => match disk {
            Some(d) => (d.total_bytes, d.free_bytes),
            None => (0, 0),
        },
    }
}

/// NT hash: MD4 over the UTF-16LE password.
pub(crate) fn nt_hash(password: &str) -> [u8; 16] {
    let utf16: Vec<u8> = password
        .encode_utf16()
        .flat_map(|unit| unit.to_le_bytes())
        .collect();
    Md4::digest(&utf16).into()
}

/// Derive a Samba/Unix-safe account name from an email address.
pub(crate) fn username_candidate(email: &str, attempt: u32) -> String {
    let local = email.split('@').next().unwrap_or("user").to_lowercase();
    let mut name: String = local
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect();
    if !name.chars().next().is_some_and(|c| c.is_ascii_lowercase()) {
        name.insert(0, 'u');
    }
    let suffix = if attempt == 0 {
        String::new()
    } else {
        attempt.to_string()
    };
    name.truncate(32 - suffix.len());
    name.push_str(&suffix);
    name
}

/// Canonical symlink target inside the SMB container for a content-addressed object.
/// `LocalStorage::object_path` stores objects under `<root>/objects/<aa>/<bb>/<uuid>`.
pub(crate) fn object_target(data_target: &str, storage_key: &str) -> PathBuf {
    Path::new(data_target).join("objects").join(storage_key)
}

/// Extract a storage key back from a symlink target created by `object_target`.
fn extract_storage_key(data_target: &str, link_target: &Path) -> Option<String> {
    let objects_root = Path::new(data_target).join("objects");
    let rel = link_target.strip_prefix(&objects_root).ok()?;
    let mut parts = Vec::new();
    for comp in rel.components() {
        parts.push(comp.as_os_str().to_str()?);
    }
    if parts.len() == 3 {
        Some(parts.join("/"))
    } else {
        None
    }
}

/// OS metadata / temporary files created by Windows/macOS SMB clients that should
/// not be ingested as user drive files.
fn is_ignored_smb_name(name: &str) -> bool {
    matches!(name, ".DS_Store" | "Thumbs.db" | "desktop.ini" | "Desktop.ini")
        || name.starts_with("._")
        || name.starts_with("~$")
        || name.starts_with(".~")
}

fn path_has_ignored_component(rel_path: &str) -> bool {
    rel_path.split('/').any(is_ignored_smb_name)
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
struct SyncedFile {
    entry_id: Uuid,
    storage_key: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
struct Snapshot {
    dirs: HashMap<String, Uuid>,
    files: HashMap<String, SyncedFile>,
}

#[derive(Default)]
struct WorkerMemory {
    snapshots: HashMap<String, Snapshot>,
    /// Tracks `(size, mtime_secs, mtime_nanos)` of regular files across cycles so
    /// in-progress SMB uploads are only ingested once stable for a full cycle.
    pending_writes: HashMap<String, HashMap<String, (u64, u64, u32)>>,
}

pub(crate) async fn run_worker(
    pool: PgPool,
    storage: LocalStorage,
    transfer_settings: TransferSettings,
) {
    let Some(view) = VIEW_DIR.get().cloned() else {
        return;
    };
    let data_target =
        std::env::var("SMB_DATA_TARGET").unwrap_or_else(|_| "/srv/my-drive/data".into());
    tracing::info!(view = %view.display(), "SMB view worker started");
    let mut memory = WorkerMemory::default();
    loop {
        if let Err(error) =
            cycle(&pool, &storage, transfer_settings, &view, &data_target, &mut memory).await
        {
            tracing::warn!(error = %error, "SMB view refresh failed");
        }
        tokio::time::sleep(INTERVAL).await;
    }
}

#[derive(sqlx::FromRow)]
struct Account {
    user_id: Uuid,
    role: String,
    quota_bytes: Option<i64>,
    username: String,
    nt_hash: Vec<u8>,
}

#[derive(sqlx::FromRow)]
struct Node {
    id: Uuid,
    kind: String,
    path: String,
    storage_key: Option<String>,
}

#[derive(Clone, Debug)]
struct RegularFile {
    rel_path: String,
    abs_path: PathBuf,
    size: u64,
    mtime_secs: u64,
    mtime_nanos: u32,
}

#[derive(Default, Debug)]
struct FsScan {
    dirs: HashSet<String>,
    symlinks: HashMap<String, PathBuf>,
    regular_files: Vec<RegularFile>,
}

#[derive(Default, Debug, PartialEq, Eq)]
struct SmbDiff {
    new_dirs: Vec<String>,
    renamed_files: Vec<(Uuid, String, String)>, // (entry_id, old_path, new_path)
    deleted_files: Vec<(Uuid, String)>,
    deleted_dirs: Vec<(Uuid, String)>,
}

async fn cycle(
    pool: &PgPool,
    storage: &LocalStorage,
    transfer_settings: TransferSettings,
    view: &Path,
    data_target: &str,
    memory: &mut WorkerMemory,
) -> anyhow::Result<()> {
    let enabled: bool =
        sqlx::query_scalar("SELECT smb_enabled FROM network_drive_settings WHERE singleton")
            .fetch_optional(pool)
            .await?
            .unwrap_or(false);
    let accounts: Vec<Account> = if enabled {
        sqlx::query_as(
            "SELECT a.user_id, u.role, u.quota_bytes, a.username, a.nt_hash FROM smb_accounts a \
               JOIN users u ON u.id = a.user_id \
              WHERE u.disabled_at IS NULL AND NOT u.must_change_password \
              ORDER BY a.username",
        )
        .fetch_all(pool)
        .await?
    } else {
        Vec::new()
    };

    let list: String = accounts
        .iter()
        .map(|a| format!("{}:{}\n", a.username, hex(&a.nt_hash)))
        .collect();
    let view_owned = view.to_path_buf();
    let list_clone = list.clone();
    tokio::task::spawn_blocking(move || write_users_list(&view_owned, &list_clone)).await??;

    let active_usernames: HashSet<String> = accounts.iter().map(|a| a.username.clone()).collect();
    memory.snapshots.retain(|u, _| active_usernames.contains(u));
    memory
        .pending_writes
        .retain(|u, _| active_usernames.contains(u));

    let view_owned = view.to_path_buf();
    let active_clone = active_usernames.clone();
    tokio::task::spawn_blocking(move || cleanup_inactive_users(&view_owned, &active_clone))
        .await??;

    for account in &accounts {
        if let Err(error) = sync_account(
            pool,
            storage,
            transfer_settings,
            view,
            data_target,
            account,
            memory,
        )
        .await
        {
            tracing::warn!(
                username = %account.username,
                error = %error,
                "SMB account sync failed"
            );
        }
    }
    Ok(())
}

async fn load_db_snapshot(pool: &PgPool, user_id: Uuid) -> anyhow::Result<Snapshot> {
    let nodes: Vec<Node> = sqlx::query_as(
        "WITH RECURSIVE tree AS ( \
             SELECT e.id, e.kind, e.name::text AS path FROM drive_entries e \
              WHERE e.owner_id = $1 AND e.parent_id IS NULL AND e.deleted_at IS NULL \
             UNION ALL \
             SELECT c.id, c.kind, t.path || '/' || c.name FROM drive_entries c \
               JOIN tree t ON c.parent_id = t.id \
              WHERE c.owner_id = $1 AND c.deleted_at IS NULL AND t.kind = 'folder') \
         SELECT t.id, t.kind, t.path, o.storage_key FROM tree t \
           LEFT JOIN files f ON f.id = t.id \
           LEFT JOIN file_versions v ON v.id = f.current_version_id \
           LEFT JOIN storage_objects o ON o.id = v.storage_object_id AND o.state = 'ready' \
          LIMIT $2",
    )
    .bind(user_id)
    .bind(MAX_ENTRIES_PER_USER)
    .fetch_all(pool)
    .await?;

    let mut snap = Snapshot::default();
    for node in nodes {
        if node.kind == "folder" {
            snap.dirs.insert(node.path, node.id);
        } else if let Some(storage_key) = node.storage_key {
            snap.files.insert(
                node.path,
                SyncedFile {
                    entry_id: node.id,
                    storage_key,
                },
            );
        }
    }
    Ok(snap)
}

async fn sync_account(
    pool: &PgPool,
    storage: &LocalStorage,
    transfer_settings: TransferSettings,
    view: &Path,
    data_target: &str,
    account: &Account,
    memory: &mut WorkerMemory,
) -> anyhow::Result<()> {
    let user_root = view.join("tree").join(&account.username);
    let state_path = view.join("state").join(format!("{}.json", account.username));

    let prev = if let Some(existing) = memory.snapshots.get(&account.username) {
        Some(existing.clone())
    } else {
        let sp = state_path.clone();
        tokio::task::spawn_blocking(move || load_snapshot_file(&sp))
            .await
            .ok()
            .flatten()
    };

    let mut db_snap = load_db_snapshot(pool, account.user_id).await?;

    let root_for_scan = user_root.clone();
    let scan = tokio::task::spawn_blocking(move || scan_fs(&root_for_scan)).await??;

    // 1. Apply SMB-originated changes to PostgreSQL & LocalStorage.
    let diff = diff_smb_changes(prev.as_ref(), &db_snap, &scan, data_target);
    let mut db_mutated = false;

    // 1a. Create new folders created via SMB (shallowest first).
    for dir_path in &diff.new_dirs {
        if let Err(error) = ensure_folder_path(pool, account.user_id, dir_path).await {
            tracing::warn!(
                username = %account.username,
                path = %dir_path,
                error = %error,
                "failed to create SMB folder in database"
            );
        } else {
            db_mutated = true;
        }
    }

    // 1b. Rename / move symlinks that were moved via SMB.
    for (entry_id, old_path, new_path) in &diff.renamed_files {
        if let Err(error) = move_entry_by_path(pool, account.user_id, *entry_id, new_path).await {
            tracing::warn!(
                username = %account.username,
                old_path = %old_path,
                new_path = %new_path,
                error = %error,
                "failed to rename/move SMB entry in database"
            );
        } else {
            db_mutated = true;
        }
    }

    // 1c. Ingest stable regular files written via SMB.
    let pending_map = memory
        .pending_writes
        .entry(account.username.clone())
        .or_default();
    let mut seen_regular: HashSet<String> = HashSet::new();
    let mut keep_regular: HashSet<PathBuf> = HashSet::new();

    for reg in &scan.regular_files {
        if path_has_ignored_component(&reg.rel_path) {
            keep_regular.insert(reg.abs_path.clone());
            continue;
        }
        seen_regular.insert(reg.rel_path.clone());
        let sig = (reg.size, reg.mtime_secs, reg.mtime_nanos);
        let stable = pending_map.get(&reg.rel_path).is_some_and(|prev_sig| *prev_sig == sig);
        if !stable {
            pending_map.insert(reg.rel_path.clone(), sig);
            keep_regular.insert(reg.abs_path.clone());
            continue;
        }
        // File size & mtime have been stable across two consecutive cycles — ingest it!
        match ingest_regular_file(
            pool,
            storage,
            transfer_settings,
            account,
            data_target,
            reg,
        )
        .await
        {
            Ok(()) => {
                pending_map.remove(&reg.rel_path);
                db_mutated = true;
            }
            Err(error) => {
                tracing::warn!(
                    username = %account.username,
                    path = %reg.rel_path,
                    error = %error,
                    "failed to ingest SMB uploaded file"
                );
                // Keep the file on disk so the user doesn't silently lose data on transient error.
                keep_regular.insert(reg.abs_path.clone());
            }
        }
    }
    pending_map.retain(|path, _| seen_regular.contains(path));

    // 1d. Soft-delete (move to Trash) files & folders deleted via SMB.
    for (entry_id, path) in &diff.deleted_files {
        if let Err(error) = soft_delete_entry(pool, account.user_id, *entry_id).await {
            tracing::warn!(
                username = %account.username,
                path = %path,
                error = %error,
                "failed to trash SMB-deleted file"
            );
        } else {
            db_mutated = true;
        }
    }
    for (entry_id, path) in &diff.deleted_dirs {
        if let Err(error) = soft_delete_entry(pool, account.user_id, *entry_id).await {
            tracing::warn!(
                username = %account.username,
                path = %path,
                error = %error,
                "failed to trash SMB-deleted folder"
            );
        } else {
            db_mutated = true;
        }
    }

    if db_mutated {
        db_snap = load_db_snapshot(pool, account.user_id).await?;
    }

    // 2. Project DB state -> SMB view tree (preserving in-flight regular files).
    let root_for_sync = user_root.clone();
    let target_owned = data_target.to_owned();
    let snap_for_sync = db_snap.clone();
    tokio::task::spawn_blocking(move || {
        sync_tree(&root_for_sync, &target_owned, &snap_for_sync, &keep_regular)
    })
    .await??;

    // 3. Write per-user capacity file for Samba's dfree command.
    let (used_bytes, reserved_bytes): (i64, i64) = sqlx::query_as(
        "SELECT \
            (SELECT COALESCE(SUM(v.size_bytes), 0)::BIGINT \
               FROM drive_entries e \
               JOIN files f ON f.id = e.id \
               JOIN file_versions v ON v.id = f.current_version_id \
               JOIN storage_objects o ON o.id = v.storage_object_id AND o.state = 'ready' \
              WHERE e.owner_id = $1) AS used_bytes, \
            (SELECT COALESCE(SUM(expected_size), 0)::BIGINT \
               FROM upload_sessions \
              WHERE owner_id = $1 \
                AND (state = 'finalizing' OR (state = 'active' AND expires_at > now()))) \
                AS reserved_bytes",
    )
    .bind(account.user_id)
    .fetch_one(pool)
    .await?;
    let effective_quota = auth::effective_quota_bytes(
        &account.role,
        account.quota_bytes,
        transfer_settings.owner_quota_bytes,
    );
    let committed = used_bytes.max(0).saturating_add(reserved_bytes.max(0));
    let disk_usage = storage.filesystem_usage().ok();
    let (total_bytes, free_bytes) = compute_mapped_drive_space(effective_quota, committed, disk_usage);
    let view_for_quota = view.to_path_buf();
    let username_for_quota = account.username.clone();
    tokio::task::spawn_blocking(move || {
        write_quota_file(&view_for_quota, &username_for_quota, total_bytes, free_bytes)
    })
    .await??;

    // 4. Persist snapshot for next cycle.
    memory
        .snapshots
        .insert(account.username.clone(), db_snap.clone());
    let sp_save = state_path.clone();
    let snap_save = db_snap;
    tokio::task::spawn_blocking(move || save_snapshot_file(&sp_save, &snap_save)).await??;

    Ok(())
}

fn diff_smb_changes(
    prev: Option<&Snapshot>,
    db: &Snapshot,
    scan: &FsScan,
    data_target: &str,
) -> SmbDiff {
    let mut diff = SmbDiff::default();

    // New directories: present on FS, not in DB, and not in prev (or even if no prev yet).
    let mut new_dirs: Vec<String> = scan
        .dirs
        .iter()
        .filter(|dir| {
            !path_has_ignored_component(dir)
                && !db.dirs.contains_key(*dir)
                && prev.map_or(true, |p| !p.dirs.contains_key(*dir))
        })
        .cloned()
        .collect();
    new_dirs.sort_by_key(|p| (p.matches('/').count(), p.clone()));
    diff.new_dirs = new_dirs;

    // Deletions and renames require a prior snapshot so a fresh/empty smb-view
    // volume can never wipe the user's Drive.
    let Some(prev) = prev else {
        return diff;
    };

    let regular_paths: HashSet<&str> = scan
        .regular_files
        .iter()
        .map(|f| f.rel_path.as_str())
        .collect();

    // Index missing prev files by storage_key so we can match renames/moves.
    let mut missing_by_key: HashMap<&str, Vec<(&str, Uuid)>> = HashMap::new();
    for (old_path, synced) in &prev.files {
        let still_in_db = db
            .files
            .get(old_path)
            .is_some_and(|cur| cur.entry_id == synced.entry_id);
        let gone_from_fs =
            !scan.symlinks.contains_key(old_path) && !regular_paths.contains(old_path.as_str());
        if still_in_db && gone_from_fs {
            missing_by_key
                .entry(synced.storage_key.as_str())
                .or_default()
                .push((old_path.as_str(), synced.entry_id));
        }
    }

    let mut matched_old_paths: HashSet<String> = HashSet::new();
    let mut new_symlinks: Vec<(&String, &PathBuf)> = scan
        .symlinks
        .iter()
        .filter(|(path, _)| !prev.files.contains_key(*path) && !db.files.contains_key(*path))
        .collect();
    new_symlinks.sort_by(|a, b| a.0.cmp(b.0));

    for (new_path, target) in new_symlinks {
        if path_has_ignored_component(new_path) {
            continue;
        }
        let Some(key) = extract_storage_key(data_target, target) else {
            continue;
        };
        if let Some(candidates) = missing_by_key.get_mut(key.as_str()) {
            if let Some((old_path, entry_id)) = candidates.pop() {
                matched_old_paths.insert(old_path.to_owned());
                diff.renamed_files
                    .push((entry_id, old_path.to_owned(), new_path.clone()));
            }
        }
    }

    // Remaining missing files -> deleted via SMB (move to Trash).
    for (old_path, synced) in &prev.files {
        if matched_old_paths.contains(old_path) {
            continue;
        }
        let still_in_db = db
            .files
            .get(old_path)
            .is_some_and(|cur| cur.entry_id == synced.entry_id);
        let gone_from_fs =
            !scan.symlinks.contains_key(old_path) && !regular_paths.contains(old_path.as_str());
        if still_in_db && gone_from_fs {
            diff.deleted_files.push((synced.entry_id, old_path.clone()));
        }
    }
    diff.deleted_files.sort_by(|a, b| a.1.cmp(&b.1));

    // Missing directories -> deleted via SMB (move to Trash), shallowest first.
    let mut deleted_dirs: Vec<(Uuid, String)> = prev
        .dirs
        .iter()
        .filter(|(old_dir, old_id)| {
            db.dirs.get(*old_dir).is_some_and(|cur| cur == *old_id) && !scan.dirs.contains(*old_dir)
        })
        .map(|(old_dir, old_id)| (*old_id, old_dir.clone()))
        .collect();
    deleted_dirs.sort_by_key(|(_, p)| (p.matches('/').count(), p.clone()));
    diff.deleted_dirs = deleted_dirs;

    diff
}

async fn ensure_folder_path(
    pool: &PgPool,
    owner_id: Uuid,
    rel_path: &str,
) -> anyhow::Result<Option<Uuid>> {
    let mut parent_id: Option<Uuid> = None;
    for segment in rel_path.split('/').filter(|s| !s.is_empty()) {
        let name = drive::normalize_name(segment)
            .map_err(|_| anyhow::anyhow!("invalid folder name: {segment}"))?;
        let existing: Option<Uuid> = sqlx::query_scalar(
            "SELECT id FROM drive_entries \
              WHERE owner_id = $1 AND deleted_at IS NULL AND kind = 'folder' \
                AND parent_id IS NOT DISTINCT FROM $2 AND lower(name) = lower($3)",
        )
        .bind(owner_id)
        .bind(parent_id)
        .bind(&name)
        .fetch_optional(pool)
        .await?;
        if let Some(id) = existing {
            parent_id = Some(id);
            continue;
        }
        let new_id = Uuid::new_v4();
        let inserted = sqlx::query(
            "INSERT INTO drive_entries (id, owner_id, parent_id, kind, name) \
             VALUES ($1, $2, $3, 'folder', $4)",
        )
        .bind(new_id)
        .bind(owner_id)
        .bind(parent_id)
        .bind(&name)
        .execute(pool)
        .await;
        match inserted {
            Ok(_) => parent_id = Some(new_id),
            Err(error) => {
                // Re-check in case of concurrent insert.
                if let Some(id) = sqlx::query_scalar::<_, Uuid>(
                    "SELECT id FROM drive_entries \
                      WHERE owner_id = $1 AND deleted_at IS NULL AND kind = 'folder' \
                        AND parent_id IS NOT DISTINCT FROM $2 AND lower(name) = lower($3)",
                )
                .bind(owner_id)
                .bind(parent_id)
                .bind(&name)
                .fetch_optional(pool)
                .await?
                {
                    parent_id = Some(id);
                } else {
                    return Err(error.into());
                }
            }
        }
    }
    Ok(parent_id)
}

async fn move_entry_by_path(
    pool: &PgPool,
    owner_id: Uuid,
    entry_id: Uuid,
    new_rel_path: &str,
) -> anyhow::Result<()> {
    let (parent_rel, raw_name) = match new_rel_path.rsplit_once('/') {
        Some((p, n)) => (Some(p), n),
        None => (None, new_rel_path),
    };
    let name = drive::normalize_name(raw_name)
        .map_err(|_| anyhow::anyhow!("invalid target name: {raw_name}"))?;
    let parent_id = match parent_rel {
        Some(p) => ensure_folder_path(pool, owner_id, p).await?,
        None => None,
    };
    sqlx::query(
        "UPDATE drive_entries \
            SET parent_id = $3, name = $4, updated_at = now() \
          WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL",
    )
    .bind(entry_id)
    .bind(owner_id)
    .bind(parent_id)
    .bind(&name)
    .execute(pool)
    .await?;
    Ok(())
}

async fn soft_delete_entry(pool: &PgPool, owner_id: Uuid, entry_id: Uuid) -> anyhow::Result<()> {
    sqlx::query(
        "UPDATE drive_entries \
            SET deleted_at = now(), updated_at = now() \
          WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL",
    )
    .bind(entry_id)
    .bind(owner_id)
    .execute(pool)
    .await?;
    Ok(())
}

async fn ingest_regular_file(
    pool: &PgPool,
    storage: &LocalStorage,
    transfer_settings: TransferSettings,
    account: &Account,
    data_target: &str,
    reg: &RegularFile,
) -> anyhow::Result<()> {
    if reg.size > transfer_settings.max_file_size {
        anyhow::bail!("file exceeds max_file_size");
    }
    let (parent_rel, raw_name) = match reg.rel_path.rsplit_once('/') {
        Some((p, n)) => (Some(p), n),
        None => (None, reg.rel_path.as_str()),
    };
    let name = drive::normalize_name(raw_name)
        .map_err(|_| anyhow::anyhow!("invalid file name: {raw_name}"))?;
    let size_i64 = i64::try_from(reg.size)?;

    let staging_key = Uuid::new_v4();
    let staging_path = storage.staging_path(staging_key);
    let src_path = reg.abs_path.clone();
    let name_for_mime = name.clone();
    let (actual_size, checksum, detected_mime) = tokio::task::spawn_blocking(move || {
        copy_and_hash_to_staging(&src_path, &staging_path, &name_for_mime)
    })
    .await??;

    if actual_size != reg.size {
        let _ = storage.remove_staging_file(staging_key).await;
        anyhow::bail!("file changed while staging; will retry next cycle");
    }

    let parent_id = match parent_rel {
        Some(p) => ensure_folder_path(pool, account.user_id, p).await?,
        None => None,
    };

    let object_id = Uuid::new_v4();
    let storage_key = LocalStorage::storage_key(object_id);
    let modified_at = DateTime::<Utc>::from(
        UNIX_EPOCH + Duration::new(reg.mtime_secs, reg.mtime_nanos),
    );

    let mut tx = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))")
        .bind(account.user_id)
        .execute(&mut *tx)
        .await?;

    let quota = auth::effective_quota_bytes(
        &account.role,
        account.quota_bytes,
        transfer_settings.owner_quota_bytes,
    );
    if let Some(quota_limit) = quota {
        let (used_bytes, reserved_bytes): (i64, i64) = sqlx::query_as(
            "SELECT \
                (SELECT COALESCE(SUM(v.size_bytes), 0)::BIGINT \
                   FROM drive_entries e \
                   JOIN files f ON f.id = e.id \
                   JOIN file_versions v ON v.id = f.current_version_id \
                   JOIN storage_objects o ON o.id = v.storage_object_id AND o.state = 'ready' \
                  WHERE e.owner_id = $1) AS used_bytes, \
                (SELECT COALESCE(SUM(expected_size), 0)::BIGINT \
                   FROM upload_sessions \
                  WHERE owner_id = $1 \
                    AND (state = 'finalizing' OR (state = 'active' AND expires_at > now()))) \
                    AS reserved_bytes",
        )
        .bind(account.user_id)
        .fetch_one(&mut *tx)
        .await?;
        let committed = used_bytes.max(0).saturating_add(reserved_bytes.max(0));
        if committed.saturating_add(size_i64) > quota_limit {
            let _ = storage.remove_staging_file(staging_key).await;
            anyhow::bail!("user quota exceeded");
        }
    }

    sqlx::query(
        "INSERT INTO storage_objects (id, storage_key, size_bytes, state) \
         VALUES ($1, $2, $3, 'pending')",
    )
    .bind(object_id)
    .bind(&storage_key)
    .bind(size_i64)
    .execute(&mut *tx)
    .await?;

    let existing_file: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM drive_entries \
          WHERE owner_id = $1 AND deleted_at IS NULL AND kind = 'file' \
            AND parent_id IS NOT DISTINCT FROM $2 AND lower(name) = lower($3)",
    )
    .bind(account.user_id)
    .bind(parent_id)
    .bind(&name)
    .fetch_optional(&mut *tx)
    .await?;

    let file_id = if let Some(id) = existing_file {
        sqlx::query("UPDATE drive_entries SET updated_at = now() WHERE id = $1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        id
    } else {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO drive_entries (id, owner_id, parent_id, kind, name) \
             VALUES ($1, $2, $3, 'file', $4)",
        )
        .bind(id)
        .bind(account.user_id)
        .bind(parent_id)
        .bind(&name)
        .execute(&mut *tx)
        .await?;
        sqlx::query("INSERT INTO files (id) VALUES ($1)")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        id
    };

    let version_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO file_versions (id, file_id, storage_object_id, size_bytes, original_modified_at) \
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(version_id)
    .bind(file_id)
    .bind(object_id)
    .bind(size_i64)
    .bind(modified_at)
    .execute(&mut *tx)
    .await?;

    sqlx::query("UPDATE files SET current_version_id = $1 WHERE id = $2")
        .bind(version_id)
        .bind(file_id)
        .execute(&mut *tx)
        .await?;

    if let Err(error) = storage
        .promote_staging_file(staging_key, &storage_key)
        .await
    {
        let _ = storage.remove_staging_file(staging_key).await;
        return Err(error.into());
    }

    sqlx::query(
        "UPDATE storage_objects \
            SET state = 'ready', checksum_sha256 = $2, mime_detected = $3 \
          WHERE id = $1",
    )
    .bind(object_id)
    .bind(&checksum)
    .bind(detected_mime.as_deref())
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    // Replace the regular file in the SMB view with a symlink to the finalized object.
    let link_path = reg.abs_path.clone();
    let target = object_target(data_target, &storage_key);
    tokio::task::spawn_blocking(move || replace_with_symlink(&link_path, &target)).await??;
    Ok(())
}

fn copy_and_hash_to_staging(
    src: &Path,
    dst: &Path,
    filename: &str,
) -> anyhow::Result<(u64, String, Option<String>)> {
    use std::io::Write;
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut reader = std::fs::File::open(src)?;
    let mut writer = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dst)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    let mut header = Vec::with_capacity(8192);
    let mut total = 0u64;
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        if header.len() < 8192 {
            let take = (8192 - header.len()).min(n);
            header.extend_from_slice(&buf[..take]);
        }
        hasher.update(&buf[..n]);
        writer.write_all(&buf[..n])?;
        total += n as u64;
    }
    writer.sync_all()?;
    let digest: [u8; 32] = hasher.finalize().into();
    let checksum: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    let mime = guess_mime(&header, filename);
    Ok((total, checksum, mime))
}

fn guess_mime(header: &[u8], filename: &str) -> Option<String> {
    if let Some(detected) = crate::transfers::sniff_media_type(header) {
        return Some(detected.to_owned());
    }
    let ext = Path::new(filename)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    let guessed = match ext.as_deref() {
        Some("txt") | Some("log") | Some("md") => "text/plain",
        Some("csv") => "text/csv",
        Some("json") => "application/json",
        Some("xml") => "application/xml",
        Some("html") | Some("htm") => "text/html",
        Some("css") => "text/css",
        Some("js") | Some("mjs") => "text/javascript",
        Some("svg") => "image/svg+xml",
        Some("pdf") => "application/pdf",
        Some("docx") => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        Some("xlsx") => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        Some("pptx") => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        Some("zip") => "application/zip",
        _ => return None,
    };
    Some(guessed.to_owned())
}

fn replace_with_symlink(path: &Path, target: &Path) -> std::io::Result<()> {
    let tmp = path.with_file_name(format!(
        ".smb-link-{}.tmp",
        Uuid::new_v4().simple()
    ));
    make_symlink(target, &tmp)?;
    if let Err(error) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(error);
    }
    Ok(())
}

fn scan_fs(root: &Path) -> anyhow::Result<FsScan> {
    let mut scan = FsScan::default();
    if !root.exists() {
        return Ok(scan);
    }
    scan_dir(root, root, &mut scan)?;
    Ok(scan)
}

fn scan_dir(root: &Path, dir: &Path, scan: &mut FsScan) -> anyhow::Result<()> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        let Ok(rel) = path.strip_prefix(root) else {
            continue;
        };
        let rel_str = rel
            .components()
            .filter_map(|c| c.as_os_str().to_str())
            .collect::<Vec<_>>()
            .join("/");
        if rel_str.is_empty() {
            continue;
        }
        if meta.file_type().is_symlink() {
            if let Ok(target) = std::fs::read_link(&path) {
                scan.symlinks.insert(rel_str, target);
            }
        } else if meta.is_dir() {
            scan.dirs.insert(rel_str);
            scan_dir(root, &path, scan)?;
        } else if meta.is_file() {
            let (mtime_secs, mtime_nanos) = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| (d.as_secs(), d.subsec_nanos()))
                .unwrap_or((0, 0));
            scan.regular_files.push(RegularFile {
                rel_path: rel_str,
                abs_path: path,
                size: meta.len(),
                mtime_secs,
                mtime_nanos,
            });
        }
    }
    Ok(())
}

fn load_snapshot_file(path: &Path) -> Option<Snapshot> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn save_snapshot_file(path: &Path, snap: &Snapshot) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    let data = serde_json::to_vec(snap)?;
    std::fs::write(&tmp, data)?;
    std::fs::rename(tmp, path)?;
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02X}")).collect()
}

fn write_users_list(view: &Path, content: &str) -> anyhow::Result<()> {
    std::fs::create_dir_all(view)?;
    let target = view.join("users.list");
    if std::fs::read_to_string(&target).is_ok_and(|existing| existing == content) {
        return Ok(());
    }
    let temp = view.join("users.list.tmp");
    {
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
    }
    std::fs::rename(temp, target)?;
    Ok(())
}

fn write_quota_file(
    view: &Path,
    username: &str,
    total_bytes: u64,
    free_bytes: u64,
) -> anyhow::Result<()> {
    let dir = view.join("quota");
    std::fs::create_dir_all(&dir)?;
    let total_kb = total_bytes / 1024;
    let free_kb = free_bytes / 1024;
    let content = format!("{total_kb} {free_kb}\n");
    let target = dir.join(username);
    if std::fs::read_to_string(&target).is_ok_and(|existing| existing == content) {
        return Ok(());
    }
    let tmp = dir.join(format!("{username}.tmp"));
    std::fs::write(&tmp, content)?;
    std::fs::rename(tmp, target)?;
    Ok(())
}

fn cleanup_inactive_users(view: &Path, active: &HashSet<String>) -> anyhow::Result<()> {
    let root = view.join("tree");
    std::fs::create_dir_all(&root)?;
    for entry in std::fs::read_dir(&root)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !active.contains(&name) {
            remove_any(&entry.path());
        }
    }
    let state_dir = view.join("state");
    if state_dir.is_dir() {
        for entry in std::fs::read_dir(&state_dir)?.flatten() {
            let file_name = entry.file_name().to_string_lossy().into_owned();
            if let Some(username) = file_name.strip_suffix(".json") {
                if !active.contains(username) {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    }
    let quota_dir = view.join("quota");
    if quota_dir.is_dir() {
        for entry in std::fs::read_dir(&quota_dir)?.flatten() {
            let username = entry.file_name().to_string_lossy().into_owned();
            if !active.contains(&username) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    Ok(())
}

fn remove_any(path: &Path) {
    let result = match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => std::fs::remove_dir_all(path),
        Ok(_) => std::fs::remove_file(path),
        Err(_) => return,
    };
    if let Err(error) = result {
        tracing::warn!(path = %path.display(), error = %error, "could not remove stale SMB view entry");
    }
}

fn relative(path: &str) -> PathBuf {
    path.split('/').collect()
}

fn sync_tree(
    root: &Path,
    data_target: &str,
    snap: &Snapshot,
    keep_regular: &HashSet<PathBuf>,
) -> anyhow::Result<()> {
    std::fs::create_dir_all(root)?;
    let mut dirs: HashSet<PathBuf> = HashSet::new();
    let mut links: HashMap<PathBuf, PathBuf> = HashMap::new();
    for dir_path in snap.dirs.keys() {
        dirs.insert(root.join(relative(dir_path)));
    }
    for (file_path, synced) in &snap.files {
        let path = root.join(relative(file_path));
        links.insert(path, object_target(data_target, &synced.storage_key));
    }
    // Keep parent directories of in-flight regular files so prune() does not delete them.
    for reg in keep_regular {
        let mut cursor = reg.parent();
        while let Some(dir) = cursor {
            if dir == root || !dir.starts_with(root) {
                break;
            }
            dirs.insert(dir.to_path_buf());
            cursor = dir.parent();
        }
    }
    prune(root, &dirs, &links, keep_regular);
    for dir in &dirs {
        std::fs::create_dir_all(dir)?;
    }
    for (path, target) in &links {
        if keep_regular.contains(path) {
            continue;
        }
        if std::fs::symlink_metadata(path).is_ok() {
            continue;
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        make_symlink(target, path)?;
    }
    Ok(())
}

fn prune(
    dir: &Path,
    dirs: &HashSet<PathBuf>,
    links: &HashMap<PathBuf, PathBuf>,
    keep_regular: &HashSet<PathBuf>,
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            let keep = links.get(&path).is_some_and(|target| {
                std::fs::read_link(&path).is_ok_and(|current| &current == target)
            });
            if !keep {
                remove_any(&path);
            }
        } else if meta.is_dir() {
            if dirs.contains(&path) {
                prune(&path, dirs, links, keep_regular);
            } else {
                remove_any(&path);
            }
        } else if !keep_regular.contains(&path) {
            remove_any(&path);
        }
    }
}

#[cfg(unix)]
fn make_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(not(unix))]
fn make_symlink(_target: &Path, _link: &Path) -> std::io::Result<()> {
    Err(std::io::Error::other("SMB view requires a Unix host"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nt_hash_matches_known_vector() {
        // Well-known NT hash of "password".
        assert_eq!(
            hex(&nt_hash("password")),
            "8846F7EAEE8FB117AD06BDD830B7586C"
        );
    }

    #[test]
    fn usernames_are_unix_safe_and_unique_per_attempt() {
        assert_eq!(username_candidate("Van.Tan@example.com", 0), "van.tan");
        assert_eq!(username_candidate("1abc+x@e.com", 0), "u1abc_x");
        assert_eq!(username_candidate("a@e.com", 2), "a2");
        assert!(username_candidate(&format!("{}@e.com", "x".repeat(60)), 12).len() <= 32);
    }

    #[test]
    fn object_target_includes_objects_subdirectory_and_roundtrips() {
        let target = object_target("/srv/my-drive/data", "aa/bb/one");
        assert_eq!(target, Path::new("/srv/my-drive/data/objects/aa/bb/one"));
        assert_eq!(
            extract_storage_key("/srv/my-drive/data", &target).as_deref(),
            Some("aa/bb/one")
        );
        assert_eq!(
            extract_storage_key("/srv/my-drive/data", Path::new("/srv/my-drive/data/aa/bb/one")),
            None
        );
    }

    #[test]
    fn ignored_smb_names_filter_os_junk() {
        assert!(is_ignored_smb_name(".DS_Store"));
        assert!(is_ignored_smb_name("Thumbs.db"));
        assert!(is_ignored_smb_name("._photo.jpg"));
        assert!(is_ignored_smb_name("~$report.docx"));
        assert!(!is_ignored_smb_name("report.docx"));
        assert!(!is_ignored_smb_name(".env"));
    }

    #[cfg(unix)]
    #[test]
    fn view_tree_uses_objects_subdir_and_replaces_legacy_dangling_links() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("alice");
        std::fs::create_dir_all(root.join("Docs")).unwrap();
        // Simulate legacy broken symlink (missing /objects/)
        make_symlink(
            Path::new("/srv/data/aa/bb/one"),
            &root.join("Docs/a.txt"),
        )
        .unwrap();

        let mut first = Snapshot::default();
        first.dirs.insert("Docs".into(), Uuid::new_v4());
        first.files.insert(
            "Docs/a.txt".into(),
            SyncedFile {
                entry_id: Uuid::new_v4(),
                storage_key: "aa/bb/one".into(),
            },
        );
        first.files.insert(
            "b.txt".into(),
            SyncedFile {
                entry_id: Uuid::new_v4(),
                storage_key: "cc/dd/two".into(),
            },
        );

        sync_tree(&root, "/srv/data", &first, &HashSet::new()).unwrap();
        assert_eq!(
            std::fs::read_link(root.join("Docs/a.txt")).unwrap(),
            Path::new("/srv/data/objects/aa/bb/one")
        );
        assert_eq!(
            std::fs::read_link(root.join("b.txt")).unwrap(),
            Path::new("/srv/data/objects/cc/dd/two")
        );

        // Pending regular file must not be pruned during sync_tree.
        let pending_file = root.join("NewUpload/in-progress.bin");
        std::fs::create_dir_all(pending_file.parent().unwrap()).unwrap();
        std::fs::write(&pending_file, b"partial").unwrap();
        let mut keep = HashSet::new();
        keep.insert(pending_file.clone());

        let mut second = Snapshot::default();
        second.files.insert(
            "b.txt".into(),
            SyncedFile {
                entry_id: Uuid::new_v4(),
                storage_key: "ee/ff/three".into(),
            },
        );
        sync_tree(&root, "/srv/data", &second, &keep).unwrap();
        assert!(!root.join("Docs").exists());
        assert!(pending_file.is_file());
        assert_eq!(
            std::fs::read_link(root.join("b.txt")).unwrap(),
            Path::new("/srv/data/objects/ee/ff/three")
        );
    }

    #[test]
    fn diff_detects_new_dirs_renames_and_deletions_only_with_prior_snapshot() {
        let dir_id = Uuid::new_v4();
        let file_a = Uuid::new_v4();
        let file_b = Uuid::new_v4();

        let mut db = Snapshot::default();
        db.dirs.insert("OldDir".into(), dir_id);
        db.files.insert(
            "a.txt".into(),
            SyncedFile {
                entry_id: file_a,
                storage_key: "aa/bb/one".into(),
            },
        );
        db.files.insert(
            "b.txt".into(),
            SyncedFile {
                entry_id: file_b,
                storage_key: "cc/dd/two".into(),
            },
        );

        let mut scan = FsScan::default();
        scan.dirs.insert("BrandNew".into());
        scan.dirs.insert("BrandNew/Sub".into());
        // a.txt was renamed to BrandNew/a_renamed.txt; b.txt and OldDir were deleted.
        scan.symlinks.insert(
            "BrandNew/a_renamed.txt".into(),
            object_target("/srv/data", "aa/bb/one"),
        );

        // Without prior snapshot: detects new dirs, NEVER deletes anything.
        let first_diff = diff_smb_changes(None, &db, &scan, "/srv/data");
        assert_eq!(first_diff.new_dirs, vec!["BrandNew", "BrandNew/Sub"]);
        assert!(first_diff.deleted_files.is_empty());
        assert!(first_diff.deleted_dirs.is_empty());

        // With prior snapshot == db: detects new dirs, rename of a.txt, deletion of b.txt & OldDir.
        let diff = diff_smb_changes(Some(&db), &db, &scan, "/srv/data");
        assert_eq!(diff.new_dirs, vec!["BrandNew", "BrandNew/Sub"]);
        assert_eq!(
            diff.renamed_files,
            vec![(file_a, "a.txt".into(), "BrandNew/a_renamed.txt".into())]
        );
        assert_eq!(diff.deleted_files, vec![(file_b, "b.txt".into())]);
        assert_eq!(diff.deleted_dirs, vec![(dir_id, "OldDir".into())]);
    }

    #[test]
    fn mapped_drive_space_respects_quota_and_physical_hdd_limits() {
        let hdd = FilesystemUsage {
            total_bytes: 1_000_000,
            free_bytes: 400_000,
        };
        // Finite quota smaller than HDD free space: reports exact quota & remaining.
        assert_eq!(
            compute_mapped_drive_space(Some(100_000), 25_000, Some(hdd)),
            (100_000, 75_000)
        );
        // Finite quota larger than HDD free space: clamps free space to HDD free.
        assert_eq!(
            compute_mapped_drive_space(Some(800_000), 100_000, Some(hdd)),
            (500_000, 400_000)
        );
        // Unlimited quota: reports real HDD total & free.
        assert_eq!(
            compute_mapped_drive_space(None, 50_000, Some(hdd)),
            (1_000_000, 400_000)
        );
        // Over quota: free space is 0 and total >= used.
        assert_eq!(
            compute_mapped_drive_space(Some(100_000), 120_000, Some(hdd)),
            (120_000, 0)
        );
    }

    #[test]
    fn write_quota_file_outputs_kb_blocks() {
        let dir = tempfile::tempdir().unwrap();
        write_quota_file(dir.path(), "alice", 1024 * 500, 1024 * 350).unwrap();
        let text = std::fs::read_to_string(dir.path().join("quota/alice")).unwrap();
        assert_eq!(text, "500 350\n");
    }
}
