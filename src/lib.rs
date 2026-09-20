mod api;
mod auth;
mod config;
mod db;
mod health;
mod storage;

#[cfg(test)]
mod auth_http_tests;

use anyhow::Context;
use tokio::net::TcpListener;
use tracing::info;

pub use config::{BootstrapOwner, Config, ConfigError};

pub async fn run() -> anyhow::Result<()> {
    let config = Config::from_env().context("load configuration")?;

    // Validate and initialize the HDD root before connecting to PostgreSQL.
    // This prevents a missing mount from creating directories on the SSD.
    let storage = storage::LocalStorage::initialize(&config).context("initialize HDD storage")?;
    let pool = db::connect(&config.database_url)
        .await
        .context("connect to PostgreSQL")?;
    db::migrate(&pool)
        .await
        .context("apply database migrations")?;
    auth::bootstrap_owner(&pool, config.bootstrap_owner.as_ref())
        .await
        .context("bootstrap first owner")?;

    let bind_addr = config.bind_addr;
    let auth_settings = auth::AuthSettings {
        cookie_secure: config.cookie_secure,
        session_ttl_seconds: config.session_ttl_seconds,
    };
    // Drop the configuration now so database and bootstrap secrets are not
    // retained for the lifetime of the HTTP server.
    drop(config);
    let state = health::AppState {
        pool,
        storage,
        auth_settings,
        login_rate_limiter: auth::LoginRateLimiter::default(),
    };
    let listener = TcpListener::bind(bind_addr)
        .await
        .with_context(|| format!("bind HTTP listener at {bind_addr}"))?;

    info!(address = %bind_addr, "My Drive is listening");
    axum::serve(listener, api::router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("serve HTTP requests")?;
    Ok(())
}

async fn shutdown_signal() {
    #[cfg(unix)]
    let terminate = async {
        use tokio::signal::unix::{SignalKind, signal};
        match signal(SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(error) => {
                tracing::error!(error = %error, "could not install SIGTERM handler");
                std::future::pending::<()>().await;
            }
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        result = tokio::signal::ctrl_c() => {
            if let Err(error) = result {
                tracing::error!(error = %error, "could not install Ctrl-C handler");
            }
        }
        _ = terminate => {}
    }
}
