use std::path::Path;
#[cfg(any(target_os = "linux", test))]
use std::path::PathBuf;

use super::StorageError;

#[cfg(any(target_os = "linux", test))]
#[derive(Debug, PartialEq, Eq)]
struct MountEntry {
    device: String,
    mount_point: PathBuf,
}

#[cfg(target_os = "linux")]
pub(super) fn verify_mount(
    expected_mount: &Path,
    require_device_match: bool,
    expected_device: Option<&str>,
) -> Result<(), StorageError> {
    let contents = std::fs::read_to_string("/proc/self/mountinfo")
        .map_err(|_| StorageError::MountInfoUnavailable)?;
    let entry = parse_mountinfo(&contents)
        .into_iter()
        .find(|entry| entry.mount_point == expected_mount)
        .ok_or(StorageError::MountMissing)?;

    if require_device_match && expected_device != Some(entry.device.as_str()) {
        return Err(StorageError::DeviceMismatch);
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
pub(super) fn verify_mount(
    _expected_mount: &Path,
    require_device_match: bool,
    _expected_device: Option<&str>,
) -> Result<(), StorageError> {
    if require_device_match {
        return Err(StorageError::MountVerificationUnsupported);
    }
    Err(StorageError::MountVerificationUnsupported)
}

#[cfg(any(target_os = "linux", test))]
fn parse_mountinfo(contents: &str) -> Vec<MountEntry> {
    contents
        .lines()
        .filter_map(|line| {
            let (mount_fields, _) = line.split_once(" - ")?;
            let fields = mount_fields.split_whitespace().collect::<Vec<_>>();
            let device = fields.get(2)?.to_string();
            let mount_point = fields.get(4)?;
            Some(MountEntry {
                device,
                mount_point: PathBuf::from(decode_mount_field(mount_point)),
            })
        })
        .collect()
}

#[cfg(any(target_os = "linux", test))]
fn decode_mount_field(field: &str) -> String {
    let input = field.as_bytes();
    let mut output = Vec::with_capacity(input.len());
    let mut index = 0;
    while index < input.len() {
        if input[index] == b'\\'
            && index + 3 < input.len()
            && input[index + 1..=index + 3]
                .iter()
                .all(|digit| (b'0'..=b'7').contains(digit))
        {
            let value = (input[index + 1] - b'0') * 64
                + (input[index + 2] - b'0') * 8
                + (input[index + 3] - b'0');
            output.push(value);
            index += 4;
        } else {
            output.push(input[index]);
            index += 1;
        }
    }
    String::from_utf8_lossy(&output).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_mount_point_and_device_from_linux_mountinfo() {
        let contents = "36 25 8:17 / /srv/my\\040drive/data rw,nosuid - ext4 /dev/sdb1 rw\n";
        assert_eq!(
            parse_mountinfo(contents),
            vec![MountEntry {
                device: "8:17".to_owned(),
                mount_point: PathBuf::from("/srv/my drive/data"),
            }]
        );
    }

    #[test]
    fn rejects_malformed_mountinfo_lines() {
        assert!(parse_mountinfo("not mount info\n").is_empty());
    }
}
