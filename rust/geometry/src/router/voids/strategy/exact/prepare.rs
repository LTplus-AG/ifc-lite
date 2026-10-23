// SPDX-License-Identifier: MPL-2.0
//! Exact-tail preparation preserves authored/inferred direction asymmetry.
use crate::{GeometryRouter, Mesh, Point3};
use crate::program::openings::execute::Execution;
use crate::router::voids::{CutterKind, VoidContext};
use crate::router::voids::geom::infer_box_penetration_dir;
use crate::router::voids::malformed_opening_repair::opening_obb_if_malformed;

pub(in crate::router::voids) fn refine_dense_host(mut result: Mesh, ctx: &VoidContext) -> Mesh {
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

    result
}

pub(in crate::router::voids) struct PreparedCutters<'a> {
    pub synth_rect: Vec<CutterKind>,
    pub non_rect_openings: Vec<&'a CutterKind>,
}

pub(in crate::router::voids) fn cutters<'a>(
    execution: &Execution, ctx: &'a VoidContext, wall_min: Point3<f64>, wall_max: Point3<f64>,
) -> PreparedCutters<'a> {
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
                    execution.extend_opening_along_direction(
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
    PreparedCutters { synth_rect, non_rect_openings }
}
