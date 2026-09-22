use std::{fs, path::PathBuf};

use sha2::{Digest, Sha256};
use tokio::{
    fs as tokio_fs,
    io::{AsyncReadExt, AsyncWriteExt},
};
use uuid::Uuid;

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

    pub async fn publish_derivative(
        &self,
        version_id: Uuid,
        variant: &str,
        recipe_version: i16,
        bytes: &[u8],
    ) -> Result<(), StorageError> {
        if !matches!(
            variant,
            "card" | "viewer" | "video_poster" | "video_preview"
        ) || recipe_version <= 0
            || bytes.is_empty()
        {
            return Err(StorageError::UnsafeKey);
        }
        self.validate_mount()?;
        let (free_bytes, _) = capacity(&self.root)?;
        let reserve = u64::try_from(bytes.len())
            .unwrap_or(u64::MAX)
            .saturating_add(64 * 1024 * 1024);
        if free_bytes < reserve {
            return Err(StorageError::LowSpace);
        }

        let version_dir = self.root.join(version_id.to_string());
        ensure_directory(&version_dir)?;
        let destination = version_dir.join(derivative_filename(variant, recipe_version)?);
        let staging = version_dir.join(format!(".stage-{}.tmp", Uuid::new_v4()));

        let result = async {
            let mut file = tokio_fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&staging)
                .await?;
            file.write_all(bytes).await?;
            file.sync_all().await?;
            drop(file);

            self.validate_mount()?;
            #[cfg(not(unix))]
            if tokio_fs::try_exists(&destination).await? {
                tokio_fs::remove_file(&destination).await?;
            }
            tokio_fs::rename(&staging, &destination).await?;
            super::sync_directory(&version_dir)?;
            Ok::<(), StorageError>(())
        }
        .await;

        if result.is_err() {
            let _ = tokio_fs::remove_file(&staging).await;
        }
        result?;

        Ok(())
    }

    pub async fn read_derivative(
        &self,
        version_id: Uuid,
        variant: &str,
        recipe_version: i16,
        expected_size: i64,
        expected_checksum: &str,
        max_bytes: u64,
    ) -> Result<Vec<u8>, StorageError> {
        if !matches!(
            variant,
            "card" | "viewer" | "video_poster" | "video_preview"
        ) || recipe_version <= 0
            || expected_size <= 0
            || u64::try_from(expected_size).unwrap_or(u64::MAX) > max_bytes
            || expected_checksum.len() != 64
            || !expected_checksum
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(StorageError::CorruptDerivative);
        }
        self.validate_mount()?;
        let version_dir = self.root.join(version_id.to_string());
        reject_symlink_or_non_directory(&version_dir)?;
        let path = version_dir.join(derivative_filename(variant, recipe_version)?);
        let metadata = tokio_fs::symlink_metadata(&path).await?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(StorageError::UnsafeKey);
        }
        if metadata.len() != expected_size as u64 || metadata.len() > max_bytes {
            return Err(StorageError::CorruptDerivative);
        }
        let file = tokio_fs::File::open(path).await?;
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        file.take(max_bytes.saturating_add(1))
            .read_to_end(&mut bytes)
            .await?;
        if bytes.len() as u64 != metadata.len()
            || !format!("{:x}", Sha256::digest(&bytes)).eq_ignore_ascii_case(expected_checksum)
        {
            return Err(StorageError::CorruptDerivative);
        }
        Ok(bytes)
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

fn derivative_filename(variant: &str, recipe_version: i16) -> Result<String, StorageError> {
    if recipe_version <= 0 {
        return Err(StorageError::UnsafeKey);
    }
    let extension = if variant == "video_preview" {
        "mp4"
    } else if matches!(variant, "card" | "viewer" | "video_poster") {
        "webp"
    } else {
        return Err(StorageError::UnsafeKey);
    };
    Ok(format!("{variant}-v{recipe_version}.{extension}"))
}

fn ensure_directory(path: &std::path::Path) -> Result<(), StorageError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.file_type().is_symlink() && metadata.is_dir() => Ok(()),
        Ok(_) => Err(StorageError::UnsafeKey),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => match fs::create_dir(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let metadata = fs::symlink_metadata(path)?;
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    Err(StorageError::UnsafeKey)
                } else {
                    Ok(())
                }
            }
            Err(error) => Err(StorageError::Io(error)),
        },
        Err(error) => Err(StorageError::Io(error)),
    }
}

fn capacity(path: &std::path::Path) -> Result<(u64, u64), StorageError> {
    let free_bytes = fs2::available_space(path)?;
    let total_bytes = fs2::total_space(path)?;
    if total_bytes == 0 {
        return Err(StorageError::UnknownCapacity);
    }
    Ok((free_bytes, total_bytes))
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

    #[tokio::test]
    async fn derivative_files_use_version_scoped_names_and_atomic_staging() {
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
        let version_id = Uuid::new_v4();

        storage
            .publish_derivative(version_id, "card", 1, b"checked-webp-bytes")
            .await
            .unwrap();
        storage
            .publish_derivative(version_id, "video_poster", 1, b"checked-video-poster")
            .await
            .unwrap();
        storage
            .publish_derivative(version_id, "video_preview", 1, b"checked-video-mp4")
            .await
            .unwrap();

        assert_eq!(
            fs::read(root.join(format!("{version_id}/card-v1.webp"))).unwrap(),
            b"checked-webp-bytes"
        );
        assert_eq!(
            fs::read(root.join(format!("{version_id}/video_poster-v1.webp"))).unwrap(),
            b"checked-video-poster"
        );
        assert_eq!(
            fs::read(root.join(format!("{version_id}/video_preview-v1.mp4"))).unwrap(),
            b"checked-video-mp4"
        );
        assert_eq!(
            fs::read_dir(root.join(version_id.to_string()))
                .unwrap()
                .count(),
            3
        );
        let poster_checksum = format!("{:x}", Sha256::digest(b"checked-video-poster"));
        assert_eq!(
            storage
                .read_derivative(
                    version_id,
                    "video_poster",
                    1,
                    i64::try_from(b"checked-video-poster".len()).unwrap(),
                    &poster_checksum,
                    1024,
                )
                .await
                .unwrap(),
            b"checked-video-poster"
        );
        assert!(
            storage
                .publish_derivative(version_id, "../objects", 1, b"no")
                .await
                .is_err()
        );
        let video_checksum = format!("{:x}", Sha256::digest(b"checked-video-mp4"));
        assert_eq!(
            storage
                .read_derivative(
                    version_id,
                    "video_preview",
                    1,
                    i64::try_from(b"checked-video-mp4".len()).unwrap(),
                    &video_checksum,
                    1024,
                )
                .await
                .unwrap(),
            b"checked-video-mp4"
        );
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
