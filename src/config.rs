use std::{collections::HashMap, env, net::SocketAddr, path::PathBuf};

use thiserror::Error;

pub struct Config {
    pub database_url: String,
    pub bind_addr: SocketAddr,
    pub storage_root: PathBuf,
    pub expected_mount: PathBuf,
    pub require_mount: bool,
    pub require_device_match: bool,
    pub expected_device: Option<String>,
    pub media_preview: Option<MediaPreviewConfig>,
    pub max_file_size: u64,
    pub owner_quota_bytes: u64,
    pub min_free_bytes: u64,
    pub min_free_percent: f64,
    pub upload_session_ttl_seconds: u64,
    pub trash_retention_days: u64,
    pub session_ttl_seconds: u64,
    pub bootstrap_owner: Option<BootstrapOwner>,
    pub cookie_secure: bool,
    pub google_drive: Option<GoogleDriveSettings>,
}

#[derive(Clone)]
pub struct MediaPreviewConfig {
    pub root: PathBuf,
    pub expected_mount: PathBuf,
    pub require_mount: bool,
    pub require_device_match: bool,
    pub expected_device: Option<String>,
}

pub struct BootstrapOwner {
    pub email: String,
    pub password: String,
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("missing required configuration: {0}")]
    Missing(&'static str),
    #[error("invalid configuration value: {0}")]
    Invalid(&'static str),
    #[error("BOOTSTRAP_OWNER_EMAIL and BOOTSTRAP_OWNER_PASSWORD must be set together")]
    PartialBootstrapCredentials,
    #[error("STORAGE_EXPECTED_DEVICE is required when STORAGE_REQUIRE_DEVICE_MATCH is true")]
    MissingExpectedDevice,
    #[error(
        "MEDIA_PREVIEW_EXPECTED_DEVICE is required when preview device verification is enabled"
    )]
    MissingMediaPreviewDevice,
    #[error(
        "GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REDIRECT_URI, and GOOGLE_DRIVE_TOKEN_KEY must be set together"
    )]
    PartialGoogleDrive,
}

#[derive(Clone)]
pub struct GoogleDriveSettings {
    pub client_id: String,
    pub client_secret: String,
    pub redirect_uri: String,
    pub token_key: [u8; 32],
}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        let vars = env::vars().collect::<HashMap<_, _>>();
        Self::from_vars(&vars)
    }

    fn from_vars(vars: &HashMap<String, String>) -> Result<Self, ConfigError> {
        let database_url = required(vars, "DATABASE_URL")?;
        let storage_root = absolute_path(vars, "STORAGE_ROOT")?;
        let expected_mount = match nonempty(vars, "STORAGE_EXPECTED_MOUNT") {
            Some(value) => path_from_value(value, "STORAGE_EXPECTED_MOUNT")?,
            None => storage_root.clone(),
        };
        let bind_addr = match nonempty(vars, "BIND_ADDR") {
            Some(value) => value
                .parse::<SocketAddr>()
                .map_err(|_| ConfigError::Invalid("BIND_ADDR"))?,
            None => "127.0.0.1:3000"
                .parse()
                .expect("the built-in socket address is valid"),
        };

        let require_mount = bool_value(vars, "STORAGE_REQUIRE_MOUNT", true)?;
        let require_device_match = bool_value(vars, "STORAGE_REQUIRE_DEVICE_MATCH", false)?;
        let expected_device = nonempty(vars, "STORAGE_EXPECTED_DEVICE").map(str::to_owned);
        if require_device_match && !require_mount {
            return Err(ConfigError::Invalid("STORAGE_REQUIRE_DEVICE_MATCH"));
        }
        if require_device_match && expected_device.is_none() {
            return Err(ConfigError::MissingExpectedDevice);
        }
        if expected_device
            .as_deref()
            .is_some_and(|device| !valid_device_id(device))
        {
            return Err(ConfigError::Invalid("STORAGE_EXPECTED_DEVICE"));
        }

        let media_preview = match nonempty(vars, "MEDIA_PREVIEW_ROOT") {
            Some(value) => {
                let root = path_from_value(value, "MEDIA_PREVIEW_ROOT")?;
                let preview_expected_mount = match nonempty(vars, "MEDIA_PREVIEW_EXPECTED_MOUNT") {
                    Some(value) => path_from_value(value, "MEDIA_PREVIEW_EXPECTED_MOUNT")?,
                    None => root.clone(),
                };
                let preview_require_mount = bool_value(vars, "MEDIA_PREVIEW_REQUIRE_MOUNT", true)?;
                let preview_require_device_match =
                    bool_value(vars, "MEDIA_PREVIEW_REQUIRE_DEVICE_MATCH", true)?;
                let media_preview_device =
                    nonempty(vars, "MEDIA_PREVIEW_EXPECTED_DEVICE").map(str::to_owned);

                if preview_require_device_match && !preview_require_mount {
                    return Err(ConfigError::Invalid("MEDIA_PREVIEW_REQUIRE_DEVICE_MATCH"));
                }
                if preview_require_device_match && media_preview_device.is_none() {
                    return Err(ConfigError::MissingMediaPreviewDevice);
                }
                if media_preview_device
                    .as_deref()
                    .is_some_and(|device| !valid_device_id(device))
                {
                    return Err(ConfigError::Invalid("MEDIA_PREVIEW_EXPECTED_DEVICE"));
                }
                if (require_mount || require_device_match) && !preview_require_mount {
                    return Err(ConfigError::Invalid("MEDIA_PREVIEW_REQUIRE_MOUNT"));
                }
                if (require_mount || require_device_match) && !preview_require_device_match {
                    return Err(ConfigError::Invalid("MEDIA_PREVIEW_REQUIRE_DEVICE_MATCH"));
                }
                if preview_require_device_match && !require_device_match {
                    return Err(ConfigError::Invalid("STORAGE_REQUIRE_DEVICE_MATCH"));
                }

                if root == storage_root
                    || root.starts_with(&storage_root)
                    || storage_root.starts_with(&root)
                    || preview_expected_mount == expected_mount
                    || preview_expected_mount.starts_with(&expected_mount)
                    || expected_mount.starts_with(&preview_expected_mount)
                {
                    return Err(ConfigError::Invalid("MEDIA_PREVIEW_ROOT"));
                }
                if expected_device.is_some()
                    && media_preview_device.as_deref() == expected_device.as_deref()
                {
                    return Err(ConfigError::Invalid("MEDIA_PREVIEW_EXPECTED_DEVICE"));
                }

                Some(MediaPreviewConfig {
                    root,
                    expected_mount: preview_expected_mount,
                    require_mount: preview_require_mount,
                    require_device_match: preview_require_device_match,
                    expected_device: media_preview_device,
                })
            }
            None => {
                if [
                    "MEDIA_PREVIEW_EXPECTED_MOUNT",
                    "MEDIA_PREVIEW_REQUIRE_MOUNT",
                    "MEDIA_PREVIEW_REQUIRE_DEVICE_MATCH",
                    "MEDIA_PREVIEW_EXPECTED_DEVICE",
                ]
                .iter()
                .any(|name| nonempty(vars, name).is_some())
                {
                    return Err(ConfigError::Invalid("MEDIA_PREVIEW_ROOT"));
                }
                None
            }
        };

        let bootstrap_email = nonempty(vars, "BOOTSTRAP_OWNER_EMAIL");
        let bootstrap_password = nonempty(vars, "BOOTSTRAP_OWNER_PASSWORD");
        let bootstrap_owner = match (bootstrap_email, bootstrap_password) {
            (None, None) => None,
            (Some(_), None) | (None, Some(_)) => {
                return Err(ConfigError::PartialBootstrapCredentials);
            }
            (Some(email), Some(password)) => {
                if password.len() < 16 {
                    return Err(ConfigError::Invalid("BOOTSTRAP_OWNER_PASSWORD"));
                }
                Some(BootstrapOwner {
                    email: email.trim().to_lowercase(),
                    password: password.to_owned(),
                })
            }
        };
        let session_ttl_seconds = u64_value(vars, "SESSION_TTL", 604_800)?;
        if session_ttl_seconds == 0 || i64::try_from(session_ttl_seconds).is_err() {
            return Err(ConfigError::Invalid("SESSION_TTL"));
        }
        let upload_session_ttl_seconds = u64_value(vars, "UPLOAD_SESSION_TTL", 86_400)?;
        if upload_session_ttl_seconds == 0 || i64::try_from(upload_session_ttl_seconds).is_err() {
            return Err(ConfigError::Invalid("UPLOAD_SESSION_TTL"));
        }
        let trash_retention_days = u64_value(vars, "TRASH_RETENTION_DAYS", 30)?;
        if trash_retention_days == 0 || i64::try_from(trash_retention_days).is_err() {
            return Err(ConfigError::Invalid("TRASH_RETENTION_DAYS"));
        }
        let google_drive = google_drive_settings(vars)?;

        Ok(Self {
            database_url,
            bind_addr,
            storage_root,
            expected_mount,
            require_mount,
            require_device_match,
            expected_device,
            media_preview,
            max_file_size: u64_value(vars, "MAX_FILE_SIZE", 5 * 1024 * 1024 * 1024)?,
            owner_quota_bytes: u64_value(vars, "OWNER_QUOTA_BYTES", 100 * 1024 * 1024 * 1024)?,
            min_free_bytes: u64_value(vars, "MIN_FREE_BYTES", 5 * 1024 * 1024 * 1024)?,
            min_free_percent: f64_value(vars, "MIN_FREE_PERCENT", 5.0)?,
            upload_session_ttl_seconds,
            trash_retention_days,
            session_ttl_seconds,
            bootstrap_owner,
            cookie_secure: bool_value(vars, "COOKIE_SECURE", true)?,
            google_drive,
        })
    }
}

fn google_drive_settings(
    vars: &HashMap<String, String>,
) -> Result<Option<GoogleDriveSettings>, ConfigError> {
    let client_id = nonempty(vars, "GOOGLE_OAUTH_CLIENT_ID");
    let client_secret = nonempty(vars, "GOOGLE_OAUTH_CLIENT_SECRET");
    let redirect_uri = nonempty(vars, "GOOGLE_OAUTH_REDIRECT_URI");
    let token_key = nonempty(vars, "GOOGLE_DRIVE_TOKEN_KEY");
    match (client_id, client_secret, redirect_uri, token_key) {
        (None, None, None, None) => Ok(None),
        (Some(client_id), Some(client_secret), Some(redirect_uri), Some(token_key)) => {
            if !valid_oauth_client_value(client_id, 10, 200) {
                return Err(ConfigError::Invalid("GOOGLE_OAUTH_CLIENT_ID"));
            }
            if !valid_oauth_client_value(client_secret, 8, 256) {
                return Err(ConfigError::Invalid("GOOGLE_OAUTH_CLIENT_SECRET"));
            }
            if !valid_redirect_uri(redirect_uri) {
                return Err(ConfigError::Invalid("GOOGLE_OAUTH_REDIRECT_URI"));
            }
            let Some(token_key) = decode_token_key(token_key) else {
                return Err(ConfigError::Invalid("GOOGLE_DRIVE_TOKEN_KEY"));
            };
            Ok(Some(GoogleDriveSettings {
                client_id: client_id.to_owned(),
                client_secret: client_secret.to_owned(),
                redirect_uri: redirect_uri.to_owned(),
                token_key,
            }))
        }
        _ => Err(ConfigError::PartialGoogleDrive),
    }
}

fn valid_oauth_client_value(value: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_graphic() && byte != b'"' && byte != b'\\' && byte != b'&')
}

fn valid_redirect_uri(value: &str) -> bool {
    (value.starts_with("https://") || value.starts_with("http://"))
        && value.contains("/api/google-drive/callback")
        && (16..=500).contains(&value.len())
        && !value
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
}

fn decode_token_key(value: &str) -> Option<[u8; 32]> {
    if value.len() != 64 {
        return None;
    }
    let mut key = [0_u8; 32];
    for (index, byte) in key.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(key)
}

fn required(vars: &HashMap<String, String>, name: &'static str) -> Result<String, ConfigError> {
    nonempty(vars, name)
        .map(str::to_owned)
        .ok_or(ConfigError::Missing(name))
}

fn absolute_path(
    vars: &HashMap<String, String>,
    name: &'static str,
) -> Result<PathBuf, ConfigError> {
    let value = required(vars, name)?;
    path_from_value(&value, name)
}

fn path_from_value(value: &str, name: &'static str) -> Result<PathBuf, ConfigError> {
    let path = PathBuf::from(value.trim());
    if !path.is_absolute() {
        return Err(ConfigError::Invalid(name));
    }
    Ok(path)
}

fn nonempty<'a>(vars: &'a HashMap<String, String>, name: &str) -> Option<&'a str> {
    vars.get(name)
        .map(String::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn valid_device_id(value: &str) -> bool {
    let Some((major, minor)) = value.split_once(':') else {
        return false;
    };
    major.parse::<u32>().is_ok() && minor.parse::<u32>().is_ok()
}

fn bool_value(
    vars: &HashMap<String, String>,
    name: &'static str,
    default: bool,
) -> Result<bool, ConfigError> {
    match nonempty(vars, name) {
        Some(value) if value.eq_ignore_ascii_case("true") => Ok(true),
        Some(value) if value.eq_ignore_ascii_case("false") => Ok(false),
        Some(_) => Err(ConfigError::Invalid(name)),
        None => Ok(default),
    }
}

fn u64_value(
    vars: &HashMap<String, String>,
    name: &'static str,
    default: u64,
) -> Result<u64, ConfigError> {
    match nonempty(vars, name) {
        Some(value) => value.parse().map_err(|_| ConfigError::Invalid(name)),
        None => Ok(default),
    }
}

fn f64_value(
    vars: &HashMap<String, String>,
    name: &'static str,
    default: f64,
) -> Result<f64, ConfigError> {
    match nonempty(vars, name) {
        Some(value) => {
            let parsed = value
                .parse::<f64>()
                .map_err(|_| ConfigError::Invalid(name))?;
            if !parsed.is_finite() || !(0.0..=100.0).contains(&parsed) {
                return Err(ConfigError::Invalid(name));
            }
            Ok(parsed)
        }
        None => Ok(default),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_path(name: &str) -> PathBuf {
        std::env::current_dir()
            .expect("the test working directory must be available")
            .join("target")
            .join("config-tests")
            .join(name)
    }

    fn path_value(path: PathBuf) -> String {
        path.to_string_lossy().into_owned()
    }

    fn base_vars() -> HashMap<String, String> {
        HashMap::from([
            (
                "DATABASE_URL".to_owned(),
                "postgres://localhost/mydrive".to_owned(),
            ),
            ("STORAGE_ROOT".to_owned(), path_value(test_path("storage"))),
        ])
    }

    #[test]
    fn requires_an_explicit_storage_root() {
        let vars = HashMap::from([(
            "DATABASE_URL".to_owned(),
            "postgres://localhost/mydrive".to_owned(),
        )]);

        assert!(matches!(
            Config::from_vars(&vars),
            Err(ConfigError::Missing("STORAGE_ROOT"))
        ));
    }

    #[test]
    fn production_mount_checks_require_an_expected_device_when_enabled() {
        let mut vars = base_vars();
        vars.insert("STORAGE_REQUIRE_DEVICE_MATCH".to_owned(), "true".to_owned());

        assert!(matches!(
            Config::from_vars(&vars),
            Err(ConfigError::MissingExpectedDevice)
        ));
    }

    #[test]
    fn expected_device_must_be_a_linux_major_minor_pair() {
        let mut vars = base_vars();
        vars.insert(
            "STORAGE_EXPECTED_DEVICE".to_owned(),
            "not-a-device".to_owned(),
        );

        assert!(matches!(
            Config::from_vars(&vars),
            Err(ConfigError::Invalid("STORAGE_EXPECTED_DEVICE"))
        ));
    }

    #[test]
    fn media_preview_storage_is_optional_for_existing_local_configurations() {
        let config = Config::from_vars(&base_vars()).unwrap();
        assert!(config.media_preview.is_none());
    }

    #[test]
    fn configured_media_preview_requires_a_mount_and_device_identity() {
        let mut vars = base_vars();
        vars.insert(
            "MEDIA_PREVIEW_ROOT".to_owned(),
            path_value(test_path("previews")),
        );
        assert!(matches!(
            Config::from_vars(&vars),
            Err(ConfigError::MissingMediaPreviewDevice)
        ));

        vars.insert("MEDIA_PREVIEW_EXPECTED_DEVICE".to_owned(), "8:2".to_owned());
        vars.insert("STORAGE_REQUIRE_DEVICE_MATCH".to_owned(), "true".to_owned());
        vars.insert("STORAGE_EXPECTED_DEVICE".to_owned(), "8:1".to_owned());
        assert!(Config::from_vars(&vars).unwrap().media_preview.is_some());
    }

    #[test]
    fn preview_device_verification_requires_hdd_device_verification_too() {
        let mut vars = base_vars();
        vars.insert(
            "MEDIA_PREVIEW_ROOT".to_owned(),
            path_value(test_path("previews")),
        );
        vars.insert("MEDIA_PREVIEW_EXPECTED_DEVICE".to_owned(), "8:2".to_owned());

        assert!(matches!(
            Config::from_vars(&vars),
            Err(ConfigError::Invalid("STORAGE_REQUIRE_DEVICE_MATCH"))
        ));
    }

    #[test]
    fn mounted_production_preview_storage_cannot_disable_device_verification() {
        let mut vars = base_vars();
        vars.insert("STORAGE_REQUIRE_DEVICE_MATCH".to_owned(), "true".to_owned());
        vars.insert("STORAGE_EXPECTED_DEVICE".to_owned(), "8:1".to_owned());
        vars.insert(
            "MEDIA_PREVIEW_ROOT".to_owned(),
            path_value(test_path("previews")),
        );
        vars.insert(
            "MEDIA_PREVIEW_REQUIRE_DEVICE_MATCH".to_owned(),
            "false".to_owned(),
        );

        assert!(matches!(
            Config::from_vars(&vars),
            Err(ConfigError::Invalid("MEDIA_PREVIEW_REQUIRE_DEVICE_MATCH"))
        ));
    }

    #[test]
    fn media_preview_storage_cannot_overlap_the_original_hdd_tree() {
        let mut vars = base_vars();
        vars.insert("STORAGE_REQUIRE_MOUNT".to_owned(), "false".to_owned());
        vars.insert("MEDIA_PREVIEW_REQUIRE_MOUNT".to_owned(), "false".to_owned());
        vars.insert(
            "MEDIA_PREVIEW_REQUIRE_DEVICE_MATCH".to_owned(),
            "false".to_owned(),
        );
        vars.insert(
            "MEDIA_PREVIEW_ROOT".to_owned(),
            path_value(test_path("storage").join("previews")),
        );

        assert!(matches!(
            Config::from_vars(&vars),
            Err(ConfigError::Invalid("MEDIA_PREVIEW_ROOT"))
        ));
    }

    #[test]
    fn media_preview_storage_cannot_share_the_hdd_device() {
        let mut vars = base_vars();
        vars.insert("STORAGE_REQUIRE_DEVICE_MATCH".to_owned(), "true".to_owned());
        vars.insert("STORAGE_EXPECTED_DEVICE".to_owned(), "8:1".to_owned());
        vars.insert(
            "MEDIA_PREVIEW_ROOT".to_owned(),
            path_value(test_path("previews")),
        );
        vars.insert("MEDIA_PREVIEW_EXPECTED_DEVICE".to_owned(), "8:1".to_owned());

        assert!(matches!(
            Config::from_vars(&vars),
            Err(ConfigError::Invalid("MEDIA_PREVIEW_EXPECTED_DEVICE"))
        ));
    }

    #[test]
    fn bootstrap_credentials_must_be_a_pair_and_long_enough() {
        let mut vars = base_vars();
        vars.insert(
            "BOOTSTRAP_OWNER_EMAIL".to_owned(),
            "owner@example.test".to_owned(),
        );
        assert!(matches!(
            Config::from_vars(&vars),
            Err(ConfigError::PartialBootstrapCredentials)
        ));

        vars.insert("BOOTSTRAP_OWNER_PASSWORD".to_owned(), "short".to_owned());
        assert!(matches!(
            Config::from_vars(&vars),
            Err(ConfigError::Invalid("BOOTSTRAP_OWNER_PASSWORD"))
        ));
    }

    #[test]
    fn invalid_free_space_percentage_is_rejected() {
        let mut vars = base_vars();
        vars.insert("MIN_FREE_PERCENT".to_owned(), "101".to_owned());
        assert!(matches!(
            Config::from_vars(&vars),
            Err(ConfigError::Invalid("MIN_FREE_PERCENT"))
        ));
    }

    #[test]
    fn session_ttl_must_be_positive_and_fit_postgres_timestamps() {
        let mut vars = base_vars();
        vars.insert("SESSION_TTL".to_owned(), "0".to_owned());
        assert!(matches!(
            Config::from_vars(&vars),
            Err(ConfigError::Invalid("SESSION_TTL"))
        ));
        vars.insert("SESSION_TTL".to_owned(), u64::MAX.to_string());
        assert!(matches!(
            Config::from_vars(&vars),
            Err(ConfigError::Invalid("SESSION_TTL"))
        ));
    }

    #[test]
    fn upload_session_ttl_must_be_positive_and_fit_postgres_timestamps() {
        let mut vars = base_vars();
        vars.insert("UPLOAD_SESSION_TTL".to_owned(), "0".to_owned());
        assert!(matches!(
            Config::from_vars(&vars),
            Err(ConfigError::Invalid("UPLOAD_SESSION_TTL"))
        ));
        vars.insert("UPLOAD_SESSION_TTL".to_owned(), u64::MAX.to_string());
        assert!(matches!(
            Config::from_vars(&vars),
            Err(ConfigError::Invalid("UPLOAD_SESSION_TTL"))
        ));
    }

    #[test]
    fn trash_retention_must_be_positive_and_fit_postgres_timestamps() {
        let mut vars = base_vars();
        vars.insert("TRASH_RETENTION_DAYS".to_owned(), "0".to_owned());
        assert!(matches!(
            Config::from_vars(&vars),
            Err(ConfigError::Invalid("TRASH_RETENTION_DAYS"))
        ));
        vars.insert("TRASH_RETENTION_DAYS".to_owned(), u64::MAX.to_string());
        assert!(matches!(
            Config::from_vars(&vars),
            Err(ConfigError::Invalid("TRASH_RETENTION_DAYS"))
        ));
    }

    #[test]
    fn google_drive_settings_are_optional_and_all_or_nothing() {
        let config = Config::from_vars(&base_vars()).unwrap();
        assert!(config.google_drive.is_none());

        let mut partial = base_vars();
        partial.insert(
            "GOOGLE_OAUTH_CLIENT_ID".to_owned(),
            "client-id.apps.googleusercontent.com".to_owned(),
        );
        assert!(matches!(
            Config::from_vars(&partial),
            Err(ConfigError::PartialGoogleDrive)
        ));

        let mut vars = base_vars();
        vars.insert(
            "GOOGLE_OAUTH_CLIENT_ID".to_owned(),
            "client-id.apps.googleusercontent.com".to_owned(),
        );
        vars.insert(
            "GOOGLE_OAUTH_CLIENT_SECRET".to_owned(),
            "secret-value".to_owned(),
        );
        vars.insert(
            "GOOGLE_OAUTH_REDIRECT_URI".to_owned(),
            "https://drive.example.com/api/google-drive/callback".to_owned(),
        );
        vars.insert("GOOGLE_DRIVE_TOKEN_KEY".to_owned(), "ab".repeat(32));
        let settings = Config::from_vars(&vars)
            .unwrap()
            .google_drive
            .expect("complete google drive settings");
        assert_eq!(settings.token_key[0], 0xab);
        assert!(settings.redirect_uri.contains("/api/google-drive/callback"));

        vars.insert("GOOGLE_DRIVE_TOKEN_KEY".to_owned(), "zz".repeat(32));
        assert!(matches!(
            Config::from_vars(&vars),
            Err(ConfigError::Invalid("GOOGLE_DRIVE_TOKEN_KEY"))
        ));
    }
}
