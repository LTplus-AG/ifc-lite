// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Tests for the optional bearer-token layer.
//!
//! Before these, `middleware/auth.rs` had NO tests at all: a mutation making
//! `constant_time_eq` always return `true` — i.e. every request authenticated
//! with ANY token, or none — left the whole 83-test suite green. The only
//! direction the suite pinned was "no token configured ⇒ pass through", which
//! the parity tests exercise incidentally. Everything below pins the OTHER
//! direction, the one that actually protects the compute routes.

use super::*;
use axum::{body::Body, http::Request, routing::get, Router};
use tower::ServiceExt;

/// A `Config` with everything at a fixed, irrelevant value except the token —
/// built as a literal (not `from_env`) so these tests never read, and never
/// race on, the process environment.
fn config_with_token(token: Option<&str>) -> Arc<Config> {
    Arc::new(Config {
        port: 8080,
        cache_dir: String::from("/tmp/ifc-lite-auth-tests"),
        max_file_size_mb: 500,
        request_timeout_secs: 300,
        worker_threads: 1,
        initial_batch_size: 100,
        max_batch_size: 1000,
        cache_max_age_days: 7,
        cors_origins: vec![],
        max_concurrent_parses: 1,
        mem_budget_mb: 0,
        admission_queue_depth: 2,
        admission_queue_timeout_secs: 5,
        mem_shed_pct: 85,
        metrics_enabled: false,
        api_token: token.map(str::to_string),
    })
}

/// One protected route behind the real middleware, driven in-process.
fn app(token: Option<&str>) -> Router {
    let config = config_with_token(token);
    Router::new()
        .route("/protected", get(|| async { "reached the handler" }))
        .layer(axum::middleware::from_fn_with_state(
            config,
            require_bearer_token,
        ))
}

/// Issue the request, returning the status.
async fn status(token: Option<&str>, authorization: Option<&str>) -> StatusCode {
    let mut builder = Request::builder().method("GET").uri("/protected");
    if let Some(value) = authorization {
        builder = builder.header(header::AUTHORIZATION, value);
    }
    app(token)
        .oneshot(builder.body(Body::empty()).unwrap())
        .await
        .unwrap()
        .status()
}

/// BOTH directions of the configured-token signal, at the same call site.
/// The negative half is what a mutation to `constant_time_eq`'s return value
/// (or to the match guard) breaks; without it an operator who sets
/// `IFC_SERVER_API_TOKEN` gets an unprotected server that still logs
/// "auth ENABLED" at startup.
#[tokio::test]
async fn configured_token_admits_the_match_and_rejects_everything_else() {
    assert_eq!(
        status(Some("s3cret"), Some("Bearer s3cret")).await,
        StatusCode::OK,
        "the exact token must be admitted"
    );
    assert_eq!(
        status(Some("s3cret"), Some("Bearer wrong!")).await,
        StatusCode::UNAUTHORIZED,
        "a same-length non-matching token must be rejected"
    );
    assert_eq!(
        status(Some("s3cret"), None).await,
        StatusCode::UNAUTHORIZED,
        "a missing Authorization header must be rejected"
    );
}

/// `constant_time_eq` returns `false` on a length mismatch BEFORE folding
/// bytes. Inverting that early return (`return true`) authenticates every
/// token whose length differs from the secret — including the empty one —
/// and left the suite green. Both a shorter and a longer presented token,
/// plus a prefix of the real secret, pin it.
#[tokio::test]
async fn length_mismatch_is_rejected_not_short_circuited_to_success() {
    for presented in ["", "s3cr", "s3cretx", "s3crets3cret"] {
        assert_eq!(
            status(Some("s3cret"), Some(&format!("Bearer {presented}"))).await,
            StatusCode::UNAUTHORIZED,
            "token {presented:?} differs in length from the secret and must be rejected"
        );
    }
}

/// The unit under the middleware, exercised directly so a length-mismatch
/// regression is attributable to the comparator rather than to routing.
#[test]
fn constant_time_eq_pins_both_outcomes() {
    assert!(constant_time_eq(b"abc", b"abc"));
    assert!(constant_time_eq(b"", b""));
    // Equal length, differing bytes — the folding path must still say no.
    assert!(!constant_time_eq(b"abc", b"abd"));
    assert!(!constant_time_eq(b"abc", b"cba"));
    // Length mismatch — the early return must be `false`.
    assert!(!constant_time_eq(b"abc", b"ab"));
    assert!(!constant_time_eq(b"ab", b"abc"));
    assert!(!constant_time_eq(b"abc", b""));
}

/// The scheme prefix is matched case-sensitively as `"Bearer "`. Mutating it
/// to `"bearer "` (or dropping the strip entirely) survived the suite: the
/// server would then reject every correctly-formed client while accepting a
/// differently-cased one. Pin the accepted spelling and the rejected ones.
#[tokio::test]
async fn only_the_bearer_scheme_prefix_is_accepted() {
    assert_eq!(
        status(Some("s3cret"), Some("Bearer s3cret")).await,
        StatusCode::OK
    );
    for bad in ["bearer s3cret", "BEARER s3cret", "Basic s3cret", "s3cret"] {
        assert_eq!(
            status(Some("s3cret"), Some(bad)).await,
            StatusCode::UNAUTHORIZED,
            "{bad:?} does not carry the `Bearer ` scheme and must be rejected"
        );
    }
}

/// Surrounding whitespace inside the credential is trimmed (`.map(str::trim)`),
/// so a client that pads the value still authenticates.
#[tokio::test]
async fn credential_whitespace_is_trimmed() {
    assert_eq!(
        status(Some("s3cret"), Some("Bearer   s3cret  ")).await,
        StatusCode::OK
    );
}

/// The rejection status is specifically `401 Unauthorized`, not `403`: a
/// client distinguishes "authenticate" from "you may never do this", and the
/// mutation swapping them survived. Asserted against the concrete code, and
/// against the pass-through case so both branches of the layer are pinned.
#[tokio::test]
async fn rejection_is_401_and_no_token_configured_passes_through() {
    assert_eq!(
        status(Some("s3cret"), Some("Bearer nope!!")).await,
        StatusCode::UNAUTHORIZED
    );
    assert_ne!(
        status(Some("s3cret"), Some("Bearer nope!!")).await,
        StatusCode::FORBIDDEN
    );
    // Auth off (the default): the layer is transparent.
    assert_eq!(status(None, None).await, StatusCode::OK);
    assert_eq!(status(None, Some("Bearer anything")).await, StatusCode::OK);
}
