// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Structural grid (`IfcGrid` / `IfcGridAxis`) extraction for the 3D viewport.
//!
//! `IfcGrid` carries its axes as `IfcGridAxis` curves on attributes 7/8/9
//! (U/V/W axis lists), not as a triangulated `Representation`, so grids never
//! produce a mesh in the streaming batch mesher. They are also commonly placed
//! at survey / true-world coordinates (issue #945: a grid axis point reads at
//! `[294091.5, 0, 0]` mm, the grid `ObjectPlacement` resolving to ~−10 km),
//! while the mesh pipeline re-bases geometry into a unit-scaled, RTC-subtracted
//! "render frame". Resolving the grid placement naively therefore lands the
//! axes kilometres off the model.
//!
//! This module resolves each axis through the **same** transform pipeline the
//! meshes use — full `IfcLocalPlacement` chain (`resolve_scaled_placement`) +
//! `lengthUnitScale` + the same RTC offset
//! (`detect_rtc_offset_from_first_element`, gated at 10 km and above) — and
//! emits the endpoints in the renderer's **Y-up, RTC-subtracted, metres** world
//! space (the exact frame `MeshDataJs::new` produces after its IFC Z-up → WebGL
//! Y-up swap). Grids then line up with the streamed geometry by construction,
//! mirroring `alignment_lines.rs`.

use super::IfcAPI;
use ifc_lite_core::{build_entity_index, DecodedEntity, EntityDecoder, EntityScanner, IfcType};
use ifc_lite_geometry::GeometryRouter;
use wasm_bindgen::prelude::*;

// ═══════════════════════════════════════════════════════════════════════════
// PURE-RUST CORE (unit-testable without wasm-bindgen)
// ═══════════════════════════════════════════════════════════════════════════

/// One resolved grid axis: its tag plus the two endpoints of its curve, in the
/// renderer's Y-up / RTC-subtracted / metres render frame.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct GridAxis3D {
    pub grid_id: u32,
    pub axis_id: u32,
    pub tag: String,
    pub start: [f32; 3],
    pub end: [f32; 3],
}

/// Parse the file and resolve every `IfcGridAxis` into render-frame endpoints.
/// Returns an empty vec when the file has no grids (or none with a resolvable
/// axis curve), so callers can clear the overlay cheaply.
pub(crate) fn extract_grid_axes(content: &str) -> Vec<GridAxis3D> {
    let entity_index = build_entity_index(content);
    let mut decoder = EntityDecoder::with_index(content, entity_index);

    // Reuse the geometry router for both unit-scale and the placement resolver,
    // exactly like the mesh pipeline (and the symbolic builder).
    let router = GeometryRouter::with_units(content, &mut decoder);
    let unit_scale = router.unit_scale();

    // RTC offset (metres). `detect_rtc_offset_from_first_element` returns
    // (0,0,0) for models within 10 km of the origin, so this is a no-op for
    // local files and a true shift for georeferenced models — the same offset
    // the mesh pipeline applies.
    let rtc = router.detect_rtc_offset_from_first_element(content, &mut decoder);

    let mut out: Vec<GridAxis3D> = Vec::new();
    let mut scanner = EntityScanner::new(content);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if type_name != "IFCGRID" {
            continue;
        }
        let Ok(grid) = decoder.decode_at_with_id(id, start, end) else {
            continue;
        };
        // Full placement chain for the grid, translation scaled to metres.
        // Does NOT subtract RTC — we do that per point below.
        let matrix = router
            .resolve_scaled_placement(&grid, &mut decoder)
            .unwrap_or([
                1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
            ]);
        append_grid_axes(&grid, id, &mut decoder, unit_scale, &matrix, rtc, &mut out);
    }
    out
}

/// Walk an `IfcGrid`'s U/V/W axis lists (attributes 7, 8, 9), resolve each
/// `IfcGridAxis` curve's endpoints through the render-frame transform, and push
/// a [`GridAxis3D`] per axis.
fn append_grid_axes(
    grid: &DecodedEntity,
    grid_id: u32,
    decoder: &mut EntityDecoder,
    unit_scale: f64,
    matrix: &[f64; 16],
    rtc: (f64, f64, f64),
    out: &mut Vec<GridAxis3D>,
) {
    for axis_attr_idx in [7usize, 8, 9] {
        let Some(axes_attr) = grid.get(axis_attr_idx) else {
            continue;
        };
        let Ok(axes) = decoder.resolve_ref_list(axes_attr) else {
            continue;
        };
        for axis in axes {
            if axis.ifc_type != IfcType::IfcGridAxis {
                continue;
            }
            let axis_id = axis.id;
            let tag = axis
                .get(0)
                .and_then(|a| a.as_string())
                .unwrap_or("")
                .to_string();

            // AxisCurve at attribute 1 — in practice always an IfcPolyline.
            let Some(curve_ref) = axis.get_ref(1) else {
                continue;
            };
            let Ok(curve) = decoder.decode_by_id(curve_ref) else {
                continue;
            };
            let Some((p0, p1)) = sample_axis_endpoints(&curve, decoder) else {
                continue;
            };

            let start = to_render_frame(p0, unit_scale, matrix, rtc);
            let end = to_render_frame(p1, unit_scale, matrix, rtc);
            out.push(GridAxis3D {
                grid_id,
                axis_id,
                tag,
                start,
                end,
            });
        }
    }
}

/// First and last `IfcCartesianPoint` of an axis curve, in raw file units
/// (3D — the Z component is kept, unlike the 2D symbolic path). Returns `None`
/// for non-polyline curves or fewer than two points.
fn sample_axis_endpoints(
    curve: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Option<([f64; 3], [f64; 3])> {
    if curve.ifc_type != IfcType::IfcPolyline {
        return None;
    }
    let pts_attr = curve.get(0)?;
    let points = decoder.resolve_ref_list(pts_attr).ok()?;
    if points.len() < 2 {
        return None;
    }
    let extract = |pe: &DecodedEntity| -> Option<[f64; 3]> {
        if pe.ifc_type != IfcType::IfcCartesianPoint {
            return None;
        }
        let coords = pe.get(0)?.as_list()?;
        let x = coords.first()?.as_float()?;
        let y = coords.get(1)?.as_float()?;
        // 2D grid axis points are common; default Z to 0.
        let z = coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0);
        Some([x, y, z])
    };
    let first = extract(&points[0])?;
    let last = extract(&points[points.len() - 1])?;
    Some((first, last))
}

/// Transform a raw file-unit grid point into the renderer's Y-up /
/// RTC-subtracted / metres render frame.
///
/// `matrix` is the grid's scaled placement (column-major, translation already
/// in metres). The local point is scaled to metres before the matrix is
/// applied, matching the mesh path (`scale_mesh` then `transform_mesh_world`).
fn to_render_frame(
    p: [f64; 3],
    unit_scale: f64,
    matrix: &[f64; 16],
    rtc: (f64, f64, f64),
) -> [f32; 3] {
    let (x, y, z) = (p[0] * unit_scale, p[1] * unit_scale, p[2] * unit_scale);
    // Column-major 4×4 · (x, y, z, 1): element (row, col) at index col*4 + row.
    let wx = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
    let wy = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
    let wz = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
    // RTC subtraction (metres, same offset the meshes use).
    let rx = wx - rtc.0;
    let ry = wy - rtc.1;
    let rz = wz - rtc.2;
    // IFC Z-up → WebGL Y-up: (x, z, -y). Matches MeshDataJs::new so grids land
    // on the same ground as the streamed meshes.
    //
    // `+ 0.0` folds the -0.0 that negating a zero northing produces back to
    // +0.0, matching the symbolic overlay's `RenderFrameRebase::plan`
    // (`rust/processing/src/symbolic/rebase.rs`) on the sign of zero for this
    // axis. Only that: the two are NOT bit-identical in general, because
    // `plan` subtracts in f32 while this rounds once after subtracting in
    // f64, so they can differ by an ulp on the same coordinate. Sign of zero
    // is the part the symbolic side's pinned goldens record, and the part a
    // test on each side now holds.
    [rx as f32, rz as f32, -ry as f32 + 0.0]
}

// ═══════════════════════════════════════════════════════════════════════════
// JS-FRIENDLY TYPES
// ═══════════════════════════════════════════════════════════════════════════

/// One grid axis: tag + endpoints in renderer Y-up world space (metres).
#[wasm_bindgen]
pub struct GridAxisJs {
    grid_id: u32,
    axis_id: u32,
    tag: String,
    start: [f32; 3],
    end: [f32; 3],
}

#[wasm_bindgen]
impl GridAxisJs {
    /// Express ID of the owning `IfcGrid`.
    #[wasm_bindgen(getter, js_name = gridId)]
    pub fn grid_id(&self) -> u32 {
        self.grid_id
    }

    /// Express ID of the `IfcGridAxis`.
    #[wasm_bindgen(getter, js_name = axisId)]
    pub fn axis_id(&self) -> u32 {
        self.axis_id
    }

    /// Axis tag (e.g. `"A"`, `"1"`); empty string when unauthored.
    #[wasm_bindgen(getter)]
    pub fn tag(&self) -> String {
        self.tag.clone()
    }

    /// Start endpoint `[x, y, z]` in renderer Y-up world space (metres).
    #[wasm_bindgen(getter)]
    pub fn start(&self) -> js_sys::Float32Array {
        js_sys::Float32Array::from(&self.start[..])
    }

    /// End endpoint `[x, y, z]` in renderer Y-up world space (metres).
    #[wasm_bindgen(getter)]
    pub fn end(&self) -> js_sys::Float32Array {
        js_sys::Float32Array::from(&self.end[..])
    }
}

impl From<&GridAxis3D> for GridAxisJs {
    fn from(a: &GridAxis3D) -> Self {
        Self {
            grid_id: a.grid_id,
            axis_id: a.axis_id,
            tag: a.tag.clone(),
            start: a.start,
            end: a.end,
        }
    }
}

/// A collection of resolved grid axes.
#[wasm_bindgen]
pub struct GridAxisCollection {
    axes: Vec<GridAxis3D>,
}

#[wasm_bindgen]
impl GridAxisCollection {
    /// Number of grid axes.
    #[wasm_bindgen(getter)]
    pub fn length(&self) -> usize {
        self.axes.len()
    }

    /// Whether the collection is empty.
    #[wasm_bindgen(getter, js_name = isEmpty)]
    pub fn is_empty(&self) -> bool {
        self.axes.is_empty()
    }

    /// Get the axis at `index`. Returns `undefined` for out-of-bounds index.
    #[wasm_bindgen(js_name = getAxis)]
    pub fn get_axis(&self, index: usize) -> Option<GridAxisJs> {
        self.axes.get(index).map(GridAxisJs::from)
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// IfcAPI METHODS
// ═══════════════════════════════════════════════════════════════════════════

#[wasm_bindgen]
impl IfcAPI {
    /// Parse the file and return every `IfcGridAxis` as a flat `Float32Array`
    /// of 3D line-list vertices `[x0,y0,z0, x1,y1,z1, …]` (one segment per
    /// axis) in the renderer's Y-up world space (RTC-subtracted, metres). Feed
    /// straight to a line pipeline (e.g. `renderer.setLineOverlay('grid', …)`).
    ///
    /// Returns an empty array when the file has no grids, so the caller can
    /// clear the overlay cheaply.
    #[wasm_bindgen(js_name = parseGridLines)]
    pub fn parse_grid_lines(&self, content: String) -> js_sys::Float32Array {
        let axes = extract_grid_axes(&content);
        let mut verts: Vec<f32> = Vec::with_capacity(axes.len() * 6);
        for a in &axes {
            verts.extend_from_slice(&a.start);
            verts.extend_from_slice(&a.end);
        }
        js_sys::Float32Array::from(&verts[..])
    }

    /// Parse the file and return structured per-axis data (tag + endpoints) in
    /// the renderer's Y-up world space (RTC-subtracted, metres). Use this when
    /// you also need the axis tags (to render grid bubbles / labels).
    #[wasm_bindgen(js_name = parseGridAxes)]
    pub fn parse_grid_axes(&self, content: String) -> GridAxisCollection {
        GridAxisCollection {
            axes: extract_grid_axes(&content),
        }
    }
}

#[cfg(test)]
#[path = "grid_lines_tests.rs"]
mod tests;
