// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #4067: the per-load CSG diagnostics summary `tracing::warn!` in
//! `processor/mod.rs` used to describe EVERY recorded `CsgFailure` as
//! "cut dropped, host kept uncut." That is false for a `KernelError` record —
//! `rust/geometry/src/csg/topology_diagnostic.rs` is the sole production
//! emitter, and its doc comment is explicit that it "record[s] accepted
//! nonempty open-topology results without changing the returned mesh" — the
//! mesh the caller returns is the SAME one that was about to be returned
//! anyway, not a dropped cut replaced by an un-cut host.
//!
//! Pulled the message choice out into its own pure function so the text can
//! be asserted directly, without standing up a tracing-subscriber capture
//! harness just to check a string literal.

/// Choose the summary phrase for the CSG diagnostics warning, given how many
/// of this load's records are genuine drops (host kept uncut) versus
/// `KernelError` accepts (mesh unchanged, informational open-topology
/// finding — see module doc above). `dropped` and `open_topology_accepted`
/// are disjoint partitions of the same failure list, so exactly one of the
/// three arms applies.
pub(super) fn csg_summary_message(dropped: usize, open_topology_accepted: usize) -> &'static str {
    if dropped == 0 && open_topology_accepted > 0 {
        "CSG diagnostics during geometry extraction (accepted result(s) recorded an open-topology audit finding; mesh unchanged, non-gating)"
    } else if open_topology_accepted == 0 {
        "CSG failures during geometry extraction (cut dropped, host kept uncut)"
    } else {
        "CSG diagnostics during geometry extraction (mix of cuts dropped with host kept uncut, and accepted results that recorded an open-topology audit finding with mesh unchanged)"
    }
}

#[cfg(test)]
mod tests {
    use super::csg_summary_message;

    /// RED before #4067's fix: every record described as a drop, even when
    /// `open_topology_accepted` (KernelError — mesh unchanged) accounts for
    /// all of them.
    #[test]
    fn all_open_topology_accepts_are_not_described_as_dropped() {
        let msg = csg_summary_message(0, 3);
        assert!(
            !msg.contains("cut dropped"),
            "an accepted open-topology result must not be described as a dropped cut: {msg:?}"
        );
        assert!(
            msg.contains("open-topology"),
            "message should name what was actually recorded: {msg:?}"
        );
    }

    #[test]
    fn all_drops_keep_the_original_wording() {
        let msg = csg_summary_message(4, 0);
        assert_eq!(
            msg,
            "CSG failures during geometry extraction (cut dropped, host kept uncut)"
        );
    }

    #[test]
    fn mixed_records_name_both_kinds() {
        let msg = csg_summary_message(2, 1);
        assert!(msg.contains("dropped"), "mixed message drops half: {msg:?}");
        assert!(
            msg.contains("open-topology"),
            "mixed message should still name the accepted half: {msg:?}"
        );
    }
}
