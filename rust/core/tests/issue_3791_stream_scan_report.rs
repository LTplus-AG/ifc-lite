// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Issue #3791, streaming half: `parse_stream` walks `EntityScanner` to
//! exhaustion and then emits `Completed`, so both ways a scan can come back
//! short of what the file declares — a refused oversized instance name
//! (#3395) and a record with no terminator (#3695) — used to reach the
//! caller as a successful parse with a smaller `entity_count`.
//!
//! Both directions are asserted through the same sink, because "it reported"
//! is only evidence if the same harness stays silent on an intact file: a
//! sink that fired on every scan would pass a one-directional check.

use futures_util::StreamExt;
use ifc_lite_core::{parse_stream, ParseEvent, StreamConfig};
use std::sync::Mutex;

/// Captured reports. A `fn(&str)` sink cannot close over state, so the buffer
/// is a static — fine here because this integration test is its own binary.
static REPORTS: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn capture(message: &str) {
    REPORTS.lock().unwrap().push(message.to_string());
}

fn drain() -> Vec<String> {
    std::mem::take(&mut *REPORTS.lock().unwrap())
}

/// `#4294967297` is `u32::MAX + 2`: a regression that wraps yields `1` and
/// collides with a real entity rather than merely erroring.
const WITH_OVERSIZED: &str = "#1=IFCWALL('a');\n#4294967297=IFCWALL('b');\n#2=IFCDOOR('c');\n";
/// `#2`'s string literal never closes, so `find_entity_end` runs off the end
/// of the buffer and the scan stops there — #3 is never seen.
const WITH_UNTERMINATED_STRING: &str = "#1=IFCWALL('a');\n#2=IFCWALL('b);\n#3=IFCDOOR('c');\n";
/// Same three records, all intact. `#4294967295` is `u32::MAX` itself, which
/// is representable and must survive untouched.
const INTACT: &str = "#1=IFCWALL('a');\n#4294967295=IFCWALL('b');\n#3=IFCDOOR('c');\n";

/// Drive `parse_stream` to exhaustion and return the `Completed` entity count.
async fn stream_entity_count(content: &str) -> usize {
    let mut stream = parse_stream(content, StreamConfig::default());
    let mut completed = None;
    while let Some(event) = stream.next().await {
        if let ParseEvent::Completed { entity_count, .. } = event {
            completed = Some(entity_count);
        }
    }
    completed.expect("parse_stream must always end with Completed")
}

/// One test, not three: the sink is a process-wide `OnceLock`, so the cases
/// have to share a binary and run in a fixed order rather than race for it.
#[tokio::test]
async fn parse_stream_reports_both_ways_a_scan_comes_back_short() {
    assert!(
        ifc_lite_core::set_report_sink(capture),
        "this test binary must own the sink; another test installed one first"
    );

    // ── A refused oversized instance name (#3395) ──
    assert_eq!(
        stream_entity_count(WITH_OVERSIZED).await,
        2,
        "the oversized record is skipped, so the stream really is one short"
    );
    let reports = drain();
    assert_eq!(
        reports.len(),
        1,
        "parse_stream must report the refusal exactly once, got {reports:?}"
    );
    assert!(
        reports[0].contains("skipped 1 record"),
        "the report must name how many records went missing: {}",
        reports[0]
    );

    // ── A record with no terminator (#3695) ──
    assert_eq!(
        stream_entity_count(WITH_UNTERMINATED_STRING).await,
        1,
        "the scan stops at the unterminated string, so #3 never arrives"
    );
    let reports = drain();
    assert_eq!(
        reports.len(),
        1,
        "parse_stream must report the malformed stop exactly once, got {reports:?}"
    );
    assert!(
        reports[0].contains("incomplete"),
        "the report must warn the stream may be short: {}",
        reports[0]
    );

    // ── The other direction, through the same sink ──
    assert_eq!(
        stream_entity_count(INTACT).await,
        3,
        "u32::MAX must load and nothing may be dropped"
    );
    assert_eq!(
        drain(),
        Vec::<String>::new(),
        "an intact file must report nothing"
    );
}
