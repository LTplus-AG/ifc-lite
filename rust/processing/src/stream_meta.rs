// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Shared streaming pre-pass meta resolution.
//!
//! The browser pre-passes (`buildPrePassOnce` / `buildPrePassStreaming` in
//! `wasm-bindings`) each need the same bundle of load-time metadata before
//! workers can start meshing: the length/plane-angle unit scales, the RTC
//! (relative-to-centre) frame, and the building rotation from `IfcSite`.
//! This module is the single home for that resolution logic so the three
//! call sites can no longer drift.
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
//! [`GeometryRouter::detect_rtc_offset_with_fallback`], the shared
//! [`coord_is_large`](ifc_lite_core::limits::coord_is_large) predicate inside
//! the ladder, and [`MeshFrame::select`] for the frame the ladder's answer
//! turns into.

use crate::mesh_frame::MeshFrame;
use ifc_lite_core::limits::coord_is_large;
use ifc_lite_core::{EntityDecoder, IfcType};
use ifc_lite_geometry::GeometryRouter;

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
    /// The frame the workers mesh into. Carries the offset and the
    /// needs-shift decision as one value (see [`MeshFrame`]); the wire fields
    /// `rtcOffset` and `needsShift` are read off it.
    pub frame: MeshFrame,
    /// Z-rotation of the `IfcSite` placement, if any.
    pub building_rotation: Option<f64>,
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

    // Not drained: meshes nothing. Pinned by rust/geometry/tests/issue_3821_auxiliary_routers_mesh_nothing.rs.
    let router = GeometryRouter::with_scale(length_unit_scale);

    let detected = match mode {
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
    // No site tier here: the browser meshes in world axes and reports the
    // site rotation separately as `building_rotation`. The native pipeline
    // passes the site translation to the same selector, and that one argument
    // is the whole difference between the two frames.
    let frame = MeshFrame::select(None, detected);

    let building_rotation =
        site_position.and_then(|pos| resolve_building_rotation(pos, &router, decoder));

    StreamMeta {
        length_unit_scale,
        plane_angle_to_radians: unit_scales.plane_angle_to_radians,
        frame,
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
/// `None` only when every stage came back without a coordinate to judge;
/// `Some(RtcVerdict::Small)` is a detection that resolved samples and
/// concluded "no shift", which the later stages must not override.
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
) -> Option<ifc_lite_core::RtcVerdict> {
    let mut rtc_offset = router.detect_rtc_offset_from_jobs(jobs, decoder);
    let found_large = rtc_offset.is_some_and(coord_is_large);

    if !found_large && (site_position.is_none() || rtc_offset.is_none()) {
        let full_index = crate::build_entity_index_parallel(content);
        let mut full_decoder = EntityDecoder::with_index(content, full_index);
        if let Some(full_rtc) = router.detect_rtc_offset_from_jobs(jobs, &mut full_decoder) {
            // The full index resolved the placement chain: a successful
            // detection whether it shifts (large) or not. It replaces a
            // partial-pass "no data", and a partial-pass "no shift" only when
            // the full pass found the shift the partial index could not see.
            if coord_is_large(full_rtc) || rtc_offset.is_none() {
                rtc_offset = Some(full_rtc);
            }
        }
    }

    rtc_offset.map(ifc_lite_core::RtcVerdict::of_anchor).or_else(|| {
        // scan_placement_bounds reads raw IfcCartesianPoint values (FILE
        // units); rtc_offset applies the unit scale before the 10 km gate.
        ifc_lite_core::scan_placement_bounds(content)
            .rtc_offset(length_unit_scale)
    })
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
#[path = "stream_meta_tests.rs"]
mod tests;
