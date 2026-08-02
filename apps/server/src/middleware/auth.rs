// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Optional bearer-token authentication for the compute/parse routes.
//!
//! Authentication is **off by default** so the public viewer -> server flow
//! keeps working. When `Config::api_token` is set (via `IFC_SERVER_API_TOKEN`
//! or `API_TOKEN`), the protected routes require an
//! `Authorization: Bearer <token>` header and return `401 Unauthorized`
//! otherwise. The health endpoint is intentionally left unprotected so this
//! layer never applies to it.

use std::sync::Arc;

use axum::{
    extract::State,
    http::{header, Request, StatusCode},
    middleware::Next,
    response::Response,
};

use crate::config::Config;

/// Axum middleware enforcing optional bearer-token auth on protected routes.
///
/// If no token is configured the request passes through unchanged. If a token
/// is configured, the `Authorization: Bearer <token>` header must match exactly
/// (constant-time compare) or the request is rejected with `401`.
pub async fn require_bearer_token(
    State(config): State<Arc<Config>>,
    request: Request<axum::body::Body>,
    next: Next,
) -> Result<Response, StatusCode> {
    // Auth disabled: pass through. (Startup warning is logged once in `main`.)
    let Some(expected) = config.api_token.as_deref() else {
        return Ok(next.run(request).await);
    };

    let presented = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim);

    match presented {
        Some(token) if constant_time_eq(token.as_bytes(), expected.as_bytes()) => {
            Ok(next.run(request).await)
        }
        _ => {
            tracing::warn!("Rejected request to protected route: missing or invalid bearer token");
            Err(StatusCode::UNAUTHORIZED)
        }
    }
}

/// Length-aware constant-time byte comparison to avoid leaking the token via
/// early-exit timing. Returns `false` immediately on length mismatch (the
/// length itself is not secret), then folds all remaining bytes.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}
