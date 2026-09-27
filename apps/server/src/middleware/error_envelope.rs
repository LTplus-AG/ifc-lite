// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! One error body for the failures no handler writes (#5750).
//!
//! Every handler failure is an [`ApiError`](crate::error::ApiError), which
//! renders the shared `ErrorResponse` envelope. The responses produced
//! AROUND the handlers did not: an extractor rejection (a bad query string, a
//! request that is not multipart) was `text/plain`, and an unknown route, a
//! wrong method, the request timeout and the panic catcher answered with an
//! empty body. A client decoding `{"error", "code"}` got a JSON parse failure
//! on exactly those statuses. This layer rewrites them into the envelope,
//! keeping the status, every header but the body's own, and the framework's
//! message where it wrote one.
//!
//! A JSON error body is left alone: `ApiError` has already written the
//! envelope, and the one other JSON non-2xx body, `/api/v1/ready`'s `503`, is
//! a probe document whose status field is its contract.

use axum::{
    body::to_bytes,
    http::{header, HeaderMap, StatusCode},
    response::Response,
};

use crate::error::error_response;

/// The most of a framework-written body carried into `error`. Rejection texts
/// are a line or two; anything longer is not a message worth relaying.
const MAX_MESSAGE_BYTES: usize = 4096;

/// `axum::middleware::map_response` target: wrap any non-JSON `4xx`/`5xx` in
/// the shared error envelope.
pub async fn envelope_errors(response: Response) -> Response {
    let status = response.status();
    if !(status.is_client_error() || status.is_server_error()) || is_json(response.headers()) {
        return response;
    }

    let (mut parts, body) = response.into_parts();
    // An encoded body is not text; only the router below this layer writes
    // these, and compression sits above it, so this is a guard, not a path.
    let encoded = parts.headers.contains_key(header::CONTENT_ENCODING);
    let message = match to_bytes(body, MAX_MESSAGE_BYTES).await {
        Ok(bytes) if !encoded => String::from_utf8_lossy(&bytes).trim().to_owned(),
        _ => String::new(),
    };
    let error = if message.is_empty() {
        status.canonical_reason().unwrap_or("Error").to_owned()
    } else {
        message
    };
    // Rebuilt through the one envelope builder, then given back every header
    // the original carried (`Allow`, `Retry-After`, CORS) except the ones
    // that described the old body.
    let mut envelope = error_response(status, &code_for_status(status), error);
    parts.headers.remove(header::CONTENT_LENGTH);
    parts.headers.remove(header::CONTENT_ENCODING);
    parts.headers.remove(header::CONTENT_TYPE);
    envelope.headers_mut().extend(parts.headers);
    envelope
}

fn is_json(headers: &HeaderMap) -> bool {
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("application/json"))
}

/// The `code` for a status no `ApiError` variant chose. The statuses
/// `ApiError` also produces keep its spelling (`INTERNAL_ERROR`,
/// `FILE_TOO_LARGE`, `OVERLOADED`), so a client branching on the code sees one
/// name per condition whichever layer answered; the rest are the status's
/// reason phrase in `SCREAMING_SNAKE` (`METHOD_NOT_ALLOWED`, `REQUEST_TIMEOUT`).
fn code_for_status(status: StatusCode) -> String {
    match status {
        StatusCode::INTERNAL_SERVER_ERROR => "INTERNAL_ERROR".to_owned(),
        StatusCode::PAYLOAD_TOO_LARGE => "FILE_TOO_LARGE".to_owned(),
        StatusCode::SERVICE_UNAVAILABLE => "OVERLOADED".to_owned(),
        _ => status
            .canonical_reason()
            .map(|reason| {
                reason
                    .chars()
                    .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_uppercase() } else { '_' })
                    .collect()
            })
            .unwrap_or_else(|| format!("HTTP_{}", status.as_u16())),
    }
}

/// The `CatchPanicLayer` response. That layer sits outside this one, so it
/// renders the envelope itself, as an `INTERNAL_ERROR`. The panic payload is
/// file-derived text and goes to the log, never to the client.
pub fn panic_response(panic: Box<dyn std::any::Any + Send + 'static>) -> Response {
    use axum::response::IntoResponse;
    let detail = panic
        .downcast_ref::<String>()
        .map(String::as_str)
        .or_else(|| panic.downcast_ref::<&str>().copied())
        .unwrap_or("non-string panic payload");
    tracing::error!(panic = %detail, "Request handler panicked");
    crate::error::ApiError::Internal("request handler panicked".to_owned()).into_response()
}

#[cfg(test)]
#[path = "error_envelope_tests.rs"]
mod error_envelope_tests;
