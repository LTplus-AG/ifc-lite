// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Tests for `build_cors_layer` as it is actually mounted on the router.
//!
//! Nothing tested it. Breaking the wildcard detection (`o == "*"`) left the
//! suite green in the direction that matters least — but the same blind spot
//! covers the direction that matters most: if the ALLOW-LIST branch ever
//! degraded into a permissive one, every deployment with an explicit
//! `CORS_ORIGINS` would start serving any origin on the internet, and no test
//! would notice.

use super::*;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use tower::ServiceExt;

const ALLOWED: &str = "https://allowed.example";
const OTHER: &str = "https://other.example";

/// The shipped defaults, with NO environment read at all.
///
/// `Config::from_env()` would import the runner's environment into these
/// tests: a CI job that exports `CORS_ORIGINS=*` would turn
/// [`the_shipped_default_is_not_permissive`] into an assertion about the
/// runner's override, and it would fail loudly for the wrong reason instead of
/// pinning the default we actually ship. `from_lookup(|_| None)` is the same
/// parser with every variable unset, so this fixture is the shipped default by
/// construction. Environment *parsing* coverage lives in `config_tests.rs`,
/// where the lookup is injected per case.
fn shipped_default_config() -> Config {
    Config::from_lookup(|_| None)
}

async fn state_with_origins(label: &str, origins: &[&str]) -> AppState {
    let dir = std::env::temp_dir().join(format!(
        "ifc-lite-server-cors-{}-{}",
        std::process::id(),
        label
    ));
    let _ = std::fs::remove_dir_all(&dir);
    let cache = Arc::new(DiskCache::new(dir.to_str().unwrap()).await);
    let mut config = shipped_default_config();
    config.cors_origins = origins.iter().map(|o| (*o).to_string()).collect();
    // Auth must stay off here, or a 401 would mask the CORS assertions.
    config.api_token = None;
    AppState {
        cache,
        config: Arc::new(config),
        admission: Arc::new(crate::admission::Admission::new(
            crate::admission::AdmissionCfg {
                max_concurrent_parses: 2,
                mem_budget_bytes: 0,
                queue_depth: 2,
                queue_timeout: std::time::Duration::from_millis(50),
                shed_pct: 0,
            },
        )),
    }
}

/// `GET /api/v1/health` with an `Origin`, returning the
/// `Access-Control-Allow-Origin` response header value.
///
/// `None` means the header was genuinely absent from the response — the
/// no-CORS-access contract. This is deliberately NOT collapsed to `""`:
/// a `Some("".to_string())` (an explicit, empty header value) would be a
/// different and stranger bug than a missing header, and callers that only
/// care about "was access granted" must still be able to tell the two
/// apart from "was the header present at all".
async fn allow_origin_for(state: AppState, origin: &str) -> Option<String> {
    let request = Request::builder()
        .method("GET")
        .uri("/api/v1/health")
        .header(header::ORIGIN, origin)
        .body(Body::empty())
        .unwrap();
    let response = build_router(state).oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    response
        .headers()
        .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
        .map(|v| v.to_str().unwrap().to_string())
}

/// A `"*"` entry anywhere in `CORS_ORIGINS` puts the layer in permissive mode.
/// This is the documented development escape hatch, so it must keep working —
/// and it must be reachable ONLY through that exact literal.
#[tokio::test]
async fn a_wildcard_entry_enables_permissive_cors() {
    let state = state_with_origins("wildcard", &["*"]).await;
    assert_eq!(allow_origin_for(state, OTHER).await.as_deref(), Some("*"));

    // The wildcard is honoured even when it is not the first entry.
    let state = state_with_origins("wildcard-tail", &[ALLOWED, "*"]).await;
    assert_eq!(allow_origin_for(state, OTHER).await.as_deref(), Some("*"));
}

/// The other direction, and the security-relevant one: with an explicit
/// allow-list, an origin that is NOT on it gets no
/// `Access-Control-Allow-Origin` header at all, so a browser blocks the
/// cross-origin read. A listed origin is reflected back.
#[tokio::test]
async fn an_explicit_allow_list_reflects_only_listed_origins() {
    let state = state_with_origins("allowlist-hit", &[ALLOWED]).await;
    assert_eq!(allow_origin_for(state, ALLOWED).await.as_deref(), Some(ALLOWED));

    let state = state_with_origins("allowlist-miss", &[ALLOWED]).await;
    assert_eq!(
        allow_origin_for(state, OTHER).await,
        None,
        "an unlisted origin must NOT be granted access — the header must be \
         absent, not merely non-matching"
    );

    // ...and must never be answered with a blanket wildcard.
    let state = state_with_origins("allowlist-nowild", &[ALLOWED]).await;
    assert_ne!(allow_origin_for(state, OTHER).await.as_deref(), Some("*"));
}

/// A near-miss on the wildcard literal (`"**"`, `" * "`, an empty list) must
/// fall into the allow-list branch, not the permissive one. This is what pins
/// the `o == "*"` comparison itself rather than merely "some entry exists".
#[tokio::test]
async fn near_miss_wildcards_do_not_enable_permissive_cors() {
    for spelling in ["**", "*.example.com", "all"] {
        let state = state_with_origins("near-miss", &[spelling]).await;
        let allow = allow_origin_for(state, OTHER).await;
        assert_ne!(
            allow.as_deref(),
            Some("*"),
            "{spelling:?} must not be treated as the permissive wildcard"
        );
    }
    // An empty list allows nothing — the header must be absent entirely.
    let state = state_with_origins("empty", &[]).await;
    assert_eq!(allow_origin_for(state, OTHER).await, None);
}

/// The default `CORS_ORIGINS` (nothing configured) is a localhost allow-list,
/// never permissive — a wildcard default would expose every self-hosted
/// deployment that never sets the variable.
///
/// Pins that the header is ABSENT for an untrusted origin, not merely "not
/// the literal `*`" and not merely "an empty string". A layer that reflected
/// the request's `Origin` back (`AllowOrigin::mirror_request()`) would pass
/// the old `assert_ne!(.., "*")` version of this test while still granting
/// `https://attacker.example` cross-origin access — the response header
/// would read `https://attacker.example`, never the string `"*"`. Asserting
/// `None` is the only way this test can catch that AND distinguish a
/// genuinely missing header from a header present with an empty value,
/// which `allow_origin_for`'s old `String` return type collapsed together.
#[tokio::test]
async fn the_shipped_default_is_not_permissive() {
    let defaults = shipped_default_config().cors_origins;
    let state = state_with_origins(
        "defaults",
        &defaults.iter().map(String::as_str).collect::<Vec<_>>(),
    )
    .await;
    assert_eq!(
        allow_origin_for(state, "https://attacker.example").await,
        None,
        "the default CORS configuration must not grant an untrusted origin any \
         Access-Control-Allow-Origin header (reflected or wildcard): {defaults:?}"
    );
}
