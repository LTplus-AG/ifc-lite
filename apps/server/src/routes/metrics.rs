// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `GET /api/v1/metrics` - Prometheus text exposition of the admission
//! gauges/counters and resident memory. Hand-rolled text (no exporter
//! dependency); the route only responds when `IFC_METRICS_ENABLED` is set,
//! and it sits behind the bearer-token layer like every compute route.

use axum::extract::State;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};

use crate::AppState;

pub async fn metrics(State(state): State<AppState>) -> Response {
    if !state.config.metrics_enabled {
        return (StatusCode::NOT_FOUND, "metrics disabled").into_response();
    }

    let mut body = state.admission.metrics_text();

    // Cache size gauges (issue #3636): the index already carries a `size` per
    // entry, so this is a directory scan, not new bookkeeping. A scan failure
    // (e.g. an unreadable cache dir) drops just these two lines rather than
    // failing the whole scrape -- the admission gauges above are still useful
    // on their own.
    if let Ok(stats) = state.cache.stats().await {
        body.push_str(&format!(
            "# TYPE ifc_server_cache_entries gauge\n\
             ifc_server_cache_entries {}\n\
             # TYPE ifc_server_cache_bytes gauge\n\
             ifc_server_cache_bytes {}\n",
            stats.entries, stats.bytes,
        ));
    }

    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/plain; version=0.0.4")],
        body,
    )
        .into_response()
}

#[cfg(test)]
#[path = "metrics_tests.rs"]
mod metrics_tests;
