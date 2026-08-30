// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The one place Rust says that a scan refused a record (issue #3395).
//!
//! [`EntityScanner`](super::EntityScanner) drops a record whose instance name
//! does not fit `u32` and counts it in
//! [`skipped_oversized_ids`](super::EntityScanner::skipped_oversized_ids).
//! Dropping it is the only outcome the workspace's `u32` express-id columns
//! can hold, but a load that comes back quietly short reads exactly like a
//! load that had nothing to drop — so the counter is only half a guard. This
//! module is the other half.
//!
//! It is one home, not one call site: the scanner has ~50 consumers and the
//! first version of #3395 wired the report into exactly one of them, which is
//! the defect two reviewers found. Every consumer that builds a model or an
//! entity index from a scan calls [`report_oversized_ids`] once, and the
//! message itself is written here so the wording cannot drift the way four
//! copies of it would.
//!
//! **A refusal is a diagnostic, not an error.** `#4294967297` is a legal ISO
//! 10303-21 instance name, so a file carrying one is not corrupt — ifc-lite
//! simply cannot represent that one record. Failing the load would turn a
//! one-record loss into a total loss on a file that is otherwise fine, and it
//! would make native refuse a file the browser still opens (the wasm entry
//! points warn and keep going). So: report on every path, loudly, and keep
//! loading.
//!
//! ## Where the message goes
//!
//! Native builds write to stderr, which is where the CLI, the server and the
//! PyO3 wheel already surface their warnings. `wasm32-unknown-unknown` has no
//! stderr — `eprintln!` there is a silent no-op, which is the same
//! absence-reads-as-success failure one layer down — so the wasm bindings
//! install a console sink through [`set_report_sink`] from
//! `#[wasm_bindgen(start)] init()`, i.e. when the module LOADS, not when an
//! `IfcAPI` is constructed: the free functions and `ColumnarEntityIndex`
//! report too, and a load that never constructs an `IfcAPI` would otherwise
//! scan with the sink still unset. Anything embedding this crate with its own
//! log pipeline can do the same.

use std::sync::OnceLock;

/// Host-installed destination for [`report_oversized_ids`]. Set once, because
/// a swappable sink invites a reset race between two loads on different
/// threads and nothing here needs one.
static REPORT_SINK: OnceLock<fn(&str)> = OnceLock::new();

/// Route [`report_oversized_ids`] to `sink` instead of stderr.
///
/// Returns `true` when this call installed the sink, `false` when one was
/// already installed (the first wins). Callers on `wasm32` MUST install one:
/// the default sink is `eprintln!`, which that target discards.
pub fn set_report_sink(sink: fn(&str)) -> bool {
    REPORT_SINK.set(sink).is_ok()
}

/// The one-line report for `skipped` refused records, or `None` when the scan
/// refused nothing.
///
/// Exposed separately from [`report_oversized_ids`] so a host that already has
/// a place to put the text — the wasm bindings put it on the browser console,
/// and carry the number itself across to the JS entity-index handoff — emits
/// the same sentence rather than writing a second one.
pub fn oversized_id_report(skipped: usize) -> Option<String> {
    if skipped == 0 {
        return None;
    }
    Some(format!(
        "scan: skipped {skipped} record(s) with an express id above {} (#3395)",
        u32::MAX
    ))
}

/// Emit [`oversized_id_report`] to the installed sink (stderr by default).
///
/// A no-op at `skipped == 0`, so a caller can hand it
/// `scanner.skipped_oversized_ids()` unconditionally.
pub fn report_oversized_ids(skipped: usize) {
    let Some(message) = oversized_id_report(skipped) else {
        return;
    };
    match REPORT_SINK.get() {
        Some(sink) => sink(&format!("[ifc-lite] {message}")),
        None => eprintln!("[ifc-lite] {message}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn report_is_none_when_nothing_was_refused() {
        assert_eq!(oversized_id_report(0), None);
    }

    #[test]
    fn report_names_the_count_and_the_inclusive_bound() {
        let message = oversized_id_report(3).expect("3 refusals must produce a report");
        assert!(message.contains('3'), "report must name the count: {message}");
        assert!(
            message.contains("4294967295"),
            "report must name the inclusive u32 bound so the reader can tell \
             which ids were refused: {message}"
        );
    }
}
