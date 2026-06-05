// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression for georeferenced jitter (ISSUE_129). The world offset lives in
//! spatial-structure placements emitted LATE in the file (IfcSite at line
//! 202 339 of a 202 691 line model). `buildPrePassStreaming` emits its RTC meta
//! as soon as `RTC_SAMPLE_THRESHOLD` (50) geometry jobs are buffered — near the
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

use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner, IfcType};
use ifc_lite_geometry::GeometryRouter;

const FIXTURE: &str =
    "../../tests/models/ara3d/ISSUE_129_N1540_17_EXE_MOD_448200_02_09_11SMC_IGC_V17.ifc";
const RTC_SAMPLE_THRESHOLD: usize = 50; // mirrors gpu_meshes.rs

/// First `n` geometry-bearing jobs, in file order. Byte spans are valid in any
/// prefix of `content` that contains them.
fn geometry_jobs(content: &str, n: usize) -> Vec<(u32, usize, usize, IfcType)> {
    let mut jobs = Vec::new();
    let mut sc = EntityScanner::new(content);
    while let Some((id, ty, s, e)) = sc.next_entity() {
        if matches!(
            ty,
            "IFCWALL" | "IFCWALLSTANDARDCASE" | "IFCSLAB" | "IFCCOLUMN" | "IFCBEAM" | "IFCSTAIRFLIGHT"
        ) {
            jobs.push((id, s, e, IfcType::IfcWall));
            if jobs.len() >= n {
                break;
            }
        }
    }
    jobs
}

#[test]
fn streaming_partial_index_misses_late_site_offset_but_full_index_recovers_it() {
    let Ok(full) = std::fs::read_to_string(FIXTURE) else {
        eprintln!("skipping: fixture {FIXTURE} not present — run `pnpm fixtures`");
        return;
    };
    if full.starts_with("version https://git-lfs") {
        eprintln!("skipping: fixture is a Git LFS pointer — run `pnpm fixtures`");
        return;
    }

    let jobs = geometry_jobs(&full, RTC_SAMPLE_THRESHOLD);
    assert_eq!(jobs.len(), RTC_SAMPLE_THRESHOLD, "need the first 50 geometry jobs");

    // The streaming meta is emitted right after the 50th geometry job is
    // buffered, against the partial index built up to that scan point. Model
    // that exactly: content truncated at the end of the 50th geometry job.
    let cut = jobs.last().unwrap().2;
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
    let partial_index = build_entity_index(partial);
    let mut partial_decoder = EntityDecoder::with_index(partial, partial_index);
    let partial_rtc = router
        .detect_rtc_offset_from_jobs(&jobs, &mut partial_decoder)
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
        .detect_rtc_offset_from_jobs(&jobs, &mut full_decoder)
        .expect("full-index detection returns an offset");
    assert!(
        is_large(full_rtc) && full_rtc.0.abs() > 1.0e6 && full_rtc.1.abs() > 1.0e6,
        "full-index detection must recover the national-grid offset (~1.66e6, 8.18e6); got {full_rtc:?}"
    );
}
