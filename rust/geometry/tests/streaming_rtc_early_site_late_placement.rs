// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression for georeferenced f32 collapse on the streaming-parallel path
//! when the IfcSite *entity* is early but its placement *transform* is
//! forward-referenced LATE.
//!
//! `streaming_rtc_late_site.rs` covers the case where the whole IfcSite (entity
//! AND placement) lands past the meta-emit cut, which `gpu_meshes.rs` rescued by
//! re-detecting against a full index "when no offset was found AND the IfcSite
//! hasn't been scanned yet" (`site_position.is_none()`).
//!
//! That gate is insufficient. A national-grid IFC export commonly emits the
//! `IfcSite` record near the TOP of the file (so `site_position` is already set
//! at the meta cut) while the `IfcAxis2Placement3D` LOCATION carrying the
//! multi-megametre offset is a high express-id defined far below it. The first 50
//! geometry elements reference that placement via PlacementRelTo, so the
//! element -> ... -> site chain still cannot resolve from the partial file-head
//! index: detection returns None. With the old gate the full-index re-detect was
//! skipped (because the site *was* scanned), and the path fell through to the
//! placement-bounds centroid — which averages the near-origin relative
//! placements against the lone far anchor and lands at ~half the true offset,
//! leaving the geometry stranded in the f32-collapse zone (~0.25 m ULP at a few
//! megametres). The browser confirms it as a `[stream] meta` RTC at ~half the
//! model's true world coordinates, so geometry sitting at ~N renders shifted to
//! ~N/2 and shatters into f32 noise.
//!
//! This pins the mechanism the corrected gate (`|| !detection_succeeded`) relies
//! on: at the meta cut the partial index MISSES the offset *even though the
//! IfcSite entity is present*, while the full index recovers it.

use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner, IfcType};
use ifc_lite_geometry::GeometryRouter;

/// A minimal, self-contained IFC where the IfcSite entity precedes the
/// meta-emit cut but its placement (and the national-grid point it carries) is
/// forward-referenced below the cut. No external fixture — always runs.
///
/// Layout (file order):
///   #1  IfcWall          -> placement #2, representation #9 (non-null)
///   #2  IfcLocalPlacement(PlacementRelTo = #4 (LATE), RelativePlacement = #3)
///   #3  IfcAxis2Placement3D(#7)            -- element-local origin
///   #7  IfcCartesianPoint(0,0,0)
///   #9  IfcProductDefinitionShape          -- only needs to be non-null
///   #10 IfcSite(ObjectPlacement = #4)       -- site ENTITY is early
///   == meta-emit cut here ==
///   #4  IfcLocalPlacement($, #5)            -- site placement, LATE
///   #5  IfcAxis2Placement3D(#6)
///   #6  IfcCartesianPoint(500000, 4500000, 0)  -- the offset, LATE
const IFC: &str = "\
ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCWALL('0WALL0000000000000001',$,'W',$,$,#2,#9,$);
#2=IFCLOCALPLACEMENT(#4,#3);
#3=IFCAXIS2PLACEMENT3D(#7,$,$);
#7=IFCCARTESIANPOINT((0.,0.,0.));
#9=IFCPRODUCTDEFINITIONSHAPE($,$,(#3));
#10=IFCSITE('0SITE0000000000000001',$,$,$,$,#4,$,$,.ELEMENT.,$,$,0.,$,$);
#4=IFCLOCALPLACEMENT($,#5);
#5=IFCAXIS2PLACEMENT3D(#6,$,$);
#6=IFCCARTESIANPOINT((500000.0,4500000.0,0.));
ENDSEC;
END-ISO-10303-21;
";

fn wall_jobs(content: &str) -> Vec<(u32, usize, usize, IfcType)> {
    let mut jobs = Vec::new();
    let mut sc = EntityScanner::new(content);
    while let Some((id, ty, s, e)) = sc.next_entity() {
        if ty == "IFCWALL" {
            jobs.push((id, s, e, IfcType::IfcWall));
        }
    }
    jobs
}

#[test]
fn partial_index_misses_offset_even_with_early_site_full_index_recovers_it() {
    let jobs = wall_jobs(IFC);
    assert_eq!(jobs.len(), 1, "fixture must yield exactly one wall job");

    // The streaming meta is emitted right after the sample threshold of geometry
    // jobs is buffered, against the partial index built up to that scan point.
    // Cut the content just before the late site placement (#4) is defined.
    let cut = IFC.find("#4=IFCLOCALPLACEMENT").expect("site placement marker");
    let partial = &IFC[..cut];

    // Distinguishing trait vs. ISSUE_129: the IfcSite ENTITY is already present
    // at the cut, so the old `site_position.is_none()` gate would (wrongly)
    // conclude "site scanned, no shift needed" and skip the full-index re-detect.
    assert!(
        partial.contains("IFCSITE"),
        "the IfcSite entity must precede the meta cut for this regression"
    );
    assert!(
        !partial.contains("#4=IFCLOCALPLACEMENT"),
        "the site PLACEMENT must be beyond the cut (forward reference)"
    );

    let is_large =
        |t: (f64, f64, f64)| t.0.abs() > 10000.0 || t.1.abs() > 10000.0 || t.2.abs() > 10000.0;
    let router = GeometryRouter::with_scale(1.0); // metres

    // Partial index at the meta cut: the forward-referenced site placement is
    // unreachable, so the element placement chain cannot resolve and detection
    // returns None (NOT a small "no shift" — the chain genuinely failed).
    let partial_index = build_entity_index(partial);
    let mut partial_decoder = EntityDecoder::with_index(partial, partial_index);
    let partial_rtc = router.detect_rtc_offset_from_jobs(&jobs, &mut partial_decoder);
    assert!(
        partial_rtc.is_none() || !is_large(partial_rtc.unwrap()),
        "partial index must MISS the late offset (the bug); got {partial_rtc:?}"
    );

    // Full index (the fix path): the complete wall -> site chain resolves, so the
    // national-grid offset is recovered and a shift is applied.
    let full_index = build_entity_index(IFC);
    let mut full_decoder = EntityDecoder::with_index(IFC, full_index);
    let full_rtc = router
        .detect_rtc_offset_from_jobs(&jobs, &mut full_decoder)
        .expect("full-index detection returns an offset");
    assert!(
        is_large(full_rtc),
        "full-index detection must recover the forward-referenced offset; got {full_rtc:?}"
    );
    assert!(
        (full_rtc.0 - 500000.0).abs() < 1.0 && (full_rtc.1 - 4500000.0).abs() < 1.0,
        "recovered offset must match the site placement, not a half-magnitude centroid; got {full_rtc:?}"
    );
}
