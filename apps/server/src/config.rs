// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Server configuration loaded from environment variables.

/// Server configuration.
///
/// `Debug` is implemented by hand (not derived) so the bearer token in
/// `api_token` is never leaked through logs, traces, or panic reports.
#[derive(Clone)]
pub struct Config {
    /// Port to listen on.
    pub port: u16,
    /// Directory for cache storage.
    pub cache_dir: String,
    /// Maximum file size in MB.
    pub max_file_size_mb: usize,
    /// Request timeout in seconds.
    pub request_timeout_secs: u64,
    /// Number of worker threads for parallel processing.
    pub worker_threads: usize,
    /// Initial batch size for fast first frame (first 3 batches).
    pub initial_batch_size: usize,
    /// Maximum batch size for throughput (batches 11+).
    pub max_batch_size: usize,
    /// Maximum cache age in days.
    pub cache_max_age_days: u64,
    /// Allowed CORS origins (comma-separated, or "*" for all in development).
    pub cors_origins: Vec<String>,
    /// Parse jobs allowed to run at once (`IFC_MAX_CONCURRENT_PARSES`,
    /// default = `worker_threads`). The admission CPU gate.
    pub max_concurrent_parses: usize,
    /// Total upload bytes (in MB) allowed to be admitted at once
    /// (`IFC_MEM_BUDGET_MB`). Default: auto-detected from the cgroup memory
    /// limit (70% of it) when readable, else 0 = memory gate disabled.
    pub mem_budget_mb: usize,
    /// Requests allowed to wait for an admission permit before immediate
    /// rejection (`IFC_ADMISSION_QUEUE_DEPTH`, default = 2 * worker_threads).
    pub admission_queue_depth: usize,
    /// Longest a queued request waits for a permit, seconds
    /// (`IFC_ADMISSION_QUEUE_TIMEOUT_SECS`, default 5).
    pub admission_queue_timeout_secs: u64,
    /// RSS high-water percentage of the memory budget above which new parse
    /// jobs are shed (`IFC_MEM_SHED_PCT`, default 85).
    pub mem_shed_pct: u8,
    /// Expose `GET /api/v1/metrics` (`IFC_METRICS_ENABLED`, default false).
    /// Protected by the bearer token when one is configured.
    pub metrics_enabled: bool,
    /// Optional bearer token for the compute/parse routes.
    ///
    /// Read from `IFC_SERVER_API_TOKEN` (falling back to `API_TOKEN`). When set,
    /// the parse/cache routes require an `Authorization: Bearer <token>` header
    /// and return 401 otherwise. When unset (the default), those routes stay
    /// open so the public viewer -> server flow keeps working, and the server
    /// logs a startup warning that it is unauthenticated. The health endpoint is
    /// always open regardless of this setting (liveness probes).
    pub api_token: Option<String>,
}

impl std::fmt::Debug for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Config")
            .field("port", &self.port)
            .field("cache_dir", &self.cache_dir)
            .field("max_file_size_mb", &self.max_file_size_mb)
            .field("request_timeout_secs", &self.request_timeout_secs)
            .field("worker_threads", &self.worker_threads)
            .field("initial_batch_size", &self.initial_batch_size)
            .field("max_batch_size", &self.max_batch_size)
            .field("cache_max_age_days", &self.cache_max_age_days)
            .field("cors_origins", &self.cors_origins)
            .field("max_concurrent_parses", &self.max_concurrent_parses)
            .field("mem_budget_mb", &self.mem_budget_mb)
            .field("admission_queue_depth", &self.admission_queue_depth)
            .field("admission_queue_timeout_secs", &self.admission_queue_timeout_secs)
            .field("mem_shed_pct", &self.mem_shed_pct)
            .field("metrics_enabled", &self.metrics_enabled)
            // Redacted: never print the bearer token.
            .field("api_token", &self.api_token.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

impl Config {
    /// Load configuration from environment variables.
    pub fn from_env() -> Self {
        Self::from_lookup(|key| std::env::var(key).ok())
    }

    /// The actual parsing, over an injected variable lookup.
    ///
    /// Split out from [`Self::from_env`] purely so the defaults and the
    /// parse/clamp rules are unit-testable without mutating the process
    /// environment — `from_env` is called from other tests in this binary
    /// (`parity_tests::test_state`), so a test that set `IFC_SERVER_API_TOKEN`
    /// globally would silently switch those tests to an authenticated server.
    /// Behavior is unchanged: `from_env` passes the real `std::env::var`.
    ///
    /// `pub(crate)` so tests outside this module (`cors_tests`) can build a
    /// config that is pinned to the shipped defaults rather than to whatever
    /// the CI runner happens to export.
    pub(crate) fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Self {
        let worker_threads: usize = get("WORKER_THREADS")
            .unwrap_or_else(|| num_cpus::get().to_string())
            .parse()
            .unwrap_or_else(|_| num_cpus::get());
        Self {
            port: get("PORT")
                .unwrap_or_else(|| "8080".into())
                .parse()
                .unwrap_or(8080),
            cache_dir: get("CACHE_DIR").unwrap_or_else(|| {
                // Auto-detect environment:
                // - Docker: use /app/cache (created in Dockerfile)
                // - Local dev: use ./.cache relative to server directory
                if std::path::Path::new("/.dockerenv").exists() {
                    "/app/cache".into()
                } else {
                    // Use absolute path for local development to avoid issues
                    std::env::current_dir()
                        .ok()
                        .and_then(|dir| dir.join(".cache").to_str().map(|s| s.to_string()))
                        .unwrap_or_else(|| "./.cache".into())
                }
            }),
            max_file_size_mb: get("MAX_FILE_SIZE_MB")
                .unwrap_or_else(|| "500".into())
                .parse()
                .unwrap_or(500),
            request_timeout_secs: get("REQUEST_TIMEOUT_SECS")
                .unwrap_or_else(|| "300".into())
                .parse()
                .unwrap_or(300),
            worker_threads,
            max_concurrent_parses: get("IFC_MAX_CONCURRENT_PARSES")
                .and_then(|v| v.parse().ok())
                .unwrap_or(worker_threads)
                .max(1),
            // Self-tune to the tightest readable memory ceiling (cgroup, else
            // physical RAM), 70% of it; an explicit IFC_MEM_BUDGET_MB wins and
            // `=0` is an opt-out. Only 0 when no ceiling is readable, which
            // main() warns about (memory admission then falls back to OFF).
            mem_budget_mb: crate::mem_policy::resolve_mem_budget_mb(
                get("IFC_MEM_BUDGET_MB").and_then(|v| v.parse().ok()),
                crate::mem_policy::cgroup_memory_limit_bytes(),
                crate::mem_policy::total_physical_memory_bytes(),
            ),
            admission_queue_depth: get("IFC_ADMISSION_QUEUE_DEPTH")
                .and_then(|v| v.parse().ok())
                .unwrap_or(worker_threads * 2),
            admission_queue_timeout_secs: get("IFC_ADMISSION_QUEUE_TIMEOUT_SECS")
                .and_then(|v| v.parse().ok())
                .unwrap_or(5),
            mem_shed_pct: get("IFC_MEM_SHED_PCT")
                .and_then(|v| v.parse::<u8>().ok())
                .unwrap_or(85)
                .min(100),
            metrics_enabled: get("IFC_METRICS_ENABLED")
                .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
                .unwrap_or(false),
            initial_batch_size: get("INITIAL_BATCH_SIZE")
                .unwrap_or_else(|| "100".into())
                .parse()
                .unwrap_or(100),
            max_batch_size: get("MAX_BATCH_SIZE")
                .unwrap_or_else(|| "1000".into())
                .parse()
                .unwrap_or(1000),
            cache_max_age_days: get("CACHE_MAX_AGE_DAYS")
                .unwrap_or_else(|| "7".into())
                .parse()
                .unwrap_or(7),
            cors_origins: get("CORS_ORIGINS")
                .unwrap_or_else(|| {
                    // Default: allow common development origins
                    "http://localhost:3000,http://localhost:5173,http://127.0.0.1:3000,http://127.0.0.1:5173".into()
                })
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect(),
            api_token: get("IFC_SERVER_API_TOKEN")
                .or_else(|| get("API_TOKEN"))
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty()),
        }
    }
}

impl Default for Config {
    fn default() -> Self {
        Self::from_env()
    }
}

#[cfg(test)]
#[path = "config_tests.rs"]
mod config_tests;
