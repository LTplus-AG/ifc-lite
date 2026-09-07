// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Unit tests for `csg_summary::csg_summary_message` (#4067/#4081). Split
//! into its own `_tests.rs` sibling file, declared from `processor/mod.rs`
//! rather than from inside `csg_summary.rs` itself — see that file's module
//! doc for why: `csg_summary.rs` is one of the files
//! `scripts/check-test-revert-oracle.mjs` reverts to prove these tests
//! observe the production change, so an inline `#[cfg(test)] mod tests`
//! would be deleted along with the code it checks.

use super::csg_summary::csg_summary_message;

/// RED before #4067's fix: every record described as a drop, even when
/// `open_topology_accepted` (KernelError — mesh unchanged) accounts for all
/// of them.
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
