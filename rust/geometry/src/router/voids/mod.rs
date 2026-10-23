// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Void (opening) subtraction: 3D CSG, AABB clipping, and triangle-box intersection.

use super::processing::SourceHygiene;
use super::GeometryRouter;
use crate::csg::ClippingProcessor;
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
    cutter_is_closed_manifold, opening_obb_if_malformed,
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
            return self.apply_void_context_inner(mesh, ctx, element_id, host_world_bounds, true);
        }
        // Work entirely in the host's local frame (origin 0 on every operand).
        // `relativized_by` folds each cutter's OWN origin and subtracts the host
        // origin in f64, so a per-element local-frame opening lands at the host
        // precisely. This also covers a host that snapped to origin 0 while its
        // openings did not (origin == 0 but cutters are local-framed).
        mesh.origin = [0.0, 0.0, 0.0];
        let local_ctx = ctx.relativized_by(origin);
        let mut result =
            self.apply_void_context_inner(mesh, &local_ctx, element_id, host_world_bounds, true);
        // Keep an inner local-frame cut's translation when restoring this frame.
        result.origin = std::array::from_fn(|i| result.origin[i] + origin[i]);
        result
    }

    // `allow_local_frame` (#3641) caps local-frame recursion.
    #[allow(clippy::too_many_arguments)]
    fn apply_void_context_inner(
        &self,
        mesh: Mesh,
        ctx: &VoidContext,
        element_id: u32,
        host_bounds_capture: ((f32, f32, f32), (f32, f32, f32)),
        allow_local_frame: bool,
    ) -> Mesh {
        // Capture the input triangle count so the per-host diagnostic can flag
        // the "cuts attempted but produced no change" case — the silent-no-op
        // signature when an opening box doesn't intersect the host mesh. The
        // WORLD-space host AABB (`host_bounds_capture`) is passed in from
        // `apply_void_context` (captured before the origin clear / frame
        // rotation), not recomputed here from the possibly local-framed `mesh`.
        let tris_before = mesh.triangle_count();
        if ctx.is_noop() {
            return mesh;
        }
        let original_host = mesh.clone(); // stray-shard sweep parity reference

        // LOCAL-FRAME CUT (issue #1167): a vertical wall rotated in plan is cut
        // in its own axis-aligned, origin-centred frame — where the exact
        // subtract is clean and f32-precise — then the result is rotated back.
        // The world-space tilted cut at large coordinates over-cuts and
        // fragments badly. Scoped to plan-rotated walls; everything else falls
        // through to the world path unchanged. Gated on `allow_local_frame`.
        let [wall_local, rect_fast] = strategy::INNER_STRATEGIES;
        if allow_local_frame {
            if let Some(cut) = wall_local.try_cut(self, &mesh, ctx, element_id, host_bounds_capture, tris_before) {
                return cut;
            }
        }

        let clipper = ClippingProcessor::new();
        // Every exit drains this clipper's reached failures exactly once,
        // including an unwind before the ordinary drain below.
        let kernel_failures = self.capture_failures(&clipper, element_id);
        // ROOT-CAUSE FIX (issue #1007, host #1112): correct f32 facet jitter on
        // the host triangle soup BEFORE the exact-kernel cut. A faceted-BREP
        // roof slope authored as ONE flat plane comes back from the f32 import
        // with adjacent facets ~0.09° non-coplanar. That jitter (a) splits the
        // slope into many one-triangle plane buckets in `consolidate_coplanar`
        // — a single-triangle bucket bypasses the CDT and is emitted as a 25:1
        // far-corner sliver fan — and (b) blocks clean coalescing of the cut
        // hole. Welding near-coplanar adjacent facets (≤0.15°, well below any
        // real roof pitch) to a single least-squares plane makes the slope
        // EXACTLY coplanar, so the cut emits one CDT-refined region (rim sliver
        // gone) with a clean opening hole. Deterministic + watertight + grid-
        // snapped; a no-op for already-planar extrusion hosts. The ordinary
        // router has already removed sub-grid SOURCE triangles before placement;
        // this whole-position-buffer weld does not replace that hygiene step or
        // promise clean output. Fresh cut candidates require path-specific
        // downstream handling (#4797).
        let mut result = crate::facet_weld::weld_near_coplanar_facets(&mesh);

        // ANALYTIC FAST PATH: an axis-aligned box host whose openings are ALL
        // axis-aligned rectangular through-cuts is subtracted analytically
        // (`rect_fast`), skipping the exact mesh-arrangement kernel — the
        // ~80 s memory-bandwidth-bound void-cut window's dominant cost. Pure
        // optimization: any precondition miss (non-box host, mixed/non-rect
        // openings, near-edge feature) returns `None` and the host falls through
        // to the exact path below unchanged. Fired BEFORE the dense-host
        // subdivision (that workaround is only for the exact kernel).
        if let Some(fast) = rect_fast.try_cut(self, &result, ctx, element_id, host_bounds_capture, tris_before) {
            return fast;
        }

        // OPENING-DENSE HOST REFINEMENT: when many openings target the same host
        // (a window wall is usually 2 big face-triangles per side), every cut's
        // intersection segments pile onto those few triangles — the exact
        // arrangement then re-triangulates a single triangle carrying dozens of
        // constraints (O(k²)), and the batched N-ary subtract leaves unrecovered
        // constraints and degrades to the O(N²) sequential path. Pre-subdividing
        // the host spreads the segments across many small triangles (small k each)
        // so the batched cut recovers. `consolidate_coplanar` re-triangulates each
        // coplanar group afterwards, so the temporary interior vertices don't
        // bloat the final mesh. Levels are scaled to opening count and capped.
        let n_openings = ctx.merged_openings.len();
        if n_openings >= 8 {
            // Just enough subdivision that each host triangle carries only a few
            // intersection segments, so the batched N-ary subtract RECOVERS rather
            // than degrading to the O(N²) sequential path — that recovery is the
            // win (≈10× on the densest walls), not the per-triangle segment count
            // itself. Over-subdividing is counter-productive: the extra triangles
            // cost more in the arrangement than the spreading saves (level 3 was
            // ~3× slower than level 1 on a 14-opening wall). Aim for ≳ a handful of
            // host triangles per opening, capped at 2 levels.
            let host_tris = result.triangle_count().max(1);
            let target = 4 * n_openings;
            let mut levels = 0usize;
            while host_tris * (1usize << (2 * (levels + 1))) < target && levels < 2 {
                levels += 1;
            }
            // A COARSE host (a box wall is ~12 triangles) still needs one split
            // even when the next level would overshoot the target; an ALREADY-dense
            // host (e.g. a faceted-BREP wall whose triangle count already meets the
            // target) is left untouched — extra geometry there only slows the cut.
            if levels == 0 && host_tris < target {
                levels = 1;
            }
            if levels > 0 {
                result = result.subdivided(levels);
            }
        }

        let (wall_min_f32, wall_max_f32) = result.bounds();
        let wall_min = Point3::new(
            wall_min_f32.x as f64,
            wall_min_f32.y as f64,
            wall_min_f32.z as f64,
        );
        let wall_max = Point3::new(
            wall_max_f32.x as f64,
            wall_max_f32.y as f64,
            wall_max_f32.z as f64,
        );

        let wall_valid = !result.is_empty()
            && result.positions.iter().all(|&v| v.is_finite())
            && result.triangle_count() >= 4;

        if !wall_valid {
            return result;
        }

        // NOTE: there is deliberately NO per-element CSG operation budget here.
        // The BSP-era `MAX_CSG_OPERATIONS = 10` cap silently skipped the 11th+
        // opening (it `continue`d past BOTH the exact subtract AND the #635 AABB
        // fallback), which is exactly the regression `csg_void_test::
        // many_tessellated_box_openings_are_all_cut` pins (history: #413/#439).
        // On the unified exact path every opening is a cheap box-vs-host cut, so
        // a budget-skipped opening is a correctness bug, not a perf guard.

        // UNIFIED EXACT PATH (PART B): every opening — axis-aligned RECTANGULAR
        // included — is now subtracted by the exact mesh kernel, NOT the legacy
        // Sutherland-Hodgman AABB clip. A `Rectangular` opening is materialised as
        // a PENETRATING box mesh (its bounds extended through the wall along the
        // extrusion axis by `extend_opening_along_direction`, so both caps poke past
        // the host ⇒ a transversal cut with no flush-cap sliver — the same robust
        // condition PART A guarantees for tilted openings). The exact subtract emits
        // the void's interior reveal faces itself, so the explicit reveal/recess
        // quad generators are no longer needed on this path.
        //
        // `synth_rect` owns the synthesised box meshes so they outlive the loop's
        // borrowed `&CutterKind`s below.
        let mut synth_rect: Vec<CutterKind> = Vec::new();
        let mut non_rect_openings: Vec<&CutterKind> = Vec::new();
        for opening in &ctx.merged_openings {
            match opening {
                CutterKind::Rectangular(open_min, open_max, extrusion_dir) => {
                    // Penetration axis: the authored extrusion dir when present,
                    // else inferred from how the box pierces the host (issue
                    // #1337). Carrying a concrete dir downstream keeps the
                    // through-host cap-flush extension off the opening's thinnest
                    // (in-plane) axis for deep cutters.
                    let dir = extrusion_dir.unwrap_or_else(|| {
                        infer_box_penetration_dir(open_min, open_max, &wall_min, &wall_max)
                    });
                    // Only openings with an AUTHORED extrusion dir were extended
                    // here before; keep the synthesized box identical for the
                    // dirless case (the inferred dir only steers the later
                    // through-host extension, not the box bounds).
                    let (final_min, final_max) = if extrusion_dir.is_some() {
                        self.extend_opening_along_direction(
                            *open_min, *open_max, wall_min, wall_max, dir,
                        )
                    } else {
                        (*open_min, *open_max)
                    };
                    let box_mesh = GeometryRouter::make_box_mesh(final_min, final_max);
                    synth_rect.push(CutterKind::NonRectangular(
                        box_mesh,
                        final_min,
                        final_max,
                        Some(dir),
                    ));
                }
                // A MALFORMED (self-intersecting) tessellated cutter is NOT cut
                // here: its messy mesh under-cuts the opening, and double-cutting
                // it (here AND in the clean-box `recut_malformed_openings` pass)
                // leaves overlapping sliver "shards" in the reveals. Skip it; the
                // recut performs the single, clean box cut for these openings.
                CutterKind::NonRectangular(m, ..) if opening_obb_if_malformed(m).is_some() => {}
                other => non_rect_openings.push(other),
            }
        }
        let all_openings: Vec<&CutterKind> =
            synth_rect.iter().chain(non_rect_openings.iter().copied()).collect();

        // DISJOINT-CUTTER BATCHING: group cutters whose pad-inflated AABBs are
        // pairwise disjoint and subtract each group in ONE conforming arrangement
        // (`ClippingProcessor::subtract_mesh_many`). Sequential per-opening
        // subtraction re-arranges the (growing) host once per cutter, and each
        // intermediate f64→f32→snap round-trip re-jitters carve vertices off
        // shared planes so cut N+1 re-cracks what cut N reconciled (many-void
        // walls' compounding open edges, the 16-void slab's ~3.5 s cost). Batching
        // admits only openings passing the SAME guards as the sequential loop plus
        // per-component watertightness (#2176). Singletons and any group whose
        // batched cut fails its guards — or the kernel conformity gate
        // (`subtract_mesh_many` rejects a group whose N-ary arrangement left an
        // unrecovered constraint) — fall through to the per-opening sequential
        // loop below with its full #635 fallback / engulf / redundant-void machinery.
        let mut tail = strategy::exact::ExactTail::new(all_openings.len());

        // COAXIAL FOOTPRINT-UNION for OVERLAPPING clusters (issue #129, flag
        // `IFC_LITE_VOID_UNION`). Overlapping cutters can't join the disjoint batch
        // below and otherwise fall to the O(N) sequential exact path; this fuses
        // each overlapping coaxial cluster into disjoint re-extruded prisms and cuts
        // them in one `subtract_mesh_many`. See `coaxial_union`. Marks consumed
        // openings so the batch + sequential loops skip them; a cluster that fails
        // any guard is left unconsumed for the exact path (never worse than exact).
        self.coaxial_union_prepass(
            &mut result,
            &all_openings,
            &mut tail.consumed,
            &mut tail.host_mutated,
            &clipper,
        );

        tail.plan_groups(self, &result, &all_openings, wall_min, wall_max);

        for (opening_idx, opening) in all_openings.iter().enumerate() {
            if tail.consumed[opening_idx] {
                continue; // already handled by a batched disjoint group
            }
            // Batched group cut, attempted ONCE, inline at the group's first
            // member — so the relative order of batched vs sequential cutters
            // matches the pure sequential pass. On any failure (admission,
            // guards, or the kernel's conformity gate) the members fall back
            // to the per-opening sequential path below.
            if tail.cut_group(&mut result, &all_openings, &clipper, opening_idx) {
                continue; // this opening was handled with its group
            }
            if let strategy::exact::Flow::Stop = tail.cut_one(&mut result, opening, strategy::exact::CutContext {
                execution: self, clipper: &clipper, element_id, wall_min, wall_max,
            }) {
                break;
            }
        }

        // NOTE (issue #635): the clipping planes from `IfcBooleanClippingResult`
        // are already applied by `BooleanClippingProcessor::process` during
        // `process_element` — the post-clip mesh is the *input* to this
        // function. Re-clipping here was a leftover from before that
        // processor existed; for `IfcPolygonalBoundedHalfSpace` it actively
        // *broke* gable walls, because `extract_half_space_plane` discards
        // the polygonal bound and the resulting unbounded plane chops off
        // the gable peak. Voids alone are applied here.

        post::finish(result, post::Context {
            execution: self, kernel_failures, ctx, element_id, tris_before,
            host_bounds_capture, wall_min, wall_max, original_host: &original_host, host_mutated: tail.host_mutated,
        })
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
