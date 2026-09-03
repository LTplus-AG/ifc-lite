// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Issue #3752, `find_ifcproject_id` reporting half: a refused `IFCPROJECT`
//! express id must be SAID, through the same sink the definition scanner uses
//! for issue #3395 — not just refused (issue #3421) with nothing downstream
//! able to tell a genuinely-absent project apart from one whose id ifc-lite
//! could not represent.
//!
//! Separate integration-test binary (its own process) for the same reason
//! the sibling #3395 report test is one: [`ifc_lite_core::set_report_sink`]
//! is a process-wide `OnceLock` (first install wins), so a capturing sink
//! installed here must not collide with another test binary's.

use std::sync::Mutex;

/// Captured reports; see the sibling #3395 report test for why this is a
/// static (one sink per process, shared across every test in this binary).
static REPORTS: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Both tests below share `REPORTS` and the process-wide report sink through
/// `drain()`. Cargo runs tests in one binary on multiple threads by default,
/// so without this lock one test's `drain()` can race another's `capture()`
/// and steal or lose its report (CodeRabbit, PR #3766). Held for each test's
/// full body, including its own setup and `drain()` calls.
static TEST_LOCK: Mutex<()> = Mutex::new(());

fn capture(message: &str) {
    REPORTS.lock().unwrap().push(message.to_string());
}

fn drain() -> Vec<String> {
    std::mem::take(&mut *REPORTS.lock().unwrap())
}

/// RED for issue #3752: an `IFCPROJECT` express id above `u32::MAX` is
/// refused by `parse_express_id` (issue #3421) but that refusal used to leave
/// no trace anywhere. It must now reach the installed report sink.
#[test]
fn an_oversized_ifcproject_id_is_reported() {
    let _guard = TEST_LOCK.lock().unwrap();
    let _ = ifc_lite_core::set_report_sink(capture);
    drain(); // clear anything a sibling test in this binary already left.

    let ifc = b"ISO-10303-21;\nDATA;\n#1=IFCWALL('x',$,$,$,$,$,$,$,$);\n\
                #4294967297=IFCPROJECT('g',$,'P',$,$,$,$,$,$);\nENDSEC;\n";
    let project_id = ifc_lite_processing::prepass::find_ifcproject_id(ifc);

    assert_eq!(project_id, None, "the oversized IFCPROJECT id must still be refused, not aliased");
    let reports = drain();
    assert!(
        reports.iter().any(|r| r.contains("skipped 1 record") && r.contains("4294967295")),
        "the refusal must be reported through the installed sink, not silently dropped (#3752): {reports:?}"
    );
}

/// Control: a file with no oversized id reports nothing.
#[test]
fn an_ordinary_ifcproject_id_reports_nothing() {
    let _guard = TEST_LOCK.lock().unwrap();
    let _ = ifc_lite_core::set_report_sink(capture);
    drain();

    let ifc = b"ISO-10303-21;\nDATA;\n#1=IFCWALL('x',$,$,$,$,$,$,$,$);\n\
                #42=IFCPROJECT('g',$,'P',$,$,$,$,$,$);\nENDSEC;\n";
    let project_id = ifc_lite_processing::prepass::find_ifcproject_id(ifc);

    assert_eq!(project_id, Some(42));
    assert!(
        drain().is_empty(),
        "an ordinary IFCPROJECT id must not produce a report"
    );
}
