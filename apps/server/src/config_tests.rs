// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Tests for `Config` parsing, defaults and clamps.
//!
//! `config.rs` had NO tests. Mutating the listen port default, deleting the
//! empty-token filter (so `IFC_SERVER_API_TOKEN=""` would ENABLE auth against
//! an empty secret), deleting the `IFC_MEM_SHED_PCT` clamp, and dropping the
//! `IFC_METRICS_ENABLED=1` spelling all left the suite green.
//!
//! Everything is driven through `Config::from_lookup`, so no test here reads or
//! writes the real process environment — `parity_tests` calls `from_env()` on
//! other threads and would be silently reconfigured by a global `set_var`.

use super::*;
use std::collections::HashMap;

/// A lookup over an explicit map — anything not listed is "unset".
fn cfg(vars: &[(&str, &str)]) -> Config {
    let map: HashMap<String, String> = vars
        .iter()
        .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
        .collect();
    Config::from_lookup(|key| map.get(key).cloned())
}

/// Every var unset: the shipped defaults. These are the values a bare
/// `docker run` gets, so each one is a deployment contract.
#[test]
fn defaults_apply_when_nothing_is_set() {
    let c = cfg(&[]);
    assert_eq!(c.port, 8080, "the container/Railway port contract");
    assert_eq!(c.max_file_size_mb, 500);
    assert_eq!(c.request_timeout_secs, 300);
    assert_eq!(c.initial_batch_size, 100);
    assert_eq!(c.max_batch_size, 1000);
    assert_eq!(c.cache_max_age_days, 7);
    assert_eq!(c.admission_queue_timeout_secs, 5);
    assert_eq!(c.mem_shed_pct, 85);
    assert!(!c.metrics_enabled, "metrics are opt-in, never on by default");
    assert!(c.api_token.is_none(), "auth is off by default");
    // Derived from worker_threads, which defaults to the CPU count.
    assert_eq!(c.max_concurrent_parses, c.worker_threads.max(1));
    assert_eq!(c.admission_queue_depth, c.worker_threads * 2);
}

/// Both directions of every scalar override: a valid value is honoured, and an
/// unparseable one falls back to the default rather than panicking at startup.
#[test]
fn scalar_overrides_are_honoured_and_garbage_falls_back() {
    let c = cfg(&[
        ("PORT", "9443"),
        ("MAX_FILE_SIZE_MB", "42"),
        ("REQUEST_TIMEOUT_SECS", "17"),
        ("INITIAL_BATCH_SIZE", "7"),
        ("MAX_BATCH_SIZE", "77"),
        ("CACHE_MAX_AGE_DAYS", "1"),
        ("IFC_ADMISSION_QUEUE_TIMEOUT_SECS", "9"),
    ]);
    assert_eq!(c.port, 9443);
    assert_eq!(c.max_file_size_mb, 42);
    assert_eq!(c.request_timeout_secs, 17);
    assert_eq!(c.initial_batch_size, 7);
    assert_eq!(c.max_batch_size, 77);
    assert_eq!(c.cache_max_age_days, 1);
    assert_eq!(c.admission_queue_timeout_secs, 9);

    let bad = cfg(&[
        ("PORT", "not-a-port"),
        ("MAX_FILE_SIZE_MB", "-1"),
        ("REQUEST_TIMEOUT_SECS", ""),
        ("INITIAL_BATCH_SIZE", "1e6"),
        ("MAX_BATCH_SIZE", "∞"),
        ("CACHE_MAX_AGE_DAYS", "seven"),
        ("IFC_ADMISSION_QUEUE_TIMEOUT_SECS", "5s"),
    ]);
    assert_eq!(bad.port, 8080);
    assert_eq!(bad.max_file_size_mb, 500);
    assert_eq!(bad.request_timeout_secs, 300);
    assert_eq!(bad.initial_batch_size, 100);
    assert_eq!(bad.max_batch_size, 1000);
    assert_eq!(bad.cache_max_age_days, 7);
    assert_eq!(bad.admission_queue_timeout_secs, 5);
}

/// `IFC_MAX_CONCURRENT_PARSES` feeds the admission CPU semaphore. `0` must be
/// clamped up to 1 — a zero-permit semaphore would wedge every parse request
/// until the queue timeout and then 503 forever.
#[test]
fn concurrency_is_clamped_to_at_least_one() {
    assert_eq!(cfg(&[("IFC_MAX_CONCURRENT_PARSES", "0")]).max_concurrent_parses, 1);
    assert_eq!(cfg(&[("IFC_MAX_CONCURRENT_PARSES", "3")]).max_concurrent_parses, 3);
    // Unparseable ⇒ worker_threads, still clamped.
    let c = cfg(&[("WORKER_THREADS", "0"), ("IFC_MAX_CONCURRENT_PARSES", "x")]);
    assert_eq!(c.worker_threads, 0);
    assert_eq!(c.max_concurrent_parses, 1);
}

/// `IFC_MEM_SHED_PCT` is a percentage of the memory budget. Values above 100
/// are clamped: an unclamped 200 would put the RSS watermark at twice the
/// budget, so the circuit breaker would never fire and the container would be
/// OOM-killed instead of shedding. Pinned at the boundary in both directions.
#[test]
fn shed_pct_is_clamped_to_100() {
    assert_eq!(cfg(&[("IFC_MEM_SHED_PCT", "100")]).mem_shed_pct, 100);
    assert_eq!(cfg(&[("IFC_MEM_SHED_PCT", "101")]).mem_shed_pct, 100);
    assert_eq!(cfg(&[("IFC_MEM_SHED_PCT", "255")]).mem_shed_pct, 100);
    assert_eq!(cfg(&[("IFC_MEM_SHED_PCT", "99")]).mem_shed_pct, 99);
    assert_eq!(cfg(&[("IFC_MEM_SHED_PCT", "0")]).mem_shed_pct, 0, "0 disables the breaker");
    // A value beyond u8 does not parse ⇒ the default, not a wrapped number.
    assert_eq!(cfg(&[("IFC_MEM_SHED_PCT", "256")]).mem_shed_pct, 85);
}

/// `IFC_METRICS_ENABLED` accepts `1` and any casing of `true`, and NOTHING
/// else. Dropping the `"1"` arm survived the suite: an operator following the
/// usual `=1` convention would silently get a 404 on the metrics route.
#[test]
fn metrics_flag_accepts_one_and_true_only() {
    for on in ["1", "true", "TRUE", "True"] {
        assert!(
            cfg(&[("IFC_METRICS_ENABLED", on)]).metrics_enabled,
            "{on:?} must enable metrics"
        );
    }
    for off in ["0", "false", "yes", "on", "", "2", "truthy"] {
        assert!(
            !cfg(&[("IFC_METRICS_ENABLED", off)]).metrics_enabled,
            "{off:?} must NOT enable metrics"
        );
    }
}

/// The bearer token: `IFC_SERVER_API_TOKEN` wins over `API_TOKEN`, the value is
/// trimmed, and a blank value stays `None`.
///
/// The blank case is the load-bearing one. Without the `!is_empty()` filter,
/// `IFC_SERVER_API_TOKEN=""` (a very common way to "unset" a variable in a
/// compose file or CI secret) would flip `api_token` to `Some("")`, and the
/// server would start REQUIRING an `Authorization: Bearer ` header whose secret
/// is the empty string — every real client 401s while anyone sending the empty
/// credential is admitted. The mutation deleting that filter left the suite
/// green.
#[test]
fn api_token_precedence_trimming_and_blank_handling() {
    assert_eq!(
        cfg(&[("IFC_SERVER_API_TOKEN", "primary"), ("API_TOKEN", "legacy")]).api_token,
        Some("primary".to_string()),
        "IFC_SERVER_API_TOKEN takes precedence"
    );
    assert_eq!(
        cfg(&[("API_TOKEN", "legacy")]).api_token,
        Some("legacy".to_string()),
        "API_TOKEN is the documented fallback"
    );
    assert_eq!(
        cfg(&[("IFC_SERVER_API_TOKEN", "  padded  ")]).api_token,
        Some("padded".to_string()),
        "surrounding whitespace is stripped"
    );
    for blank in ["", "   ", "\n", "\t "] {
        assert_eq!(
            cfg(&[("IFC_SERVER_API_TOKEN", blank)]).api_token,
            None,
            "a blank token ({blank:?}) must leave auth OFF, not enable it with an empty secret"
        );
    }
    assert_eq!(cfg(&[]).api_token, None);
}

/// A set-but-blank `IFC_SERVER_API_TOKEN` must not shadow a real `API_TOKEN`
/// into oblivion silently... it does, and that is the documented precedence
/// (first var wins if present). Pinned so the behavior is a decision, not an
/// accident: the fallback is `or_else` on presence, not on emptiness.
#[test]
fn blank_primary_token_shadows_the_fallback_and_leaves_auth_off() {
    let c = cfg(&[("IFC_SERVER_API_TOKEN", ""), ("API_TOKEN", "legacy")]);
    assert_eq!(c.api_token, None);
}

/// CORS origins: comma-split, trimmed, empty segments dropped. A trailing
/// comma or padded list must not produce an empty origin, which would later be
/// an unparseable `HeaderValue` silently dropped from the allow-list.
#[test]
fn cors_origins_are_split_trimmed_and_compacted() {
    let c = cfg(&[(
        "CORS_ORIGINS",
        " https://a.example , ,https://b.example,,  ",
    )]);
    assert_eq!(
        c.cors_origins,
        vec!["https://a.example".to_string(), "https://b.example".to_string()]
    );
    assert_eq!(cfg(&[("CORS_ORIGINS", "*")]).cors_origins, vec!["*".to_string()]);
    // The default list is localhost-only — never a wildcard.
    let d = cfg(&[]);
    assert!(!d.cors_origins.is_empty());
    assert!(
        !d.cors_origins.iter().any(|o| o == "*"),
        "the default CORS list must not be permissive: {:?}",
        d.cors_origins
    );
    assert!(d.cors_origins.iter().all(|o| o.contains("localhost") || o.contains("127.0.0.1")));
}

/// `Debug` must never print the token. Derived `Debug` (or a stray field
/// rename) would leak the secret into logs and panic reports.
#[test]
fn debug_redacts_the_api_token() {
    let c = cfg(&[("IFC_SERVER_API_TOKEN", "sup3r-s3cret-value")]);
    let rendered = format!("{c:?}");
    assert!(
        !rendered.contains("sup3r-s3cret-value"),
        "the bearer token leaked into Debug output: {rendered}"
    );
    assert!(rendered.contains("<redacted>"));
    // A sanity check that Debug prints anything at all (so the assertion above
    // is not vacuously satisfied by an empty string).
    assert!(rendered.contains("port"));
}

/// `IFC_MEM_BUDGET_MB` is forwarded to the resolver, including the explicit
/// `0` opt-out; a garbage value is treated as unset (auto-detect).
#[test]
fn mem_budget_env_reaches_the_resolver() {
    assert_eq!(cfg(&[("IFC_MEM_BUDGET_MB", "2048")]).mem_budget_mb, 2048);
    assert_eq!(cfg(&[("IFC_MEM_BUDGET_MB", "0")]).mem_budget_mb, 0);
    // Unparseable ⇒ auto-detection, i.e. whatever the host's ceilings resolve
    // to; it must equal the no-explicit-value result, not the parsed garbage.
    assert_eq!(
        cfg(&[("IFC_MEM_BUDGET_MB", "lots")]).mem_budget_mb,
        cfg(&[]).mem_budget_mb
    );
}
