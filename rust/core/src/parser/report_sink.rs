// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The one host-installed destination every scan diagnostic in this crate
//! writes to (issue #3395's oversized-id refusals, and the malformed-record
//! stop this module now shares the channel with).
//!
//! One sink, not one per diagnostic kind: [`super::oversized_ids`] and
//! [`super::malformed_records`] both report a scan that came back short of
//! what the file declares, for a different reason each, but a host that
//! wants to see one wants to see the other the same way — installing two
//! sinks (or forgetting to install the second) would silently drop half the
//! warnings on whichever target adds a diagnostic later. `set_report_sink`
//! stays exported from [`super::oversized_ids`] (its original, still public
//! name) so no caller-visible API changes.

use std::sync::OnceLock;

/// Set once, because a swappable sink invites a reset race between two loads
/// on different threads and nothing here needs one.
pub(super) static REPORT_SINK: OnceLock<fn(&str)> = OnceLock::new();

/// Route a diagnostic `message` to the installed sink, or stderr by default.
pub(super) fn emit(message: &str) {
    match REPORT_SINK.get() {
        Some(sink) => sink(&format!("[ifc-lite] {message}")),
        None => eprintln!("[ifc-lite] {message}"),
    }
}
