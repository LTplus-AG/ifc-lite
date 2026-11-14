// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! PR #9614 review 3, R3-4: the scan reports refused records (oversized ids,
//! #3395) and malformed/truncated files (#3695) through core's host-installed
//! report sink, outside `ProcessingSink`. A hit never scans, so at 32d3c1a3 a
//! cached model silently lost its "this file may be incomplete" warning. A
//! pass that emits such a report is now never stored, so every call for that
//! input keeps delivering it.
//!
//! Its own test binary: the report sink can be installed once per process.

#![cfg(all(feature = "native-result-cache", not(target_arch = "wasm32")))]

use ifc_lite_processing::result_cache::{CacheMode, CacheOutcome, PublishOutcome, ResultCache, ResultCacheConfig};
use ifc_lite_processing::{result_fingerprint, ProcessingRequest};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

static REPORTS: AtomicUsize = AtomicUsize::new(0);

fn count(_message: &str) {
    REPORTS.fetch_add(1, Ordering::SeqCst);
}

fn fixture() -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/issue_6601_multicolor_element.ifc");
    std::fs::read_to_string(path).expect("in-repo fixture")
}

#[test]
fn passes_that_report_scan_refusals_are_never_replayed_silently() {
    assert!(ifc_lite_core::set_report_sink(count), "this binary installs the sink first");
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let dir = std::env::temp_dir().join(format!("rc-r3-4-{}-{nanos}", std::process::id()));
    let cache = ResultCache::new(ResultCacheConfig::default().mode(CacheMode::ReadWrite).directory(&dir).min_free_bytes(0));
    let request = ProcessingRequest::full_pass();

    // A clean file reports nothing and caches normally (control).
    let clean = fixture();
    REPORTS.store(0, Ordering::SeqCst);
    let cold = cache.process(clean.as_bytes(), &request);
    assert_eq!(REPORTS.load(Ordering::SeqCst), 0);
    assert!(matches!(cold.report.publish, PublishOutcome::Published { .. }), "{:?}", cold.report.publish);
    assert_eq!(cache.process(clean.as_bytes(), &request).report.outcome, CacheOutcome::Hit);

    let oversized = clean.replacen("DATA;", "DATA;\n#4294967297=IFCWALL();", 1);
    let truncated = format!("{}\n#999999=IFCWALL('unterminated", clean.trim_end().trim_end_matches("END-ISO-10303-21;"));
    for (name, text) in [("oversized id", oversized), ("unterminated record", truncated)] {
        REPORTS.store(0, Ordering::SeqCst);
        let first = cache.process(text.as_bytes(), &request);
        let reported = REPORTS.swap(0, Ordering::SeqCst);
        assert!(reported > 0, "{name}: the live pass reports through the sink");
        let second = cache.process(text.as_bytes(), &request);
        assert_ne!(second.report.outcome, CacheOutcome::Hit, "{name}: a hit would drop the report");
        assert_eq!(REPORTS.load(Ordering::SeqCst), reported, "{name}: every call delivers the same reports");
        assert_eq!(result_fingerprint(&second.result, false), result_fingerprint(&first.result, false));
        assert!(!matches!(first.report.publish, PublishOutcome::Published { .. }), "{name}: {:?}", first.report.publish);
    }
    let _ = std::fs::remove_dir_all(&dir);
}
