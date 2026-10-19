// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Placement and transformation: axis placement parsing, coordinate transforms, RTC offset.

pub(crate) mod mapped;
mod mesh_world;
mod mesh_local;
pub(crate) use mesh_local::transform_mesh_local;
pub(crate) use mesh_world::{WorldFrame, LARGE_MAPPED_ORIGIN_M};
pub(crate) mod operator;

mod parsers;

use super::GeometryRouter;
use crate::math::mat4;
use crate::placement;
use crate::Result;
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

    /// Get placement transform from element without applying it
    pub(crate) fn get_placement_transform_from_element(
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
