// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The one place Rust says that a scan stopped early because a record had no
//! terminator - the Rust twin of the TS fix on `EntityScanResult.malformedRecordCount`
//! (`packages/parser/src/entity-scanner.ts`, #3695).
//!
//! [`EntityScanner`](super::EntityScanner) drops any record
//! [`EntityScanner::find_entity_end`] refuses. Most are recoverable: a record
//! missing its `;` costs that one record and the scan carries on at the `)`
//! closing its parameter list (#4179), exactly as the oversized-id refusal in
//! [`super::oversized_ids`] does. It stops the whole scan only when there is
//! nothing to resume from, which is a `'` string or a `/* ... */` comment that
//! never closes. Either way a model that comes back short reads exactly like a
//! complete one, so this module is the other half: the caller reports it
//! rather than staying quiet.
//!
//! Modelled directly on [`super::oversized_ids`] - same "one home, not one
//! call site" reasoning, same host-installed sink (shared with it via
//! [`super::report_sink`], not a second `OnceLock`) - but the count this
//! reports is always 0 or 1: it answers "was anything dropped", which is what
//! a user needs in order to distrust the result, not how many.
//!
//! One constant message, not a builder like [`super::oversized_id_report`]:
//! the oversized-id report names a count, so it has to allocate a formatted
//! string; this report names nothing that varies, so a `const &str` is the
//! whole of it and there is no `Option<String>`-returning sibling to keep in
//! sync with it.

/// The one-line report for a scan that stopped because of a malformed
/// record.
const MALFORMED_RECORD_MESSAGE: &str =
    "scan: dropped a record with no terminating ';' (an unterminated quoted \
     string, comment, or truncated file); the entities returned may be an \
     incomplete view of this file (#3695)";

/// Emit [`MALFORMED_RECORD_MESSAGE`] to the installed sink (stderr by
/// default; see [`super::set_report_sink`]).
///
/// A no-op at `stopped == false`, so a caller can hand it
/// `scanner.malformed_record_start().is_some()` unconditionally, exactly
/// like [`super::report_oversized_ids`] takes `skipped_oversized_ids()`.
pub fn report_malformed_records(stopped: bool) {
    if !stopped {
        return;
    }
    super::report_sink::emit(MALFORMED_RECORD_MESSAGE);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_names_the_shape_of_the_problem() {
        assert!(
            MALFORMED_RECORD_MESSAGE.contains("incomplete"),
            "report must warn the caller the model may be short: {MALFORMED_RECORD_MESSAGE}"
        );
    }
}
