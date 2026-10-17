// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! C9a perf probe (#7784 §6): wall time of `parse_landxml_document` over the
//! golden fixtures. Not a gate; the C9a PRs quote its numbers, base against
//! branch, interleaved:
//!
//! ```text
//! /usr/bin/time -v cargo test -p ifc-lite-landxml --release \
//!     --test landxml_pull_probe -- --ignored --nocapture
//! ```
//!
//! `LANDXML_PROBE_ITERS` (default 200) sets the repetitions per fixture.

#[path = "../../export/src/test_support.rs"]
#[allow(dead_code, unused_macros)] // shared with the export unit tests; this file uses `fixture_opt` only
mod test_support;

use std::time::Instant;

const FIXTURES: &[&str] = &[
    "apps/viewer/public/samples/terrain-tin-metric.xml",
    "rust/landxml/tests/fixtures/storm-pipe-network.xml",
    "landxml/federation/bonsai-topo-control-v1/terrain.xml",
    "landxml/producers/autodesk-civil3d-2020-international-foot-tin.xml",
    "landxml/producers/3d-win-6.6.4-m3-rockbed-terrain.xml",
    "landxml/producers/3d-win-6.6.4-m3-road-alignment.xml",
    "landxml/producers/3d-win-6.6.4-m3-lighting-cgpoints.xml",
    "landxml/producers/aplitop-mdt-8.0-alignment.xml",
    "landxml/producers/bentley-openroads-designer-10.09-us-survey-foot-alignment.xml",
    "landxml/producers/trimble-novapoint-21.354-drainage.xml",
];

/// The probes below are `#[ignore]`d; this keeps their fixtures and entry
/// point compiling and running in the ordinary test lane.
#[test]
fn probe_fixtures_parse_once() {
    let mut parsed = 0;
    for path in FIXTURES {
        let abs = format!("{}/../../{path}", env!("CARGO_MANIFEST_DIR"));
        if let Ok(bytes) = std::fs::read(&abs) {
            let _ = ifc_lite_landxml::parse_landxml_document(&bytes);
            parsed += 1;
        }
    }
    assert!(parsed >= 2, "the in-tree fixtures are always present");
}

#[test]
#[ignore = "perf probe; run with --release --ignored --nocapture"]
fn pull_document_wall_time() {
    let iters: usize = std::env::var("LANDXML_PROBE_ITERS").ok().and_then(|v| v.parse().ok()).unwrap_or(200);
    let mut total = std::time::Duration::ZERO;
    for path in FIXTURES {
        let bytes = if path.starts_with("apps/") || path.starts_with("rust/") {
            std::fs::read(format!("{}/../../{path}", env!("CARGO_MANIFEST_DIR"))).expect("in-tree fixture")
        } else if let Some(bytes) = test_support::fixture_opt(path) {
            bytes
        } else {
            continue;
        };
        let start = Instant::now();
        for _ in 0..iters {
            let _ = std::hint::black_box(ifc_lite_landxml::parse_landxml_document(std::hint::black_box(&bytes)));
        }
        let elapsed = start.elapsed();
        total += elapsed;
        println!("{path}: {:.1} us/parse", elapsed.as_secs_f64() * 1e6 / iters as f64);
    }
    println!("total: {:.1} ms for {iters} iterations of every fixture", total.as_secs_f64() * 1e3);
}

/// The smallest `max_work` that still parses each fixture, against the 100M
/// default (C9a-1 logs the corpus maximum when the work charge moves).
#[test]
#[ignore = "probe; run with --ignored --nocapture"]
fn corpus_work_boundary() {
    use ifc_lite_landxml::LandXmlLimits;
    let mut worst = 0usize;
    for path in FIXTURES {
        let bytes = if path.starts_with("apps/") || path.starts_with("rust/") {
            std::fs::read(format!("{}/../../{path}", env!("CARGO_MANIFEST_DIR"))).expect("in-tree fixture")
        } else if let Some(bytes) = test_support::fixture_opt(path) {
            bytes
        } else {
            continue;
        };
        // The families that accept the fixture at the default limit must
        // all still accept it at `max_work`.
        let families = |max_work: usize| {
            let limits = LandXmlLimits { max_work, ..LandXmlLimits::default() };
            let plan = ifc_lite_landxml::LandXmlPlanLimits { xml: limits.clone(), ..Default::default() };
            let alignment = ifc_lite_landxml::alignment::LandXmlAlignmentLimits { xml: limits.clone(), ..Default::default() };
            [
                ifc_lite_landxml::parse_landxml_tin_with_cancel(&bytes, &limits, None).is_ok(),
                ifc_lite_landxml::parse_landxml_plan_with_cancel(&bytes, &plan, None).is_ok(),
                ifc_lite_landxml::alignment::parse_landxml_alignments_optional_with_cancel(&bytes, &alignment, None).is_ok(),
                ifc_lite_landxml::parse_landxml_pipe_networks_with_cancel(&bytes, &limits, None).is_ok(),
            ]
        };
        let baseline = families(100_000_000);
        if !baseline.iter().any(|ok| *ok) {
            println!("{path}: refused at the default limit for other reasons");
            continue;
        }
        let accepts = |max_work: usize| {
            let now = families(max_work);
            baseline.iter().zip(now).all(|(was, is)| !was || is)
        };
        let (mut refused, mut accepted) = (0usize, 100_000_000usize);
        while accepted - refused > 1 {
            let middle = refused + (accepted - refused) / 2;
            if accepts(middle) { accepted = middle } else { refused = middle }
        }
        worst = worst.max(accepted);
        println!("{path}: max_work >= {accepted}");
    }
    println!("corpus maximum: {worst} of 100000000");
}
