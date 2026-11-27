// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

#![cfg(feature = "probe-phase-timings")]

#[path = "../examples/perf_probe/phase_timings.rs"]
mod phase_timings;

use phase_timings::Recorder;

#[test]
fn live_pipeline_reports_the_durations_used_in_public_stats_11669() {
    let model = include_bytes!("fixtures/issue_2019_wall_two_overlapping_openings.ifc");
    let recorder = Recorder::new();
    let (result, timings) = recorder.measure(|| ifc_lite_processing::process_geometry(model));
    let timings = timings.expect("the live pipeline emitted precise phase timings");
    let stats = result.stats;
    assert!(stats.total_triangles > 0);
    for (ns, rounded_ms) in [
        (timings.parse_ns, stats.parse_time_ms),
        (timings.scan_ns, stats.entity_scan_time_ms),
        (timings.lookup_ns, stats.lookup_time_ms),
        (timings.preprocess_ns, stats.preprocess_time_ms),
        (timings.geometry_ns, stats.geometry_time_ms),
        (timings.total_ns, stats.total_time_ms),
    ] {
        assert_eq!(ns / 1_000_000, rounded_ms);
    }
}
