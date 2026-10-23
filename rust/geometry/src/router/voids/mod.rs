// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Void (opening) subtraction: 3D CSG, AABB clipping, and triangle-box intersection.

use super::processing::SourceHygiene;
use super::GeometryRouter;
use crate::mesh::SubMeshCollection;
use crate::program::openings::execute::Execution;
use crate::{Mesh, Point3, Result, Vector3};
use ifc_lite_core::{DecodedEntity, EntityDecoder};
#[cfg(test)]
use nalgebra::Matrix3;
use rustc_hash::FxHashMap;

mod aabb_clip;
mod admission;
mod context;
pub use context::RectParam;
pub(crate) use context::{ParamRectCut, VoidContext};
mod batch_cutter;
pub(crate) mod bool2d_path;
mod coaxial_union;
mod cutter;
mod frame_rotate;
pub(crate) mod geom;
mod malformed_opening_repair;
mod opening_frame;
mod parity;
mod local_frame;
mod frame_snap;
pub(crate) mod hygiene;
pub(crate) mod prism_cut;
pub(crate) mod probe;
mod representation;
mod staged;
mod strategy;
mod post;
#[cfg(test)]
mod execution_tests_adapter;
mod synthesis;
pub use bool2d_path::take_bool2d_stats;
pub use prism_cut::{take_prism_defers, take_prism_stats};
#[cfg(test)]
mod reveal_tests;


pub(crate) use cutter::{CutterKind, OpeningFrame};
use geom::*;
use malformed_opening_repair::{
    cutter_is_closed_manifold,
    translate_cutter_mesh, world_host_bounds,
};
mod sweep;

/// Epsilon for normalizing direction vectors (guards against zero-length).
const NORMALIZE_EPSILON: f64 = 1e-12;
/// |cos| above which an authored cutter depth counts as the wall normal itself
/// (matches the vertical selector's 0.98 axis tolerance in `local_frame.rs`).
const WALL_NORMAL_DEPTH_COS: f64 = 0.98;
/// A mixed 2D + residual composition may inherit a small number of imperfect
/// IFC seams, but a large absolute increase signals that the second route tore
/// the re-extruded host. Below this floor the relative comparison still rules.
const MIXED_ROUTE_DEFECT_FLOOR: usize = 64;
const MIXED_ROUTE_DEFECT_GROWTH: usize = 4;
/// Maximum wrapper depth when drilling through mapped/boolean items to find an extrusion.
const MAX_EXTRUSION_EXTRACT_DEPTH: usize = 32;

impl GeometryRouter {
    /// Process element with void subtraction (openings)
    /// Process element with voids using optimized plane clipping
    ///
    /// This approach is more efficient than full 3D CSG for rectangular openings:
    /// 1. Get chamfered wall mesh (preserves chamfered corners)
    /// 2. For each opening, use optimized box cutting with internal face generation
    /// 3. Apply any clipping operations (roof clips) from original representation
    ///
    /// Process an element with void subtraction (openings).
    ///
    /// This function handles three distinct cases for cutting openings:
    ///
    /// 1. **Floor/Slab openings** (vertical Z-extrusion): Uses CSG with actual mesh geometry
    ///    because the XY footprint may be rotated relative to the slab orientation.
    ///
    /// 2. **Wall openings** (horizontal X/Y-extrusion, axis-aligned): Uses AABB clipping
    ///    for fast, accurate cutting of rectangular openings.
    ///
    /// 3. **Diagonal wall openings**: Uses AABB clipping without internal face generation
    ///    to avoid rotation artifacts.
    ///
    /// Reveal faces (inner surfaces of the opening holes) are generated as a
    /// post-clipping step for rectangular and diagonal openings.  For diagonal
    /// walls the geometry is computed in a rotated axis-aligned frame and
    /// rotated back, giving correct results for any wall orientation.
    ///
    /// Errors when the element's body items cannot share one f64 frame
    /// (#6349); [`Self::process_element_with_voids_parts`] keeps them.
    #[inline]
    pub fn process_element_with_voids(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
        void_index: &FxHashMap<u32, Vec<u32>>,
    ) -> Result<Mesh> {
        let parts = self.process_element_with_voids_parts(element, decoder, void_index)?;
        super::frame_parts::single_frame(element.id, parts)
    }

    /// [`Self::process_element_with_voids`] over the element's frame parts
    /// ([`Self::process_element_parts`]): each part is cut by the same openings,
    /// classified once. An ordinary element has exactly one part (#6349).
    pub fn process_element_with_voids_parts(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
        void_index: &FxHashMap<u32, Vec<u32>>,
    ) -> Result<Vec<Mesh>> {
        // The host walk, its void context and each part's cut: the common
        // program's void control. With no openings it is the plain walk.
        let opening_ids = void_index.get(&element.id).map(Vec::as_slice).unwrap_or_default();
        crate::program::GeometryProgram::voided(element, opening_ids).drain_parts(self, decoder)
    }
}

impl Execution {
    /// Apply a pre-built `VoidContext` to a single mesh.
    ///
    /// This is the cheap per-mesh half of void subtraction: it re-reads the
    /// mesh bounds (which differ per sub-mesh), extends rectangular openings
    /// along their extrusion axis so they fully penetrate the mesh, then
    /// subtracts every opening through the unified exact-kernel path (with the
    /// per-opening #635 AABB fallback). All the classification work has
    /// already been done by the owned host-opening control.
    ///
    /// `element_id` is the IFC product express ID of the host element. Any
    /// `BoolFailure` recorded by the inner CSG kernel is attributed to that
    /// product and stored on the router (drainable via
    /// [`GeometryRouter::take_csg_failures`]). The router's failure log is
    /// the only path failures reach the caller; `apply_void_context` itself
    /// always returns the (possibly un-cut) mesh.
    /// Apply a pre-built `VoidContext`, honouring the host's per-element local
    /// frame.
    ///
    /// When local-frame precision is on, the host mesh arrives stored relative
    /// to `mesh.origin` (small, f32-exact). The CSG must run with host AND
    /// cutters in that SAME frame, or the cutters (resolved in world coords)
    /// won't overlap the local host and every cut silently drops — the
    /// 222692→190201 regression from the first attempt. This wrapper strips the
    /// origin off the host (so the inner body works in a pure origin-0 local
    /// frame with no origin-aware-merge surprises), relativizes the cutters by
    /// the same origin, runs the CSG, then re-stamps the origin on the result so
    /// `world = origin + position` holds for the renderer.
    pub(crate) fn apply_void_context(
        &self,
        mut mesh: Mesh,
        ctx: &VoidContext,
        element_id: u32,
    ) -> Mesh {
        for strategy in strategy::HOST_STRATEGIES {
            if let Some(cut) = strategy.try_cut(self, &mesh, ctx, element_id) {
                return match cut.residual {
                    None => cut.mesh,
                    Some(residual) => self.apply_void_context(cut.mesh, &residual, element_id),
                };
            }
        }

        // WORLD-space host AABB for the per-host diagnostic (`bbox`), captured
        // HERE — before the local-frame branch below zeroes `mesh.origin` and
        // before the wall-local strategy rotates the mesh into its own frame.
        // On the wasm/local-frame default the host is stored relative to a
        // nonzero `mesh.origin` (world = origin + position), so bounds taken
        // after the clear would be local/near-zero and misdirect
        // `diagnose-geometry --product/--type` (the #1474 local-frame-consumer
        // bug class: every world-space reader must fold `MeshData.origin`). The
        // origin is folded in f64 so georeferenced hosts report true world
        // coords, then cast to the f32 diagnostic surface.
        let host_world_bounds = world_host_bounds(&mesh);

        let origin = mesh.origin;
        if origin == [0.0, 0.0, 0.0] && ctx.all_cutters_world_framed() {
            // Legacy/world frame on host AND cutters: no relativization needed.
            return self.cut_in_frame(mesh, ctx, element_id, host_world_bounds, true);
        }
        // Work entirely in the host's local frame (origin 0 on every operand).
        // `relativized_by` folds each cutter's OWN origin and subtracts the host
        // origin in f64, so a per-element local-frame opening lands at the host
        // precisely. This also covers a host that snapped to origin 0 while its
        // openings did not (origin == 0 but cutters are local-framed).
        mesh.origin = [0.0, 0.0, 0.0];
        let local_ctx = ctx.relativized_by(origin);
        let mut result =
            self.cut_in_frame(mesh, &local_ctx, element_id, host_world_bounds, true);
        // Keep an inner local-frame cut's translation when restoring this frame.
        result.origin = std::array::from_fn(|i| result.origin[i] + origin[i]);
        result
    }


}

impl GeometryRouter {
    /// Process an element into per-item sub-meshes with opening subtraction.
    ///
    /// Mirrors [`process_element_with_voids`] but preserves each
    /// `IfcShapeRepresentation` item as its own sub-mesh so that callers can
    /// look up a direct `IfcStyledItem` color per geometry item (e.g. the
    /// three extrusion layers of a multi-layer wall). The opening(s) are
    /// subtracted from each sub-mesh independently so that windows and doors
    /// cut through every material layer they intersect.
    ///
    /// Returns an empty collection when there are no openings (callers should
    /// fall back to [`process_element_with_submeshes`]) or when every
    /// sub-mesh is destroyed by void subtraction.
    pub fn process_element_with_submeshes_and_voids(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
        void_index: &FxHashMap<u32, Vec<u32>>,
    ) -> Result<SubMeshCollection> {
        // The common program's styled void entry. Layered single-solid path
        // first: slice the element's base mesh by its material-layer buildup
        // AFTER subtracting voids, one sub-mesh per layer keyed by IfcMaterial
        // id, so layers show up as individual colors even when the geometry
        // is a single swept solid. With no openings that is all. Otherwise
        // the host is the un-voided sub-mesh walk, which itself first tries
        // the layered slicing without voids (an element whose voided slicing
        // declined can still slice uncut, and then each layer is cut); its
        // void context is classified ONCE per element, not per sub-mesh.
        let opening_ids = void_index.get(&element.id).map(Vec::as_slice).unwrap_or_default();
        crate::program::GeometryProgram::voided_styled(element, opening_ids).drain_styled(self, decoder)
    }
}

#[cfg(test)]
mod flap_clip_tests;
#[cfg(test)]
mod batch_cutter_tests;
#[cfg(test)]
mod cut_effect_count_tests;
#[cfg(test)]
mod single_cut_outcome_tests;
#[cfg(test)]
mod program_tests;
