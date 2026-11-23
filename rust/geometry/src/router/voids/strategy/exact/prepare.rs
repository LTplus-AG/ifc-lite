// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Exact-tail preparation: the opening-dense host refinement and the cutter
//! set the exact passes iterate, synthesised rectangles first.

use crate::program::openings::execute::Execution;
use crate::router::voids::flush::flush_band_at;
use crate::router::voids::geom::{
    infer_box_penetration_dir, is_axis_aligned_direction, mesh_point, point_inside_mesh_agreed,
};
use crate::router::voids::malformed_opening_repair::opening_obb_if_malformed;
use crate::router::voids::{CutterKind, VoidContext};
use crate::{GeometryRouter, Mesh, Point3, Vector3};

/// Subdivide an opening-dense host before the exact passes.
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

/// The cutters the exact passes take, in their frozen order: every
/// `Rectangular` opening synthesised into a box mesh (owned here), then the
/// mesh-carrying openings in merged order, malformed ones left to the recut.
pub(in crate::router::voids) struct PreparedCutters<'a> {
    synth_rect: Vec<CutterKind>,
    non_rect_openings: Vec<&'a CutterKind>,
    #[cfg(feature = "csg_manifold_gate")]
    // Same order as the synthesized prefix of ordered().
    pub(in crate::router::voids) unextended_rectangles: Vec<[Point3<f64>; 2]>,
}

impl<'a> PreparedCutters<'a> {
    /// The ordered view the exact tail iterates.
    pub(in crate::router::voids) fn ordered(&self) -> Vec<&CutterKind> {
        self.synth_rect.iter().chain(self.non_rect_openings.iter().copied()).collect()
    }
}

pub(in crate::router::voids) fn cutters<'a>(
    execution: &Execution,
    ctx: &'a VoidContext,
    wall_min: Point3<f64>,
    wall_max: Point3<f64>,
    original_host: &Mesh,
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
    #[cfg(feature = "csg_manifold_gate")]
    let mut unextended_rectangles = Vec::new();
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
                let mut bounds = if extrusion_dir.is_some() {
                    execution.extend_opening_along_direction(
                        *open_min, *open_max, wall_min, wall_max, dir,
                    )
                } else {
                    (*open_min, *open_max)
                };
                let authored = (*open_min, *open_max);
                if bounds != authored
                    && weld_changes_rectangle_extension(execution, original_host, authored, dir)
                {
                    if cutter_is_outside_source(original_host, authored, dir) {
                        continue;
                    }
                    // The manifold gate can retry with the authored cutter
                    // against the union of the host shells (#10512).
                    if !cfg!(feature = "csg_manifold_gate")
                        && rectangle_samples_material(original_host, *open_min, *open_max)
                    {
                        bounds = authored;
                    }
                }
                #[cfg(feature = "csg_manifold_gate")]
                unextended_rectangles.push([*open_min, *open_max]);
                let (final_min, final_max) = bounds;
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
    PreparedCutters {
        synth_rect, non_rect_openings,
        #[cfg(feature = "csg_manifold_gate")]
        unextended_rectangles,
    }
}

/// The caller has already found that the welded host would extend the box.
fn weld_changes_rectangle_extension(
    execution: &Execution,
    host: &Mesh,
    (min, max): (Point3<f64>, Point3<f64>),
    dir: Vector3<f64>,
) -> bool {
    let (host_min, host_max) = host.bounds();
    execution.extend_opening_along_direction(min, max, host_min.cast(), host_max.cast(), dir)
        == (min, max)
}

/// Look for a recess in the source host (#10528). Include axial offsets
/// because a finish can end inside the footprint.
fn rectangle_samples_material(host: &Mesh, min: Point3<f64>, max: Point3<f64>) -> bool {
    let centre = Point3::from((min.coords + max.coords) * 0.5);
    let quarter = (max - min) * 0.25;
    let inside = |point| point_inside_mesh_agreed(host, point) == Some(true);
    inside(centre)
        || (0..3).any(|axis| {
            let mut step = Vector3::zeros();
            step[axis] = quarter[axis];
            inside(centre - step) || inside(centre + step)
        })
}

/// Beyond the end of a finish, a recess can touch the core but enclose
/// only air (#11313). Prove that no source triangle enters the box's open
/// interior. Compare at f32 precision, the format of both meshes.
fn cutter_is_outside_source(
    host: &Mesh,
    (min, max): (Point3<f64>, Point3<f64>),
    dir: Vector3<f64>,
) -> bool {
    if !is_axis_aligned_direction(&dir) {
        return false;
    }
    let min = min.cast::<f32>().cast::<f64>();
    let max = max.cast::<f32>().cast::<f64>();
    if (0..3).any(|axis| min[axis] >= max[axis]) {
        return false;
    }
    let separated = host.indices.chunks_exact(3).all(|tri| {
        let [Some(a), Some(b), Some(c)] = [tri[0], tri[1], tri[2]].map(|i| mesh_point(host, i)) else {
            return false;
        };
        (0..3).any(|axis| {
            a[axis].max(b[axis]).max(c[axis]) <= min[axis]
                || a[axis].min(b[axis]).min(c[axis]) >= max[axis]
        })
    });
    separated && cap_touches_exterior(host, min, max, dir.iamax())
}

/// The exterior surface continues across the cutter's footprint. A recess
/// already carved into a finish can also enclose air, but its floor ends at
/// the edge of the authored box (rvt01.ifc #6934).
fn cap_touches_exterior(host: &Mesh, min: Point3<f64>, max: Point3<f64>, depth: usize) -> bool {
    let centre = Point3::from((min.coords + max.coords) * 0.5);
    let band = flush_band_at(min[depth].abs().max(max[depth].abs()));
    if max[depth] - min[depth] <= 2.0 * band {
        return false;
    }
    [(min[depth], -band), (max[depth], band)].into_iter().any(|(cap, step)| {
        let touches = |mut point: Point3<f64>| {
            point[depth] = cap + step;
            if point_inside_mesh_agreed(host, point) != Some(true) {
                return false;
            }
            point[depth] = cap - step;
            point_inside_mesh_agreed(host, point) == Some(false)
        };
        touches(centre) && (0..3).filter(|&axis| axis != depth).any(|axis| {
            [min[axis] - band, max[axis] + band].into_iter().any(|side| {
                let mut beyond = centre;
                beyond[axis] = side;
                touches(beyond)
            })
        })
    })
}
