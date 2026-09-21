use anyhow::{Context, anyhow};
use argon2::{
    Algorithm, Argon2, Params, Version,
    password_hash::{PasswordHasher, SaltString, rand_core::OsRng},
};
use sqlx::PgPool;
use uuid::Uuid;

use crate::BootstrapOwner;

mod session;
pub use session::{AuthSettings, LoginRateLimiter, change_password, login, logout, me};
pub(crate) use session::{AuthenticatedUser, new_temporary_password, require_csrf};

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

#[cfg(test)]
mod tests {
    use super::*;

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
}
