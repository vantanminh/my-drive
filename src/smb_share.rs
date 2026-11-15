//! Read-only SMB view of every user's drive.
//!
//! Drive contents are stored under content-addressed keys and the folder tree
//! only exists in PostgreSQL, so Samba cannot share the storage directory
//! directly. While the owner has SMB enabled, this worker materialises a tree of
//! symlinks (`<view>/tree/<smb user>/Folder/file -> <data>/<storage key>`) and a
//! `users.list` file with the NT hashes. The `smb` container (Samba) shares
//! `tree/%U` read-only and imports `users.list`. Nothing here can modify drive
//! data: the links are read-only views and Samba exports read-only.

use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::OnceLock,
    time::Duration,
};

use md4::{Digest, Md4};
use sqlx::PgPool;
use uuid::Uuid;

pub(crate) static VIEW_DIR: OnceLock<PathBuf> = OnceLock::new();

const INTERVAL: Duration = Duration::from_secs(10);
const MAX_ENTRIES_PER_USER: i64 = 500_000;

pub(crate) fn available() -> bool {
    VIEW_DIR.get().is_some()
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

pub(crate) async fn run_worker(pool: PgPool) {
    let Some(view) = VIEW_DIR.get().cloned() else {
        return;
    };
    let data_target =
        std::env::var("SMB_DATA_TARGET").unwrap_or_else(|_| "/srv/my-drive/data".into());
    tracing::info!(view = %view.display(), "SMB view worker started");
    loop {
        if let Err(error) = cycle(&pool, &view, &data_target).await {
            tracing::warn!(error = %error, "SMB view refresh failed");
        }
        tokio::time::sleep(INTERVAL).await;
    }
}

#[derive(sqlx::FromRow)]
struct Account {
    user_id: Uuid,
    username: String,
    nt_hash: Vec<u8>,
}

#[derive(sqlx::FromRow)]
struct Node {
    kind: String,
    path: String,
    storage_key: Option<String>,
}

async fn cycle(pool: &PgPool, view: &Path, data_target: &str) -> anyhow::Result<()> {
    let enabled: bool =
        sqlx::query_scalar("SELECT smb_enabled FROM network_drive_settings WHERE singleton")
            .fetch_optional(pool)
            .await?
            .unwrap_or(false);
    let accounts: Vec<Account> = if enabled {
        sqlx::query_as(
            "SELECT a.user_id, a.username, a.nt_hash FROM smb_accounts a \
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

    let mut trees: HashMap<String, Vec<Node>> = HashMap::new();
    for account in &accounts {
        let nodes: Vec<Node> = sqlx::query_as(
            "WITH RECURSIVE tree AS ( \
                 SELECT e.id, e.kind, e.name::text AS path FROM drive_entries e \
                  WHERE e.owner_id = $1 AND e.parent_id IS NULL AND e.deleted_at IS NULL \
                 UNION ALL \
                 SELECT c.id, c.kind, t.path || '/' || c.name FROM drive_entries c \
                   JOIN tree t ON c.parent_id = t.id \
                  WHERE c.owner_id = $1 AND c.deleted_at IS NULL AND t.kind = 'folder') \
             SELECT t.kind, t.path, o.storage_key FROM tree t \
               LEFT JOIN files f ON f.id = t.id \
               LEFT JOIN file_versions v ON v.id = f.current_version_id \
               LEFT JOIN storage_objects o ON o.id = v.storage_object_id AND o.state = 'ready' \
              LIMIT $2",
        )
        .bind(account.user_id)
        .bind(MAX_ENTRIES_PER_USER)
        .fetch_all(pool)
        .await?;
        trees.insert(account.username.clone(), nodes);
    }
    let view_owned = view.to_path_buf();
    let data_target = data_target.to_owned();
    tokio::task::spawn_blocking(move || sync_all(&view_owned, &data_target, &trees)).await??;
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

fn sync_all(
    view: &Path,
    data_target: &str,
    trees: &HashMap<String, Vec<Node>>,
) -> anyhow::Result<()> {
    let root = view.join("tree");
    std::fs::create_dir_all(&root)?;
    for entry in std::fs::read_dir(&root)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !trees.contains_key(&name) {
            remove_any(&entry.path());
        }
    }
    for (username, nodes) in trees {
        sync_tree(&root.join(username), data_target, nodes)?;
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

fn sync_tree(root: &Path, data_target: &str, nodes: &[Node]) -> anyhow::Result<()> {
    std::fs::create_dir_all(root)?;
    let mut dirs: HashSet<PathBuf> = HashSet::new();
    let mut links: HashMap<PathBuf, PathBuf> = HashMap::new();
    for node in nodes {
        let path = root.join(relative(&node.path));
        if node.kind == "folder" {
            dirs.insert(path);
        } else if let Some(key) = &node.storage_key {
            links.insert(path, Path::new(data_target).join(key));
        }
    }
    prune(root, &dirs, &links);
    for dir in &dirs {
        std::fs::create_dir_all(dir)?;
    }
    for (path, target) in &links {
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

fn prune(dir: &Path, dirs: &HashSet<PathBuf>, links: &HashMap<PathBuf, PathBuf>) {
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
                prune(&path, dirs, links);
            } else {
                remove_any(&path);
            }
        } else {
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

    #[cfg(unix)]
    #[test]
    fn view_tree_is_synced_incrementally() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("alice");
        let node = |kind: &str, path: &str, key: Option<&str>| Node {
            kind: kind.into(),
            path: path.into(),
            storage_key: key.map(Into::into),
        };
        let first = vec![
            node("folder", "Docs", None),
            node("file", "Docs/a.txt", Some("aa/bb/one")),
            node("file", "b.txt", Some("cc/dd/two")),
        ];
        let target = "/srv/data";
        sync_tree(&root, target, &first).unwrap();
        assert_eq!(
            std::fs::read_link(root.join("Docs/a.txt")).unwrap(),
            Path::new("/srv/data/aa/bb/one")
        );
        let second = vec![node("file", "b.txt", Some("ee/ff/three"))];
        sync_tree(&root, target, &second).unwrap();
        assert!(!root.join("Docs").exists());
        assert_eq!(
            std::fs::read_link(root.join("b.txt")).unwrap(),
            Path::new("/srv/data/ee/ff/three")
        );
    }
}
