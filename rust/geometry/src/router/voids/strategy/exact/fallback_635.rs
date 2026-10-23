// SPDX-License-Identifier: MPL-2.0
use super::{CutContext, ExactTail};
use crate::{Mesh, Point3, Vector3};
use crate::router::voids::admission::{aabb_engulfs, ENGULF_TOLERANCE};
use crate::router::voids::geom::{opening_redundant_with_host, wall_thinnest_axis_dir};

pub(super) struct Fallback<'a> {
    pub opening_mesh: &'a Mesh,
    pub open_min_pt: &'a Point3<f64>,
    pub open_max_pt: &'a Point3<f64>,
    pub extrusion_dir: Option<Vector3<f64>>,
    pub tri_before: usize,
    pub failures_before: usize,
    pub csg_unchanged: bool,
}

impl ExactTail {
    pub(super) fn fallback_635(&mut self, result: &mut Mesh, context: CutContext<'_>, fallback: Fallback<'_>) {
        let CutContext { execution, clipper, wall_min, wall_max, .. } = context;
        let Fallback { opening_mesh, open_min_pt, open_max_pt, extrusion_dir,
            tri_before, failures_before, csg_unchanged } = fallback;
        let dir = extrusion_dir.or_else(|| {
            Some(wall_thinnest_axis_dir(&wall_min, &wall_max))
        });
        let (final_min, final_max) = if let Some(dir) = dir {
            execution.extend_opening_along_direction(
                *open_min_pt,
                *open_max_pt,
                wall_min,
                wall_max,
                dir,
            )
        } else {
            (*open_min_pt, *open_max_pt)
        };
        // Near-engulf guard. When CSG returned the host *unchanged*
        // (no cut) AND the opening's AABB covers the whole wall on
        // every axis, the rectangular fallback would cut that
        // engulfing box and delete the wall. This is the signature
        // of a non-rectangular opening whose bounding box engulfs
        // the host while its real profile excludes it: the kernel
        // errors on the grazing/coplanar cutter and returns the
        // un-cut host, which is already the correct result vs
        // IfcOpenShell (advanced #555433's facade-scale void
        // #555493). Keep the un-cut host instead of over-cutting.
        // Normal windows/doors — including the issue-635 high-poly
        // round openings the AABB box approximates — sit INSIDE the
        // wall and never engulf it, so they still take the fallback.
        // The 3% per-axis tolerance absorbs an opening that reaches
        // ~flush with a wall face (its near plane).
        let engulfs_host = aabb_engulfs(
            [final_min.x, final_min.y, final_min.z],
            [final_max.x, final_max.y, final_max.z],
            [wall_min.x, wall_min.y, wall_min.z],
            [wall_max.x, wall_max.y, wall_max.z],
            ENGULF_TOLERANCE,
        );
        // `capped` keys on the `OperandTooLarge` rejection: the
        // #1109 per-boolean/-element escalation budget records it
        // when a cut trips mid-arrangement and bails to the un-cut
        // host (`csg/mod.rs`), so it is NOT always false — a
        // grazing engulfing cutter that would run long trips the
        // budget just as it errors on the coincident faces.
        // Engulf suppression therefore applies regardless of WHY
        // the CSG produced no change (budget trip or kernel error
        // on the coincident faces): an engulfing cutter's AABB
        // covers the whole host, so the #635 box-cut would delete
        // the entire wall — a silent element deletion strictly
        // worse than leaving a phantom (un-cut) solid. `capped` is
        // now only read by the diagnostic below (it no longer
        // gates the suppression), so it is unused in a release
        // build that compiles out both the tracing and the
        // debug/test `eprintln!` legs of `diag_warn!`.
        #[allow(unused_variables)]
        let capped = clipper.has_operand_too_large_since(failures_before);
        // Issue #964: suppress the destructive AABB box when the
        // host already has this void cut into it (a void
        // double-encoded as both a profile inner curve and a
        // redundant IfcOpeningElement). When every column through
        // the opening footprint is already open in the host,
        // cutting the bounding box would replace a correct
        // round/polygonal hole with a rectangle. Unlike the
        // engulf heuristic this is a positive void detection, so
        // it overrides `capped` too (the void demonstrably
        // exists — there is nothing left to approximate).
        let probe_axis = dir.unwrap_or_else(|| {
            wall_thinnest_axis_dir(&wall_min, &wall_max)
        });
        let redundant_void =
            opening_redundant_with_host(result, opening_mesh, &probe_axis);
        let suppress_fallback =
            redundant_void || (csg_unchanged && engulfs_host);
        if !suppress_fallback {
            // Diagnostic for issue #635: log the opening
            // triangle count when the AABB fallback actually
            // fires, so round windows (post profile
            // simplification) can be confirmed to hit CSG and
            // only genuinely-uncut voids land on the box cut.
            // A genuine degraded mode, so warn-level under
            // observability; the legacy debug/test-only
            // eprintln is preserved otherwise.
            record_fallback(opening_mesh);
            // Deliberate degraded mode: this fallback removes
            // the wall material inside the opening AABB but no
            // longer emits reveal/recess quads (deleted with
            // the legacy clip path), so its output has an open
            // rim. It runs only when the kernel FAILED on an
            // opening that reaches the host, never on one the
            // kernel found disjoint (#5362).
            let aabb_cut =
                execution.cut_rectangular_opening(result, final_min, final_max);
            #[cfg(feature = "opening-perf-trace")]
            crate::opening_perf_trace::record(|c| {
                c.aabb_fallback_attempts = c.aabb_fallback_attempts.saturating_add(1);
                c.aabb_fallback_input_triangles = c.aabb_fallback_input_triangles.saturating_add(result.triangle_count() as u64);
                c.aabb_fallback_output_triangles = c.aabb_fallback_output_triangles.saturating_add(aabb_cut.triangle_count() as u64);
            });
            if !aabb_cut.is_empty() && aabb_cut.triangle_count() != tri_before {
                #[cfg(feature = "opening-perf-trace")]
                crate::opening_perf_trace::record(|c| c.aabb_fallback_commits = c.aabb_fallback_commits.saturating_add(1));
                *result = aabb_cut;
                self.host_mutated = true;
            }
        } else {
            // The engulfing/redundant-void guard suppressed the
            // #635 AABB box-cut. For an engulfing cutter the box
            // covers the whole host, so cutting it would DELETE
            // the wall; leaving the host un-cut (a phantom solid)
            // is the strictly safer degrade. `capped` records
            // whether the CSG bailed via the #1109 budget trip
            // (`OperandTooLarge`) vs a kernel error on the
            // coincident faces.
            record_suppressed(opening_mesh, capped);
        }
    }
}

#[allow(unused_variables)]
fn record_fallback(opening_mesh: &Mesh) {
    crate::diag::diag_warn!(
            { target: "ifc_lite_geometry::router::voids",
              opening_tris = opening_mesh.triangle_count(),
              reason = "csg-produced-no-change",
              "voids: AABB fallback cut used for opening" }
            else {
                #[cfg(any(debug_assertions, test))]
                eprintln!(
                    "[issue-635] AABB fallback used: opening={} tris (CSG produced no change)",
                    opening_mesh.triangle_count()
                );
        }
    );
}

#[allow(unused_variables)]
fn record_suppressed(opening_mesh: &Mesh, capped: bool) {
    crate::diag::diag_warn!(
            { target: "ifc_lite_geometry::router::voids",
              opening_tris = opening_mesh.triangle_count(),
              capped = capped,
              reason = "engulfing-cutter-fallback-suppressed",
              "voids: AABB fallback suppressed for engulfing cutter (host left un-cut)" }
            else {
                #[cfg(any(debug_assertions, test))]
                eprintln!(
                    "[issue-635] AABB fallback SUPPRESSED for engulfing cutter: opening={} tris, capped={} (host left un-cut)",
                    opening_mesh.triangle_count(),
                    capped
                );
        }
    );
}
