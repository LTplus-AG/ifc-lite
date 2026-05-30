// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! IfcAlignment centerline extraction for the 3D viewport.
//!
//! IfcAlignment carries its geometry in the `Axis` curve (an
//! `IfcAlignmentCurve` or an `IfcPolyline`), not a `Representation`. Rather
//! than render it as a triangulated ribbon mesh — which reads as a thin solid
//! strip and not the thin LINE users expect (matching IfcGrid axes and
//! IfcAnnotation curves) — we sample the alignment directrix into a flat
//! line-list vertex buffer and feed it through the renderer's existing
//! `uploadAnnotationLines3D` line pipeline.
//!
//! The output is `[x0,y0,z0, x1,y1,z1, …]` line-list pairs in the renderer's
//! **Y-up, RTC-subtracted, metres** world space — the exact frame the mesh
//! pipeline produces after its IFC Z-up → WebGL Y-up swap (see
//! `MeshDataJs::new` in `zero_copy.rs`), so alignment lines land on the same
//! ground as the terrain meshes.

use super::IfcAPI;
use ifc_lite_core::{
    build_entity_index, extract_length_unit_scale, EntityDecoder, EntityScanner, IfcType,
};
use ifc_lite_geometry::{AlignmentCurve, GeometryRouter};
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
    /// `renderer.uploadAnnotationLines3D(...)`.
    ///
    /// Returns an empty array when the file has no alignments (or none with a
    /// resolvable Axis curve), so the caller can clear the overlay cheaply.
    #[wasm_bindgen(js_name = parseAlignmentLines)]
    pub fn parse_alignment_lines(&self, content: String) -> js_sys::Float32Array {
        let verts = extract_alignment_line_vertices(&content);
        js_sys::Float32Array::from(&verts[..])
    }
}

/// Pure-Rust core (unit-testable without wasm-bindgen).
pub(crate) fn extract_alignment_line_vertices(content: &str) -> Vec<f32> {
    let entity_index = build_entity_index(content);
    let mut decoder = EntityDecoder::with_index(content, entity_index);

    // Unit scale (file units → metres) resolved the same way the mesh
    // pipeline does, so the alignment shares the model's scale.
    let mut project_scanner = EntityScanner::new(content);
    let mut unit_scale = 1.0_f64;
    while let Some((id, type_name, _, _)) = project_scanner.next_entity() {
        if type_name == "IFCPROJECT" {
            if let Ok(s) = extract_length_unit_scale(&mut decoder, id) {
                unit_scale = s;
            }
            break;
        }
    }

    // RTC offset (metres) — `detect_rtc_offset_from_first_element` returns
    // (0,0,0) for models within 10 km of the origin, so this is a no-op for
    // local files and a true shift for georeferenced infrastructure.
    let router = GeometryRouter::with_scale(unit_scale);
    let rtc = router.detect_rtc_offset_from_first_element(content, &mut decoder);

    let mut out: Vec<f32> = Vec::new();
    let mut scanner = EntityScanner::new(content);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if type_name != "IFCALIGNMENT" {
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
        append_alignment_segments(&alignment, unit_scale, rtc, &mut out);
    }
    out
}

/// Sample one alignment's centerline and append its line-list segments to
/// `out`, in renderer Y-up / RTC-subtracted / metres space.
fn append_alignment_segments(
    alignment: &AlignmentCurve,
    unit_scale: f64,
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
        // file units → metres
        let mx = o.x * unit_scale - rtc.0;
        let my = o.y * unit_scale - rtc.1;
        let mz = o.z * unit_scale - rtc.2;
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

/// Resolve an `IfcAlignment`'s directrix curve. IFC4X1 puts `Axis` at
/// attribute 7; some publishers reuse `Representation` (6) or hang it at 8.
/// Accept the first ref that resolves to an `IfcAlignmentCurve` or
/// `IfcPolyline` (the two `AlignmentCurve::parse` understands).
fn locate_axis_curve(
    entity: &ifc_lite_core::DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Option<ifc_lite_core::DecodedEntity> {
    let alignment_curve = IfcType::from_str("IFCALIGNMENTCURVE");
    for idx in [7usize, 8, 6] {
        let Some(attr) = entity.get(idx) else { continue };
        if attr.is_null() {
            continue;
        }
        if let Ok(Some(resolved)) = decoder.resolve_ref(attr) {
            if resolved.ifc_type == alignment_curve || resolved.ifc_type == IfcType::IfcPolyline {
                return Some(resolved);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    // Minimal IFC4X1 alignment: IfcAlignment whose Axis (attr 7) is a
    // 3-point IfcPolyline directrix (0,0,0)->(10,0,0)->(10,10,0), metres.
    const CONTENT: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('','',(''),(''),'','','');
FILE_SCHEMA(('IFC4X1'));
ENDSEC;
DATA;
#1=IFCCARTESIANPOINT((0.,0.,0.));
#2=IFCCARTESIANPOINT((10.,0.,0.));
#3=IFCCARTESIANPOINT((10.,10.,0.));
#4=IFCPOLYLINE((#1,#2,#3));
#10=IFCALIGNMENT('0aBcDeFgHiJkLmNoPqRsT0',$,'Test Alignment',$,$,$,$,#4,$);
ENDSEC;
END-ISO-10303-21;
"#;

    #[test]
    fn emits_line_list_for_polyline_alignment() {
        let verts = extract_alignment_line_vertices(CONTENT);
        assert!(!verts.is_empty(), "alignment must emit centerline vertices");
        // Flat [x,y,z] triples, even count of vertices (line-list pairs).
        assert_eq!(verts.len() % 3, 0, "vertices must be xyz triples");
        assert_eq!((verts.len() / 3) % 2, 0, "line-list = even vertex count");

        // First sample is the directrix start (0,0,0) → renderer (0,0,-0).
        assert!(verts[0].abs() < 1e-4, "start x≈0, got {}", verts[0]);
        assert!(verts[1].abs() < 1e-4, "start y(elev)≈0, got {}", verts[1]);
        assert!(verts[2].abs() < 1e-4, "start z≈0, got {}", verts[2]);

        // The 20 m polyline lies in the plan (z_ifc = 0) so every renderer-Y
        // (elevation) must stay 0, and the path must span ~10 m in renderer X
        // and ~10 m in renderer Z (plan Y, negated).
        let mut max_x = f32::MIN;
        let mut max_abs_z = 0.0_f32;
        for v in verts.chunks_exact(3) {
            assert!(v[1].abs() < 1e-3, "planar alignment elevation must be ~0");
            max_x = max_x.max(v[0]);
            max_abs_z = max_abs_z.max(v[2].abs());
        }
        assert!((max_x - 10.0).abs() < 0.5, "max renderer-x ≈10, got {max_x}");
        assert!((max_abs_z - 10.0).abs() < 0.5, "max |renderer-z| ≈10, got {max_abs_z}");
    }

    #[test]
    fn empty_for_no_alignment() {
        let none = "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n";
        assert!(extract_alignment_line_vertices(none).is_empty());
    }
}
