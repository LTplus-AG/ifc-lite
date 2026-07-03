// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Host tests for [`super`] (the streaming pre-pass meta resolver). Split into
//! its own `*_tests.rs` file so the production module stays small; every case
//! drives the PUBLIC surface (`resolve_stream_meta` / `MetaMode` / `StreamMeta`
//! / `coord_is_large`) with crafted inputs — no wasm needed.

use super::*;
use ifc_lite_core::EntityDecoder;

// A minimal IFC4 fragment: metric project, an origin-local wall, and an
// IfcSite whose placement carries a large national-grid offset that only
// resolves once the FULL index is available. `\n` line breaks keep the
// spans byte-addressable for the scanner-free decoder path.
//
// The wall (#40) is placed at the LARGE world coordinate directly so the
// job-sample detector can find the shift when — and only when — its
// placement chain resolves.
const IFC: &str = "\
ISO-10303-21;
HEADER;
ENDSEC;
DATA;
#1=IFCPROJECT('p',$,'P',$,$,$,$,(#5),#8);
#5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#6,$);
#6=IFCAXIS2PLACEMENT3D(#7,$,$);
#7=IFCCARTESIANPOINT((0.,0.,0.));
#8=IFCUNITASSIGNMENT((#9));
#9=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#20=IFCSITE('site',$,$,$,$,#21,$,$,.ELEMENT.,$,$,$,$,$);
#21=IFCLOCALPLACEMENT($,#22);
#22=IFCAXIS2PLACEMENT3D(#23,$,$);
#23=IFCCARTESIANPOINT((800000.,900000.,0.));
#40=IFCWALL('wall',$,$,$,$,#41,#50,$,$);
#41=IFCLOCALPLACEMENT($,#42);
#42=IFCAXIS2PLACEMENT3D(#43,$,$);
#43=IFCCARTESIANPOINT((800000.,900000.,0.));
#50=IFCPRODUCTDEFINITIONSHAPE($,$,(#51));
#51=IFCSHAPEREPRESENTATION(#5,'Body','SweptSolid',(#52));
#52=IFCEXTRUDEDAREASOLID(#53,#56,#60,1.0);
#53=IFCRECTANGLEPROFILEDEF(.AREA.,$,#54,1.0,1.0);
#54=IFCAXIS2PLACEMENT2D(#55,$);
#55=IFCCARTESIANPOINT((0.,0.));
#56=IFCAXIS2PLACEMENT3D(#57,$,$);
#57=IFCCARTESIANPOINT((0.,0.,0.));
#60=IFCDIRECTION((0.,0.,1.));
ENDSEC;
END-ISO-10303-21;
";

fn wall_job(content: &[u8]) -> Job {
    // Locate the #40=IFCWALL span so we can hand the detector a real job.
    let needle = "#40=IFCWALL";
    let start = content
        .windows(needle.len())
        .position(|w| w == needle.as_bytes())
        .expect("wall present");
    // End at the terminating ';' of that line.
    let rel_end = content[start..]
        .iter()
        .position(|&b| b == b';')
        .expect("stmt end");
    (40, start, start + rel_end + 1, IfcType::IfcWall)
}

/// SmallFileSingle over the FULL index resolves the metric scale and the
/// large IfcSite/wall offset in one detect pass.
#[test]
fn small_file_single_resolves_scale_and_offset() {
    let content = IFC.as_bytes();
    let full_index = ifc_lite_core::build_entity_index(content);
    let mut decoder = EntityDecoder::with_index(content, full_index);
    let jobs = vec![wall_job(content)];

    let meta = resolve_stream_meta(
        MetaMode::SmallFileSingle,
        content,
        Some(1),
        None,
        &jobs,
        &mut decoder,
    );

    assert_eq!(meta.length_unit_scale, 1.0, "metric project → scale 1");
    assert!(meta.needs_shift, "800 km offset must trigger a shift");
    assert!(
        coord_is_large(meta.rtc_offset),
        "resolved RTC must exceed the large-coordinate threshold, got {:?}",
        meta.rtc_offset
    );
}

/// StreamingPartial: when the partial index is missing the wall's
/// placement chain (empty index → detect returns None), the 3-stage
/// ladder rebuilds the FULL index and recovers the large offset instead of
/// defaulting to no-shift.
#[test]
fn streaming_partial_full_index_fallback_recovers_offset() {
    let content = IFC.as_bytes();
    // A DELIBERATELY EMPTY partial index: the file-head scan hasn't reached
    // the wall/site placement rows yet, so the partial decoder resolves no
    // usable samples and detect_rtc_offset_from_jobs returns None.
    let partial_index = ifc_lite_core::EntityIndex::default();
    let mut decoder = EntityDecoder::with_index(content, partial_index);
    let jobs = vec![wall_job(content)];

    let meta = resolve_stream_meta(
        MetaMode::StreamingPartial,
        content,
        Some(1),
        None, // IfcSite not scanned yet → gates the full-index re-detect on
        &jobs,
        &mut decoder,
    );

    assert!(
        meta.needs_shift,
        "3-stage fallback must recover the large offset from the full index, got {:?}",
        meta.rtc_offset
    );
    assert!(coord_is_large(meta.rtc_offset));
}

/// StreamingPartial suppression: when the FIRST-pass detect SUCCEEDS on the
/// partial index (a genuine origin-local resolution) and the IfcSite has
/// been scanned, BOTH fallback arms are closed by that success — no
/// full-index re-detect, no placement-bounds scan — so the offset is the
/// partial pass's own no-shift, NOT the large centroid the fallback would
/// have produced. (The prior version passed `site_position = None`, which
/// forced the stage-2 gate open and so never exercised suppression.)
#[test]
fn streaming_partial_first_pass_success_suppresses_fallback() {
    // Wall made origin-local; the IfcSite placement (#23) stays at the large
    // national-grid coordinate, so `scan_placement_bounds` WOULD return a
    // large offset if the placement-bounds fallback were (wrongly) reached.
    let near = IFC.replace(
        "#43=IFCCARTESIANPOINT((800000.,900000.,0.));",
        "#43=IFCCARTESIANPOINT((1.,2.,0.));",
    );
    let content = near.as_bytes();
    let full = ifc_lite_core::build_entity_index(content);

    // A genuinely PARTIAL index: the wall's whole placement + representation
    // chain, the project/units, and the IfcSite ENTITY — but NOT the site's
    // forward-referenced placement (#21/#22/#23). The origin-local wall
    // resolves (first pass SUCCEEDS) and the site is present, so both
    // fallback arms are closed by the success itself, not by a None site.
    let partial = || {
        let mut p = ifc_lite_core::EntityIndex::default();
        for id in [1u32, 8, 9, 20, 40, 41, 42, 43, 50, 51] {
            if let Some(&s) = full.get(&id) {
                p.insert(id, s);
            }
        }
        p
    };
    let jobs = vec![wall_job(content)];

    // The first pass genuinely SUCCEEDS with a no-shift result, and the
    // placement-bounds fallback WOULD differ (large) if it were reached.
    let mut probe = EntityDecoder::with_index(content, partial());
    assert_eq!(
        GeometryRouter::with_scale(1.0).detect_rtc_offset_from_jobs(&jobs, &mut probe),
        Some((0.0, 0.0, 0.0)),
        "first pass must succeed on the partial index"
    );
    assert!(
        coord_is_large(ifc_lite_core::scan_placement_bounds(content).rtc_offset()),
        "placement-bounds fallback would shift (large) if taken"
    );

    let site = *full.get(&20).expect("site present");
    let mut decoder = EntityDecoder::with_index(content, partial());
    let meta = resolve_stream_meta(
        MetaMode::StreamingPartial,
        content,
        Some(1),
        Some((20, site.0, site.1)),
        &jobs,
        &mut decoder,
    );

    assert!(!meta.needs_shift, "partial-pass success suppresses the shift");
    assert_eq!(
        meta.rtc_offset,
        (0.0, 0.0, 0.0),
        "offset comes from the partial pass, not the placement-bounds fallback"
    );
}

// A MILLIMETRE model whose only geometry-job element (#40) carries NO
// representation, so `sample_element_translation` abstains and BOTH detect
// passes return None. The large world offset lives solely in the wall's
// placement point (#43), which `scan_placement_bounds` reads in raw FILE
// units — driving stage 3, the leg other tests only cover by suppression.
// That is the only IfcAxis2Placement3D, so the bounds box == that point.
const IFC_STAGE3: &str = "\
ISO-10303-21;
HEADER;
ENDSEC;
DATA;
#1=IFCPROJECT('p',$,'P',$,$,$,$,$,#8);
#8=IFCUNITASSIGNMENT((#9));
#9=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#40=IFCWALL('wall',$,$,$,$,#41,$,$,$);
#41=IFCLOCALPLACEMENT($,#42);
#42=IFCAXIS2PLACEMENT3D(#43,$,$);
#43=IFCCARTESIANPOINT((80000000.,90000000.,0.));
ENDSEC;
END-ISO-10303-21;
";

/// StreamingPartial stage 3: both detect passes abstain (no representation),
/// so resolution falls through to `scan_placement_bounds` and unit-scales
/// the raw FILE-unit bounds to metres. Asserts the RTC offset equals the
/// unit-scaled placement bounds exactly.
#[test]
fn streaming_partial_stage3_placement_bounds_fallback() {
    let content = IFC_STAGE3.as_bytes();
    let full_index = ifc_lite_core::build_entity_index(content);
    let mut decoder = EntityDecoder::with_index(content, full_index);
    let jobs = vec![wall_job(content)];

    let meta = resolve_stream_meta(
        MetaMode::StreamingPartial,
        content,
        Some(1),
        None,
        &jobs,
        &mut decoder,
    );

    // Millimetre project → a non-trivial (≠ 1.0) scale, so stage 3's
    // unit-scaling is actually exercised.
    let scale = meta.length_unit_scale;
    assert!((scale - 0.001).abs() < 1e-12, "expected mm scale, got {scale}");

    // Reproduce exactly what stage 3 computes: raw placement bounds times scale.
    let raw = ifc_lite_core::scan_placement_bounds(content).rtc_offset();
    assert_eq!(raw, (80_000_000.0, 90_000_000.0, 0.0), "raw mm bounds");
    let expected = (raw.0 * scale, raw.1 * scale, raw.2 * scale);
    assert_eq!(meta.rtc_offset, expected, "stage 3 unit-scales raw bounds");
    assert_ne!(meta.rtc_offset, raw, "scaling changed the value");
    assert!(meta.needs_shift);
}
