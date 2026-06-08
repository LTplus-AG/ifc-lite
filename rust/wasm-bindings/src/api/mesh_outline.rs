// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! WASM API: mesh_outline_2d — winding-robust 2D footprint outline of a mesh,
//! for construction projection of non-extruded geometry (issue #979).
//!
//! Unlike normal-based silhouette extraction, this unions the projected
//! triangle areas, so the footprint is correct regardless of the source
//! mesh's (unreliable) triangle winding.

use ifc_lite_geometry::projection_outline::{mesh_outline_2d, ProjectionAxis};
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

/// Compute the winding-robust 2D footprint outline of a triangle mesh.
///
/// `positions` is flat XYZ; `indices` is flat triangle indices. `axis` is
/// 0/1/2 = x/y/z (the cut axis, WebGL Y-up). Returns `undefined` when the mesh
/// has no triangles or projects to nothing.
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
    axis: u8,
    flipped: bool,
) -> Option<MeshOutlineJs> {
    let axis = ProjectionAxis::from_u8(axis)?;
    let outline = mesh_outline_2d(positions, indices, axis, flipped)?;
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
    Some(MeshOutlineJs {
        contours,
        axis_min: outline.axis_min,
        axis_max: outline.axis_max,
    })
}
