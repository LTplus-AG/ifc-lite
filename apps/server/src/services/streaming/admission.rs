// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Admission state carried by a streaming response.

use crate::admission::AdmissionGuard;
use std::time::Duration;

/// The admission permit a streaming response carries, and the ceiling on how
/// long it may carry it.
///
/// The two travel together because the second exists only to bound the first:
/// the permit's lifetime is otherwise decided by the client (see
/// [`super::process_streaming`]), and a client that stops reading its socket
/// has no deadline of its own.
pub struct StreamAdmission {
    /// The acquired permit, or `None` on paths that hold none (cached replay,
    /// unit tests).
    pub(super) guard: Option<AdmissionGuard>,
    /// Longest the response may go without the client consuming a frame
    /// before the permit is released and the parse cancelled. `None` disables
    /// the bound.
    pub(super) idle_timeout: Option<Duration>,
}

impl StreamAdmission {
    /// The production shape: a held permit, bounded by the operator's
    /// `IFC_STREAM_IDLE_TIMEOUT_SECS`. The only constructor a route can
    /// reach, so a stream cannot be wired up with the bound forgotten.
    pub fn admitted(guard: AdmissionGuard, config: &crate::config::Config) -> Self {
        Self { guard: Some(guard), idle_timeout: config.stream_idle_timeout() }
    }

    /// A held permit with an explicit bound, for the end-to-end test.
    #[cfg(test)]
    pub fn bounded(guard: AdmissionGuard, idle_timeout: Duration) -> Self {
        Self { guard: Some(guard), idle_timeout: Some(idle_timeout) }
    }

    /// No permit and no bound. Test-only: every production caller holds a
    /// permit, and a production path that did not would be the defect this
    /// type exists to make visible.
    #[cfg(test)]
    pub fn none() -> Self {
        Self { guard: None, idle_timeout: None }
    }
}
