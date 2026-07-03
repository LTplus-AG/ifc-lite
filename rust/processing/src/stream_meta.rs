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
#[path = "stream_meta_tests.rs"]
mod tests;
