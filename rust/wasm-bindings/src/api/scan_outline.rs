// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! WASM API: vector outlines traced from a slab of scan points (#6871).
//!
//! ```javascript
//! // planeXY: Float32Array [u0, v0, u1, v1, …], the slab points in plane coordinates
//! const outline = traceScanOutline(planeXY, { maxGap: 0.3 }, {
//!   origin: [0, 1.2, 0], uAxis: [1, 0, 0], vAxis: [0, 0, -1],
//! });
//! try {
//!   const coords = outline.coords();        // Float64Array, every ring concatenated
//!   const lengths = outline.ringLengths();  // Uint32Array, vertices per ring
//!   const world = outline.worldCoords();    // Float64Array [x, y, z, …] when a frame was given
//!   const diag = outline.diagnostics();     // { cellSize, cellCapHit, ringCount, … }
//! } finally {
//!   outline.free();
//! }
//! ```
//!
//! Rings carry no closing duplicate. Outer boundaries wind counter-clockwise
//! and holes clockwise (in plane coordinates); `shapeOffsets()` groups them as
//! `Contours2D` does, and `ringParents()` gives each ring's direct container.
//! See `ifc_lite_geometry::scan_outline` for the pipeline and its guarantees.

use ifc_lite_geometry::{trace_scan_outline, PlaneFrame, ScanOutline, ScanOutlineOptions};
use serde::Deserialize;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(typescript_type = "ScanOutlineOptionsJs")]
    pub type ScanOutlineOptionsJs;
    #[wasm_bindgen(typescript_type = "ScanOutlinePlaneFrameJs")]
    pub type ScanOutlinePlaneFrameJs;
    #[wasm_bindgen(typescript_type = "ScanOutlineDiagnosticsJs")]
    pub type ScanOutlineDiagnosticsJs;
}

#[wasm_bindgen(typescript_custom_section)]
const SCAN_OUTLINE_TYPES: &str = r#"
/** Every field is optional; absent or `undefined` means the default. Unknown fields and non-finite numbers are refused. Lengths in metres; pass plane coordinates local to the slab (f32 input). */
export interface ScanOutlineOptionsJs {
  /** Fixed cell edge; omit to pick it from the point density between minCellSize and maxCellSize. */
  cellSize?: number;
  /** Default 0.02, at least 0.001. */ minCellSize?: number;
  /** Default 0.05. */ maxCellSize?: number;
  /** Adaptive cells grow until the median occupied cell holds this many points. Default 6. */
  targetPointsPerCell?: number;
  /** Cell budget for the padded grid, from (2·pad + 1)² (81 with the defaults) up to 67108864. Default 16777216; hitting it sets diagnostics.cellCapHit. */
  maxCells?: number;
  /** Default 1. */ minPointsPerCell?: number;
  /** A cell is occupied from this fraction of the median occupied-cell count. Default 0.25. */
  noiseFraction?: number;
  /** Widest gap the closing bridges, about a wall thickness; clamped to 0.5. Default 0.3. */
  maxGap?: number;
  /** Speckle opening radius in cells (0 disables). Default 1. */ openRadiusCells?: number;
  /** Solid components below this area (m²) are dropped. Default 0.02. */ minComponentArea?: number;
  /** Enclosed holes below this area (m²) are filled. Default 0.5. */ minHoleArea?: number;
  /** Douglas-Peucker tolerance in cells. Default 1.5. */ simplifyToleranceCells?: number;
  /** Refit edges to the points. Default true. */ snap?: boolean;
  /** Evidence band beside an edge, in cells (at most 16). Default 3. */ snapDistanceCells?: number;
  /** Fewest points to refit an edge. Default 8. */ minSnapPoints?: number;
  /** Largest squaring move, in cells (at most 32). Default 4. */ maxVertexMoveCells?: number;
  /** Square edges to the dominant direction. Default true. */ square?: boolean;
  /** Default 3. */ squareAngleToleranceDeg?: number;
  /** Squares edges whose ends move at most this far. Default 0.03. */ squareOffsetTolerance?: number;
}
/** world = origin + u * uAxis + v * vAxis */
export interface ScanOutlinePlaneFrameJs {
  origin: [number, number, number];
  uAxis: [number, number, number];
  vAxis: [number, number, number];
}
export interface ScanOutlineDiagnosticsJs {
  inputPoints: number; usedPoints: number; nonFinitePoints: number; outlierPoints: number;
  cellSize: number; gridWidth: number; gridHeight: number;
  cellCapHit: boolean; maxGapClamped: boolean; countThreshold: number;
  /** f32 step at the largest input coordinate; `coordinatePrecisionDegraded` when above a tenth of a cell. Pass coordinates local to the slab. */
  coordinateSpacingMetres: number; coordinatePrecisionDegraded: boolean;
  occupiedCells: number; solidCells: number; componentsDropped: number; holesFilled: number;
  ringCount: number; outerRingCount: number; holeRingCount: number; vertexCount: number;
  simplifyReinsertions: number; snappedEdges: number;
  /** Degrees in [0, 90); absent when no edge was long enough to tell. */
  dominantAngleDeg?: number;
  squaredEdges: number; revertedMoves: number;
}
"#;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FrameInput {
    origin: [f64; 3],
    u_axis: [f64; 3],
    v_axis: [f64; 3],
}

/// The traced outline. Owns wasm memory: call `free()`.
#[wasm_bindgen]
pub struct ScanOutlineJs {
    outline: ScanOutline,
    frame: Option<PlaneFrame>,
}

#[wasm_bindgen]
impl ScanOutlineJs {
    /// Total number of rings (outer boundaries and holes).
    #[wasm_bindgen(getter, js_name = ringCount)]
    pub fn ring_count(&self) -> usize {
        self.outline.rings.len()
    }

    /// Number of outer boundaries.
    #[wasm_bindgen(getter, js_name = shapeCount)]
    pub fn shape_count(&self) -> usize {
        self.outline.shape_offsets.len()
    }

    /// Every ring's plane coordinates concatenated, `[u0, v0, u1, v1, …]`.
    pub fn coords(&self) -> js_sys::Float64Array {
        let flat: Vec<f64> = self.outline.rings.iter().flatten().flat_map(|p| [p[0], p[1]]).collect();
        js_sys::Float64Array::from(&flat[..])
    }

    /// Vertex count of each ring, in `coords()` order.
    #[wasm_bindgen(js_name = ringLengths)]
    pub fn ring_lengths(&self) -> js_sys::Uint32Array {
        let v: Vec<u32> = self.outline.rings.iter().map(|r| r.len() as u32).collect();
        js_sys::Uint32Array::from(&v[..])
    }

    /// Ring index at which each shape starts; entry `s` is shape `s`'s outer
    /// ring and the rings up to the next entry are its holes.
    #[wasm_bindgen(js_name = shapeOffsets)]
    pub fn shape_offsets(&self) -> js_sys::Uint32Array {
        let v: Vec<u32> = self.outline.shape_offsets.iter().map(|o| *o as u32).collect();
        js_sys::Uint32Array::from(&v[..])
    }

    /// The ring directly containing each ring (a hole's outer boundary, an
    /// island's hole), or `-1` at top level.
    #[wasm_bindgen(js_name = ringParents)]
    pub fn ring_parents(&self) -> js_sys::Int32Array {
        let v: Vec<i32> = self.outline.parents.iter().map(|p| p.map_or(-1, |p| p as i32)).collect();
        js_sys::Int32Array::from(&v[..])
    }

    /// Every ring mapped through the plane frame, `[x0, y0, z0, …]` in
    /// `coords()` order, or `undefined` when no frame was given.
    #[wasm_bindgen(js_name = worldCoords)]
    pub fn world_coords(&self) -> Option<js_sys::Float64Array> {
        let frame = self.frame.as_ref()?;
        let flat: Vec<f64> = self.outline.world_rings(frame).into_iter().flatten().flatten().collect();
        Some(js_sys::Float64Array::from(&flat[..]))
    }

    /// What the run did: cell size, cap hits, ring counts, repairs.
    pub fn diagnostics(&self) -> Result<ScanOutlineDiagnosticsJs, JsError> {
        let value = serde_wasm_bindgen::to_value(&self.outline.diagnostics)
            .map_err(|e| JsError::new(&format!("traceScanOutline: cannot encode diagnostics: {e}")))?;
        Ok(value.unchecked_into())
    }
}

/// Trace closed outlines from slab points given in plane coordinates.
///
/// THROWS on invalid options or plane frame (unknown field, non-finite or
/// out-of-range value). Points that are not finite are skipped and counted.
#[wasm_bindgen(js_name = traceScanOutline)]
pub fn trace_scan_outline_js(
    plane_xy: &[f32],
    options: Option<ScanOutlineOptionsJs>,
    plane_frame: Option<ScanOutlinePlaneFrameJs>,
) -> Result<ScanOutlineJs, JsError> {
    let opts: ScanOutlineOptions = match options {
        Some(value) => strict_from_js(JsValue::from(value)).map_err(|e| JsError::new(&format!("traceScanOutline: invalid options: {e}")))?,
        None => ScanOutlineOptions::default(),
    };
    let frame = match plane_frame {
        Some(value) => {
            let f: FrameInput = strict_from_js(JsValue::from(value))
                .map_err(|e| JsError::new(&format!("traceScanOutline: invalid plane frame: {e}")))?;
            Some(checked_frame(f).map_err(|e| JsError::new(&e))?)
        }
        None => None,
    };
    let outline = trace_scan_outline(plane_xy, &opts).map_err(|e| JsError::new(&format!("traceScanOutline: {e}")))?;
    Ok(ScanOutlineJs { outline, frame })
}

/// Deserialise a JS object so that `deny_unknown_fields` holds and the
/// documented contract is what actually happens: a field set to `undefined`
/// counts as absent (the `.d.ts` marks every option optional), and a
/// non-finite number is refused. `serde_wasm_bindgen` looks up only declared
/// field names (a misspelt `maxgap` would be ignored), and a detour through
/// `serde_json` alone turns NaN into `null`, which then reads as "use the
/// default", so the value is converted here first.
fn strict_from_js<T: serde::de::DeserializeOwned>(value: JsValue) -> Result<T, String> {
    let json = js_to_json(&value, "value", 0)?.unwrap_or(serde_json::Value::Null);
    serde_json::from_value(json).map_err(|e| e.to_string())
}

/// Plain-data conversion, depth-bounded; `None` for `undefined`.
fn js_to_json(value: &JsValue, path: &str, depth: usize) -> Result<Option<serde_json::Value>, String> {
    use serde_json::Value;
    if depth > 8 {
        return Err(format!("{path} is nested too deeply"));
    }
    if value.is_undefined() {
        return Ok(None);
    }
    if value.is_null() {
        return Ok(Some(Value::Null));
    }
    if let Some(b) = value.as_bool() {
        return Ok(Some(Value::Bool(b)));
    }
    if let Some(n) = value.as_f64() {
        return number_json(n, path).map(Some);
    }
    if let Some(s) = value.as_string() {
        return Ok(Some(Value::String(s)));
    }
    if js_sys::Array::is_array(value) {
        let items = js_sys::Array::from(value);
        let mut out = Vec::with_capacity(items.length() as usize);
        for (i, item) in items.iter().enumerate() {
            out.push(js_to_json(&item, &format!("{path}[{i}]"), depth + 1)?.unwrap_or(Value::Null));
        }
        return Ok(Some(Value::Array(out)));
    }
    if value.is_object() {
        let mut map = serde_json::Map::new();
        for entry in js_sys::Object::entries(value.unchecked_ref()).iter() {
            let pair = js_sys::Array::from(&entry);
            let key = pair.get(0).as_string().unwrap_or_default();
            if let Some(v) = js_to_json(&pair.get(1), &key, depth + 1)? {
                map.insert(key, v);
            }
        }
        return Ok(Some(Value::Object(map)));
    }
    Err(format!("{path} has an unsupported type"))
}

/// A JS number as JSON: integral values as integers (so `usize` fields
/// accept `16777216`), non-finite values refused.
fn number_json(n: f64, path: &str) -> Result<serde_json::Value, String> {
    if !n.is_finite() {
        return Err(format!("{path} must be a finite number, got {n}"));
    }
    if n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0 {
        return Ok(serde_json::Value::from(n as i64));
    }
    serde_json::Number::from_f64(n).map(serde_json::Value::Number).ok_or_else(|| format!("{path} is not a number"))
}

fn checked_frame(f: FrameInput) -> Result<PlaneFrame, String> {
    let all = f.origin.iter().chain(&f.u_axis).chain(&f.v_axis);
    if all.clone().any(|v| !v.is_finite()) {
        return Err("traceScanOutline: plane frame must be finite".into());
    }
    Ok(PlaneFrame { origin: f.origin, u_axis: f.u_axis, v_axis: f.v_axis })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_are_refused_when_non_finite_and_kept_integral_when_whole() {
        assert!(number_json(f64::NAN, "maxGap").unwrap_err().contains("maxGap must be a finite"));
        assert!(number_json(f64::INFINITY, "maxGap").is_err());
        assert_eq!(number_json(16777216.0, "maxCells").unwrap(), serde_json::json!(16777216));
        assert_eq!(number_json(0.3, "maxGap").unwrap(), serde_json::json!(0.3));
    }

    #[test]
    fn a_non_finite_frame_is_refused() {
        let bad = FrameInput { origin: [0.0, f64::NAN, 0.0], u_axis: [1.0, 0.0, 0.0], v_axis: [0.0, 1.0, 0.0] };
        assert!(checked_frame(bad).is_err());
        let good = FrameInput { origin: [1.0, 2.0, 3.0], u_axis: [1.0, 0.0, 0.0], v_axis: [0.0, 0.0, 1.0] };
        assert_eq!(checked_frame(good).unwrap().to_world([2.0, 5.0]), [3.0, 2.0, 8.0]);
    }
}
