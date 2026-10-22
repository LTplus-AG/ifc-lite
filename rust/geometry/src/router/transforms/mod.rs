// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Placement and transformation: axis placement parsing, coordinate transforms, RTC offset.

pub(crate) mod mapped;
mod mesh_world;
pub(crate) use mesh_world::{WorldFrame, LARGE_MAPPED_ORIGIN_M};
pub(crate) mod operator;

mod parsers;

use super::GeometryRouter;
use crate::math::mat4;
use crate::placement;
use crate::{Mesh, Result, SubMeshCollection};
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use nalgebra::Matrix4;

/// A product's resolved, scaled `ObjectPlacement`: what placement reads from
/// source. `placed` is false for the identity fallback, which stamps no
/// instance transform.
pub(crate) struct ObjectPlacement {
    transform: Matrix4<f64>,
    placed: bool,
}

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

    /// The source half of placing a product's meshes: its `ObjectPlacement`,
    /// resolved and scaled to metres. A genuinely absent placement is the
    /// identity: the world frame IS the object frame, and placement still runs
    /// the ordinary world step over it (the #1474 frame capture, the model RTC
    /// shift and local-frame relativization), so consumers reconstruct
    /// `true_world = origin + position + rtc` uniformly. A present but
    /// unreadable placement chain is refused (#7877).
    pub(crate) fn resolve_object_placement(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<ObjectPlacement> {
        let Some(mut transform) = placement::resolve_object_placement(element, decoder)? else {
            return Ok(ObjectPlacement { transform: Matrix4::identity(), placed: false });
        };
        self.scale_transform(&mut transform);
        Ok(ObjectPlacement { transform, placed: true })
    }

    /// Place one mesh by a resolved [`ObjectPlacement`]; reads no source.
    ///
    /// Welds the source vertices FIRST (#4103). This is the last point at which
    /// the vertices are still in the object frame, and the weld keys on raw f32
    /// bits, so welding after the bake makes the merge depend on where the
    /// element sits and leaves two occurrences of one representation with
    /// different buffers. See `crate::mesh_weld`'s module doc.
    pub(crate) fn place_mesh(&self, mesh: &mut Mesh, placement: &ObjectPlacement) {
        crate::mesh_weld::weld_mesh(mesh);
        // Instancing: record the full (scaled) world placement on the mesh's
        // instance metadata BEFORE it is baked + RTC-folded by transform_mesh_world.
        // Only fires when processing already marked this mesh instanceable (so the
        // metadata exists); a no-op otherwise, keeping the flat path untouched.
        if placement.placed {
            if let Some(im) = mesh.instance_meta.as_mut() {
                im.transform = mat4::from_na(&placement.transform);
            }
        }
        self.transform_mesh_world(mesh, &placement.transform);
    }

    /// Place every sub-mesh by a resolved [`ObjectPlacement`]; reads no source.
    /// Placement is a rigid per-instance transform, kept OUT of the dedup cache so
    /// instances of one shared geometry land at their own positions.
    ///
    /// Welds each sub-mesh's source vertices first, for the reason
    /// [`Self::place_mesh`] gives. Every per-style channel (plain, layered,
    /// textured) converges here, so one loop covers them all, and the sub-mesh
    /// weld carries `SubMesh::uvs` through the same remap.
    pub(crate) fn place_sub_meshes(&self, sub_meshes: &mut SubMeshCollection, placement: &ObjectPlacement) {
        for sub in &mut sub_meshes.sub_meshes {
            crate::mesh_weld::weld_sub_mesh(sub);
        }
        // Instancing: record the per-element world placement on EACH sub-mesh's
        // instance metadata BEFORE it is baked into the vertices, mirroring
        // `place_mesh` for the single-mesh path. Without this, the sub-mesh
        // path (every multi-item element — all the Tekla steel: beams, plates,
        // assemblies) leaves `instance_meta.transform` at the IDENTITY placeholder,
        // so `collate_refs` computes rel_k = m_k · m_ref⁻¹ = identity for every
        // occurrence and they all stack on the first one. The flat path was
        // always correct (placement IS baked into the vertices below), so the
        // dedup made it look like repeated geometry was "missing".
        if placement.placed && instancing_enabled() {
            let row_major = mat4::from_na(&placement.transform);
            for sub in &mut sub_meshes.sub_meshes {
                if let Some(im) = sub.mesh.instance_meta.as_mut() {
                    im.transform = row_major;
                }
            }
        }
        for sub in &mut sub_meshes.sub_meshes {
            self.transform_mesh_world(&mut sub.mesh, &placement.transform);
        }
    }

    /// Get placement transform from element without applying it
    pub(super) fn get_placement_transform_from_element(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Matrix4<f64>> {
        Ok(placement::resolve_object_placement(element, decoder)?.unwrap_or_else(Matrix4::identity))
    }

    /// Exact counterpart to `resolve_scaled_placement`: refuses a world
    /// placement whose `ObjectPlacement` is present but cannot be resolved.
    pub fn resolve_scaled_placement_strict(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<[f64; 16]> {
        self.admit_placement_scale()?;
        if let Some(attr) = element.get(5).filter(|attr| !attr.is_null()) {
            if decoder.resolve_ref(attr)?.is_none() {
                return Err(crate::Error::geometry(format!(
                    "ObjectPlacement for #{} cannot be resolved",
                    element.id
                )));
            }
        }
        let mut transform = self.get_placement_transform_from_element(element, decoder)?;
        self.scale_transform(&mut transform);
        Ok(mat4::col_major_array(&transform))
    }

    /// Strict column-major local frame of an `IfcLinearPlacement` relative to
    /// its `PlacementRelTo`, in file units, with no identity fallback: a
    /// writer baking this frame must refuse a placement it cannot resolve
    /// (#7335). The sampling lives in [`crate::placement`].
    pub fn resolve_linear_placement_local_strict(
        &self,
        placement: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<[f64; 16]> {
        placement::linear::local_strict(placement, decoder)
    }
}
