// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The frame-local void-cut chain every host reaches after stage A.

use super::super::{post, CutterKind, VoidContext};
use super::exact::{self, CutContext, ExactTail};
use super::rect_fast;
use crate::csg::ClippingProcessor;
use crate::program::openings::execute::Execution;
use crate::{Mesh, Point3};

impl Execution {
    /// The frame-local chain: stage B (WallLocalFrame, facet weld, RectFast),
    /// then the exact tail (stage C) and its post passes (stage D), in the
    /// statement order below. `allow_local_frame` (#3641) caps the wall-frame
    /// recursion at one level.
    pub(in crate::router::voids) fn cut_in_frame(
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
        if allow_local_frame {
            if let Some(cut) = self.cut_in_wall_frame(&mesh, ctx, element_id, host_bounds_capture) {
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

        // RectFast: the analytic cut of an axis-aligned box host, on the welded
        // host and before the dense-host subdivision (see `rect_fast`).
        if let Some(fast) =
            rect_fast::try_cut(self, &result, ctx, element_id, host_bounds_capture, tris_before)
        {
            return fast;
        }

        result = exact::prepare::refine_dense_host(result, ctx);

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

        let prepared = exact::prepare::cutters(self, ctx, wall_min, wall_max);
        let all_openings: Vec<&CutterKind> = prepared.ordered();

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
        let tail = ExactTail::new(result, all_openings);
        let (result, host_mutated) = tail.run(CutContext { execution: self, clipper: &clipper, wall_min, wall_max });

        // NOTE (issue #635): the clipping planes from `IfcBooleanClippingResult`
        // are already applied by `BooleanClippingProcessor::process` during
        // `process_element` — the post-clip mesh is the *input* to this
        // function. Re-clipping here was a leftover from before that
        // processor existed; for `IfcPolygonalBoundedHalfSpace` it actively
        // *broke* gable walls, because `extract_half_space_plane` discards
        // the polygonal bound and the resulting unbounded plane chops off
        // the gable peak. Voids alone are applied here.

        post::finish(
            result,
            post::PostContext {
                execution: self,
                kernel_failures,
                ctx,
                element_id,
                tris_before,
                host_bounds_capture,
                wall_min,
                wall_max,
                original_host: &original_host,
                host_mutated,
            },
        )
    }
}
