mod mount;

use std::{fs, io, path::PathBuf};

use fs2::available_space;
use thiserror::Error;
use tokio::fs as tokio_fs;
use uuid::Uuid;

use crate::Config;

#[derive(Clone)]
pub struct LocalStorage {
    root: PathBuf,
    expected_mount: PathBuf,
    require_mount: bool,
    require_device_match: bool,
    expected_device: Option<String>,
    min_free_bytes: u64,
    min_free_percent: f64,
}

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("storage root is missing or is not a directory")]
    MissingRoot,
    #[error("storage root is outside the configured mounted filesystem")]
    OutsideExpectedMount,
    #[error("configured storage path is not mounted")]
    MountMissing,
    #[cfg(target_os = "linux")]
    #[error("storage device does not match STORAGE_EXPECTED_DEVICE")]
    DeviceMismatch,
    #[cfg(not(target_os = "linux"))]
    #[error("mount verification is supported only on Linux")]
    MountVerificationUnsupported,
    #[cfg(target_os = "linux")]
    #[error("could not read Linux mount information")]
    MountInfoUnavailable,
    #[error("storage has less free space than the configured safety threshold")]
    LowSpace,
    #[error("storage has no measurable capacity")]
    UnknownCapacity,
    #[error("storage object key is invalid")]
    UnsafeKey,
    #[error("staging and finalized object both exist unexpectedly")]
    ObjectCollision,
    #[error("storage filesystem operation failed: {0}")]
    Io(#[from] std::io::Error),
}

impl LocalStorage {
    pub fn initialize(config: &Config) -> Result<Self, StorageError> {
        let mut storage = Self {
            root: config.storage_root.clone(),
            expected_mount: config.expected_mount.clone(),
            require_mount: config.require_mount,
            require_device_match: config.require_device_match,
            expected_device: config.expected_device.clone(),
            min_free_bytes: config.min_free_bytes,
            min_free_percent: config.min_free_percent,
        };

        if storage.require_mount {
            storage.validate_mount()?;
        } else {
            fs::create_dir_all(&storage.root)?;
        }
        storage.root = fs::canonicalize(&storage.root)?;

        for child in ["objects", "uploads", "trash", "previews"] {
            fs::create_dir_all(storage.root.join(child))?;
        }
        sync_directory(&storage.root)?;
        storage.health()?;
        Ok(storage)
    }

    pub fn health(&self) -> Result<(), StorageError> {
        self.ensure_mounted()?;

        let (free_bytes, total_bytes) = self.capacity()?;
        if free_bytes < self.required_free_bytes(total_bytes) {
            return Err(StorageError::LowSpace);
        }
        Ok(())
    }

    pub fn ensure_mounted(&self) -> Result<(), StorageError> {
        if self.require_mount {
            self.validate_mount()?;
        }
        Ok(())
    }

    pub fn check_write_capacity(&self, additional_bytes: u64) -> Result<(), StorageError> {
        self.ensure_mounted()?;
        let (free_bytes, total_bytes) = self.capacity()?;
        if additional_bytes > free_bytes
            || free_bytes - additional_bytes < self.required_free_bytes(total_bytes)
        {
            return Err(StorageError::LowSpace);
        }
        Ok(())
    }

    pub fn staging_path(&self, staging_key: Uuid) -> PathBuf {
        self.root
            .join("uploads")
            .join(format!("{staging_key}.part"))
    }

    pub fn storage_key(object_id: Uuid) -> String {
        let id = object_id.to_string();
        format!("{}/{}/{}", &id[..2], &id[2..4], id)
    }

    pub fn object_path(&self, storage_key: &str) -> Result<PathBuf, StorageError> {
        let mut components = storage_key.split('/');
        let first = components.next().ok_or(StorageError::UnsafeKey)?;
        let second = components.next().ok_or(StorageError::UnsafeKey)?;
        let filename = components.next().ok_or(StorageError::UnsafeKey)?;
        if components.next().is_some()
            || first.len() != 2
            || second.len() != 2
            || !first
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            || !second
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err(StorageError::UnsafeKey);
        }
        let object_id = Uuid::parse_str(filename).map_err(|_| StorageError::UnsafeKey)?;
        let canonical = object_id.to_string();
        if canonical != filename || &canonical[..2] != first || &canonical[2..4] != second {
            return Err(StorageError::UnsafeKey);
        }
        Ok(self
            .root
            .join("objects")
            .join(first)
            .join(second)
            .join(canonical))
    }

    pub async fn create_staging_file(&self, staging_key: Uuid) -> Result<(), StorageError> {
        self.ensure_mounted()?;
        let file = tokio_fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(self.staging_path(staging_key))
            .await?;
        file.sync_all().await?;
        sync_directory(&self.root.join("uploads"))?;
        Ok(())
    }

    pub async fn remove_staging_file(&self, staging_key: Uuid) -> Result<(), StorageError> {
        self.ensure_mounted()?;
        match tokio_fs::remove_file(self.staging_path(staging_key)).await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(StorageError::Io(error)),
        }
    }

    pub async fn promote_staging_file(
        &self,
        staging_key: Uuid,
        storage_key: &str,
    ) -> Result<PathBuf, StorageError> {
        self.ensure_mounted()?;
        let source = self.staging_path(staging_key);
        let destination = self.object_path(storage_key)?;
        let parent = self.ensure_object_parent(storage_key, true).await?;
        let source_exists = tokio_fs::try_exists(&source).await?;
        let destination_exists = tokio_fs::try_exists(&destination).await?;
        match (source_exists, destination_exists) {
            (true, true) => return Err(StorageError::ObjectCollision),
            (true, false) => {
                match tokio_fs::rename(&source, &destination).await {
                    Ok(()) => {}
                    Err(error)
                        if error.kind() == io::ErrorKind::NotFound
                            && tokio_fs::try_exists(&destination).await?
                            && !tokio_fs::try_exists(&source).await? =>
                    {
                        // Another finalizer completed the same atomic rename.
                    }
                    Err(error) => return Err(StorageError::Io(error)),
                }
                sync_directory_chain(&parent, &self.root.join("objects"))?;
                sync_directory(&self.root.join("uploads"))?;
            }
            (false, true) => {}
            (false, false) => {
                return Err(StorageError::Io(io::Error::from(io::ErrorKind::NotFound)));
            }
        }
        Ok(destination)
    }

    pub async fn open_object(&self, storage_key: &str) -> Result<tokio_fs::File, StorageError> {
        self.ensure_mounted()?;
        let path = self.object_path(storage_key)?;
        self.ensure_object_parent(storage_key, false).await?;
        let metadata = tokio_fs::symlink_metadata(&path).await?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(StorageError::UnsafeKey);
        }
        Ok(tokio_fs::File::open(path).await?)
    }

    pub async fn object_exists(&self, storage_key: &str) -> Result<bool, StorageError> {
        self.ensure_mounted()?;
        let path = self.object_path(storage_key)?;
        match self.ensure_object_parent(storage_key, false).await {
            Ok(_) => {}
            Err(StorageError::Io(error)) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(false);
            }
            Err(error) => return Err(error),
        }
        match tokio_fs::symlink_metadata(&path).await {
            Ok(metadata) if !metadata.file_type().is_symlink() && metadata.is_file() => Ok(true),
            Ok(_) => Err(StorageError::UnsafeKey),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(StorageError::Io(error)),
        }
    }

    pub async fn remove_object(&self, storage_key: &str) -> Result<(), StorageError> {
        self.ensure_mounted()?;
        let path = self.object_path(storage_key)?;
        let parent = match self.ensure_object_parent(storage_key, false).await {
            Ok(parent) => parent,
            Err(StorageError::Io(error)) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(());
            }
            Err(error) => return Err(error),
        };
        match tokio_fs::symlink_metadata(&path).await {
            Ok(metadata) if !metadata.file_type().is_symlink() && metadata.is_file() => {
                tokio_fs::remove_file(&path).await?;
                sync_directory(&parent)?;
                Ok(())
            }
            Ok(_) => Err(StorageError::UnsafeKey),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(StorageError::Io(error)),
        }
    }

    async fn ensure_object_parent(
        &self,
        storage_key: &str,
        create_missing: bool,
    ) -> Result<PathBuf, StorageError> {
        let destination = self.object_path(storage_key)?;
        let mut components = storage_key.split('/');
        let first = components.next().ok_or(StorageError::UnsafeKey)?;
        let second = components.next().ok_or(StorageError::UnsafeKey)?;
        let mut current = self.root.join("objects");
        for (index, component) in [None, Some(first), Some(second)].into_iter().enumerate() {
            if let Some(component) = component {
                current.push(component);
            }
            match tokio_fs::symlink_metadata(&current).await {
                Ok(metadata) if !metadata.file_type().is_symlink() && metadata.is_dir() => {}
                Ok(_) => return Err(StorageError::UnsafeKey),
                Err(error)
                    if error.kind() == io::ErrorKind::NotFound && create_missing && index > 0 =>
                {
                    match tokio_fs::create_dir(&current).await {
                        Ok(()) => {
                            let parent = current.parent().ok_or(StorageError::UnsafeKey)?;
                            sync_directory(parent)?;
                        }
                        Err(create_error)
                            if create_error.kind() == io::ErrorKind::AlreadyExists => {}
                        Err(create_error) => return Err(StorageError::Io(create_error)),
                    }
                    let metadata = tokio_fs::symlink_metadata(&current).await?;
                    if metadata.file_type().is_symlink() || !metadata.is_dir() {
                        return Err(StorageError::UnsafeKey);
                    }
                }
                Err(error) => return Err(StorageError::Io(error)),
            }
        }
        destination
            .parent()
            .map(PathBuf::from)
            .ok_or(StorageError::UnsafeKey)
    }

    fn capacity(&self) -> Result<(u64, u64), StorageError> {
        let free_bytes = available_space(&self.root)?;
        let total_bytes = fs2::total_space(&self.root)?;
        if total_bytes == 0 {
            return Err(StorageError::UnknownCapacity);
        }
        Ok((free_bytes, total_bytes))
    }

    fn required_free_bytes(&self, total_bytes: u64) -> u64 {
        let percent_floor =
            ((total_bytes as f64 * self.min_free_percent / 100.0).ceil() as u64).min(total_bytes);
        self.min_free_bytes.max(percent_floor)
    }

    fn validate_mount(&self) -> Result<(), StorageError> {
        let root = fs::canonicalize(&self.root).map_err(|_| StorageError::MissingRoot)?;
        let expected =
            fs::canonicalize(&self.expected_mount).map_err(|_| StorageError::MountMissing)?;
        if !root.is_dir() || !expected.is_dir() {
            return Err(StorageError::MissingRoot);
        }
        if root.strip_prefix(&expected).is_err() {
            return Err(StorageError::OutsideExpectedMount);
        }

        mount::verify_mount(
            &expected,
            self.require_device_match,
            self.expected_device.as_deref(),
        )
    }
}

#[cfg(unix)]
fn sync_directory(path: &std::path::Path) -> Result<(), StorageError> {
    fs::File::open(path)?.sync_all()?;
    Ok(())
}

fn sync_directory_chain(
    path: &std::path::Path,
    stop_at: &std::path::Path,
) -> Result<(), StorageError> {
    let mut current = path;
    loop {
        if !current.starts_with(stop_at) {
            return Err(StorageError::UnsafeKey);
        }
        sync_directory(current)?;
        if current == stop_at {
            return Ok(());
        }
        current = current.parent().ok_or(StorageError::UnsafeKey)?;
    }
}

#[cfg(not(unix))]
fn sync_directory(_path: &std::path::Path) -> Result<(), StorageError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::net::SocketAddr;

    use super::*;

    fn config(storage_root: PathBuf, require_mount: bool) -> Config {
        Config {
            database_url: "postgres://localhost/my-drive-test".to_owned(),
            bind_addr: "127.0.0.1:3000".parse::<SocketAddr>().unwrap(),
            expected_mount: storage_root.clone(),
            storage_root,
            require_mount,
            require_device_match: false,
            expected_device: None,
            max_file_size: 1024,
            owner_quota_bytes: 4096,
            min_free_bytes: 0,
            min_free_percent: 0.0,
            upload_session_ttl_seconds: 60,
            trash_retention_days: 30,
            session_ttl_seconds: 60,
            bootstrap_owner: None,
            cookie_secure: true,
        }
    }

    #[test]
    fn required_mount_failure_does_not_create_storage_directories() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("mounted-hdd");
        fs::create_dir(&root).unwrap();

        assert!(LocalStorage::initialize(&config(root.clone(), true)).is_err());
        assert!(!root.join("objects").exists());
        assert!(!root.join("uploads").exists());
    }

    #[test]
    fn local_development_mode_creates_directories_only_when_explicitly_selected() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("development-data");

        let storage = LocalStorage::initialize(&config(root.clone(), false)).unwrap();
        assert_eq!(storage.root, fs::canonicalize(&root).unwrap());
        for child in ["objects", "uploads", "trash", "previews"] {
            assert!(root.join(child).is_dir());
        }
    }

    #[test]
    fn generated_object_keys_are_sharded_and_cannot_escape_storage() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("data");
        let storage = LocalStorage::initialize(&config(root.clone(), false)).unwrap();
        let id = Uuid::new_v4();
        let key = LocalStorage::storage_key(id);
        let path = storage.object_path(&key).unwrap();
        assert!(path.starts_with(storage.root.join("objects")));
        assert!(matches!(
            storage.check_write_capacity(u64::MAX),
            Err(StorageError::LowSpace)
        ));
        assert!(storage.object_path("../outside").is_err());
        assert!(storage.object_path("aa/bb/not-a-uuid").is_err());
        assert!(
            storage
                .object_path(&format!("ff/{}/{}", &id.to_string()[2..4], id))
                .is_err()
        );
    }

    #[test]
    fn initialization_rejects_a_storage_root_below_the_configured_free_space_floor() {
        let temp = tempfile::tempdir().unwrap();
        let mut config = config(temp.path().join("data"), false);
        config.min_free_bytes = u64::MAX;
        assert!(matches!(
            LocalStorage::initialize(&config),
            Err(StorageError::LowSpace)
        ));
    }

    #[tokio::test]
    async fn object_removal_is_idempotent_and_refuses_non_file_paths() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("data");
        let storage = LocalStorage::initialize(&config(root.clone(), false)).unwrap();
        let object_id = Uuid::new_v4();
        let key = LocalStorage::storage_key(object_id);
        let staging_key = Uuid::new_v4();
        storage.create_staging_file(staging_key).await.unwrap();
        tokio_fs::write(storage.staging_path(staging_key), b"payload")
            .await
            .unwrap();
        let path = storage
            .promote_staging_file(staging_key, &key)
            .await
            .unwrap();
        assert!(storage.object_exists(&key).await.unwrap());

        storage.remove_object(&key).await.unwrap();
        storage.remove_object(&key).await.unwrap();
        assert!(!path.exists());
        assert!(!storage.object_exists(&key).await.unwrap());

        let obstructed_id = Uuid::new_v4();
        let obstructed_key = LocalStorage::storage_key(obstructed_id);
        let obstructed_path = storage.object_path(&obstructed_key).unwrap();
        fs::create_dir_all(&obstructed_path).unwrap();
        assert!(matches!(
            storage.remove_object(&obstructed_key).await,
            Err(StorageError::UnsafeKey)
        ));
        assert!(obstructed_path.is_dir());
    }
}
