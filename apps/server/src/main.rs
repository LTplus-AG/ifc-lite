// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! IFC-Lite Server - High-performance IFC processing server.
//!
//! This server provides a REST API for parsing IFC files and extracting
//! geometry. It supports:
//!
//! - Full synchronous parsing with caching
//! - Streaming Server-Sent Events for progressive rendering
//! - Quick metadata extraction without geometry processing
//!
//! # Endpoints
//!
//! - `GET /api/v1/health` - Health check
//! - `POST /api/v1/parse` - Full parse with all geometry (JSON)
//! - `POST /api/v1/parse/stream` - Streaming parse (SSE)
//! - `POST /api/v1/parse/metadata` - Quick metadata only
//! - `POST /api/v1/parse/parquet` - Full parse with Parquet-encoded geometry (~15x smaller)
//! - `POST /api/v1/parse/parquet/optimized` - ara3d BOS-optimized format (~50x smaller)
//! - `GET /api/v1/parse/symbolic/:cache_key` - 2D symbol stream (IfcAnnotation + IfcGrid) as JSON
//! - `GET /api/v1/cache/:key` - Retrieve cached result

use axum::http::{header, HeaderValue, Method};
use axum::{
    extract::DefaultBodyLimit,
    routing::{get, post},
    Router,
};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tower_http::{
    catch_panic::CatchPanicLayer, compression::CompressionLayer, cors::CorsLayer,
    timeout::TimeoutLayer, trace::TraceLayer,
};

mod config;
mod error;
mod middleware;
mod routes;
mod services;
mod types;

#[cfg(test)]
mod parity_tests;

use config::Config;
use services::cache::DiskCache;

/// Build CORS layer based on configuration.
///
/// If CORS_ORIGINS env var contains "*", allows any origin (use only in development).
/// Otherwise, only allows specified origins.
fn build_cors_layer(config: &Config) -> CorsLayer {
    let is_permissive = config.cors_origins.iter().any(|o| o == "*");

    if is_permissive {
        tracing::warn!("CORS is set to permissive mode - use only in development");
        CorsLayer::permissive()
    } else {
        tracing::info!("CORS configured for origins: {:?}", config.cors_origins);
        let origins: Vec<HeaderValue> = config
            .cors_origins
            .iter()
            .filter_map(|o| o.parse::<HeaderValue>().ok())
            .collect();

        CorsLayer::new()
            .allow_origin(origins)
            .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
            .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION, header::ACCEPT])
            .max_age(Duration::from_secs(3600))
    }
}

/// Application state shared across handlers.
#[derive(Clone)]
pub struct AppState {
    pub cache: Arc<DiskCache>,
    pub config: Arc<Config>,
}

/// Build the application router with all routes and middleware.
///
/// Extracted from `main` so integration tests can exercise the full route
/// table in-process (via `tower`'s `oneshot`) without binding a socket.
fn build_router(state: AppState) -> Router {
    let config = state.config.clone();

    // Open routes: liveness/info probes are always reachable, even when an
    // API token is configured (so health checks keep working).
    let open_routes = Router::new()
        // Root endpoint - API information
        .route("/", get(routes::health::info))
        // Health check
        .route("/api/v1/health", get(routes::health::check));

    // Protected routes: the compute-heavy parse endpoints and cache reads. When
    // `config.api_token` is set these require an `Authorization: Bearer <token>`
    // header; otherwise the layer is a pass-through (see `middleware::auth`).
    let protected_routes = Router::new()
        // Parse endpoints
        .route("/api/v1/parse", post(routes::parse::parse_full))
        .route("/api/v1/parse/stream", post(routes::parse::parse_stream))
        .route(
            "/api/v1/parse/parquet-stream",
            post(routes::parse::parse_parquet_stream),
        )
        .route(
            "/api/v1/parse/metadata",
            post(routes::parse::parse_metadata),
        )
        .route("/api/v1/parse/parquet", post(routes::parse::parse_parquet))
        .route(
            "/api/v1/parse/parquet/optimized",
            post(routes::parse::parse_parquet_optimized),
        )
        .route(
            "/api/v1/parse/data-model/{cache_key}",
            get(routes::parse::get_data_model),
        )
        .route(
            "/api/v1/parse/symbolic/{cache_key}",
            get(routes::parse::get_symbolic),
        )
        // Cache endpoints
        .route("/api/v1/cache/{key}", get(routes::cache::get_cached))
        .route("/api/v1/cache/check/{hash}", get(routes::parse::check_cache))
        .route(
            "/api/v1/cache/geometry/{hash}",
            get(routes::parse::get_cached_geometry),
        )
        // Optional bearer-token auth (off unless `api_token` is configured).
        .layer(axum::middleware::from_fn_with_state(
            config.clone(),
            middleware::auth::require_bearer_token,
        ));

    open_routes
        .merge(protected_routes)
        // Middleware (applies to all routes below this point)
        .layer(DefaultBodyLimit::max(config.max_file_size_mb * 1024 * 1024)) // Match max_file_size_mb
        .layer(CompressionLayer::new()) // Compress responses (gzip)
        // Note: Request decompression handled manually in extract_file() to support multipart
        .layer(TimeoutLayer::new(Duration::from_secs(
            config.request_timeout_secs,
        )))
        .layer(TraceLayer::new_for_http())
        .layer(build_cors_layer(&config))
        // Outermost: turn any panic that unwinds out of a request handler into a
        // 500 instead of propagating. Combined with the `server-release` profile
        // (`panic = "unwind"`), this contains a malformed-IFC panic to the single
        // offending request rather than crashing the whole server. Requires the
        // `tower-http` `catch-panic` feature and a build profile that unwinds.
        .layer(CatchPanicLayer::new())
        .with_state(state)
}

#[tokio::main]
async fn main() {
    // Initialize logging
    tracing_subscriber::fmt()
        .with_env_filter(
            std::env::var("RUST_LOG")
                .unwrap_or_else(|_| "info,tower_http=debug,ifc_lite_server=debug".into()),
        )
        .pretty()
        .init();

    let config = Config::from_env();

    tracing::info!(
        port = config.port,
        cache_dir = %config.cache_dir,
        max_file_size_mb = config.max_file_size_mb,
        worker_threads = config.worker_threads,
        "Starting IFC-Lite Server"
    );

    if config.api_token.is_some() {
        tracing::info!(
            "Bearer-token auth ENABLED on compute/parse routes (IFC_SERVER_API_TOKEN set); /api/v1/health stays open"
        );
    } else {
        tracing::warn!(
            "Server is UNAUTHENTICATED: parse/cache routes are open to anyone. Set IFC_SERVER_API_TOKEN to require an Authorization: Bearer <token> header, and/or front the deployment with an edge rate limiter."
        );
    }

    // Initialize rayon thread pool
    rayon::ThreadPoolBuilder::new()
        .num_threads(config.worker_threads)
        .build_global()
        .expect("Failed to initialize rayon thread pool");

    // Initialize cache
    let cache = Arc::new(DiskCache::new(&config.cache_dir).await);

    let state = AppState {
        cache,
        config: Arc::new(config.clone()),
    };

    // Build router
    let app = build_router(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], config.port));
    tracing::info!("Listening on http://{}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
