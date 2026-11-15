use anyhow::{Context, anyhow};
use argon2::{
    Algorithm, Argon2, Params, Version,
    password_hash::{PasswordHasher, SaltString, rand_core::OsRng},
};
use sqlx::PgPool;
use uuid::Uuid;

use crate::BootstrapOwner;

mod session;
pub use session::{
    AuthSettings, LoginRateLimiter, change_password, issue_mobile_token, list_sessions, login,
    logout, me, revoke_other_sessions, revoke_session,
};
pub(crate) use session::{
    AuthenticatedUser, new_temporary_password, require_csrf, verify_login_password,
};

pub(crate) const MAX_PASSWORD_BYTES: usize = 1024;
pub(crate) const MIN_PASSWORD_CHARS: usize = 12;

pub async fn bootstrap_owner(
    pool: &PgPool,
    credentials: Option<&BootstrapOwner>,
) -> anyhow::Result<()> {
    let mut tx = pool
        .begin()
        .await
        .context("begin owner bootstrap transaction")?;
    sqlx::query("SELECT pg_advisory_xact_lock(7042026, 1)")
        .execute(&mut *tx)
        .await
        .context("lock owner bootstrap")?;

    let owner_exists: bool =
        sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM users WHERE role = 'owner')")
            .fetch_one(&mut *tx)
            .await
            .context("check for an existing owner")?;

    if owner_exists {
        tx.commit().await.context("finish owner bootstrap check")?;
        return Ok(());
    }

    let credentials = credentials.ok_or_else(|| {
        anyhow!("no owner account exists; set BOOTSTRAP_OWNER_EMAIL and BOOTSTRAP_OWNER_PASSWORD for the first run")
    })?;
    let email = credentials.email.trim().to_lowercase();
    if !valid_email(&email) {
        return Err(anyhow!(
            "BOOTSTRAP_OWNER_EMAIL is not a valid email address"
        ));
    }
    if !valid_password(&credentials.password) {
        return Err(anyhow!(
            "BOOTSTRAP_OWNER_PASSWORD must be between 12 and 1024 bytes"
        ));
    }

    let hash = password_hash(&credentials.password).context("hash bootstrap owner password")?;
    sqlx::query("INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, $3, 'owner')")
        .bind(Uuid::new_v4())
        .bind(email)
        .bind(hash)
        .execute(&mut *tx)
        .await
        .context("insert bootstrap owner")?;

    sqlx::query("INSERT INTO audit_events (event_type, actor_id, details) SELECT 'owner_bootstrap', id, '{}'::jsonb FROM users WHERE role = 'owner' ORDER BY created_at DESC LIMIT 1")
        .execute(&mut *tx)
        .await
        .context("record owner bootstrap event")?;
    tx.commit().await.context("commit owner bootstrap")?;
    Ok(())
}

pub fn password_hash(password: &str) -> anyhow::Result<String> {
    let params = Params::default();
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let salt = SaltString::generate(&mut OsRng);
    Ok(argon2
        .hash_password(password.as_bytes(), &salt)
        .map_err(|error| anyhow!("Argon2id password hashing failed: {error}"))?
        .to_string())
}

pub(crate) fn valid_email(email: &str) -> bool {
    let Some((local, domain)) = email.split_once('@') else {
        return false;
    };
    !local.is_empty()
        && !domain.is_empty()
        && domain.contains('.')
        && email.len() <= 320
        && !email.chars().any(char::is_whitespace)
}

pub(crate) fn valid_password(password: &str) -> bool {
    password.len() <= MAX_PASSWORD_BYTES && password.chars().count() >= MIN_PASSWORD_CHARS
}

/// Resolves an account's effective quota in signed bytes for API summaries.
pub(crate) fn effective_quota_bytes(
    role: &str,
    db_quota_bytes: Option<i64>,
    default_owner_quota_bytes: u64,
) -> Option<i64> {
    if role == "member" {
        db_quota_bytes
    } else {
        db_quota_bytes.or_else(|| i64::try_from(default_owner_quota_bytes).ok())
    }
}

/// Resolves an account's effective quota limit in unsigned bytes for enforcement.
pub(crate) fn effective_quota_limit(
    role: &str,
    db_quota_bytes: Option<i64>,
    default_owner_quota_bytes: u64,
) -> Option<u64> {
    if role == "member" {
        db_quota_bytes.and_then(|quota| u64::try_from(quota).ok())
    } else {
        match db_quota_bytes {
            Some(quota) => u64::try_from(quota).ok(),
            None => Some(default_owner_quota_bytes),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn effective_quota_respects_owner_override_or_falls_back_to_default() {
        let default_owner = 100 * 1024 * 1024 * 1024;
        assert_eq!(
            effective_quota_bytes("owner", None, default_owner),
            Some(default_owner as i64)
        );
        assert_eq!(
            effective_quota_bytes("owner", Some(500_000), default_owner),
            Some(500_000)
        );
        assert_eq!(
            effective_quota_limit("owner", Some(0), default_owner),
            Some(0)
        );
        assert_eq!(
            effective_quota_limit("owner", None, default_owner),
            Some(default_owner)
        );
        assert_eq!(effective_quota_limit("member", None, default_owner), None);
        assert_eq!(
            effective_quota_limit("member", Some(2048), default_owner),
            Some(2048)
        );
    }

    #[test]
    fn bootstrap_passwords_use_argon2id_v19() {
        let encoded = password_hash("correct horse battery staple 2026").unwrap();
        assert!(encoded.starts_with("$argon2id$v=19$"));
        assert!(!encoded.contains("correct horse"));
    }

    #[test]
    fn email_validation_rejects_missing_host_or_local_part() {
        assert!(!valid_email("@example.test"));
        assert!(!valid_email("owner@"));
        assert!(!valid_email("owner example@example.test"));
        assert!(valid_email("owner@example.test"));
    }

    #[test]
    fn password_validation_matches_the_account_policy() {
        assert!(!valid_password("short"));
        assert!(valid_password("correct horse battery staple"));
        assert!(!valid_password(&"x".repeat(MAX_PASSWORD_BYTES + 1)));
    }
}
