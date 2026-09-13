// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! WASM API: mesh_outline_2d — winding-robust 2D footprint outline of a mesh,
//! for construction projection of non-extruded geometry (issue #979).
//!
//! Unlike normal-based silhouette extraction, this unions the projected
//! triangle areas, so the footprint is correct regardless of the source
//! mesh's (unreliable) triangle winding.

use ifc_lite_geometry::projection_outline::{
    mesh_outline_2d, NoOutline, ProjectionAxis, MAX_OVERLAY_TRIANGLES,
};
use wasm_bindgen::prelude::*;

/// A mesh's projected footprint outline.
///
/// Contours are closed rings in drawing 2D space (same basis as `projectTo2D`
/// in `@ifc-lite/drawing-2d`), WITHOUT a duplicated closing vertex.
/// `axisMin`/`axisMax` are the element's extent along the cut axis (world
/// units, not flip-adjusted) for band classification on the TS side.
#[wasm_bindgen]
pub struct MeshOutlineJs {
    contours: Vec<Vec<f32>>, // each: flat [u0, v0, u1, v1, …]
    axis_min: f32,
    axis_max: f32,
}

#[wasm_bindgen]
impl MeshOutlineJs {
    /// Element extent (min) along the cut axis, world units.
    #[wasm_bindgen(getter, js_name = axisMin)]
    pub fn axis_min(&self) -> f32 {
        self.axis_min
    }

    /// Element extent (max) along the cut axis, world units.
    #[wasm_bindgen(getter, js_name = axisMax)]
    pub fn axis_max(&self) -> f32 {
        self.axis_max
    }

    /// Number of boundary rings (outer + holes).
    #[wasm_bindgen(getter, js_name = contourCount)]
    pub fn contour_count(&self) -> usize {
        self.contours.len()
    }

    /// Ring `i` as a flat `[u0, v0, u1, v1, …]` array, or `undefined` if out of
    /// range. The ring is closed implicitly (connect the last point to the
    /// first).
    pub fn contour(&self, index: usize) -> Option<js_sys::Float32Array> {
        self.contours
            .get(index)
            .map(|c| js_sys::Float32Array::from(&c[..]))
    }
}

impl MeshOutlineJs {
    /// Rings as f64 `[x, y]` pairs, widened from the stored f32 flat form, for
    /// the 2D boolean bindings (`Contours2D::fromMeshOutline`). Not exported to
    /// JS — the accessor above is the JS-facing shape.
    pub(crate) fn rings_f64(&self) -> Vec<Vec<[f64; 2]>> {
        self.contours
            .iter()
            .map(|flat| {
                flat.chunks_exact(2)
                    .map(|p| [p[0] as f64, p[1] as f64])
                    .collect()
            })
            .collect()
    }
}

/// Compute the winding-robust 2D footprint outline of a triangle mesh.
///
/// `positions` is flat XYZ; `indices` is flat triangle indices. `axis` is
/// 0/1/2 = x/y/z (the cut axis, WebGL Y-up). Returns `undefined` when the mesh
/// has no triangles or projects to nothing: the element has no footprint.
///
/// THROWS when the outline was not computed: an `axis` outside 0..=2, or a
/// mesh with more valid projected triangles than the overlay budget (50 000).
/// The viewer's outline provider catches the throw and draws its TypeScript
/// silhouette for that mesh.
///
/// ```javascript
/// const outline = meshOutline2d(positions, indices, 1, false); // axis 1 = y
/// if (outline) {
///   for (let i = 0; i < outline.contourCount; i++) {
///     const ring = outline.contour(i); // Float32Array of [u0, v0, u1, v1, ...]
///   }
///   outline.free();
/// }
/// ```
#[wasm_bindgen(js_name = meshOutline2d)]
pub fn mesh_outline_2d_js(
    positions: &[f32],
    indices: &[u32],
    axis: f64,
    flipped: bool,
) -> Result<Option<MeshOutlineJs>, JsError> {
    let Some(axis) = axis_from_js(axis) else {
        return Err(JsError::new(&format!("meshOutline2d: axis must be 0, 1 or 2, got {axis}")));
    };
    let outline = match mesh_outline_2d(positions, indices, axis, flipped) {
        Ok(outline) => outline,
        Err(NoOutline::Empty) => return Ok(None),
        Err(NoOutline::OverBudget { triangles }) => {
            return Err(JsError::new(&format!(
                "meshOutline2d: {triangles} triangles exceed the {MAX_OVERLAY_TRIANGLES}-triangle overlay budget; outline not computed"
            )));
        }
    };
    let contours = outline
        .contours
        .into_iter()
        .map(|ring| {
            let mut flat = Vec::with_capacity(ring.len() * 2);
            for p in ring {
                flat.push(p[0]);
                flat.push(p[1]);
            }
            flat
        })
        .collect();
    Ok(Some(MeshOutlineJs {
        contours,
        axis_min: outline.axis_min,
        axis_max: outline.axis_max,
    }))
}

/// The JS `axis` number as a [`ProjectionAxis`], or `None` unless it is
/// exactly 0, 1 or 2. Taken as `f64` because a `u8` parameter is wrapped by
/// the wasm ABI before any check runs (`256` and `NaN` arrive as `0`, `1.5`
/// as `1`), which computes an outline for an axis the caller never named.
fn axis_from_js(axis: f64) -> Option<ProjectionAxis> {
    if !(0.0..=2.0).contains(&axis) || axis.fract() != 0.0 {
        return None;
    }
    ProjectionAxis::from_u8(axis as u8)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// meshOutline2d took `axis: u8`, and the wasm ABI wrapped the JS number
    /// before any check: on the previous build 256, NaN and Infinity computed
    /// an X outline and 257 and 1.5 a Y outline (#4644). Mutation: return
    /// `ProjectionAxis::from_u8(axis as u8)` without the check, and NaN, 1.5,
    /// 0.5 and -1 decode to an axis.
    #[test]
    fn only_an_exact_0_1_or_2_decodes_to_an_axis() {
        assert_eq!(axis_from_js(0.0), Some(ProjectionAxis::X));
        assert_eq!(axis_from_js(1.0), Some(ProjectionAxis::Y));
        assert_eq!(axis_from_js(2.0), Some(ProjectionAxis::Z));
        for refused in [3.0, 256.0, -1.0, 1.5, 0.5, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert_eq!(axis_from_js(refused), None, "axis {refused}");
        }
    }
}
