// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Placement and transformation: axis placement parsing, coordinate transforms, RTC offset.

mod grid;
mod linear;
mod mesh_world;
mod parsers;

use super::GeometryRouter;
use crate::{Mesh, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use nalgebra::Matrix4;

static LOCAL_FRAME_OVERRIDE: std::sync::atomic::AtomicI8 = std::sync::atomic::AtomicI8::new(-1);

/// Test/harness-only: force [`local_frame_enabled`] on/off, or `None` for the
/// target default. Mirrors `rect_fast::param_set_enabled_override`. The
/// mesh-output determinism manifest uses it to run native and wasm with the
/// SAME flag state (wasm defaults ON, native defaults OFF below), so the two
/// targets' outputs are comparable byte-for-byte.
pub fn local_frame_set_enabled_override(v: Option<bool>) {
    LOCAL_FRAME_OVERRIDE.store(
        match v {
            None => -1,
            Some(false) => 0,
            Some(true) => 1,
        },
        std::sync::atomic::Ordering::Relaxed,
    );
}

/// Whether per-element local-frame vertex precision is enabled.
///
/// When ON, `transform_mesh_world` stores positions relative to a per-element
/// f64 `origin` (so f32 coords stay element-small and never collapse to
/// degenerate fans at building/georef scale), and the void CSG runs in that same
/// local frame. Consumers reconstruct world = `MeshData.origin` + position.
/// Default is ON for wasm (the precision-critical viewer path, whose renderer
/// consumes `origin`) and OFF for native, where `IFC_LITE_LOCAL_FRAME=1` opts
/// in. Env/cfg default read once and cached; the
/// [`local_frame_set_enabled_override`] hook takes precedence on every call.
pub(crate) fn local_frame_enabled() -> bool {
    match LOCAL_FRAME_OVERRIDE.load(std::sync::atomic::Ordering::Relaxed) {
        0 => return false,
        1 => return true,
        _ => {}
    }
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        // The viewer (wasm) is the precision-critical target: building-scale f32
        // vertex storage collapses near-edges into fans, fixed by storing each
        // element relative to its AABB-centre origin (the renderer reconstructs
        // world = origin + position). Default ON for wasm. Native stays opt-in
        // (env) so server output + the cross-arch determinism snapshots remain
        // absolute-coord byte-identical; native consumers reconstruct from
        // MeshData.origin when they want the local frame.
        if cfg!(target_arch = "wasm32") {
            true
        } else {
            std::env::var("IFC_LITE_LOCAL_FRAME").is_ok()
        }
    })
}

/// GPU-instancing capture is ALWAYS ON (no flag). The pipeline attaches
/// [`crate::mesh::InstanceMeta`] (rep-identity + per-occurrence world transform)
/// to every instanceable mesh so the collator can group occurrences into unique
/// templates + per-instance transforms. This adds only metadata + an O(verts)
/// content hash — the flat geometry output (positions/normals/indices) is
/// unchanged, so determinism snapshots (which hash geometry, not `instance_meta`)
/// stay byte-identical, and the instancing renderer path is data-driven, not
/// toggled. (The old env flag never fired in wasm — `std::env` is empty there —
/// which is exactly the browser path that needs it.)
#[inline]
pub(crate) fn instancing_enabled() -> bool {
    true
}

/// Flatten a nalgebra `Matrix4<f64>` into a **column-major** `[f64; 16]` for the
/// [`EntityDecoder`] placement-transform memo. `Matrix4::as_slice` is already
/// column-major length 16, and [`Matrix4::from_column_slice`] reconstructs it
/// bit-for-bit (an f64 round-trip is exact), so the memo is byte-identical to
/// recomputing the transform. Distinct from [`mat4_to_row_major`], which is the
/// row-major GPU-instancing convention.
#[inline]
fn mat4_to_col_array(m: &Matrix4<f64>) -> [f64; 16] {
    *m.as_slice()
        .first_chunk::<16>()
        .expect("Matrix4<f64> as_slice is exactly 16 elements")
}

/// Flatten a column-major nalgebra `Matrix4<f64>` into a row-major `[f64; 16]`
/// (the [`crate::mesh::InstanceMeta`] convention; matches a GPU mat4 fed row-by-row).
pub(crate) fn mat4_to_row_major(m: &Matrix4<f64>) -> [f64; 16] {
    [
        m[(0, 0)], m[(0, 1)], m[(0, 2)], m[(0, 3)],
        m[(1, 0)], m[(1, 1)], m[(1, 2)], m[(1, 3)],
        m[(2, 0)], m[(2, 1)], m[(2, 2)], m[(2, 3)],
        m[(3, 0)], m[(3, 1)], m[(3, 2)], m[(3, 3)],
    ]
}

impl GeometryRouter {
    /// Apply local placement transformation to mesh
    pub(super) fn apply_placement(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
        mesh: &mut Mesh,
    ) -> Result<()> {
        let placement_attr = match element.get(5) {
            Some(attr) if !attr.is_null() => attr,
            _ => return Ok(()),
        };

        let placement = match decoder.resolve_ref(placement_attr)? {
            Some(p) => p,
            None => return Ok(()),
        };

        let mut transform = self.get_placement_transform(&placement, decoder)?;
        self.scale_transform(&mut transform);
        // Instancing: record the full (scaled) world placement on the mesh's
        // instance metadata BEFORE it is baked + RTC-folded by transform_mesh_world.
        // Only fires when processing already marked this mesh instanceable (so the
        // metadata exists); a no-op otherwise, keeping the flat path untouched.
        if let Some(im) = mesh.instance_meta.as_mut() {
            im.transform = mat4_to_row_major(&transform);
        }
        self.transform_mesh_world(mesh, &transform);
        Ok(())
    }

    /// Get placement transform from element without applying it
    pub(super) fn get_placement_transform_from_element(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Matrix4<f64>> {
        // Get ObjectPlacement (attribute 5)
        let placement_attr = match element.get(5) {
            Some(attr) if !attr.is_null() => attr,
            _ => return Ok(Matrix4::identity()), // No placement
        };

        let placement = match decoder.resolve_ref(placement_attr)? {
            Some(p) => p,
            None => return Ok(Matrix4::identity()),
        };

        // Recursively get combined transform from placement hierarchy
        self.get_placement_transform(&placement, decoder)
    }

    /// Recursively resolve placement hierarchy
    ///
    /// Uses a depth limit (100) to prevent stack overflow on malformed files
    /// with circular placement references or extremely deep hierarchies.
    pub(super) fn get_placement_transform(
        &self,
        placement: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Matrix4<f64>> {
        self.get_placement_transform_with_depth(placement, decoder, 0)
    }

    /// Internal helper with depth tracking to prevent stack overflow.
    /// Keep low for WASM — each frame uses ~2KB+ of stack with Matrix4<f64> locals.
    const MAX_PLACEMENT_DEPTH: usize = 32;

    pub(super) fn get_placement_transform_with_depth(
        &self,
        placement: &DecodedEntity,
        decoder: &mut EntityDecoder,
        depth: usize,
    ) -> Result<Matrix4<f64>> {
        // Depth limit to prevent stack overflow on circular references or deep hierarchies
        if depth > Self::MAX_PLACEMENT_DEPTH {
            return Ok(Matrix4::identity());
        }

        // Per-worker placement-transform memo. For a well-formed acyclic IFC
        // placement DAG the composed world transform is a pure function of
        // `placement.id`, so returning a cached result is byte-identical — and
        // it collapses the repeated work: storey/building placements shared by
        // thousands of elements compose once per worker, not once per element.
        // Only the REAL computed transforms below (local/linear/grid) are
        // cached, never the depth-guard/identity fallbacks, so a cache hit is
        // depth-independent (the depth guard only bites on chains deeper than
        // MAX_PLACEMENT_DEPTH or cycles, which never reach a cache write).
        if let Some(m) = decoder.get_placement_transform_cached(placement.id) {
            return Ok(Matrix4::from_column_slice(&m));
        }

        // IfcLinearPlacement is the IFC4x3 placement used by infrastructure
        // models to put products at a station along an alignment / gradient
        // curve. Without dedicated handling, every linearly-placed element
        // (signals, referents, signs on a railway alignment) falls back to
        // identity here and piles up at world origin — the exact symptom
        // reported in issue #859 on the `linear-placement-of-signal` fixture.
        //
        // Attribute layout (IFC4x3):
        //   0 PlacementRelTo (IfcObjectPlacement, optional) — same as IfcLocalPlacement
        //   1 RelativePlacement (IfcAxis2PlacementLinear) — required, samples the curve
        //   2 CartesianPosition (IfcAxis2Placement3D, optional) — pre-baked world fallback
        if placement.ifc_type == IfcType::IfcLinearPlacement {
            let result = self.resolve_linear_placement_with_depth(placement, decoder, depth)?;
            decoder.cache_placement_transform(placement.id, mat4_to_col_array(&result));
            return Ok(result);
        }

        // IfcGridPlacement positions a product on a grid-axis intersection
        // instead of a local coordinate system. Without dedicated handling
        // every grid-placed element (columns laid out on a structural grid)
        // falls back to identity here and stacks at the world origin — the
        // exact symptom reported in issue #883 on the `ifcgrid` fixture.
        if placement.ifc_type == IfcType::IfcGridPlacement {
            let result = self.resolve_grid_placement_with_depth(placement, decoder, depth)?;
            decoder.cache_placement_transform(placement.id, mat4_to_col_array(&result));
            return Ok(result);
        }

        if placement.ifc_type != IfcType::IfcLocalPlacement {
            return Ok(Matrix4::identity());
        }

        // Get parent transform first (attribute 0: PlacementRelTo)
        let parent_transform = if let Some(parent_attr) = placement.get(0) {
            if !parent_attr.is_null() {
                if let Some(parent) = decoder.resolve_ref(parent_attr)? {
                    self.get_placement_transform_with_depth(&parent, decoder, depth + 1)?
                } else {
                    Matrix4::identity()
                }
            } else {
                Matrix4::identity()
            }
        } else {
            Matrix4::identity()
        };

        // Get local transform (attribute 1: RelativePlacement)
        let local_transform = if let Some(rel_attr) = placement.get(1) {
            if !rel_attr.is_null() {
                if let Some(rel) = decoder.resolve_ref(rel_attr)? {
                    if rel.ifc_type == IfcType::IfcAxis2Placement3D {
                        self.parse_axis2_placement_3d(&rel, decoder)?
                    } else {
                        Matrix4::identity()
                    }
                } else {
                    Matrix4::identity()
                }
            } else {
                Matrix4::identity()
            }
        } else {
            Matrix4::identity()
        };

        // Compose: parent * local
        let result = parent_transform * local_transform;
        decoder.cache_placement_transform(placement.id, mat4_to_col_array(&result));
        Ok(result)
    }
}
