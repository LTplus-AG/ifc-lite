// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The one place Rust reports that a scan encountered a malformed record
//! (unterminated string or comment) and stopped (issue #3791).
//!
//! [`EntityScanner`](super::EntityScanner) stops scanning when it encounters
//! an unterminated string literal or comment, recording the byte offset in
//! [`malformed_record_start`](super::EntityScanner::malformed_record_start).
//! Unlike oversized ids (which are skipped), a malformed record leaves no safe
//! byte to resume from — every entity after that break is dropped silently
//! without this diagnostic.
//!
//! This module provides the report infrastructure, mirroring the pattern from
//! [`crate::parser::oversized_ids`].

/// The one-line report for a malformed record, or `None` if the scan
/// encountered no malformed input.
///
/// Exposed separately from [`report_malformed_records`] so a host that already
/// has a place to put the text (the wasm bindings, for instance) emits the
/// same sentence rather than writing a second one.
pub fn malformed_record_report(malformed: bool) -> Option<String> {
    if !malformed {
        return None;
    }
    Some(
        "scan: stopped early — a string literal or comment never closed; \
         the entities returned may be an incomplete view of this file"
            .to_string(),
    )
}

/// Emit [`malformed_record_report`] to stderr if `malformed` is true.
///
/// A no-op when `malformed == false`, so a caller can hand it
/// `scanner.malformed_record_start().is_some()` unconditionally.
pub fn report_malformed_records(malformed: bool) {
    let Some(message) = malformed_record_report(malformed) else {
        return;
    };
    eprintln!("[ifc-lite] {message}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn report_is_none_when_no_malformed_record() {
        assert_eq!(malformed_record_report(false), None);
    }

    #[test]
    fn report_names_the_stop_condition_when_malformed() {
        let message = malformed_record_report(true).expect("malformed=true must produce a report");
        assert!(
            message.contains("stopped early"),
            "report must indicate the scan stopped: {message}"
        );
        assert!(
            message.contains("string literal") || message.contains("comment"),
            "report must name the kind of malformation: {message}"
        );
    }
}
