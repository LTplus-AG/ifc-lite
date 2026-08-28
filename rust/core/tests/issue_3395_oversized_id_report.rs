// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Issue #3395, reporting half: the whole-file index builders must SAY that
//! they refused a record, not only count it internally.
//!
//! `EntityScanner::skipped_oversized_ids` shipped with exactly one consumer
//! reading it, so `build_entity_index` and `ColumnarEntityIndex::from_scan` —
//! the index builds behind every CLI, server and Python load — handed back a
//! model that was quietly one record short. A missing bound corrupts; a
//! missing report returns a truncated success, which is the failure this
//! pins.
//!
//! Both directions are asserted in the same test, because "it reported" is
//! only evidence if the same harness stays silent on a file with nothing to
//! refuse: a sink that fires unconditionally would pass a one-directional
//! check.

use std::sync::Mutex;

/// Captured reports. A `fn(&str)` sink cannot close over state, so the buffer
/// is a static — fine here because this integration test is its own binary and
/// nothing else in it triggers a refusal.
static REPORTS: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn capture(message: &str) {
    REPORTS.lock().unwrap().push(message.to_string());
}

fn drain() -> Vec<String> {
    std::mem::take(&mut *REPORTS.lock().unwrap())
}

/// `#4294967297` is `u32::MAX + 2`, so a regression that wraps yields `1` and
/// collides with a REAL entity rather than merely erroring. `#4294967295` is
/// `u32::MAX` itself and must survive untouched.
const WITH_OVERSIZED: &str = "#1=IFCWALL('a');\n#4294967297=IFCWALL('b');\n#2=IFCDOOR('c');\n";
const WITHOUT_OVERSIZED: &str = "#1=IFCWALL('a');\n#4294967295=IFCWALL('b');\n#2=IFCDOOR('c');\n";

#[test]
fn native_index_builders_report_a_refused_oversized_id() {
    assert!(
        ifc_lite_core::set_report_sink(capture),
        "this test binary must own the sink; another test installed one first"
    );

    // ── build_entity_index (the decoder's index, every native load) ──
    let index = ifc_lite_core::build_entity_index(WITH_OVERSIZED);
    // The record really is gone — and it did not alias onto #1's span, which
    // is the corruption the bound half of #3395 fixed.
    assert_eq!(index.len(), 2, "the oversized record must not be indexed");
    assert!(index.contains_key(&1) && index.contains_key(&2));
    let reports = drain();
    assert_eq!(
        reports.len(),
        1,
        "build_entity_index must report exactly once, got {reports:?}"
    );
    assert!(
        reports[0].contains("skipped 1 record"),
        "the report must name how many records went missing: {}",
        reports[0]
    );

    // ── ColumnarEntityIndex::from_scan (the wasm lazy fallback's index) ──
    let columnar = ifc_lite_core::ColumnarEntityIndex::from_scan(WITH_OVERSIZED);
    assert_eq!(columnar.len(), 2);
    let reports = drain();
    assert_eq!(
        reports.len(),
        1,
        "from_scan must report exactly once, got {reports:?}"
    );
    assert!(reports[0].contains("skipped 1 record"), "{}", reports[0]);

    // ── The other direction, through the same sink ──
    // u32::MAX is inclusive, so this file refuses nothing and must produce
    // NO report. Without this, a sink that fired on every scan would pass.
    let index = ifc_lite_core::build_entity_index(WITHOUT_OVERSIZED);
    assert_eq!(index.len(), 3, "u32::MAX must load, not be refused");
    assert!(index.contains_key(&u32::MAX));
    let columnar = ifc_lite_core::ColumnarEntityIndex::from_scan(WITHOUT_OVERSIZED);
    assert_eq!(columnar.len(), 3);
    assert_eq!(
        drain(),
        Vec::<String>::new(),
        "a file with nothing to refuse must report nothing"
    );
}
