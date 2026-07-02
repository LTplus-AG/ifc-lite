// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Health check endpoint.

use axum::Json;
use serde::Serialize;

/// Health check response.
#[derive(Debug, Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
    pub version: &'static str,
    pub service: &'static str,
}

/// API information response.
#[derive(Debug, Serialize)]
pub struct ApiInfoResponse {
    pub service: &'static str,
    pub version: &'static str,
    pub description: &'static str,
    pub endpoints: Vec<EndpointInfo>,
}

/// Endpoint information.
#[derive(Debug, Serialize)]
pub struct EndpointInfo {
    pub method: &'static str,
    pub path: &'static str,
    pub description: &'static str,
}

/// GET /api/v1/health - Health check endpoint.
pub async fn check() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "healthy",
        version: env!("CARGO_PKG_VERSION"),
        service: "ifc-lite-server",
    })
}

/// GET /api/v1/ready - readiness probe: 503 while the admission RSS
/// breaker is shedding new work, so an external load balancer can drain the
/// instance. Deliberately separate from `/api/v1/health` (liveness), which
/// Railway's healthcheck consumes - gating THAT on load would restart-loop
/// the box exactly when it is busiest.
pub async fn ready(
    axum::extract::State(state): axum::extract::State<crate::AppState>,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    if state.admission.is_shedding() {
        (
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            axum::Json(HealthResponse {
                status: "shedding",
                version: env!("CARGO_PKG_VERSION"),
                service: "ifc-lite-server",
            }),
        )
            .into_response()
    } else {
        axum::Json(HealthResponse {
            status: "ready",
            version: env!("CARGO_PKG_VERSION"),
            service: "ifc-lite-server",
        })
        .into_response()
    }
}

/// GET / - API information endpoint.
pub async fn info() -> Json<ApiInfoResponse> {
    Json(ApiInfoResponse {
        service: "ifc-lite-server",
        version: env!("CARGO_PKG_VERSION"),
        description: "High-performance IFC processing server",
        endpoints: vec![
            EndpointInfo {
                method: "GET",
                path: "/api/v1/health",
                description: "Health check endpoint",
            },
            EndpointInfo {
                method: "POST",
                path: "/api/v1/parse",
                description: "Full parse with all geometry",
            },
            EndpointInfo {
                method: "POST",
                path: "/api/v1/parse/stream",
                description: "Streaming parse (Server-Sent Events)",
            },
            EndpointInfo {
                method: "POST",
                path: "/api/v1/parse/metadata",
                description: "Quick metadata extraction only",
            },
            EndpointInfo {
                method: "GET",
                path: "/api/v1/cache/:key",
                description: "Retrieve cached result",
            },
        ],
    })
}
