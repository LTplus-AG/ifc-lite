// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Issue #3395, reporting half, processing crate: the shard scanners and the
//! streaming processor scan must SAY that they refused a record.
//!
//! These are the paths Codex named that the first #3395 change left silent —
//! `build_entity_index_parallel` (every native exporter and model load fans
//! its scan across cores through `scan_shard`) and the streaming processor's
//! own single whole-file walk. Both exhausted `next_entity()` without ever
//! reading `skipped_oversized_ids()`, so a CLI, server or Python load came
//! back one record short with nothing said.
//!
//! `scan_shard_classified_counted` is pinned here too, because the browser's
//! pre-scanned load can only report what that function hands back: the parser
//! worker receives narrowed `Uint32Array` columns and cannot recount a record
//! that is not in them.

use std::sync::Mutex;

/// Captured reports; see the sibling core test for why this is a static.
static REPORTS: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn capture(message: &str) {
    REPORTS.lock().unwrap().push(message.to_string());
}

fn drain() -> Vec<String> {
    std::mem::take(&mut *REPORTS.lock().unwrap())
}

/// `#4294967297` is `u32::MAX + 2`: a regression that wraps yields `1`, which
/// collides with a real entity instead of merely erroring.
const WITH_OVERSIZED: &str = "ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n\
#1=IFCWALL('a');\n#4294967297=IFCWALL('b');\n#2=IFCDOOR('c');\nENDSEC;\n";
/// The other end of the same threshold: `u32::MAX` is a legal instance name.
const WITHOUT_OVERSIZED: &str = "ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n\
#1=IFCWALL('a');\n#4294967295=IFCWALL('b');\n#2=IFCDOOR('c');\nENDSEC;\n";

/// The shard primitive the browser's SAB-backed pre-scanned load runs must
/// hand the count back, and the 3-tuple wrapper must stay in lockstep with it
/// (one loop, not two — the drift `issue_2053_shard_scan_parity` exists for).
#[test]
fn shard_scan_hands_back_the_refusal_count() {
    let bytes = WITH_OVERSIZED.as_bytes();
    let (records, classes, handoff, skipped) =
        ifc_lite_processing::scan_shard_classified_counted(bytes, 0, bytes.len());

    assert_eq!(skipped, 1, "the oversized record must be counted, not lost");
    let ids: Vec<u32> = records.iter().map(|&(id, _, _)| id).collect();
    assert_eq!(ids, vec![1, 2], "and it must not alias onto #1");

    let (wrapper_records, wrapper_classes, wrapper_handoff) =
        ifc_lite_processing::scan_shard_classified(bytes, 0, bytes.len());
    assert_eq!(wrapper_records, records);
    assert_eq!(wrapper_classes, classes);
    assert_eq!(wrapper_handoff, handoff);

    // Other direction: u32::MAX is inclusive and refuses nothing.
    let clean = WITHOUT_OVERSIZED.as_bytes();
    let (records, _, _, skipped) =
        ifc_lite_processing::scan_shard_classified_counted(clean, 0, clean.len());
    assert_eq!(skipped, 0);
    let ids: Vec<u32> = records.iter().map(|&(id, _, _)| id).collect();
    assert_eq!(ids, vec![1, u32::MAX, 2]);
}

/// `build_entity_index_parallel` (native exporters, model load, georeferencing)
/// and the streaming processor scan both report through the shared sink.
#[test]
fn parallel_index_and_processor_scan_report_the_refusal() {
    assert!(
        ifc_lite_core::set_report_sink(capture),
        "this test binary must own the sink; another test installed one first"
    );

    // `scan_shard` DIRECTLY, not only through `build_entity_index_parallel`:
    // that wrapper runs the serial `build_entity_index` below 8 MB of DATA
    // (`PARALLEL_MIN_BYTES`) and on a single-core host, so a small-fixture
    // assertion on it is claimed by core's report and stays green with the
    // shard report deleted — measured, not assumed.
    let bytes = WITH_OVERSIZED.as_bytes();
    let (records, _handoff) = ifc_lite_processing::scan_shard(bytes, 0, bytes.len());
    assert_eq!(records.len(), 2, "the oversized record must not be in the shard");
    let reports = drain();
    assert!(
        !reports.is_empty() && reports.iter().all(|r| r.contains("skipped 1 record")),
        "scan_shard must report the refusal, got {reports:?}"
    );

    let index = ifc_lite_processing::build_entity_index_parallel(WITH_OVERSIZED);
    assert_eq!(index.len(), 2, "the oversized record must not be indexed");
    let reports = drain();
    assert!(
        !reports.is_empty() && reports.iter().all(|r| r.contains("skipped 1 record")),
        "build_entity_index_parallel must report the refusal, got {reports:?}"
    );

    // The streaming processor's own whole-file scan — the native/server load.
    let result = ifc_lite_processing::process_geometry_streaming_filtered(
        WITH_OVERSIZED.as_bytes(),
        ifc_lite_processing::OpeningFilterMode::default(),
        64,
        |_, _, _| {},
        |_| {},
    );
    let _ = result;
    let reports = drain();
    assert!(
        reports.iter().any(|r| r.contains("skipped 1 record")),
        "the processor scan must report the refusal, got {reports:?}"
    );

    // Other direction, same sink: nothing to refuse, nothing said. Without
    // this a sink that fired on every scan would pass the assertions above.
    let clean = WITHOUT_OVERSIZED.as_bytes();
    let (records, _) = ifc_lite_processing::scan_shard(clean, 0, clean.len());
    assert_eq!(records.len(), 3);
    let index = ifc_lite_processing::build_entity_index_parallel(WITHOUT_OVERSIZED);
    assert_eq!(index.len(), 3, "u32::MAX must load, not be refused");
    assert!(index.contains_key(&u32::MAX));
    let _ = ifc_lite_processing::process_geometry_streaming_filtered(
        WITHOUT_OVERSIZED.as_bytes(),
        ifc_lite_processing::OpeningFilterMode::default(),
        64,
        |_, _, _| {},
        |_| {},
    );
    assert_eq!(
        drain(),
        Vec::<String>::new(),
        "a file with nothing to refuse must report nothing"
    );
}
