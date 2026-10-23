// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression for georeferenced jitter (ISSUE_129). The world offset lives in
//! spatial-structure placements emitted LATE in the file (IfcSite at line
//! 202 339 of a 202 691 line model). `buildPrePassStreaming` emits its RTC meta
//! as soon as `META_EMIT_JOBS` (50) geometry jobs are buffered — near the
//! TOP of the file — using the partial entity index built so far. At that point
//! the element -> storey -> building -> site placement chain can't resolve, so
//! detection returns (0,0,0), `needsShift=false`, and the ~8e6 m coordinates are
//! cast to f32 downstream (~0.5 m jitter). The browser confirmed this:
//! `[stream] meta unitScale=1 rtc=[0,0,0]` for this model.
//!
//! This pins the mechanism the streaming fix relies on: at the meta-emit cut
//! point the *partial* index MISSES the offset (reproducing the bug), while a
//! *full* index recovers it (the fallback `gpu_meshes.rs` now performs when no
//! offset is found and the IfcSite hasn't been scanned yet).

use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner};
use ifc_lite_geometry::GeometryRouter;

const FIXTURE: &str =
    "ara3d/ISSUE_129_N1540_17_EXE_MOD_448200_02_09_11SMC_IGC_V17.ifc";
const META_EMIT_JOBS: usize = 50; // mirrors META_EMIT_JOB_THRESHOLD in gpu_meshes/prepass.rs

/// Record-end offsets of the first `n` geometry-bearing entities, in file order.
/// The last of them is where the streaming pre-pass emits its meta, so it is
/// the byte the partial index reaches.
fn geometry_job_ends(content: &str, n: usize) -> Vec<usize> {
    let mut ends = Vec::new();
    let mut sc = EntityScanner::new(content);
    while let Some((_, ty, _, e)) = sc.next_entity() {
        if matches!(
            ty,
            "IFCWALL" | "IFCWALLSTANDARDCASE" | "IFCSLAB" | "IFCCOLUMN" | "IFCBEAM" | "IFCSTAIRFLIGHT"
        ) {
            ends.push(e);
            if ends.len() >= n {
                break;
            }
        }
    }
    ends
}

#[test]
fn streaming_partial_index_misses_late_site_offset_but_full_index_recovers_it() {
    let full = ifc_lite_testkit::fixture_text_or_skip!(FIXTURE);

    let job_ends = geometry_job_ends(&full, META_EMIT_JOBS);
    assert_eq!(job_ends.len(), META_EMIT_JOBS, "need the first 50 geometry jobs");

    // The streaming meta is emitted right after the 50th geometry job is
    // buffered, against the partial index built up to that scan point. Model
    // that exactly: content truncated at the end of the 50th geometry job.
    let cut = *job_ends.last().unwrap();
    let partial = &full[..cut];
    assert!(
        !partial.contains("IFCSITE"),
        "the late IfcSite must be beyond the meta-emit cut (else the bug wouldn't reproduce)"
    );

    let is_large =
        |t: (f64, f64, f64)| t.0.abs() > 10000.0 || t.1.abs() > 10000.0 || t.2.abs() > 10000.0;
    let router = GeometryRouter::with_scale(1.0); // model is in metres

    // Partial index (reproduces the browser's rtc=[0,0,0]): the late spatial
    // placements are unreachable, so the offset is missed.
    // The decoder reads the FULL content with the PARTIAL index, and the sample
    // window is the scanned head, which is what `resolve_partial_rtc` hands the
    // detector mid-scan: the whole buffer is resident, only the index and the
    // window stop at the scan point.
    let partial_index = build_entity_index(partial);
    let mut partial_decoder = EntityDecoder::with_index(&full, partial_index);
    let partial_rtc = router
        .detect_rtc_anchor_for_file(partial.as_bytes(), &mut partial_decoder)
        .unwrap_or((0.0, 0.0, 0.0));
    assert!(
        !is_large(partial_rtc),
        "partial index at the meta cut should MISS the late offset (the bug); got {partial_rtc:?}"
    );

    // Full index (the fix): the complete element -> site chain resolves, so the
    // ~8e6 m offset is recovered.
    let full_index = build_entity_index(&full);
    let mut full_decoder = EntityDecoder::with_index(&full, full_index);
    let full_rtc = router
        .detect_rtc_anchor_for_file(full.as_bytes(), &mut full_decoder)
        .expect("full-index detection returns an offset");
    assert!(
        is_large(full_rtc) && full_rtc.0.abs() > 1.0e6 && full_rtc.1.abs() > 1.0e6,
        "full-index detection must recover the national-grid offset (~1.66e6, 8.18e6); got {full_rtc:?}"
    );
}
