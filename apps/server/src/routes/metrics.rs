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
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/plain; version=0.0.4")],
        state.admission.metrics_text(),
    )
        .into_response()
}
