// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The route side of reading a stored model (#7676): how a cache read is
//! admitted, how long its bytes stay charged, and what a sidecar fetch
//! answers. The storage side, what counts as present or usable, is
//! `services::cache_entry`.
//!
//! - A read that computes nothing is admitted for the stored entry's size
//!   against the byte budget (`Admission::acquire_resident`); one that
//!   transforms the entry (a replay, a re-encode) takes a parse slot like
//!   any other job, and keeps only its bytes once the response is built
//!   (`AdmissionGuard::into_resident`).
//! - Either way the reservation rides the response body ([`resident_body`]
//!   or the SSE stream) until the client has taken the last of it: a slow
//!   reader keeps every byte resident, so dropping the charge when the
//!   handler returns left any number of them unaccounted (SERVER-7).

use crate::admission::{AdmissionGuard, ResidentBytes};
use crate::error::ApiError;
use crate::AppState;
use axum::body::Body;
use axum::http::{header, StatusCode};
use axum::response::Response;
use bytes::Bytes;
use futures::StreamExt;
use std::convert::Infallible;

/// What a cache-first route's replay attempt came to.
pub(super) enum Replay {
    /// A usable hit, already a response whose body carries the admission.
    Hit(Response),
    /// Nothing replayable; the admission comes back so the caller can parse
    /// with it (or drop it, for a probe).
    Miss(AdmissionGuard),
}

/// How much of a body hyper is handed per frame. Slices share the one
/// allocation, so this costs no copy; it is what keeps the body (and the
/// reservation it carries) alive until the client has taken nearly all of it,
/// rather than ending the moment one whole-model frame is queued.
const BODY_SLICE: usize = 1024 * 1024;

/// A response body that keeps `resident` until it has been sent or dropped.
pub(crate) fn resident_body(bytes: impl Into<Bytes>, resident: ResidentBytes) -> Body {
    let mut rest: Bytes = bytes.into();
    let mut slices = Vec::with_capacity(rest.len() / BODY_SLICE + 1);
    while rest.len() > BODY_SLICE {
        slices.push(rest.split_to(BODY_SLICE));
    }
    slices.push(rest);
    Body::from_stream(futures::stream::iter(slices).map(move |slice| {
        let _charged = &resident;
        Ok::<_, Infallible>(slice)
    }))
}

/// `GET` of a sidecar a background fill may still be writing: the data model
/// (#5129) and the symbolic stream (#7676, SERVER-21). `200` with the entry;
/// `202` while a fill for exactly this entry is in flight; `404` otherwise,
/// which a client treats as final.
///
/// The in-flight marker is checked on BOTH sides of the (awaited, disk-I/O)
/// read, and either sighting answers `202` (#5134 review): a single check
/// before the read leaves the read's whole await window open for a fill to
/// begin and go unnoticed, and a single check after leaves the window before
/// the read open the same way in the other direction. Either alone can land
/// on a `404` for a fill that is (or was, moments ago) in progress, and a
/// client treats `404` as final, so that false negative stops it asking. The
/// residual window, a fill starting AND finishing entirely between the two
/// checks, is negligible next to a real fill's milliseconds to seconds of
/// work; closing it would need a lock spanning the marker and the disk read.
pub(super) async fn sidecar_response(
    state: &AppState,
    request_key: &str,
    entry_key: &str,
    content_type: &'static str,
    what: &str,
) -> Result<Response, ApiError> {
    let in_flight_before = state.data_model_in_flight.contains(entry_key);
    let read = match state.cache.lookup(entry_key).await? {
        Some(entry) => {
            let resident = state.admission.acquire_resident(entry.size()).await?;
            state.cache.read_entry(entry_key, &entry).await.map(|bytes| (bytes, resident))
        }
        None => None,
    };
    let in_flight = in_flight_before || state.data_model_in_flight.contains(entry_key);

    match read {
        Some((bytes, resident)) => {
            tracing::info!(cache_key = %entry_key, size = bytes.len(), "{what} cache HIT");
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, content_type)
                .header(header::CONTENT_LENGTH, bytes.len())
                .body(resident_body(bytes, resident))
                .map_err(|e| ApiError::Internal(e.to_string()))
        }
        None if in_flight => {
            tracing::debug!(cache_key = %entry_key, "{what} fill in flight");
            let body = serde_json::json!({
                "status": "processing",
                "message": format!("{what} is still being processed. Retry in a moment."),
            });
            Response::builder()
                .status(StatusCode::ACCEPTED)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .map_err(|e| ApiError::Internal(e.to_string()))
        }
        None => {
            tracing::debug!(cache_key = %entry_key, "No {what} cached and none in flight");
            Err(ApiError::NotFound(format!(
                "No {} cached for key: {request_key}",
                what.to_lowercase()
            )))
        }
    }
}
