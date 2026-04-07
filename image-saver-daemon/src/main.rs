mod application;
mod infrastructure;
mod interface;

use std::{
    net::{IpAddr, SocketAddr},
    path::PathBuf,
    str::FromStr,
    sync::Arc,
};

use sqlx::{
    SqlitePool,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};
use tokio::{net::TcpListener, signal, sync::RwLock};
use tower_http::cors::{Any, CorsLayer};
use tracing::{info, warn};
use tracing_subscriber::{EnvFilter, fmt, layer::SubscriberExt, util::SubscriberInitExt};
use url::Url;

use crate::interface::http::routes::AppState;

const DEFAULT_DAEMON_BASE_URL: &str = "http://127.0.0.1:8765";
const DAEMON_BASE_URL_ENV: &str = "DAEMON_BASE_URL";
const DEFAULT_DATABASE_URL: &str = "sqlite:./image-saver-daemon.db";
const DATABASE_URL_ENV: &str = "DATABASE_URL";

#[tokio::main]
async fn main() -> Result<(), std::io::Error> {
    load_env();
    init_tracing();
    let sqlite_pool = init_sqlite_pool().await?;
    infrastructure::sqlite_files::set_pool(sqlite_pool)
        .map_err(|error| invalid_input(format!("failed to set sqlite pool: {error}")))?;

    let app_state = AppState {
        save_directory: Arc::new(RwLock::new(None::<PathBuf>)),
    };
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);
    let app = interface::http::routes::build_router(app_state).layer(cors);
    let address = resolve_bind_address()?;
    let listener = TcpListener::bind(address).await?;
    let swagger_url = format!("http://{address}/swagger-ui/");
    let openapi_url = format!("http://{address}/api-doc/openapi.json");

    info!(%address, "image-saver-daemon started");
    info!("Swagger API:  {swagger_url}");
    info!("OpenApi schema:  {openapi_url}");
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

fn load_env() {
    let _ = dotenvy::from_filename(".env");
}

fn resolve_bind_address() -> Result<SocketAddr, std::io::Error> {
    let base_url =
        std::env::var(DAEMON_BASE_URL_ENV).unwrap_or_else(|_| DEFAULT_DAEMON_BASE_URL.to_string());
    let parsed = Url::parse(&base_url)
        .map_err(|error| invalid_input(format!("invalid {DAEMON_BASE_URL_ENV}: {error}")))?;

    let host = parsed
        .host_str()
        .ok_or_else(|| invalid_input(format!("{DAEMON_BASE_URL_ENV} must include host")))?;
    let ip: IpAddr = host
        .parse()
        .map_err(|_| invalid_input(format!("{DAEMON_BASE_URL_ENV} host must be an IP address")))?;

    if !ip.is_loopback() {
        return Err(invalid_input(format!(
            "{DAEMON_BASE_URL_ENV} must use loopback address"
        )));
    }

    let port = parsed
        .port_or_known_default()
        .ok_or_else(|| invalid_input(format!("{DAEMON_BASE_URL_ENV} must include port")))?;

    Ok(SocketAddr::new(ip, port))
}

fn invalid_input(message: String) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidInput, message)
}

async fn init_sqlite_pool() -> Result<SqlitePool, std::io::Error> {
    let database_url =
        std::env::var(DATABASE_URL_ENV).unwrap_or_else(|_| DEFAULT_DATABASE_URL.to_string());
    info!(database_url = %database_url, "connecting to sqlite database");
    let connect_options = SqliteConnectOptions::from_str(&database_url)
        .map_err(|error| invalid_input(format!("invalid {DATABASE_URL_ENV}: {error}")))?
        .create_if_missing(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(connect_options)
        .await
        .map_err(|error| invalid_input(format!("failed to connect sqlite database: {error}")))?;
    info!("sqlite database connected");

    sqlx::query("PRAGMA journal_mode = WAL;")
        .execute(&pool)
        .await
        .map_err(|error| invalid_input(format!("failed to enable sqlite WAL mode: {error}")))?;
    sqlx::query("PRAGMA busy_timeout = 5000;")
        .execute(&pool)
        .await
        .map_err(|error| invalid_input(format!("failed to set sqlite busy timeout: {error}")))?;

    info!("running sqlite migrations");
    sqlx::migrate!()
        .run(&pool)
        .await
        .map_err(|error| invalid_input(format!("failed to run sqlite migrations: {error}")))?;
    info!("sqlite migrations applied");

    Ok(pool)
}
