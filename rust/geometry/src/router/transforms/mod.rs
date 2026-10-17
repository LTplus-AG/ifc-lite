// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Placement and transformation: axis placement parsing, coordinate transforms, RTC offset.

mod grid;
mod grid_frame;
mod linear;
pub(crate) mod mapped;
mod mesh_world;
pub(crate) use mesh_world::LARGE_MAPPED_ORIGIN_M;
pub(crate) mod operator;

mod parsers;
mod walk;

#[cfg(test)]
#[path = "placement_depth_tests.rs"]
mod placement_depth_tests;

use super::GeometryRouter;
use crate::math::mat4;
use crate::{Mesh, Result, SubMeshCollection};
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use nalgebra::Matrix4;

static LOCAL_FRAME_OVERRIDE: std::sync::atomic::AtomicI8 = std::sync::atomic::AtomicI8::new(-1);

/// Test/harness-only: force the target/env fallback on/off, or `None` for the
/// target default. A router constructed with an explicit frame policy does not
/// consult this process-global hook. Mirrors `rect_fast::param_set_enabled_override`. The
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
/// in. Env/cfg default read once and cached. An explicit per-router policy takes
/// precedence; otherwise [`local_frame_set_enabled_override`] selects this fallback.
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

impl GeometryRouter {
    pub(super) fn local_frame_enabled(&self) -> bool {
        self.local_frame_enabled.unwrap_or_else(local_frame_enabled)
    }

    /// Apply local placement transformation to mesh
    ///
    /// Welds the source vertices FIRST (#4103). This is the last point at which
    /// the vertices are still in the object frame, and the weld keys on raw f32
    /// bits, so welding after the bake makes the merge depend on where the
    /// element sits and leaves two occurrences of one representation with
    /// different buffers. See `crate::mesh_weld`'s module doc.
    pub(super) fn apply_placement(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
        mesh: &mut Mesh,
    ) -> Result<()> {
        crate::mesh_weld::weld_mesh(mesh);
        let placement_attr = match element.get(5) {
            Some(attr) if !attr.is_null() => attr,
            _ => {
                // No ObjectPlacement: the world frame IS the object frame, so
                // run the ordinary world step with an identity placement. This
                // both records the #1474 frame capture AND applies the model
                // RTC shift / local-frame relativization exactly like every
                // placed mesh — consumers (renderer, demesher session)
                // reconstruct `true_world = origin + position + rtc` uniformly
                // and must not special-case placement-less geometry.
                self.transform_mesh_world(mesh, &Matrix4::identity());
                return Ok(());
            }
        };

        let placement = match decoder.resolve_ref(placement_attr)? {
            Some(p) => p,
            None => {
                self.transform_mesh_world(mesh, &Matrix4::identity());
                return Ok(());
            }
        };

        let mut transform = self.get_placement_transform(&placement, decoder)?;
        self.scale_transform(&mut transform);
        // Instancing: record the full (scaled) world placement on the mesh's
        // instance metadata BEFORE it is baked + RTC-folded by transform_mesh_world.
        // Only fires when processing already marked this mesh instanceable (so the
        // metadata exists); a no-op otherwise, keeping the flat path untouched.
        if let Some(im) = mesh.instance_meta.as_mut() {
            im.transform = mat4::from_na(&transform);
        }
        self.transform_mesh_world(mesh, &transform);
        Ok(())
    }

    /// Apply the element's `ObjectPlacement` (scaled to metres) to every sub-mesh.
    /// Placement is a rigid per-instance transform, kept OUT of the dedup cache so
    /// instances of one shared geometry land at their own positions.
    /// (Moved here from `processing.rs` — placement logic lives with the other
    /// placement appliers, and `processing.rs` sits at its ratchet budget.)
    ///
    /// Welds each sub-mesh's source vertices first, for the reason
    /// [`Self::apply_placement`] gives. Every per-style channel (plain, layered,
    /// textured) converges here, so one loop covers them all, and the sub-mesh
    /// weld carries `SubMesh::uvs` through the same remap.
    pub(super) fn apply_submesh_placement(
        &self,
        sub_meshes: &mut SubMeshCollection,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<()> {
        for sub in &mut sub_meshes.sub_meshes {
            crate::mesh_weld::weld_sub_mesh(sub);
        }
        // ObjectPlacement translation is in file units (e.g. mm) but geometry is
        // scaled to metres, so the transform MUST be scaled to match.
        if let Some(placement_attr) = element.get(5) {
            if !placement_attr.is_null() {
                if let Some(placement) = decoder.resolve_ref(placement_attr)? {
                    let mut transform = self.get_placement_transform(&placement, decoder)?;
                    self.scale_transform(&mut transform);
                    // Instancing: record the per-element world placement on EACH sub-mesh's
                    // instance metadata BEFORE it is baked into the vertices, mirroring
                    // `apply_placement` for the single-mesh path. Without this, the sub-mesh
                    // path (every multi-item element — all the Tekla steel: beams, plates,
                    // assemblies) leaves `instance_meta.transform` at the IDENTITY placeholder,
                    // so `collate_refs` computes rel_k = m_k · m_ref⁻¹ = identity for every
                    // occurrence and they all stack on the first one. The flat path was
                    // always correct (placement IS baked into the vertices below), so the
                    // dedup made it look like repeated geometry was "missing".
                    if instancing_enabled() {
                        let row_major = mat4::from_na(&transform);
                        for sub in &mut sub_meshes.sub_meshes {
                            if let Some(im) = sub.mesh.instance_meta.as_mut() {
                                im.transform = row_major;
                            }
                        }
                    }
                    for sub in &mut sub_meshes.sub_meshes {
                        self.transform_mesh_world(&mut sub.mesh, &transform);
                    }
                    return Ok(());
                }
            }
        }
        // No resolvable ObjectPlacement: run the ordinary world step with an
        // identity placement — records the #1474 frame capture AND applies
        // the model RTC shift / relativization, mirroring the same branch in
        // `apply_placement` (single-mesh path).
        for sub in &mut sub_meshes.sub_meshes {
            self.transform_mesh_world(&mut sub.mesh, &Matrix4::identity());
        }
        Ok(())
    }

    /// Get placement transform from element without applying it
    pub(super) fn get_placement_transform_from_element(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Matrix4<f64>> {
        Ok(self.get_placement_transform_from_element_with_status(element, decoder)?.0)
    }

    /// Return the placement and whether the shared depth guard truncated its
    /// parent chain. Exact geometry descriptions must not report the partial
    /// transform as a complete world placement.
    pub(super) fn get_placement_transform_from_element_with_status(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<(Matrix4<f64>, bool)> {
        // Get ObjectPlacement (attribute 5)
        let placement_attr = match element.get(5) {
            Some(attr) if !attr.is_null() => attr,
            _ => return Ok((Matrix4::identity(), false)), // No placement
        };

        let placement = match decoder.resolve_ref(placement_attr)? {
            Some(p) => p,
            None => return Ok((Matrix4::identity(), false)),
        };

        let walk = self.get_placement_transform_with_depth(&placement, decoder, 0)?;
        Ok((walk.transform, walk.truncated))
    }

    /// Exact counterpart to `resolve_scaled_placement`: refuses a world
    /// placement when the shared reference-walk guard truncated its chain.
    pub fn resolve_scaled_placement_strict(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<[f64; 16]> {
        if let Some(attr) = element.get(5).filter(|attr| !attr.is_null()) {
            if decoder.resolve_ref(attr)?.is_none() {
                return Err(crate::Error::geometry(format!(
                    "ObjectPlacement for #{} cannot be resolved",
                    element.id
                )));
            }
        }
        let (mut transform, truncated) =
            self.get_placement_transform_from_element_with_status(element, decoder)?;
        if truncated {
            return Err(crate::Error::geometry(format!(
                "placement chain for #{} exceeded maximum depth",
                element.id
            )));
        }
        self.scale_transform(&mut transform);
        Ok(mat4::col_major_array(&transform))
    }

}
