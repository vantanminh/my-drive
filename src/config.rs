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
    pub max_file_size: u64,
    pub owner_quota_bytes: u64,
    pub min_free_bytes: u64,
    pub min_free_percent: f64,
    pub upload_session_ttl_seconds: u64,
    pub trash_retention_days: u64,
    pub session_ttl_seconds: u64,
    pub bootstrap_owner: Option<BootstrapOwner>,
    pub cookie_secure: bool,
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

        Ok(Self {
            database_url,
            bind_addr,
            storage_root,
            expected_mount,
            require_mount,
            require_device_match,
            expected_device,
            max_file_size: u64_value(vars, "MAX_FILE_SIZE", 5 * 1024 * 1024 * 1024)?,
            owner_quota_bytes: u64_value(vars, "OWNER_QUOTA_BYTES", 100 * 1024 * 1024 * 1024)?,
            min_free_bytes: u64_value(vars, "MIN_FREE_BYTES", 5 * 1024 * 1024 * 1024)?,
            min_free_percent: f64_value(vars, "MIN_FREE_PERCENT", 5.0)?,
            upload_session_ttl_seconds,
            trash_retention_days: u64_value(vars, "TRASH_RETENTION_DAYS", 30)?,
            session_ttl_seconds,
            bootstrap_owner,
            cookie_secure: bool_value(vars, "COOKIE_SECURE", true)?,
        })
    }
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

    fn base_vars() -> HashMap<String, String> {
        HashMap::from([
            (
                "DATABASE_URL".to_owned(),
                "postgres://localhost/mydrive".to_owned(),
            ),
            ("STORAGE_ROOT".to_owned(), "C:/my-drive-data".to_owned()),
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
}
