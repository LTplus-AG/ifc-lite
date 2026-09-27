// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! IfcAlignment centerline extraction for the 3D viewport.
//!
//! IFC4x1 `IfcAlignment` carries its geometry in the `Axis` curve (an
//! `IfcAlignmentCurve` or an `IfcPolyline`); IFC4x3 moved it into the
//! `Representation` (`'Axis'` → `IfcGradientCurve` /
//! `IfcSegmentedReferenceCurve`, `'FootPrint'` → 2D `IfcCompositeCurve`),
//! positioned by the alignment's `ObjectPlacement`. Rather
//! than render it as a triangulated ribbon mesh — which reads as a thin solid
//! strip and not the thin LINE users expect (matching IfcGrid axes and
//! IfcAnnotation curves) — we sample the alignment directrix into a flat
//! line-list vertex buffer and feed it through the renderer's existing
//! `setLineOverlay('alignment', …)` line pipeline.
//!
//! The output is `[x0,y0,z0, x1,y1,z1, …]` line-list pairs in renderer
//! **Y-up, metres** space. The explicit-frame binding uses the exact mesh
//! pre-pass RTC decision before the IFC Z-up → WebGL Y-up swap, so its lines
//! share the mesh frame. The legacy standalone binding detects RTC from the
//! whole source and can differ from an earlier streaming sample or federation
//! override.

use super::IfcAPI;
use ifc_lite_core::{
    build_entity_index, extract_length_unit_scale, EntityDecoder, EntityScanner,
};
use ifc_lite_geometry::{locate_axis_curve, AlignmentCurve, GeometryRouter};
use ifc_lite_processing::MeshFrame;
use wasm_bindgen::prelude::*;

/// Station spacing for centerline sampling, in file length units. Mirrors the
/// (now-removed) ribbon processor: 1 unit ≈ 1 m for metre files, with a hard
/// sample cap so sub-metre-unit files on long alignments fall back to a
/// coarser, length-proportional step instead of emitting millions of points.
const SAMPLE_STEP_FILE_UNITS: f64 = 1.0;
const MAX_SAMPLES: usize = 5_000;

#[wasm_bindgen]
impl IfcAPI {
    /// Parse the file and return every `IfcAlignment` directrix as a flat
    /// `Float32Array` of 3D line-list vertices `[x0,y0,z0, x1,y1,z1, …]` in
    /// the renderer's Y-up world space (RTC-subtracted, metres). Consecutive
    /// samples form line segments. Feed straight to
    /// `renderer.setLineOverlay('alignment', ...)`.
    ///
    /// Returns an empty array when the file has no alignments (or none with a
    /// resolvable Axis curve), so the caller can clear the overlay cheaply.
    #[wasm_bindgen(js_name = parseAlignmentLines)]
    pub fn parse_alignment_lines(&self, content: String) -> js_sys::Float32Array {
        let verts = extract_alignment_line_vertices(&content, None);
        js_sys::Float32Array::from(&verts[..])
    }

    /// Parse alignments in the exact RTC frame selected by the mesh pre-pass.
    #[wasm_bindgen(js_name = parseAlignmentLinesInFrame)]
    pub fn parse_alignment_lines_in_frame(
        &self,
        content: String,
        #[wasm_bindgen(unchecked_param_type = "RtcFrame")] frame: JsValue,
    ) -> Result<js_sys::Float32Array, JsValue> {
        let frame = super::overlay_frame::parse_overlay_frame(&frame)?;
        let verts = extract_alignment_line_vertices(&content, Some(frame));
        Ok(js_sys::Float32Array::from(&verts[..]))
    }
}

/// Pure-Rust core (unit-testable without wasm-bindgen).
pub(crate) fn extract_alignment_line_vertices(
    content: &str,
    frame: Option<MeshFrame>,
) -> Vec<f32> {
    let entity_index = build_entity_index(content);
    let mut decoder = EntityDecoder::with_index(content, entity_index);

    // Unit scale (file units → metres) resolved the same way the mesh
    // pipeline does, so the alignment shares the model's scale.
    let mut project_scanner = EntityScanner::new(content);
    let mut unit_scale = 1.0_f64;
    while let Some((id, type_name, _, _)) = project_scanner.next_entity() {
        if ifc_lite_core::keyword_eq(type_name, "IFCPROJECT") {
            if let Ok(s) = extract_length_unit_scale(&mut decoder, id) {
                unit_scale = s;
            }
            break;
        }
    }

    // RTC offset (metres): exact when supplied by the browser mesh pre-pass;
    // otherwise the standalone whole-source choice (#4665, #4799).
    // Not drained: meshes nothing. Pinned by rust/geometry/tests/issue_3821_auxiliary_routers_mesh_nothing.rs.
    let router = GeometryRouter::with_scale(unit_scale);
    let rtc = frame
        .unwrap_or_else(|| MeshFrame::for_overlay(&router, content.as_bytes(), &mut decoder))
        .rtc_offset();

    let mut out: Vec<f32> = Vec::new();
    let mut scanner = EntityScanner::new(content);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if !ifc_lite_core::keyword_eq(type_name, "IFCALIGNMENT") {
            continue;
        }
        let Ok(entity) = decoder.decode_at_with_id(id, start, end) else {
            continue;
        };
        let Some(axis) = locate_axis_curve(&entity, &mut decoder) else {
            continue;
        };
        let Ok(Some(alignment)) = AlignmentCurve::parse(&axis, &mut decoder) else {
            continue;
        };
        // Curve coordinates are relative to the alignment's ObjectPlacement
        // (metres, column-major); identity when it has none.
        let placement = router
            .resolve_scaled_placement(&entity, &mut decoder)
            .unwrap_or(IDENTITY);
        append_alignment_segments(&alignment, unit_scale, &placement, rtc, &mut out);
    }
    out
}

/// Sample one alignment's centerline and append its line-list segments to
/// `out`, in renderer Y-up / RTC-subtracted / metres space.
const IDENTITY: [f64; 16] = [
    1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
];

fn append_alignment_segments(
    alignment: &AlignmentCurve,
    unit_scale: f64,
    placement: &[f64; 16],
    rtc: (f64, f64, f64),
    out: &mut Vec<f32>,
) {
    let length = alignment.horizontal_length();
    if !(length.is_finite() && length > 0.0) {
        return;
    }

    let raw_count = ((length / SAMPLE_STEP_FILE_UNITS).ceil() as usize).max(1);
    let (step, count) = if raw_count > MAX_SAMPLES {
        (length / MAX_SAMPLES as f64, MAX_SAMPLES + 1)
    } else {
        (SAMPLE_STEP_FILE_UNITS, raw_count + 1)
    };

    // Collect sampled vertices in renderer space.
    let mut pts: Vec<[f32; 3]> = Vec::with_capacity(count);
    for i in 0..count {
        let station = (i as f64 * step).min(length);
        let o = alignment.evaluate(station).origin;
        // file units → metres, then the (already metre-scaled) placement.
        let (lx, ly, lz) = (o.x * unit_scale, o.y * unit_scale, o.z * unit_scale);
        let m = placement;
        let mx = m[0] * lx + m[4] * ly + m[8] * lz + m[12] - rtc.0;
        let my = m[1] * lx + m[5] * ly + m[9] * lz + m[13] - rtc.1;
        let mz = m[2] * lx + m[6] * ly + m[10] * lz + m[14] - rtc.2;
        // IFC Z-up → WebGL Y-up: (x, z, -y). Matches MeshDataJs::new so the
        // line lands on the same ground as the terrain meshes.
        pts.push([mx as f32, mz as f32, -my as f32]);
    }

    // Emit as a line-list: each adjacent pair is one segment.
    for w in pts.windows(2) {
        out.extend_from_slice(&w[0]);
        out.extend_from_slice(&w[1]);
    }
}
