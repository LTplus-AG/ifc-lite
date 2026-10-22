// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::mesh::Mesh;
use nalgebra::{Point3, Vector3};
mod buckets;
mod candidates;
mod conform;
mod plans;
mod plan;
mod recovery;
mod plane_merge;
mod ring_ops;
mod preservation;
mod supported_cells;
mod source_boundary;
mod source_boundary_graph;

use super::ClippingProcessor;
use conform::{count_open_boundary_edges_at, open_edge_endpoints_at};
#[cfg(test)]
use conform::{build_seam_map, conform_plans, PlanBucket};
use ring_ops::floor_pow2;
#[cfg(test)]
use ring_ops::{ring_is_noise, weld_near_coincident_2d};

/// Is `v` a degenerate NEEDLE — its shortest edge a hairline relative to its
/// longest? Such a triangle is a zero-area-intended sliver: the exact kernel
/// faithfully spans two near-coincident-but-distinct rim Vids (an f32-import /
/// shallow-dihedral near-duplicate the interner correctly does NOT weld) out to a
/// far vertex (issue #1007 / schependomlaan: the diagonal flap over an opening).
///
/// The test is `min_edge < floor_pow2(max_edge) · 2⁻¹³` — POWER-OF-TWO and
/// scale-relative, so it is bit-deterministic AND catches the needle (min 6.6 µm
/// vs max ~5 m ⇒ threshold ~5·10⁻⁴) while never touching a real thin sliver at
/// that scale (e.g. a 0.2 m × 2 m face, min 0.2 m ≫ 2·10⁻⁴). Dropping such a
/// needle cannot open a gap: the hole/seam is already framed by the neighbouring
/// non-degenerate triangles, exactly as Manifold (which welds the near-duplicate)
/// produces.
///
/// The cost of scale-relativity, documented behaviour rather than a defect
/// (#4698): a REAL face thinner than `floor_pow2(max_edge) / 8192` is dropped
/// with the needles — 7.8 mm across a 64 m span, so a 64 m × 5 mm plate edge
/// does not survive the needle filter. Consolidation retains a source cell, or a patch joined only along convex
/// ridges, when its complete boundary has healthy opposite supports in
/// nonoverlapping source buckets (#7292, #8047); the predicate stays unchanged. Its
/// removal DOES leave a gap — the framing argument above covers a needle, not a
/// face. No absolute floor is threaded here: this runs in the CALLER's unit
/// (metres on the void path, millimetres on the file-unit boolean path, #2684),
/// and the corpus needles it must keep dropping reach 1.7 mm (ISSUE_129
/// #296868) and 0.054 file units (S_Office #92642) — within 3× of a plausible
/// real thin face. Every absolute floor from 2⁻¹² to 2⁻²⁰ re-tore both hosts.
/// #4744 did thread a metres-per-unit scale into the sibling RING gate; doing the
/// same here would still need that call, since the `aabb_clip` site has no scale.
pub(crate) fn tri_is_needle(v: &[Point3<f64>; 3]) -> bool {
    let d = |a: &Point3<f64>, b: &Point3<f64>| (a - b).norm();
    let (e0, e1, e2) = (d(&v[0], &v[1]), d(&v[1], &v[2]), d(&v[2], &v[0]));
    let mn = e0.min(e1).min(e2);
    let mx = e0.max(e1).max(e2);
    if !mx.is_finite() || mx <= 0.0 {
        return true; // fully degenerate
    }
    mn < floor_pow2(mx) * 2.0_f64.powi(-13)
}

/// Push a single triangle (with the supplied face normal applied to all
/// three vertices) onto `mesh`, UNLESS it is a degenerate needle ([`tri_is_needle`]).
/// Used by `consolidate_coplanar` for plane buckets that don't go through the
/// 2D-union round-trip (single-triangle buckets and the union-collapse fallback);
/// the needle drop here is what removes the #1007 diagonal sliver, since each
/// tilted opening face lands in its own single-triangle plane bucket and would
/// otherwise pass the raw kernel needle through verbatim. See [`tri_is_needle`]
/// for what else the rule drops at long spans.
pub(super) fn emit_triangle(mesh: &mut Mesh, v: &[Point3<f64>; 3], normal: &Vector3<f64>) {
    if tri_is_needle(v) {
        return;
    }
    let base = mesh.vertex_count() as u32;
    mesh.add_vertex(v[0], *normal);
    mesh.add_vertex(v[1], *normal);
    mesh.add_vertex(v[2], *normal);
    mesh.add_triangle(base, base + 1, base + 2);
}

/// Count OPEN boundary edges: undirected edges whose directed half-edges do not
/// pair (one forward + one reverse). Vertices are merged on a 1 mm grid — bigger
/// than the few-ULP spread between the per-bucket duplicate vertices
/// `consolidate_coplanar` emits at a shared position (a finer grid would read every
/// inter-bucket edge as "open"), yet far smaller than a genuine crack (which spans a
/// facet width, cm). A watertight closed mesh returns 0; the consolidation tear
/// shows up as a positive count the (watertight) raw kernel output lacks.
fn count_open_boundary_edges(mesh: &Mesh) -> usize {
    count_open_boundary_edges_at(mesh, 1.0e3)
}

/// Count spike triangles (longest-edge / shortest-edge > 50:1) — the same quality
/// bar the `csg_quality_regression` tests use. Combined with the open-edge count
/// into a "badness" score so the consolidation fallback reverts to raw ONLY when raw
/// is the cleaner mesh overall (a curved / offset-jittered host's raw is watertight
/// AND well-formed), never when raw carries needle fans consolidation would merge.
fn count_spike_triangles(mesh: &Mesh) -> usize {
    let mut n = 0usize;
    for tri in mesh.indices.chunks_exact(3) {
        let p = |i: u32| {
            let i = i as usize;
            [
                mesh.positions[i * 3],
                mesh.positions[i * 3 + 1],
                mesh.positions[i * 3 + 2],
            ]
        };
        let (a, b, c) = (p(tri[0]), p(tri[1]), p(tri[2]));
        let d = |u: [f32; 3], v: [f32; 3]| {
            ((u[0] - v[0]).powi(2) + (u[1] - v[1]).powi(2) + (u[2] - v[2]).powi(2)).sqrt()
        };
        let (e0, e1, e2) = (d(a, b), d(b, c), d(c, a));
        let mn = e0.min(e1).min(e2);
        let mx = e0.max(e1).max(e2);
        if mn > 1.0e-6 && mx / mn > 50.0 {
            n += 1;
        }
    }
    n
}

impl ClippingProcessor {
    /// Re-merge the kernel's per-plane fragments via 2D polygon union, then
    /// earcut each result back to triangles. CSG over-fragments host faces
    /// along operand cut lines; a naive edge-walk merge fails on the
    /// "X" crossings that appear at cutter-outline corners (four fragments
    /// sharing only a vertex), so we project each plane bucket to 2D, run
    /// the same `i_overlay` boolean engine `bool2d.rs` already uses elsewhere
    /// in the crate, and earcut the resulting (possibly annular) shapes.
    /// This is what brought the bath from 189 → ~50
    /// triangles with the cavity outline intact (issue #780); it also hosts
    /// the needle/weld cleanup passes for #1007.
    ///
    /// Returns the input mesh unchanged if the consolidate fails or yields
    /// nothing — never worse than the raw kernel output.
    pub(crate) fn consolidate_coplanar(mesh: Mesh) -> Mesh {
        Self::consolidate_coplanar_with_unit_scale(mesh, 1.0)
    }

    /// Construct a clipper for operands that are still expressed in file units.
    pub(crate) fn with_unit_scale(length_unit_scale: f64) -> Self {
        Self { length_unit_scale, ..Self::new() }
    }

    /// Consolidate using this processor's caller-unit-to-metre scale.
    pub(crate) fn consolidate(&self, mesh: Mesh) -> Mesh {
        Self::consolidate_coplanar_with_unit_scale(mesh, self.length_unit_scale)
    }

    fn consolidate_coplanar_with_unit_scale(mesh: Mesh, length_unit_scale: f64) -> Mesh {
        Self::consolidate_with_supported_cells(mesh, length_unit_scale, true, true)
    }

    fn consolidate_with_supported_cells(mesh: Mesh, length_unit_scale: f64, preserve_supported: bool, preserve_folds: bool) -> Mesh {
        if mesh.indices.len() < 6 {
            return mesh;
        }
        let mut buckets = buckets::build(&mesh);
        // Stitch only the adjacent rounding splits certified by the kernel tags.
        let merged_bucket_keys = plane_merge::merge_rounding_split_buckets(&mut buckets);
        let mut supported = if preserve_folds { supported_cells::find(&buckets) }
            else { supported_cells::find_with_folds(&buckets, false) };
        if !preserve_supported {
            // Healthy folds have a separate exact source-topology certificate.
            // Keep their finite surface in the ordinary baseline while still
            // dropping thin cells and applying the unchanged adoption guards.
            supported.cells.clear();
            supported.buckets.clear();
            supported.buckets.extend(supported.folded_buckets.iter().copied());
            supported.buckets.extend(supported.fold_support_buckets.iter().copied());
        }
        let mut planned = plans::build(&buckets, &merged_bucket_keys, &supported, length_unit_scale);
        let Some(output) = candidates::emit(&mut planned, &buckets, &supported) else {
            return mesh;
        };
        if output.is_empty() {
            return mesh;
        }
        let output = candidates::prefer_raw_if_cleaner(&mesh, output, &buckets, &supported);
        // Fold retention may leave the fold's own boundary open, never the rest
        // of the host: where it does, the fold-free result is the better one.
        // The fold-free consolidation is the same call in both checks below, so
        // it runs at most once.
        let mut fold_free: Option<Mesh> = None;
        if !supported.folded_buckets.is_empty()
            && preservation::tears_beyond_folds(&output, &buckets, &supported)
        {
            let ordinary = Self::consolidate_with_supported_cells(
                mesh.clone(), length_unit_scale, preserve_supported, false);
            // Only a fully closed fold-free host replaces the fold output; one
            // that is merely less open gives up the fold's finite support for
            // nothing (rvt01 #26681 pins that trade).
            //
            // `has_uncertified_needle` is deliberately NOT asked here, unlike the
            // partial-closure fallback below: on the hosts this exists for
            // (ISSUE_068 #43810, #54549) the closed fold-free result does carry
            // uncertified needles, so that guard would reject the only closed
            // answer and ship the torn candidate. A sliver needle is the lesser
            // defect than an open boundary, and the #7292 star, which forbids
            // restored needles, tears nothing beyond its fold and never gets here.
            if crate::exact_topology::strict_closed_mesh(&ordinary)
                && preservation::public_weld_closed(&ordinary) {
                return ordinary;
            }
            fold_free = Some(ordinary);
        }
        // A local healthy fold cannot reopen a boundary ordinary cleanup
        // already closes. Only an open candidate pays for this comparison;
        // the no-fold call retains the original thin-cell policy.
        if !supported.folded_buckets.is_empty() {
            let exact = crate::exact_topology::strict_closed_mesh(&output);
            let public = preservation::public_weld_closed(&output);
            if !exact || !public {
                let ordinary = fold_free.take().unwrap_or_else(|| Self::consolidate_with_supported_cells(
                    mesh.clone(), length_unit_scale, preserve_supported, false));
                if ((!exact && crate::exact_topology::strict_closed_mesh(&ordinary))
                    || (!public && preservation::public_weld_closed(&ordinary)))
                    && !supported_cells::has_uncertified_needle(&ordinary, &supported) {
                    return ordinary;
                }
            }
        }
        // Retention may not restore unrelated needles through the whole-raw
        // fallback (#1007, #5739). Preserve the established exact/public closure
        // and signed boundary bars, including partially conforming source meshes.
        if !supported.cells.is_empty() {
            let baseline = Self::consolidate_with_supported_cells(mesh.clone(), length_unit_scale, false, preserve_folds);
            // An already closed ordinary boundary needs no source-cell rescue.
            if crate::exact_topology::strict_closed_mesh(&baseline) { return baseline; }
            let exact = crate::exact_topology::strict_closed_mesh(&output);
            let certified = !supported_cells::has_uncertified_needle(&output, &supported);
            let public = preservation::public_weld_closed(&output);
            // Connected thin patches change the input to subsequent boolean
            // cuts. A partial boundary improvement cannot certify that input
            // (#8051): require closure before adopting a connected rescue.
            if supported.has_connected_patch && std::env::var_os("IFCLITE_DIAG_PATCH").is_some() {
                eprintln!("PATCH input={} output={} baseline={} exact={exact} public={public} certified={certified} open={} baseopen={}", mesh.indices.len()/3, output.indices.len()/3, baseline.indices.len()/3, count_open_boundary_edges(&output), count_open_boundary_edges(&baseline));
            }
            if supported.has_connected_patch && (!exact || !public) {
                return baseline;
            }
            if (!certified || !exact || !public)
                && (!certified
                    || (!public && preservation::public_weld_closed(&baseline))
                    || preservation::signed_boundary_worse(&output, &baseline))
            {
                return baseline;
            }
        }
        let mut output = recovery::retry_closed_input(
            &mesh, output, &buckets, planned, length_unit_scale, &supported,
        );
        // Carry the input's placement / frame metadata (`origin` local-frame
        // translation, `rtc_applied`, and the #1474 world-capture `local_bounds` /
        // `local_to_world`) onto the re-triangulated output. `consolidate_coplanar`
        // only re-triangulates coplanar faces — the geometry stays in the SAME
        // frame — but `output` is a bare `Mesh::new()` whose defaults reset those
        // fields to zero/None. For a LOCAL-FRAME caller (origin != 0: the prism /
        // coaxial-union void fast paths, #1806/#1815) that reset drops the host's
        // per-element origin and mis-places the whole cut host at the world origin
        // (the mesh.rs #1474 hazard; mirrors `refine_high_aspect_slivers`'s
        // `rebuilt_like`). World-frame callers (origin 0) are unaffected. The early
        // `return mesh` branches above already carry the original frame.
        output.rtc_applied = mesh.rtc_applied;
        output.origin = mesh.origin;
        output.local_bounds = mesh.local_bounds;
        output.local_to_world = mesh.local_to_world;
        output
    }
}

/// Apply the same mesh hygiene as the router before judging the all-or-nothing
/// conform candidate. Triangulation can emit sub-grid collinear slivers beside
/// an otherwise paired seam; they are not geometry and must not make a closed
/// candidate look open at the acceptance bar.
fn complete_conformed_candidate(
    mut candidate: Mesh,
    complete: bool,
    require_exact: bool,
) -> Option<Mesh> {
    candidate.clean_degenerate();
    (complete
        && !candidate.is_empty()
        && count_open_boundary_edges_at(&candidate, 1.0e4) == 0
        && (!require_exact || count_open_boundary_edges_exact(&candidate) == 0))
        .then_some(candidate)
}

fn count_open_boundary_edges_exact(mesh: &Mesh) -> usize {
    let mut vertices: rustc_hash::FxHashMap<[u32; 3], u32> = Default::default();
    let mut id_of = |index: usize| -> u32 {
        let base = index * 3;
        let key = [
            mesh.positions[base].to_bits(),
            mesh.positions[base + 1].to_bits(),
            mesh.positions[base + 2].to_bits(),
        ];
        let next = vertices.len() as u32;
        *vertices.entry(key).or_insert(next)
    };
    let mut balance: rustc_hash::FxHashMap<(u32, u32), i32> = Default::default();
    for triangle in mesh.indices.chunks_exact(3) {
        let ids = [
            id_of(triangle[0] as usize),
            id_of(triangle[1] as usize),
            id_of(triangle[2] as usize),
        ];
        for (a, b) in [(ids[0], ids[1]), (ids[1], ids[2]), (ids[2], ids[0])] {
            let (edge, sign) = if a < b { ((a, b), 1) } else { ((b, a), -1) };
            *balance.entry(edge).or_default() += sign;
        }
    }
    balance.values().filter(|&&value| value != 0).count()
}

#[cfg(test)]
#[path = "consolidate_threshold_tests.rs"]
mod threshold_tests;

#[cfg(test)]
#[path = "consolidate_3977_tests.rs"]
mod issue_3977_tests;

#[cfg(test)]
#[path = "consolidate_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "consolidate/healthy_fold_adoption_tests.rs"]
mod healthy_fold_adoption_tests;
