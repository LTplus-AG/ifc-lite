// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Ray parity, ray/triangle tests and the "does this cutter swallow the host"
//! containment scan.

use super::geom::mesh_point;
use super::NORMALIZE_EPSILON;
use crate::math::v3::{self, V3};
use crate::{Mesh, Point3, Vector3};

/// Möller–Trumbore ray/triangle intersection returning the signed ray
/// parameter `t` (signed distance along `dir` from `origin`), or `None` when
/// the ray misses the triangle or runs parallel to it. `dir` must be
/// normalized.
///
/// The one ray/triangle test of the void path (ROUTER-8). `det_eps` is the
/// parallel-ray floor on the determinant and `bary_eps` the slack on the
/// barycentric bounds; the host-already-open probes use `1e-9` for both, the
/// prism path's crossing parity a tighter determinant floor (`1e-12`). Written
/// out over [`v3`] with no fused operations, so it is bit-equal to the
/// `nalgebra` spelling it replaced (`ray_triangle_matches_nalgebra_spelling`).
pub(super) fn ray_triangle_param(
    origin: V3,
    dir: V3,
    a: V3,
    b: V3,
    c: V3,
    det_eps: f64,
    bary_eps: f64,
) -> Option<f64> {
    let e1 = v3::sub(b, a);
    let e2 = v3::sub(c, a);
    let pvec = v3::cross(dir, e2);
    let det = v3::dot(e1, pvec);
    if det.abs() < det_eps {
        return None; // ray parallel to the triangle plane
    }
    let inv_det = 1.0 / det;
    let tvec = v3::sub(origin, a);
    let u = v3::dot(tvec, pvec) * inv_det;
    if !(-bary_eps..=1.0 + bary_eps).contains(&u) {
        return None;
    }
    let qvec = v3::cross(tvec, e1);
    let v = v3::dot(dir, qvec) * inv_det;
    if v < -bary_eps || u + v > 1.0 + bary_eps {
        return None;
    }
    Some(v3::dot(e2, qvec) * inv_det)
}

/// Determinant floor and barycentric slack of the host-already-open probes and
/// the mesh parity ray.
const MESH_RAY_EPS: f64 = 1e-9;

/// A crossing counts toward ray parity only when it lies at least this far
/// ahead of the origin.
pub(super) const PARITY_T_MIN: f64 = 1e-9;

/// The three vertices of triangle `tri` as arrays, or `None` when an index is
/// out of range.
fn tri_points(mesh: &Mesh, tri: &[u32]) -> Option<[V3; 3]> {
    let p = |i: u32| mesh_point(mesh, i).map(|p| [p.x, p.y, p.z]);
    Some([p(tri[0])?, p(tri[1])?, p(tri[2])?])
}

/// Whether the infinite line through `point` along `axis` crosses any
/// triangle of `mesh`.
pub(super) fn axis_line_crosses_mesh(mesh: &Mesh, point: Point3<f64>, axis: &Vector3<f64>) -> bool {
    let (origin, dir) = ([point.x, point.y, point.z], [axis.x, axis.y, axis.z]);
    for tri in mesh.indices.chunks_exact(3) {
        let Some([a, b, c]) = tri_points(mesh, tri) else {
            continue;
        };
        if ray_triangle_param(origin, dir, a, b, c, MESH_RAY_EPS, MESH_RAY_EPS).is_some() {
            return true;
        }
    }
    false
}

/// Whether `opening` is a redundant cutter — every column through its footprint
/// (along `axis`) is *already* open in `host`, so subtracting it would remove
/// nothing.
///
/// Issue #964: some exporters (Revit) double-encode a void — once baked into
/// the host's `IfcArbitraryProfileDefWithVoids` profile and again as a
/// redundant `IfcOpeningElement`. The body geometry already carries the
/// (correct, possibly round/polygonal) hole, so when the redundant opening's
/// CSG subtraction finds nothing to remove the AABB fallback must NOT fire:
/// cutting the opening's bounding box would carve a rectangle over the
/// already-correct hole.
///
/// Clearance is probed across the *whole* footprint, not just the centroid:
/// the centroid plus every cutter vertex pulled slightly inward toward the
/// centroid (so the samples stay strictly inside the real round/polygonal
/// footprint rather than its bounding box). The opening is redundant only when
/// a ray along `axis` through *every* sample hits zero host triangles. If any
/// sample still finds host material — e.g. a circular opening centred inside an
/// already-cut rectangle but spilling out into solid host beyond it — the
/// cutter has real work left and the fallback proceeds. A genuinely solid host
/// (the issue #635 round window in an un-voided wall) is rejected at the very
/// first sample, so the fallback still fires there. No regression.
pub(super) fn opening_redundant_with_host(host: &Mesh, opening: &Mesh, axis: &Vector3<f64>) -> bool {
    let Some(axis) = axis.try_normalize(NORMALIZE_EPSILON) else {
        return false;
    };
    let Some(centroid) = mesh_vertex_centroid(opening) else {
        return false;
    };
    // Pull each footprint sample 10% toward the centroid so a sample sitting
    // exactly on a hole boundary that coincides with the cutter wall lands
    // strictly inside the existing void.
    const PULL_TO_CENTROID: f64 = 0.1;
    if axis_line_crosses_mesh(host, centroid, &axis) {
        return false;
    }
    for v in opening.positions.chunks_exact(3) {
        let vertex = Point3::new(v[0] as f64, v[1] as f64, v[2] as f64);
        let sample = vertex + (centroid - vertex) * PULL_TO_CENTROID;
        if axis_line_crosses_mesh(host, sample, &axis) {
            return false;
        }
    }
    true
}

/// Ray parity from two independent directions, or `None` when they disagree.
///
/// Disagreement means the surface around `point` is not closed to a ray, so the
/// crossing count is not evidence of anything. Callers that would ACT on
/// "inside" need to tell that apart from "inside", because a torn shell answers
/// this question differently depending on where the ray goes.
///
/// Deliberately not `param_cut_watertight`: that pairs directed edges, so a
/// closed solid whose faces carry T-junctions (an annulus around a hole, which
/// is how IFC breps and pre-cut wall layers are built) reads as open when it is
/// not. This asks about the point, not the topology.
pub(super) fn point_inside_mesh_agreed(mesh: &Mesh, point: Point3<f64>) -> Option<bool> {
    let a = parity_along(mesh, point, PARITY_DIR_A);
    let b = parity_along(mesh, point, PARITY_DIR_B);
    (a == b).then_some(a)
}

/// Irrational-ish, non-axis-aligned: avoids exact edge and vertex grazes on the
/// axis-aligned faces that dominate IFC opening boxes. ONE definition, shared by
/// both callers, so the single-ray and two-ray answers cannot drift apart.
pub(super) const PARITY_DIR_A: V3 = [0.573_257_1, 0.665_412_3, 0.477_889_5];

/// Shares no plane with [`PARITY_DIR_A`] and no axis with those same facets.
const PARITY_DIR_B: V3 = [-0.412_889_7, 0.734_115_3, -0.538_662_1];

/// Whether the ray from `origin` along `dir` crosses triangle `a b c` ahead of
/// the origin (`t > PARITY_T_MIN`): one count of ray parity.
#[inline]
pub(super) fn forward_crossing(origin: V3, dir: V3, a: V3, b: V3, c: V3, det_eps: f64) -> bool {
    ray_triangle_param(origin, dir, a, b, c, det_eps, MESH_RAY_EPS)
        .is_some_and(|t| t > PARITY_T_MIN)
}

fn parity_along(mesh: &Mesh, point: Point3<f64>, dir: V3) -> bool {
    let origin = [point.x, point.y, point.z];
    let mut crossings = 0usize;
    for tri in mesh.indices.chunks_exact(3) {
        let Some([a, b, c]) = tri_points(mesh, tri) else {
            continue;
        };
        if forward_crossing(origin, dir, a, b, c, MESH_RAY_EPS) {
            crossings += 1;
        }
    }
    crossings % 2 == 1
}

/// Forward-ray crossing parity: `true` when `point` lies inside the closed
/// `mesh`. Casts a ray in a fixed off-axis direction and counts triangle
/// crossings ahead of the origin — an odd count means inside. The skewed
/// direction keeps the ray from grazing axis-aligned shared edges/vertices
/// (the common case for box cutters), so the parity stays reliable.
pub(super) fn point_inside_mesh(mesh: &Mesh, point: Point3<f64>) -> bool {
    parity_along(mesh, point, PARITY_DIR_A)
}

/// `true` when the opening's real solid CONTAINS the host: the host centroid
/// and every host vertex (each pulled slightly inward toward the host centroid
/// so a vertex lying on a face coincident with the cutter still samples
/// strictly inside) lie inside the opening mesh.
///
/// This is the signature of a void that fully consumes its host: the correct
/// boolean result is empty. The exact subtract instead no-ops on the
/// coincident shared faces and returns the host re-triangulated at unchanged
/// volume, so detect containment directly and drop the host.
///
/// Tests the opening's REAL solid, not just its AABB, so it does NOT fire when
/// the opening's bounding box engulfs the host but its actual profile excludes
/// it — there the host vertices fall outside the opening solid and it is kept.
pub(super) fn opening_engulfs_host_solid(host: &Mesh, opening: &Mesh) -> bool {
    if host.indices.is_empty() || opening.indices.is_empty() {
        return false;
    }
    let Some(host_centroid) = mesh_vertex_centroid(host) else {
        return false;
    };
    if !point_inside_mesh(opening, host_centroid) {
        return false;
    }
    // Inset each host vertex by a fixed absolute distance toward the centroid
    // before testing containment. Vertices on a face coincident with the
    // opening boundary must land strictly inside; for a truly engulfing opening
    // even sub-millimetre distances suffice. Using 0.1 % of the host's smallest
    // extent (clamped to [1e-5, 1e-3] model units) keeps the inset smaller than
    // any real gap between a non-engulfing opening and the host, preventing
    // false positives on near-complete openings that leave a narrow border.
    let inset = {
        let mut mn = [f32::INFINITY; 3];
        let mut mx = [f32::NEG_INFINITY; 3];
        for v in host.positions.chunks_exact(3) {
            mn[0] = mn[0].min(v[0]);
            mx[0] = mx[0].max(v[0]);
            mn[1] = mn[1].min(v[1]);
            mx[1] = mx[1].max(v[1]);
            mn[2] = mn[2].min(v[2]);
            mx[2] = mx[2].max(v[2]);
        }
        let min_extent = (0..3)
            .map(|i| (mx[i] - mn[i]) as f64)
            .fold(f64::INFINITY, f64::min);
        (min_extent * 0.001).clamp(1e-5, 1e-3)
    };
    for v in host.positions.chunks_exact(3) {
        let vertex = Point3::new(v[0] as f64, v[1] as f64, v[2] as f64);
        let to_centroid = host_centroid - vertex;
        let dist = to_centroid.norm();
        let sample = if dist > inset {
            vertex + to_centroid * (inset / dist)
        } else {
            host_centroid
        };
        if !point_inside_mesh(opening, sample) {
            return false;
        }
    }
    true
}

/// Centroid (vertex average) of a mesh, or `None` when it has no vertices.
pub(super) fn mesh_vertex_centroid(mesh: &Mesh) -> Option<Point3<f64>> {
    let n = mesh.positions.len() / 3;
    if n == 0 {
        return None;
    }
    let (mut sx, mut sy, mut sz) = (0.0f64, 0.0f64, 0.0f64);
    for chunk in mesh.positions.chunks_exact(3) {
        sx += chunk[0] as f64;
        sy += chunk[1] as f64;
        sz += chunk[2] as f64;
    }
    let inv = 1.0 / n as f64;
    Some(Point3::new(sx * inv, sy * inv, sz * inv))
}


#[cfg(test)]
#[path = "parity_tests.rs"]
mod tests;
