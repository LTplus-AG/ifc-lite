// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `--result-cache DIR`: drive the full pass through the native result cache
//! and report what THIS process did: on a miss the live pass plus encode and
//! write; on a hit the source hash, entry read, validation and decode. One
//! fixture, one iteration, a fresh process each (`--cold` is required), so a
//! warm hit is measured end to end the way a second open would pay it.
//!
//! On a hit the result's `ProcessingStats` durations are the producer's,
//! replayed verbatim; the probe labels them so and never reports them as
//! this run's phases.

use ifc_lite_processing::result_cache::{CacheMode, CacheReport, ResultCache, ResultCacheConfig};
use ifc_lite_processing::{ProcessingRequest, ProcessingResult};

pub(super) struct CacheArgs {
    pub(super) dir: String,
    pub(super) mode: CacheMode,
    /// Exit 3 unless the outcome label matches (`hit`, `miss`, ...).
    pub(super) expect: Option<String>,
}

pub(super) fn parse_mode(value: Option<String>) -> CacheMode {
    match value.as_deref() {
        Some("rw") | Some("read-write") => CacheMode::ReadWrite,
        Some("ro") | Some("read-only") => CacheMode::ReadOnly,
        Some("off") => CacheMode::Off,
        other => {
            eprintln!("--result-cache-mode expects rw|ro|off, got {other:?}");
            std::process::exit(2);
        }
    }
}

pub(super) fn process(content: &[u8], args: &CacheArgs) -> (ProcessingResult, CacheReport) {
    let config = ResultCacheConfig::default().mode(args.mode).directory(&args.dir);
    let out = ResultCache::new(config).process(content, &ProcessingRequest::full_pass());
    if let Some(want) = &args.expect {
        if out.report.outcome_label() != want {
            eprintln!("result cache outcome {} (expected {want}): {:?}", out.report.outcome_label(), out.report.outcome);
            std::process::exit(3);
        }
    }
    (out.result, out.report)
}

fn ms(d: std::time::Duration) -> f64 {
    d.as_secs_f64() * 1e3
}

pub(super) fn print_human(r: &CacheReport) {
    let w = &r.work;
    eprintln!("  result cache: {} ({:?}); publish {:?}", r.outcome_label(), r.outcome, r.publish);
    eprintln!(
        "    hash {:.2} ms over {} B | read {:.2} ms, {} B | validate {:.2} ms | decode {:.2} ms, {} B",
        ms(w.hash), w.bytes_hashed, ms(w.read), w.entry_bytes_read, ms(w.validate), ms(w.decode), w.bytes_decoded
    );
    eprintln!(
        "    live pass {:.2} ms | encode {:.2} ms | write {:.2} ms, {} B",
        ms(w.process), ms(w.encode), ms(w.write), w.entry_bytes_written
    );
    if r.outcome_label() == "hit" {
        eprintln!("    phase table below: the PRODUCER's replayed ProcessingStats, not this run's work");
    }
    for warning in &r.warnings {
        eprintln!("    warning: {warning}");
    }
}

pub(super) fn json(r: &CacheReport) -> String {
    let w = &r.work;
    format!(
        concat!(
            r#","resultCache":{{"outcome":{},"publish":{},"key":{},"bytesHashed":{},"hashMs":{:.3},"#,
            r#""entryBytesRead":{},"readMs":{:.3},"validateMs":{:.3},"bytesDecoded":{},"decodeMs":{:.3},"#,
            r#""processMs":{:.3},"encodeMs":{:.3},"writeMs":{:.3},"entryBytesWritten":{},"statsAreProducers":{}}}"#,
        ),
        serde_json::to_string(r.outcome_label()).expect("label"),
        serde_json::to_string(&format!("{:?}", r.publish)).expect("publish"),
        serde_json::to_string(&r.key).expect("key"),
        w.bytes_hashed,
        ms(w.hash),
        w.entry_bytes_read,
        ms(w.read),
        ms(w.validate),
        w.bytes_decoded,
        ms(w.decode),
        ms(w.process),
        ms(w.encode),
        ms(w.write),
        w.entry_bytes_written,
        r.outcome_label() == "hit",
    )
}
