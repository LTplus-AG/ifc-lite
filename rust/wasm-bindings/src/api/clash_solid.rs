// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! WASM API: `clashIntersectionSolid` — the overlap VOLUME of one clashing
//! pair, as a solid the viewer can draw opaque while ghosting both parents
//! (the BIMcollab Zoom / Solibri presentation).
//!
//! On demand, one pair at a time. A model here yields 81 clashes and computing
//! every intersection during the detection sweep would be a large regression;
//! this is meant to be called when a clash row is selected, exactly like the
//! existing `@ifc-lite/clash/contact` path.
//!
//! Both operands must already be in the COMMON WORLD FRAME. For a federated
//! pair that means the models' world transforms are baked into `positions`
//! before the call — `ClashElement.transform` is NOT applied here and cannot be
//! detected as missing. `@ifc-lite/clash`'s wasm kernel already bakes it in
//! `WasmKernel.prepare`; a caller on the TS backend must do the same.
//!
//! The result is deliberately not always a solid. See
//! `ifc_lite_geometry::clash_solid` for why a shallow overlap is withheld
//! rather than reported wrong; when `isSolid` is false the viewer should keep
//! the contact marker it already draws.

use ifc_lite_geometry::{intersection_solid, DegenerateReason, IntersectionSolid, Mesh};
use wasm_bindgen::prelude::*;

/// The overlap solid of one clashing pair, or the reason there is none.
#[wasm_bindgen]
pub struct ClashIntersectionSolidJs {
    positions: Vec<f64>,
    indices: Vec<u32>,
    volume_m3: f64,
    is_solid: bool,
    reason: &'static str,
    thickness_m: f64,
    required_m: f64,
}

#[wasm_bindgen]
impl ClashIntersectionSolidJs {
    /// True when a trustworthy overlap solid was produced. When false, every
    /// geometry getter is empty and `degenerateReason` says why.
    #[wasm_bindgen(getter, js_name = isSolid)]
    pub fn is_solid(&self) -> bool {
        self.is_solid
    }

    /// `""` when `isSolid`, otherwise one of:
    /// - `"empty-operand"` — an operand had no triangles.
    /// - `"no-overlap"` — the exact intersection is empty. Covers a disjoint
    ///   pair AND a *touching* pair, including any graze below the kernel's
    ///   `2^-16 m ≈ 15.26 µm` snap grid (both faces snap flush).
    /// - `"below-kernel-resolution"` — the pair overlaps, but too shallowly for
    ///   the kernel to resolve as a solid rather than a coplanar contact. See
    ///   `thicknessM` / `requiredM`.
    /// - `"budget-exhausted"` — the escalation budget tripped; the arrangement
    ///   is partial and nothing about it is trustworthy.
    #[wasm_bindgen(getter, js_name = degenerateReason)]
    pub fn degenerate_reason(&self) -> String {
        self.reason.to_string()
    }

    /// Enclosed volume in m³. `0` when not a solid — check `isSolid` first;
    /// "no measurable overlap" and "an overlap of zero" are different claims.
    #[wasm_bindgen(getter, js_name = volumeM3)]
    pub fn volume_m3(&self) -> f64 {
        self.volume_m3
    }

    /// World-space vertex positions, flat `[x, y, z, …]`, f64.
    ///
    /// f64 rather than the f32 the rest of the mesh pipeline uses because the
    /// caller reports this solid's volume: the f32 round-trip costs ~1e-7
    /// relative, a thousand times the exactness the kernel actually delivers.
    /// Downcast to f32 at the GPU upload if the renderer wants it.
    #[wasm_bindgen(getter)]
    pub fn positions(&self) -> Vec<f64> {
        self.positions.clone()
    }

    /// Triangle indices into `positions / 3`.
    #[wasm_bindgen(getter)]
    pub fn indices(&self) -> Vec<u32> {
        self.indices.clone()
    }

    /// Triangle count of the solid; `0` when degenerate.
    #[wasm_bindgen(getter, js_name = triangleCount)]
    pub fn triangle_count(&self) -> u32 {
        (self.indices.len() / 3) as u32
    }

    /// For `"below-kernel-resolution"`: the overlap's measured thinnest extent,
    /// in metres. `0` otherwise. Useful to tell the user how shallow the clash
    /// is even though no solid can be drawn.
    #[wasm_bindgen(getter, js_name = thicknessM)]
    pub fn thickness_m(&self) -> f64 {
        self.thickness_m
    }

    /// For `"below-kernel-resolution"`: the depth this pair would have needed
    /// for the kernel to resolve a solid, in metres. `0` otherwise. Grows with
    /// distance from the world origin, as the kernel's own tolerance does.
    #[wasm_bindgen(getter, js_name = requiredM)]
    pub fn required_m(&self) -> f64 {
        self.required_m
    }
}

fn mesh_from(positions: &[f32], indices: &[u32]) -> Mesh {
    let mut m = Mesh::new();
    m.positions.extend_from_slice(positions);
    m.indices.extend_from_slice(indices);
    m
}

/// Compute the intersection solid of one clashing pair.
///
/// `positionsA` / `positionsB` are flat world-space XYZ; `indicesA` /
/// `indicesB` are flat triangle indices into their own operand.
///
/// ```javascript
/// const solid = clashIntersectionSolid(posA, idxA, posB, idxB);
/// if (solid.isSolid) {
///   draw(solid.positions, solid.indices, solid.volumeM3);
/// } else {
///   keepContactMarker(solid.degenerateReason); // e.g. "no-overlap"
/// }
/// solid.free();
/// ```
#[wasm_bindgen(js_name = clashIntersectionSolid)]
pub fn clash_intersection_solid(
    positions_a: &[f32],
    indices_a: &[u32],
    positions_b: &[f32],
    indices_b: &[u32],
) -> ClashIntersectionSolidJs {
    let a = mesh_from(positions_a, indices_a);
    let b = mesh_from(positions_b, indices_b);
    match intersection_solid(&a, &b) {
        IntersectionSolid::Solid {
            positions,
            indices,
            volume_m3,
        } => ClashIntersectionSolidJs {
            positions,
            indices,
            volume_m3,
            is_solid: true,
            reason: "",
            thickness_m: 0.0,
            required_m: 0.0,
        },
        IntersectionSolid::Degenerate(reason) => {
            let (name, thickness_m, required_m) = match reason {
                DegenerateReason::EmptyOperand => ("empty-operand", 0.0, 0.0),
                DegenerateReason::NoOverlap => ("no-overlap", 0.0, 0.0),
                DegenerateReason::BudgetExhausted => ("budget-exhausted", 0.0, 0.0),
                DegenerateReason::BelowKernelResolution {
                    thickness_m,
                    required_m,
                } => ("below-kernel-resolution", thickness_m, required_m),
            };
            ClashIntersectionSolidJs {
                positions: Vec::new(),
                indices: Vec::new(),
                volume_m3: 0.0,
                is_solid: false,
                reason: name,
                thickness_m,
                required_m,
            }
        }
    }
}
