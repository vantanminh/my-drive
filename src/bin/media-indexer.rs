use tracing_subscriber::EnvFilter;

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let _ = dotenvy::dotenv();
    init_tracing();
    if let Err(error) = my_drive::run_media_indexer().await {
        tracing::error!(error = %error, "media indexer stopped during startup or runtime");
        std::process::exit(1);
    }
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(filter)
        .with_target(false)
        .init();
}
