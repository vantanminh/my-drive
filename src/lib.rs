mod api;
mod auth;
mod config;
mod db;
mod drive;
mod health;
mod maintenance;
mod shares;
mod storage;
mod transfers;

#[cfg(test)]
mod auth_http_tests;
#[cfg(test)]
mod drive_http_tests;
#[cfg(test)]
mod maintenance_http_tests;
#[cfg(test)]
mod share_http_tests;
#[cfg(test)]
mod transfer_http_tests;

use anyhow::Context;
use tokio::net::TcpListener;
use tracing::info;

pub use config::{BootstrapOwner, Config, ConfigError, MediaPreviewConfig};

pub async fn run() -> anyhow::Result<()> {
    let config = Config::from_env().context("load configuration")?;

    // Validate and initialize the HDD root before connecting to PostgreSQL.
    // This prevents a missing mount from creating directories on the SSD.
    let storage = storage::LocalStorage::initialize(&config).context("initialize HDD storage")?;
    let media_preview = config
        .media_preview
        .as_ref()
        .map(storage::PreviewStorage::new);
    if let Some(preview_storage) = &media_preview {
        if let Err(error) = preview_storage.prepare() {
            tracing::warn!(
                error = %error,
                "SSD media preview cache is unavailable; preview writes are disabled"
            );
        }
    } else {
        tracing::info!("SSD media preview cache is not configured; preview indexing is disabled");
    }
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
    let transfer_settings = health::TransferSettings {
        max_file_size: config.max_file_size,
        owner_quota_bytes: config.owner_quota_bytes,
        upload_session_ttl_seconds: config.upload_session_ttl_seconds,
    };
    let maintenance_settings = maintenance::Settings {
        trash_retention_days: config.trash_retention_days,
        upload_session_ttl_seconds: config.upload_session_ttl_seconds,
    };
    let maintenance_pool = pool.clone();
    let maintenance_storage = storage.clone();
    // Drop the configuration now so database and bootstrap secrets are not
    // retained for the lifetime of the HTTP server.
    drop(config);
    let state = health::AppState {
        pool,
        storage,
        media_preview,
        auth_settings,
        transfer_settings,
        login_rate_limiter: auth::LoginRateLimiter::default(),
    };
    let listener = TcpListener::bind(bind_addr)
        .await
        .with_context(|| format!("bind HTTP listener at {bind_addr}"))?;

    tokio::spawn(maintenance::run_worker(
        maintenance_pool,
        maintenance_storage,
        maintenance_settings,
    ));
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
