// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The one place Rust says that a scan stopped early because a record had no
//! terminator — the Rust twin of the TS fix on `EntityScanResult.malformedRecordCount`
//! (`packages/parser/src/entity-scanner.ts`, #3695).
//!
//! [`EntityScanner`](super::EntityScanner) stops the whole scan the moment a
//! record opens a `'` string, a `/* … */` comment, or simply runs to end of
//! input with none of them ever closing — [`EntityScanner::find_entity_end`]
//! has no byte to resume from once that happens (unlike the oversized-id
//! refusal in [`super::oversized_ids`], which SKIPS the one record and keeps
//! scanning). A model that comes back with its tail silently missing reads
//! exactly like a complete one, so this module is the other half: the caller
//! reports it rather than staying quiet.
//!
//! Modelled directly on [`super::oversized_ids`] — same "one home, not one
//! call site" reasoning, same host-installed sink (shared with it via
//! [`super::report_sink`], not a second `OnceLock`) — but the count this
//! reports is always 0 or 1: once a scan stops here it never resumes, so
//! there is nothing left to accumulate a second refusal from.

/// The one-line report for a scan that stopped because of a malformed
/// record, or `None` when `stopped` is `false`.
///
/// Exposed separately from [`report_malformed_records`] so a host that
/// already has a place to put the text (the wasm bindings; a future
/// `EntityScanResult`-shaped export) emits the same sentence rather than
/// writing a second one — the same split [`super::oversized_id_report`]
/// makes.
pub fn malformed_record_report(stopped: bool) -> Option<String> {
    if !stopped {
        return None;
    }
    Some(
        "scan: stopped early — a record had no terminating ';' before end of input \
         (an unterminated quoted string, comment, or truncated file); the entities \
         returned may be an incomplete view of this file (#3695)"
            .to_string(),
    )
}

/// Emit [`malformed_record_report`] to the installed sink (stderr by
/// default; see [`super::set_report_sink`]).
///
/// A no-op at `stopped == false`, so a caller can hand it
/// `scanner.malformed_record_start().is_some()` unconditionally, exactly
/// like [`super::report_oversized_ids`] takes `skipped_oversized_ids()`.
pub fn report_malformed_records(stopped: bool) {
    let Some(message) = malformed_record_report(stopped) else {
        return;
    };
    super::report_sink::emit(&message);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn report_is_none_when_the_scan_did_not_stop_early() {
        assert_eq!(malformed_record_report(false), None);
    }

    #[test]
    fn report_names_the_shape_of_the_problem() {
        let message = malformed_record_report(true).expect("a stop must produce a report");
        assert!(
            message.contains("incomplete"),
            "report must warn the caller the model may be short: {message}"
        );
    }
}
