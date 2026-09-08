// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Issue #3791, early-drop half: reporting only on the `Completed` branch
//! leaves the consumer who read the LEAST with the least information.
//!
//! `parse_stream` is lazy, so stopping early is a normal thing to do — a
//! `take`, a `break`, a cancelled task. A refusal the scanner already
//! recorded would then die with the stream, silently, while the consumer who
//! polled to exhaustion got told. `ParserState`'s `Drop` closes that.
//!
//! Its own test binary rather than a case in
//! `issue_3791_stream_scan_report.rs`: the report sink is a process-wide
//! `OnceLock`, so a binary can install exactly one, and these cases want to
//! own it without ordering against that file's.

use futures_util::StreamExt;
use ifc_lite_core::{parse_stream, StreamConfig};
use std::sync::Mutex;

static REPORTS: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn capture(message: &str) {
    REPORTS.lock().unwrap().push(message.to_string());
}

fn drain() -> Vec<String> {
    std::mem::take(&mut *REPORTS.lock().unwrap())
}

/// The refused record comes FIRST on purpose: the scanner records the refusal
/// while looking for the entity behind the stream's SECOND event, so two
/// polls are enough to have something to report and still be far from
/// `Completed`. With the refusal last, an early-dropping consumer would
/// legitimately have nothing to say yet, and the test would pass on a build
/// with no `Drop` at all.
const OVERSIZED_FIRST: &str = "#4294967297=IFCWALL('b');\n#1=IFCWALL('a');\n#2=IFCDOOR('c');\n";
/// Same shape, nothing to refuse — `#4294967295` is `u32::MAX` and fits.
const INTACT: &str = "#4294967295=IFCWALL('b');\n#1=IFCWALL('a');\n#2=IFCDOOR('c');\n";

/// Poll `content`'s stream exactly `polls` times and drop it, unread.
async fn poll_then_drop(content: &str, polls: usize) {
    let mut stream = parse_stream(content, StreamConfig::default());
    for _ in 0..polls {
        assert!(
            stream.next().await.is_some(),
            "the fixture must have at least {polls} events before the drop"
        );
    }
    drop(stream);
}

/// One test, not three: the sink is process-wide, so the cases share a binary
/// and run in a fixed order rather than race for it.
#[tokio::test]
async fn dropping_the_stream_early_still_reports_what_the_scan_refused() {
    assert!(
        ifc_lite_core::set_report_sink(capture),
        "this test binary must own the sink; another test installed one first"
    );

    // ── Started, then one EntityScanned, then drop: no `Completed` ──
    poll_then_drop(OVERSIZED_FIRST, 2).await;
    let reports = drain();
    assert_eq!(
        reports.len(),
        1,
        "a dropped stream must still report the refusal, got {reports:?}"
    );
    assert!(
        reports[0].contains("skipped 1 record"),
        "the report must name how many records went missing: {}",
        reports[0]
    );

    // ── The other direction: nothing refused, nothing said ──
    poll_then_drop(INTACT, 2).await;
    assert_eq!(
        drain(),
        Vec::<String>::new(),
        "an early drop on an intact file must report nothing"
    );

    // ── Dropped before the first poll: the scan never ran ──
    // Guards the `Drop` against reporting on an untouched scanner, which
    // would fire on every abandoned stream in the process.
    poll_then_drop(OVERSIZED_FIRST, 0).await;
    assert_eq!(
        drain(),
        Vec::<String>::new(),
        "a never-polled stream has scanned nothing to report"
    );

    // ── Polled to exhaustion, THEN dropped: still exactly one report ──
    // The `Completed` branch and `Drop` both call the same reporter, so this
    // is where a missing idempotence flag would show up as a duplicate.
    let mut stream = parse_stream(OVERSIZED_FIRST, StreamConfig::default());
    while stream.next().await.is_some() {}
    drop(stream);
    assert_eq!(
        drain().len(),
        1,
        "Completed and Drop must not both report the same scan"
    );
}
