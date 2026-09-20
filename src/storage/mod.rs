mod mount;

use std::{fs, path::PathBuf};

use fs2::available_space;
use thiserror::Error;

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
        storage.health()?;
        Ok(storage)
    }

    pub fn health(&self) -> Result<(), StorageError> {
        if self.require_mount {
            self.validate_mount()?;
        }

        let free_bytes = available_space(&self.root)?;
        let total_bytes = fs2::total_space(&self.root)?;
        if total_bytes == 0 {
            return Err(StorageError::UnknownCapacity);
        }
        let free_percent = (free_bytes as f64 / total_bytes as f64) * 100.0;
        if free_bytes < self.min_free_bytes || free_percent < self.min_free_percent {
            return Err(StorageError::LowSpace);
        }

        Ok(())
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
}
