// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Issue #3395, reporting half, processing crate: a scan must SAY that it
//! refused a record — and must say it only about records the load actually
//! dropped (#3430).
//!
//! Two failures, one file:
//!
//!  * **Silence.** `build_entity_index_parallel` (every native exporter and
//!    model load fans its scan across cores) and the streaming processor's own
//!    whole-file walk both exhausted `next_entity()` without ever reading the
//!    refusals, so a CLI, server or Python load came back one record short with
//!    nothing said.
//!  * **A false alarm.** The first fix reported from inside `scan_shard`, once
//!    per shard. A shard starts at an arbitrary byte, so it can begin inside a
//!    quoted value and refuse a string literal shaped like
//!    `#4294967297=IFCWALL(` — text no file declares. That turned a clean file
//!    into a user-visible "skipped N records" warning. Reporting now happens
//!    once, after the stitch, over the offsets the stitch retained.
//!
//! `scan_shard_classified_with_refusals` is pinned here too, because the
//! browser's pre-scanned load can only report what that function hands back:
//! the parser worker receives narrowed `Uint32Array` columns and cannot
//! recount a record that is not in them.

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

/// A file that declares NOTHING oversized, whose one long quoted value is full
/// of `#4294967297=IFCWALL(` text. Returns the bytes and the byte offset of a
/// position well inside that quoted value.
///
/// `EntityScanner::next_entity` has no quote context — its guard is the SHAPE
/// check `#<digits>[ws]*=`, which that text satisfies — so a scan STARTING
/// inside the value reads the text as records and refuses them. A scan that
/// starts at a record boundary never looks inside (it jumps from the record's
/// `#` to the terminating `;` past the string), which is why the serial
/// refusal count for this file is zero.
fn clean_file_with_oversized_shaped_string(pad_records: u32, repeats: usize) -> (String, usize) {
    let mut content = String::from("ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n");
    for id in 1..=pad_records {
        content.push_str(&format!("#{id}=IFCDOOR('g{id}',$,$,$,$,$,$,$);\n"));
    }
    let string_starts_at = content.len();
    let mut fake = String::new();
    for k in 0..repeats {
        fake.push_str(&format!("#4294967297=IFCWALL(fake {k} ; still in string "));
    }
    content.push_str(&format!(
        "#{}=IFCWALL('{fake}',$,$,$,$,$,$,$);\n",
        pad_records + 1
    ));
    let inside_the_string = string_starts_at + 200;
    for id in pad_records + 2..=pad_records + 60 {
        content.push_str(&format!("#{id}=IFCDOOR('g{id}',$,$,$,$,$,$,$);\n"));
    }
    content.push_str("ENDSEC;\n");
    (content, inside_the_string)
}

/// The shard primitive the browser's SAB-backed pre-scanned load runs must
/// hand the refusals back as OFFSETS, and the 3-tuple wrapper must stay in
/// lockstep with it (one loop, not two — the drift
/// `issue_2053_shard_scan_parity` exists for).
#[test]
fn shard_scan_hands_back_the_refusal_offsets() {
    let bytes = WITH_OVERSIZED.as_bytes();
    let (records, classes, handoff, refusals) =
        ifc_lite_processing::scan_shard_classified_with_refusals(bytes, 0, bytes.len());

    // Not a count: the offset is what makes a refusal attributable, and it
    // must point at the refused record's own first byte.
    let expected = WITH_OVERSIZED.find("#4294967297").expect("fixture has the record");
    assert_eq!(
        refusals,
        vec![expected],
        "the refusal must be reported at the refused record's start offset"
    );
    let ids: Vec<u32> = records.iter().map(|&(id, _, _)| id).collect();
    assert_eq!(ids, vec![1, 2], "and it must not alias onto #1");

    let (wrapper_records, wrapper_classes, wrapper_handoff) =
        ifc_lite_processing::scan_shard_classified(bytes, 0, bytes.len());
    assert_eq!(wrapper_records, records);
    assert_eq!(wrapper_classes, classes);
    assert_eq!(wrapper_handoff, handoff);

    // Other direction: u32::MAX is inclusive and refuses nothing.
    let clean = WITHOUT_OVERSIZED.as_bytes();
    let (records, _, _, refusals) =
        ifc_lite_processing::scan_shard_classified_with_refusals(clean, 0, clean.len());
    assert_eq!(refusals, Vec::<usize>::new());
    let ids: Vec<u32> = records.iter().map(|&(id, _, _)| id).collect();
    assert_eq!(ids, vec![1, u32::MAX, 2]);
}

/// A shard REFUSES text it finds inside a quoted value it started in the
/// middle of, on a file that declares no oversized id at all. This is the
/// mechanism behind the false alarm, asserted directly rather than assumed:
/// it is why `scan_shard*` hands offsets back instead of reporting, and why
/// the count a caller reports has to come from the stitch.
#[test]
fn a_shard_starting_inside_a_quoted_value_refuses_text_the_file_never_declared() {
    let (content, inside_the_string) = clean_file_with_oversized_shaped_string(4, 400);
    let bytes = content.as_bytes();

    // Serial ground truth first: this file declares nothing oversized.
    let (_, _, serial_refusals) =
        ifc_lite_processing::scan_shard_with_refusals(bytes, 0, bytes.len());
    assert_eq!(
        serial_refusals,
        Vec::<usize>::new(),
        "the fixture must declare no oversized id"
    );

    // Start mid-string and the same scanner refuses many records — none of
    // which the file contains. Unbounded, not one per boundary.
    let (_, _, speculative) =
        ifc_lite_processing::scan_shard_with_refusals(bytes, inside_the_string, bytes.len());
    assert!(
        speculative.len() > 1,
        "a mid-string shard must refuse MANY false records (got {}), or this \
         file cannot discriminate the fix from the bug",
        speculative.len()
    );
    assert!(
        speculative.iter().all(|&o| o >= inside_the_string),
        "every false refusal sits inside the quoted value: {speculative:?}"
    );
}

/// `build_entity_index_parallel` (native exporters, model load, georeferencing)
/// and the streaming processor scan both report through the shared sink — and
/// `scan_shard` itself reports nothing, because a shard cannot know whether its
/// refusals are real.
#[test]
fn parallel_index_and_processor_scan_report_the_refusal() {
    assert!(
        ifc_lite_core::set_report_sink(capture),
        "this test binary must own the sink; another test installed one first"
    );

    // `scan_shard` must stay SILENT. It used to report here, once per shard,
    // which is what turned a clean file into a "skipped N records" warning
    // (#3430). The refusal is handed back instead, for the stitch to attribute.
    let bytes = WITH_OVERSIZED.as_bytes();
    let (records, _handoff, refusals) =
        ifc_lite_processing::scan_shard_with_refusals(bytes, 0, bytes.len());
    assert_eq!(records.len(), 2, "the oversized record must not be in the shard");
    assert_eq!(refusals.len(), 1, "the shard must hand the refusal back");
    assert_eq!(
        drain(),
        Vec::<String>::new(),
        "a single shard must not report on its own — only the stitch can"
    );

    let index = ifc_lite_processing::build_entity_index_parallel(WITH_OVERSIZED);
    assert_eq!(index.len(), 2, "the oversized record must not be indexed");
    let reports = drain();
    assert_eq!(
        reports.len(),
        1,
        "build_entity_index_parallel must report exactly ONCE per load, got {reports:?}"
    );
    assert!(
        reports[0].contains("skipped 1 record"),
        "the report must name how many records went missing: {}",
        reports[0]
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

    // ── The false alarm, through the public entry point ──
    // Over `PARALLEL_MIN_BYTES` (8 MB) so the fan-out is real, with a quoted
    // value long enough to swallow a chunk boundary. How MANY chunks rayon
    // picks depends on the host's core count, so the deterministic sweep over
    // forced boundary positions lives in `parallel_scan.rs`'s own tests; this
    // leg proves the public path is wired to the attributed count.
    let (big, _) = clean_file_with_oversized_shaped_string(120_000, 90_000);
    assert!(
        big.len() > 8 * 1024 * 1024,
        "fixture must clear PARALLEL_MIN_BYTES, got {} bytes",
        big.len()
    );
    let index = ifc_lite_processing::build_entity_index_parallel(&big);
    assert!(index.len() > 100_000, "the clean file must load in full");
    assert_eq!(
        drain(),
        Vec::<String>::new(),
        "a file whose only oversized-looking text is inside a quoted value \
         must report NOTHING, however the shard boundaries fall"
    );

    // Same file, one REAL oversized declaration added: still exactly one
    // report, and it names one record — not one per shard, and not one per
    // false record the mis-started shards read out of the quoted value.
    let mut big_with_real = big.clone();
    let end_of_data = big_with_real.rfind("ENDSEC;").expect("fixture ends with ENDSEC");
    big_with_real.insert_str(end_of_data, "#4294967297=IFCWALL('over',$,$,$,$,$,$,$);\n");
    let index = ifc_lite_processing::build_entity_index_parallel(&big_with_real);
    assert!(index.len() > 100_000);
    let reports = drain();
    assert_eq!(
        reports.len(),
        1,
        "one report for one load, got {reports:?}"
    );
    assert!(
        reports[0].contains("skipped 1 record"),
        "and it must name the one real refusal: {}",
        reports[0]
    );
}
