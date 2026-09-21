use std::{fs, path::PathBuf};

use crate::MediaPreviewConfig;

use super::{StorageError, mount};

#[derive(Clone)]
pub struct PreviewStorage {
    root: PathBuf,
    expected_mount: PathBuf,
    require_mount: bool,
    require_device_match: bool,
    expected_device: Option<String>,
}

impl PreviewStorage {
    pub fn new(config: &MediaPreviewConfig) -> Self {
        Self {
            root: config.root.clone(),
            expected_mount: config.expected_mount.clone(),
            require_mount: config.require_mount,
            require_device_match: config.require_device_match,
            expected_device: config.expected_device.clone(),
        }
    }

    pub fn prepare(&self) -> Result<(), StorageError> {
        if !self.require_mount {
            match fs::symlink_metadata(&self.root) {
                Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                    return Err(StorageError::MissingRoot);
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    fs::create_dir_all(&self.root)?;
                }
                Err(error) => return Err(error.into()),
            }
        }
        self.validate_mount()
    }

    pub fn health(&self) -> Result<(), StorageError> {
        self.validate_mount()
    }

    fn validate_mount(&self) -> Result<(), StorageError> {
        reject_symlink_or_non_directory(&self.root)?;
        reject_symlink_or_non_directory(&self.expected_mount)?;

        let root = fs::canonicalize(&self.root).map_err(|_| StorageError::MissingRoot)?;
        let expected_mount =
            fs::canonicalize(&self.expected_mount).map_err(|_| StorageError::MountMissing)?;
        if root.strip_prefix(&expected_mount).is_err() {
            return Err(StorageError::OutsideExpectedMount);
        }
        if self.require_mount {
            mount::verify_mount(
                &expected_mount,
                self.require_device_match,
                self.expected_device.as_deref(),
            )?;
        }
        Ok(())
    }
}

fn reject_symlink_or_non_directory(path: &std::path::Path) -> Result<(), StorageError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| StorageError::MissingRoot)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(StorageError::MissingRoot);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    #[test]
    fn missing_required_ssd_mount_does_not_create_a_fallback_directory() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("preview-mount");
        fs::create_dir(&root).unwrap();
        let storage = PreviewStorage::new(&MediaPreviewConfig {
            root: root.clone(),
            expected_mount: root.clone(),
            require_mount: true,
            require_device_match: true,
            expected_device: Some("8:2".to_owned()),
        });

        assert!(storage.prepare().is_err());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
    }

    #[test]
    fn explicit_local_mode_creates_only_the_configured_preview_directory() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("ssd-previews");
        let storage = PreviewStorage::new(&MediaPreviewConfig {
            root: root.clone(),
            expected_mount: root.clone(),
            require_mount: false,
            require_device_match: false,
            expected_device: None,
        });

        storage.prepare().unwrap();
        assert!(root.is_dir());
        assert_eq!(storage.root, root);
    }

    #[cfg(unix)]
    #[test]
    fn preview_root_symlinks_are_rejected_before_any_directory_is_created() {
        use std::os::unix::fs::symlink;

        let temporary = tempfile::tempdir().unwrap();
        let real_root = temporary.path().join("real-previews");
        let link_root = temporary.path().join("preview-link");
        fs::create_dir(&real_root).unwrap();
        symlink(&real_root, &link_root).unwrap();
        let storage = PreviewStorage::new(&MediaPreviewConfig {
            root: link_root,
            expected_mount: real_root.clone(),
            require_mount: false,
            require_device_match: false,
            expected_device: None,
        });

        assert!(storage.prepare().is_err());
        assert_eq!(fs::read_dir(real_root).unwrap().count(), 0);
    }
}
