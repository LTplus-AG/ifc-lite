// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Shared streaming pre-pass meta resolution.
//!
//! The browser pre-passes (`buildPrePassOnce` / `buildPrePassStreaming` in
//! `wasm-bindings`) each need the same bundle of load-time metadata before
//! workers can start meshing: the length/plane-angle unit scales, the RTC
//! (relative-to-centre) offset plus its needs-shift flag, and the building
//! rotation from `IfcSite`. This module is the single home for that
//! resolution logic so the three call sites can no longer drift.
//!
//! Only the RESOLUTION logic lives here — the wasm side keeps ownership of
//! WHEN the resulting [`StreamMeta`] is emitted. In particular the streaming
//! pre-pass still emits its `meta` event MID-SCAN (as soon as
//! `RTC_SAMPLE_THRESHOLD` geometry jobs are buffered, near the top of the
//! file) so workers spin up early — the ~17 s → ~3 s time-to-first-geometry
//! win on a 986 MB file. This helper does not change that timing; it only
//! factors out the two-vs-three-stage RTC ladder that the two emission sites
//! previously copied.
//!
//! Everything here COMPOSES the existing canonical primitives:
//! [`resolve_unit_scales`](crate::prepass::resolve_unit_scales),
//! [`EntityDecoder::seed_unit_scales`],
//! [`GeometryRouter::with_scale`],
//! [`GeometryRouter::detect_rtc_offset_from_jobs`],
//! [`GeometryRouter::detect_rtc_offset_with_fallback`], and the shared
//! [`LARGE_COORD_THRESHOLD_METERS`](ifc_lite_geometry::LARGE_COORD_THRESHOLD_METERS)
//! needs-shift constant.

use ifc_lite_core::{EntityDecoder, IfcType};
use ifc_lite_geometry::{GeometryRouter, LARGE_COORD_THRESHOLD_METERS};

/// A geometry job span as the pre-passes carry it: `(id, start, end, type)`.
pub type Job = (u32, usize, usize, IfcType);

/// Which RTC-detection ladder [`resolve_stream_meta`] should run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MetaMode {
    /// Streaming early-meta: the caller's `decoder` sees only a PARTIAL entity
    /// index (the file head scanned so far), so RTC detection runs the 3-stage
    /// fallback ladder — partial-index detect → full-index re-detect (triggered
    /// when no large offset was found AND either the `IfcSite` has not been
    /// scanned yet OR the partial index resolved no usable placement chain) →
    /// placement-bounds last resort — instead of silently defaulting to
    /// no-shift and rendering f32 vertex jitter on models whose world offset
    /// lives in late spatial placements.
    StreamingPartial,
    /// The caller's `decoder` already sees the FULL entity index (the
    /// small-file streaming tail, or the single-pass `buildPrePassOnce`), so a
    /// single [`GeometryRouter::detect_rtc_offset_with_fallback`] is correct.
    SmallFileSingle,
}

/// The load-time metadata both pre-passes emit before workers start meshing.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StreamMeta {
    /// IFC length unit → metres.
    pub length_unit_scale: f64,
    /// IFC plane-angle unit → radians.
    pub plane_angle_to_radians: f64,
    /// World-space RTC offset to subtract before the f32 cast.
    pub rtc_offset: (f64, f64, f64),
    /// True when [`Self::rtc_offset`] exceeds the large-coordinate threshold
    /// and the model must be re-based.
    pub needs_shift: bool,
    /// Z-rotation of the `IfcSite` placement, if any.
    pub building_rotation: Option<f64>,
}

/// True when any component of the offset exceeds the shared large-coordinate
/// threshold — the single needs-shift predicate, sharing
/// [`LARGE_COORD_THRESHOLD_METERS`] with the router's own sampling so both
/// sides make the identical decision.
#[inline]
pub fn coord_is_large(offset: (f64, f64, f64)) -> bool {
    offset.0.abs() > LARGE_COORD_THRESHOLD_METERS
        || offset.1.abs() > LARGE_COORD_THRESHOLD_METERS
        || offset.2.abs() > LARGE_COORD_THRESHOLD_METERS
}

/// Resolve the full [`StreamMeta`] bundle for one pre-pass emission point.
///
/// Seeds the caller's `decoder` with the resolved unit scales (so nothing
/// downstream re-pays the `IFCPROJECT` hunt) and leaves it seeded on return.
/// The caller owns emission — this only computes.
pub fn resolve_stream_meta(
    mode: MetaMode,
    content: &[u8],
    project_id: Option<u32>,
    site_position: Option<(u32, usize, usize)>,
    jobs: &[Job],
    decoder: &mut EntityDecoder,
) -> StreamMeta {
    // Unit scales via the shared resolver (handles a missing project-id hint
    // and partial-index chains internally), then seed the decoder.
    let unit_scales = crate::prepass::resolve_unit_scales(content, project_id, decoder);
    let length_unit_scale = unit_scales.length_unit_scale;
    decoder.seed_unit_scales(length_unit_scale, unit_scales.plane_angle_to_radians);

    let router = GeometryRouter::with_scale(length_unit_scale);

    let rtc_offset = match mode {
        MetaMode::StreamingPartial => resolve_partial_rtc(
            &router,
            content,
            site_position,
            jobs,
            decoder,
            length_unit_scale,
        ),
        MetaMode::SmallFileSingle => {
            router.detect_rtc_offset_with_fallback(jobs, decoder, content)
        }
    };
    let needs_shift = coord_is_large(rtc_offset);

    let building_rotation =
        site_position.and_then(|pos| resolve_building_rotation(pos, &router, decoder));

    StreamMeta {
        length_unit_scale,
        plane_angle_to_radians: unit_scales.plane_angle_to_radians,
        rtc_offset,
        needs_shift,
        building_rotation,
    }
}

/// The streaming early-meta 3-stage RTC ladder against a PARTIAL index.
///
/// 1. Detect from the buffered jobs on the partial index.
/// 2. If no large offset was found AND either the `IfcSite` hasn't been
///    scanned yet OR the partial index resolved NO usable placement samples,
///    re-detect against a freshly built FULL index. A successful "no shift"
///    (0,0,0) that DID resolve samples must not pay for this.
/// 3. Last resort: only when NO detection (partial or full) found any usable
///    placement translation, fall back to the raw placement-bounds scan
///    (unit-scaled to metres).
///
/// Mirrors the server needs-shift decision so a browser and the native
/// pipeline re-base a given model identically.
fn resolve_partial_rtc(
    router: &GeometryRouter,
    content: &[u8],
    site_position: Option<(u32, usize, usize)>,
    jobs: &[Job],
    decoder: &mut EntityDecoder,
    length_unit_scale: f64,
) -> (f64, f64, f64) {
    let detected_rtc = router.detect_rtc_offset_from_jobs(jobs, decoder);
    let mut rtc_offset = detected_rtc.unwrap_or((0.0, 0.0, 0.0));
    // True once ANY detection (partial OR the full re-detect below) resolved
    // usable placement samples — even if it concluded "no shift" (0,0,0). The
    // placement-bounds fallback must NOT override a successful "no shift".
    let mut detection_succeeded = detected_rtc.is_some();

    if !coord_is_large(rtc_offset) && (site_position.is_none() || !detection_succeeded) {
        let full_index = ifc_lite_core::build_entity_index(content);
        let mut full_decoder = EntityDecoder::with_index(content, full_index);
        if let Some(full_rtc) = router.detect_rtc_offset_from_jobs(jobs, &mut full_decoder) {
            // The full index resolved the placement chain — a successful
            // detection whether it shifts (large) or not.
            detection_succeeded = true;
            if coord_is_large(full_rtc) {
                rtc_offset = full_rtc;
            }
        }
    }

    if !detection_succeeded && !coord_is_large(rtc_offset) {
        let raw = ifc_lite_core::scan_placement_bounds(content).rtc_offset();
        // scan_placement_bounds reads raw IfcCartesianPoint values (FILE
        // units); the detection path is unit-scaled to metres.
        rtc_offset = (
            raw.0 * length_unit_scale,
            raw.1 * length_unit_scale,
            raw.2 * length_unit_scale,
        );
    }
    rtc_offset
}

/// Building rotation = Z-rotation of the `IfcSite` scaled placement, composing
/// the router's placement resolution with the shared rotation extractor.
fn resolve_building_rotation(
    site_pos: (u32, usize, usize),
    router: &GeometryRouter,
    decoder: &mut EntityDecoder,
) -> Option<f64> {
    let (site_id, start, end) = site_pos;
    let site_entity = decoder.decode_at_with_id(site_id, start, end).ok()?;
    let matrix = router.resolve_scaled_placement(&site_entity, decoder).ok()?;
    ifc_lite_geometry::rotation_angle_about_z(&matrix)
}

#[cfg(test)]
mod tests {
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

    /// StreamingPartial on an origin-local model must NOT invent a shift: a
    /// successful "no shift" detection stays (0,0,0).
    #[test]
    fn streaming_partial_origin_local_no_shift() {
        // Same fragment but with the wall placed AT the origin — detection
        // succeeds with (0,0,0) and no fallback may override it.
        let near = IFC.replace(
            "#43=IFCCARTESIANPOINT((800000.,900000.,0.));",
            "#43=IFCCARTESIANPOINT((1.,2.,0.));",
        );
        let content = near.as_bytes();
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

        assert!(!meta.needs_shift, "origin-local model needs no shift");
        assert_eq!(meta.rtc_offset, (0.0, 0.0, 0.0));
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
}
