mod application;
mod interface;

use std::net::SocketAddr;

use tokio::{net::TcpListener, signal};
use tracing::{info, warn};
use tracing_subscriber::{EnvFilter, fmt, layer::SubscriberExt, util::SubscriberInitExt};

#[tokio::main]
async fn main() -> Result<(), std::io::Error> {
    init_tracing();

    let app = interface::http::routes::build_router();
    let address = SocketAddr::from(([127, 0, 0, 1], 8765));
    let listener = TcpListener::bind(address).await?;

    info!(%address, "image-saver-daemon started");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
}

fn init_tracing() {
    let env_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("image_saver_daemon=info,tower_http=info"));

    tracing_subscriber::registry()
        .with(env_filter)
        .with(fmt::layer())
        .init();
}

async fn shutdown_signal() {
    if signal::ctrl_c().await.is_ok() {
        warn!("shutdown signal received");
    }
}
