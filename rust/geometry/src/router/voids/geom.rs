// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Pure geometry predicates and frame transforms for void subtraction.
//! GeometryRouter-free helpers shared by the void orchestrator and probe.

use super::{OpeningFrame, NORMALIZE_EPSILON};
use crate::{Error, Mesh, Point3, Result, Vector3};
use nalgebra::{Matrix3, Matrix4};
use rustc_hash::FxHashMap;


/// Extract rotation columns from a 4x4 transform matrix.
pub(super) fn extract_rotation_columns(m: &Matrix4<f64>) -> (Vector3<f64>, Vector3<f64>, Vector3<f64>) {
    (
        Vector3::new(m[(0, 0)], m[(1, 0)], m[(2, 0)]),
        Vector3::new(m[(0, 1)], m[(1, 1)], m[(2, 1)]),
        Vector3::new(m[(0, 2)], m[(1, 2)], m[(2, 2)]),
    )
}

/// Apply rotation from columns to a direction and normalize.
pub(super) fn rotate_and_normalize(
    rot: &(Vector3<f64>, Vector3<f64>, Vector3<f64>),
    dir: &Vector3<f64>,
) -> Result<Vector3<f64>> {
    (rot.0 * dir.x + rot.1 * dir.y + rot.2 * dir.z)
        .try_normalize(NORMALIZE_EPSILON)
        .ok_or_else(|| Error::geometry("Zero-length direction vector".to_string()))
}


/// Pick a unit-vector along the wall's thinnest AABB axis. Used as a
/// last-ditch extrusion direction for the issue #635 AABB fallback when
/// the opening doesn't carry an explicit `IfcDirection`.
#[inline]
pub(super) fn wall_thinnest_axis_dir(wall_min: &Point3<f64>, wall_max: &Point3<f64>) -> Vector3<f64> {
    let ext = [
        (wall_max.x - wall_min.x).abs(),
        (wall_max.y - wall_min.y).abs(),
        (wall_max.z - wall_min.z).abs(),
    ];
    let mut axis = 0;
    for i in 1..3 {
        if ext[i] < ext[axis] {
            axis = i;
        }
    }
    match axis {
        0 => Vector3::new(1.0, 0.0, 0.0),
        1 => Vector3::new(0.0, 1.0, 0.0),
        _ => Vector3::new(0.0, 0.0, 1.0),
    }
}

/// Penetration (depth) axis for a box opening that carries no authored
/// extrusion direction. The cut axis is the one the opening pierces
/// transversally: it extends PAST the host on at least one side. A deep
/// FreeCAD-style cutter is far deeper than the wall is thick, so its THINNEST
/// AABB axis is NOT the depth — picking thinnest there points the through-host
/// cap-flush extension along an in-plane axis, where it latches onto a
/// neighbouring void's reveal facet and grows the hole (issue #1337). Falls
/// back to the thinnest axis (the classic flush wall-thickness cutter that sits
/// inside the host on every axis), preserving prior behaviour for those.
pub(super) fn infer_box_penetration_dir(
    open_min: &Point3<f64>,
    open_max: &Point3<f64>,
    host_min: &Point3<f64>,
    host_max: &Point3<f64>,
) -> Vector3<f64> {
    let o = [
        (open_min.x, open_max.x),
        (open_min.y, open_max.y),
        (open_min.z, open_max.z),
    ];
    let h = [
        (host_min.x, host_max.x),
        (host_min.y, host_max.y),
        (host_min.z, host_max.z),
    ];
    let mut best_axis = usize::MAX;
    let mut best_past = 1.0e-6;
    for a in 0..3 {
        // How far the opening pokes past the host on either side along axis `a`.
        let past = (h[a].0 - o[a].0).max(0.0) + (o[a].1 - h[a].1).max(0.0);
        if past > best_past {
            best_past = past;
            best_axis = a;
        }
    }
    match best_axis {
        0 => Vector3::new(1.0, 0.0, 0.0),
        1 => Vector3::new(0.0, 1.0, 0.0),
        2 => Vector3::new(0.0, 0.0, 1.0),
        // Inside the host on every axis ⇒ flush cutter ⇒ classic thinnest-axis.
        _ => wall_thinnest_axis_dir(open_min, open_max),
    }
}

/// World-axis along the opening MESH's THINNEST AABB extent — the depth direction
/// used to extend a cutter through the host when the opening carries no explicit
/// extrusion direction. (A box opening's thinnest axis is its depth.)
pub(super) fn opening_mesh_thinnest_axis_dir(opening_mesh: &Mesh) -> Vector3<f64> {
    let (mn, mx) = opening_mesh.bounds();
    wall_thinnest_axis_dir(
        &Point3::new(mn.x as f64, mn.y as f64, mn.z as f64),
        &Point3::new(mx.x as f64, mx.y as f64, mx.z as f64),
    )
}

/// Count the disjoint spatial clusters formed by a set of per-item void AABBs.
///
/// Two AABBs join the same cluster when they overlap or touch on every axis
/// (within `TOUCH_EPS`, so adjacent wall-leaf halves of one window count as one
/// cluster); AABBs separated by a real gap on any axis stay in different
/// clusters. Used by `classify_openings` to tell a row of SEPARATE window voids
/// (many clusters → subtract per item) from one void split into touching parts
/// (one cluster → keep merged). See the call site for the #1367 / FZK-Haus
/// rationale. O(n²) union-find; `n` is the void-body count of a single opening
/// (tiny in practice).
pub(super) fn spatial_cluster_count(
    bounds: &[(Point3<f64>, Point3<f64>, Option<Vector3<f64>>)],
) -> usize {
    const TOUCH_EPS: f64 = 1.0e-3; // 1 mm: adjacent faces count as connected
    let n = bounds.len();
    if n <= 1 {
        return n;
    }
    let mut parent: Vec<usize> = (0..n).collect();
    fn find(p: &mut [usize], x: usize) -> usize {
        let mut r = x;
        while p[r] != r {
            r = p[r];
        }
        let mut c = x;
        while p[c] != r {
            let nxt = p[c];
            p[c] = r;
            c = nxt;
        }
        r
    }
    let overlaps = |a: &(Point3<f64>, Point3<f64>, Option<Vector3<f64>>),
                    b: &(Point3<f64>, Point3<f64>, Option<Vector3<f64>>)| {
        a.0.x <= b.1.x + TOUCH_EPS
            && b.0.x <= a.1.x + TOUCH_EPS
            && a.0.y <= b.1.y + TOUCH_EPS
            && b.0.y <= a.1.y + TOUCH_EPS
            && a.0.z <= b.1.z + TOUCH_EPS
            && b.0.z <= a.1.z + TOUCH_EPS
    };
    for i in 0..n {
        for j in (i + 1)..n {
            if overlaps(&bounds[i], &bounds[j]) {
                let (ri, rj) = (find(&mut parent, i), find(&mut parent, j));
                parent[ri] = rj;
            }
        }
    }
    (0..n).filter(|&i| find(&mut parent, i) == i).count()
}

/// Closed-surface check on exact f32 bit coords: every directed edge paired,
/// no degenerate edges. The #2176 lesson — only per-component-watertight solid
/// cutters may join a batched group; an open component poisons the whole
/// group's ray parity (batch admission).
pub(super) fn mesh_is_closed_exact(m: &Mesh) -> bool {
    use std::collections::HashMap;
    let key = |i: u32| {
        let b = i as usize * 3;
        (
            m.positions[b].to_bits(),
            m.positions[b + 1].to_bits(),
            m.positions[b + 2].to_bits(),
        )
    };
    let mut edges: HashMap<_, i64> = HashMap::new();
    for t in m.indices.chunks_exact(3) {
        let k = [key(t[0]), key(t[1]), key(t[2])];
        for (u, v) in [(0usize, 1usize), (1, 2), (2, 0)] {
            if k[u] == k[v] {
                return false; // degenerate edge
            }
            *edges.entry((k[u], k[v])).or_insert(0) += 1;
            *edges.entry((k[v], k[u])).or_insert(0) -= 1;
        }
    }
    !m.indices.is_empty() && edges.values().all(|&c| c == 0)
}

/// Whether `dir` is (essentially) parallel to a world axis.
///
/// This gates the opening-classification fork: an opening only takes the fast
/// world-axis-aligned-AABB `Rectangular` cut path when its extrusion direction
/// AND its inferred frame are axis-aligned; otherwise it is cut as its true
/// oriented box (`DiagonalRectangular` / exact mesh). The AABB of a *rotated*
/// opening box is strictly larger than the box itself, so cutting the AABB
/// removes wall material outside the real opening — leaving a hole that is
/// bigger than the window and skewed to the world grid instead of orthogonal
/// to the wall.
///
/// The tolerance must therefore be TIGHT. The previous value (0.95, ≈ 18°) let
/// a wall rotated in plan by up to ~18° — a façade a few degrees off the
/// project grid, or an entire building rotated relative to the world axes —
/// fall onto the AABB path and over-cut its openings by tens of centimetres
/// (issue #1167, "weird wall hole cutting"). `cos(1°)` keeps genuinely
/// axis-aligned walls — whose direction cosines are exact up to f32 mesh-normal
/// noise (~1e-6 ≈ 0.0001°) — on the fast path with a ~1000× margin, while
/// routing anything rotated by ≥ 1° to the exact oriented cut. At 1° the
/// residual AABB over-cut would be sub-millimetre anyway.
#[inline]
pub(super) fn is_axis_aligned_direction(dir: &Vector3<f64>) -> bool {
    // cos(1°). Deliberately tight — see the doc comment (issue #1167).
    const AXIS_THRESHOLD: f64 = 0.999_847_695;
    dir.x.abs().max(dir.y.abs()).max(dir.z.abs()) > AXIS_THRESHOLD
}

// ── Parametric placement-frame cut helpers (see `try_param_rect_cut`). ───────────

/// Rotate `(x,y,z)` by the orthonormal 3×3 `r` with an explicit, non-FMA dot product
/// so the result is bit-identical native==wasm (the byte-identity contract forbids the
/// fused-multiply-add `nalgebra`'s matrix product may emit).
#[inline]
pub(super) fn rotate_point(r: &Matrix3<f64>, x: f64, y: f64, z: f64) -> [f64; 3] {
    [
        r[(0, 0)] * x + r[(0, 1)] * y + r[(0, 2)] * z,
        r[(1, 0)] * x + r[(1, 1)] * y + r[(1, 2)] * z,
        r[(2, 0)] * x + r[(2, 1)] * y + r[(2, 2)] * z,
    ]
}

/// Index of the smallest half-extent (the wall thickness / penetration axis).
pub(super) fn thin_axis(half: &[f64; 3]) -> usize {
    (0..3)
        .min_by(|&a, &b| half[a].partial_cmp(&half[b]).unwrap())
        .unwrap()
}

/// If `m` is a signed permutation matrix (each row one entry ≈±1, the rest ≈0, with
/// distinct dominant columns), return the per-row `(source-column, sign)` map; else
/// `None`. Used to align an opening's axes with the host frame.
pub(super) fn signed_permutation_map(m: &Matrix3<f64>, tol: f64) -> Option<[(usize, f64); 3]> {
    let mut out = [(0usize, 1.0f64); 3];
    let mut used = [false; 3];
    for i in 0..3 {
        let (mut best, mut best_abs, mut second) = (0usize, 0.0, 0.0);
        for j in 0..3 {
            let a = m[(i, j)].abs();
            if a > best_abs {
                second = best_abs;
                best_abs = a;
                best = j;
            } else if a > second {
                second = a;
            }
        }
        if best_abs < 1.0 - tol || second > tol || used[best] {
            return None;
        }
        used[best] = true;
        out[i] = (best, m[(i, best)].signum());
    }
    Some(out)
}

/// Rotate a world mesh into frame F (`v_F = Rᵀ(v − center)`); small coords. Normals are
/// dropped (the cellular cut recomputes per-face flat normals).
pub(super) fn rotate_mesh_into_frame(mesh: &Mesh, rt: &Matrix3<f64>, center: &Point3<f64>) -> Mesh {
    let mut positions = Vec::with_capacity(mesh.positions.len());
    for c in mesh.positions.chunks_exact(3) {
        let p = rotate_point(
            rt,
            c[0] as f64 - center.x,
            c[1] as f64 - center.y,
            c[2] as f64 - center.z,
        );
        positions.push(p[0] as f32);
        positions.push(p[1] as f32);
        positions.push(p[2] as f32);
    }
    Mesh {
        normals: vec![0.0; positions.len()],
        indices: mesh.indices.clone(),
        rtc_applied: mesh.rtc_applied,
        origin: [0.0; 3],
        positions,
        // Frame-transformed cut intermediate — not an instanceable occurrence,
        // and pre-placement (issue #1474 fields don't apply here either).
    instance_meta: None, local_bounds: None, local_to_world: None }
}

/// Rotate a frame-F mesh into a LOCAL-FRAME world mesh: positions are `R·v_F` (small,
/// near origin — NOT shifted by `center`) and `origin = center`, so `world = origin +
/// position` for the renderer. Keeping positions small is what makes the cut survive
/// f32 storage + `clean_degenerate` at building/national-grid magnitude (a world-coord
/// store there erodes opening seams into holes — see `Mesh::clean_degenerate`).
pub(super) fn rotate_mesh_from_frame(mesh: &Mesh, r: &Matrix3<f64>, center: &Point3<f64>) -> Mesh {
    let mut positions = Vec::with_capacity(mesh.positions.len());
    for c in mesh.positions.chunks_exact(3) {
        let p = rotate_point(r, c[0] as f64, c[1] as f64, c[2] as f64);
        positions.push(p[0] as f32);
        positions.push(p[1] as f32);
        positions.push(p[2] as f32);
    }
    let mut normals = Vec::with_capacity(mesh.normals.len());
    for c in mesh.normals.chunks_exact(3) {
        let p = rotate_point(r, c[0] as f64, c[1] as f64, c[2] as f64);
        normals.push(p[0] as f32);
        normals.push(p[1] as f32);
        normals.push(p[2] as f32);
    }
    Mesh {
        positions,
        normals,
        indices: mesh.indices.clone(),
        rtc_applied: mesh.rtc_applied,
        origin: [center.x, center.y, center.z],
        // Frame-transformed cut intermediate — not an instanceable occurrence,
        // and pre-placement (issue #1474 fields don't apply here either).
    instance_meta: None, local_bounds: None, local_to_world: None }
}

/// Signed volume of a (closed) triangle mesh via the divergence theorem. Used to
/// reconcile a union of parametric boxes against the meshed opening solid by volume.
pub(super) fn mesh_signed_volume(mesh: &Mesh) -> f64 {
    let v = |i: u32| {
        let b = i as usize * 3;
        [
            mesh.positions[b] as f64,
            mesh.positions[b + 1] as f64,
            mesh.positions[b + 2] as f64,
        ]
    };
    mesh.indices
        .chunks_exact(3)
        .map(|t| {
            let (a, b, c) = (v(t[0]), v(t[1]), v(t[2]));
            a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2])
                + a[2] * (b[0] * c[1] - b[1] * c[0])
        })
        .sum::<f64>()
        / 6.0
}

/// Closed-2-manifold self-check (0.1 mm weld): every undirected edge shared by exactly
/// two non-degenerate triangles. The parametric path refuses to emit a cut that fails
/// this, deferring to the exact kernel instead.
pub(super) fn param_cut_watertight(mesh: &Mesh) -> bool {
    let key = |i: u32| -> (i64, i64, i64) {
        let b = i as usize * 3;
        let q = |v: f32| (v as f64 / 1.0e-4).round() as i64;
        (
            q(mesh.positions[b]),
            q(mesh.positions[b + 1]),
            q(mesh.positions[b + 2]),
        )
    };
    let mut edges: FxHashMap<((i64, i64, i64), (i64, i64, i64)), i32> = FxHashMap::default();
    for tri in mesh.indices.chunks_exact(3) {
        let (ka, kb, kc) = (key(tri[0]), key(tri[1]), key(tri[2]));
        if ka == kb || kb == kc || kc == ka {
            continue;
        }
        for (x, y) in [(ka, kb), (kb, kc), (kc, ka)] {
            let e = if x < y { (x, y) } else { (y, x) };
            *edges.entry(e).or_insert(0) += 1;
        }
    }
    !edges.is_empty() && edges.values().all(|&c| c == 2)
}

#[inline]
pub(super) fn mesh_point(mesh: &Mesh, index: u32) -> Option<Point3<f64>> {
    let base = index as usize * 3;
    Some(Point3::new(
        *mesh.positions.get(base)? as f64,
        *mesh.positions.get(base + 1)? as f64,
        *mesh.positions.get(base + 2)? as f64,
    ))
}

/// Möller–Trumbore ray/triangle intersection returning the signed ray
/// parameter `t` (signed distance along `dir` from `origin`), or `None` when
/// the ray misses the triangle or runs parallel to it. `dir` must be
/// normalized. Used by [`host_already_open_along_axis`].
pub(super) fn ray_triangle_param(
    origin: Point3<f64>,
    dir: &Vector3<f64>,
    a: Point3<f64>,
    b: Point3<f64>,
    c: Point3<f64>,
) -> Option<f64> {
    const EPS: f64 = 1e-9;
    let e1 = b - a;
    let e2 = c - a;
    let pvec = dir.cross(&e2);
    let det = e1.dot(&pvec);
    if det.abs() < EPS {
        return None; // ray parallel to the triangle plane
    }
    let inv_det = 1.0 / det;
    let tvec = origin - a;
    let u = tvec.dot(&pvec) * inv_det;
    if !(-EPS..=1.0 + EPS).contains(&u) {
        return None;
    }
    let qvec = tvec.cross(&e1);
    let v = dir.dot(&qvec) * inv_det;
    if v < -EPS || u + v > 1.0 + EPS {
        return None;
    }
    Some(e2.dot(&qvec) * inv_det)
}

/// Whether the infinite line through `point` along `axis` crosses any
/// triangle of `mesh`.
pub(super) fn axis_line_crosses_mesh(mesh: &Mesh, point: Point3<f64>, axis: &Vector3<f64>) -> bool {
    for tri in mesh.indices.chunks_exact(3) {
        let (Some(a), Some(b), Some(c)) = (
            mesh_point(mesh, tri[0]),
            mesh_point(mesh, tri[1]),
            mesh_point(mesh, tri[2]),
        ) else {
            continue;
        };
        if ray_triangle_param(point, axis, a, b, c).is_some() {
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

/// Forward-ray crossing parity: `true` when `point` lies inside the closed
/// `mesh`. Casts a ray in a fixed off-axis direction and counts triangle
/// crossings ahead of the origin — an odd count means inside. The skewed
/// direction keeps the ray from grazing axis-aligned shared edges/vertices
/// (the common case for box cutters), so the parity stays reliable.
pub(super) fn point_inside_mesh(mesh: &Mesh, point: Point3<f64>) -> bool {
    // Irrational-ish, non-axis-aligned direction: avoids exact edge/vertex
    // grazes on the axis-aligned faces that dominate IFC opening boxes.
    let dir = Vector3::new(0.573_257_1, 0.665_412_3, 0.477_889_5);
    let mut crossings = 0usize;
    for tri in mesh.indices.chunks_exact(3) {
        let (Some(a), Some(b), Some(c)) = (
            mesh_point(mesh, tri[0]),
            mesh_point(mesh, tri[1]),
            mesh_point(mesh, tri[2]),
        ) else {
            continue;
        };
        if let Some(t) = ray_triangle_param(point, &dir, a, b, c) {
            if t > 1e-9 {
                crossings += 1;
            }
        }
    }
    crossings % 2 == 1
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

pub(super) fn extent_along_axis(mesh: &Mesh, axis: &Vector3<f64>) -> Option<f64> {
    let mut min = f64::INFINITY;
    let mut max = f64::NEG_INFINITY;
    for chunk in mesh.positions.chunks_exact(3) {
        let p = Vector3::new(chunk[0] as f64, chunk[1] as f64, chunk[2] as f64);
        let projection = p.dot(axis);
        min = min.min(projection);
        max = max.max(projection);
    }
    min.is_finite().then_some(max - min)
}

/// Whether a mesh is a clean axis-aligned (in its own frame) rectangular box —
/// i.e. exactly 6 planar faces forming a bounding parallelepiped. Curved or
/// arched openings produce many distinct triangle normals; rectilinear but
/// non-rectangular openings (e.g. an L-shaped shaft) share the same three axes
/// as a box but split their faces across more than two parallel planes per
/// axis. Both cases must go through full CSG rather than the AABB cutters.
///
/// Matches the anti-parallel merge tolerance used by `infer_opening_frame` so
/// the two helpers agree on what counts as a single axis.
pub(super) fn is_rectangular_box_mesh(mesh: &Mesh) -> bool {
    let mut axes: Vec<Vector3<f64>> = Vec::with_capacity(4);
    let mut tri_axes: Vec<(usize, f64)> = Vec::with_capacity(mesh.indices.len() / 3);
    for tri in mesh.indices.chunks_exact(3) {
        let (Some(p0), Some(p1), Some(p2)) = (
            mesh_point(mesh, tri[0]),
            mesh_point(mesh, tri[1]),
            mesh_point(mesh, tri[2]),
        ) else {
            continue;
        };
        let Some(normal) = (p1 - p0).cross(&(p2 - p0)).try_normalize(NORMALIZE_EPSILON) else {
            continue;
        };
        let axis_index = match axes
            .iter()
            .position(|axis| normal.dot(axis).abs() > 0.98)
        {
            Some(idx) => idx,
            None => {
                if axes.len() >= 3 {
                    return false;
                }
                axes.push(normal);
                axes.len() - 1
            }
        };
        // Signed offset along the merged axis. The merged axis direction is
        // the first normal seen for that group, so opposite faces produce
        // offsets of opposite sign.
        let offset = p0.coords.dot(&axes[axis_index]);
        tri_axes.push((axis_index, offset));
    }
    if axes.len() != 3 {
        return false;
    }

    // The 3 distinct face normals must be mutually orthogonal — otherwise a
    // shape like a trapezoid extrusion (front/back + top/bottom + two slanted
    // sides whose normals are anti-parallel and merge into one axis) would
    // pass with 3 "axes" but not actually be a box. A trapezoid's slanted
    // axis is not perpendicular to the top/bottom axis. Tolerance 0.02 rad
    // matches the 0.98 dot tolerance used above for anti-parallel merging.
    const ORTHOGONAL_DOT_TOL: f64 = 0.02;
    for i in 0..3 {
        for j in (i + 1)..3 {
            if axes[i].dot(&axes[j]).abs() > ORTHOGONAL_DOT_TOL {
                return false;
            }
        }
    }

    // For each axis, the triangle offsets must cluster around exactly 2 values
    // (the two opposite faces of the box). More than 2 distinct planes means
    // the footprint is rectilinear-but-not-rectangular (e.g. an L-shape).
    // Tolerance is 1mm absolute — coarser than float precision but tight
    // enough to distinguish wall positions in any realistic IFC unit.
    const PLANE_TOL: f64 = 1e-3;
    for axis_index in 0..3 {
        let mut planes: Vec<f64> = Vec::with_capacity(3);
        for (idx, offset) in &tri_axes {
            if *idx != axis_index {
                continue;
            }
            if !planes.iter().any(|p| (p - offset).abs() < PLANE_TOL) {
                planes.push(*offset);
                if planes.len() > 2 {
                    return false;
                }
            }
        }
        if planes.len() != 2 {
            return false;
        }
    }
    true
}

pub(super) fn infer_opening_frame(mesh: &Mesh, extrusion_dir: Option<&Vector3<f64>>) -> Option<OpeningFrame> {
    let mut axes: Vec<(Vector3<f64>, f64)> = Vec::new();

    for tri in mesh.indices.chunks_exact(3) {
        let (Some(p0), Some(p1), Some(p2)) = (
            mesh_point(mesh, tri[0]),
            mesh_point(mesh, tri[1]),
            mesh_point(mesh, tri[2]),
        ) else {
            continue;
        };
        let normal_raw = (p1 - p0).cross(&(p2 - p0));
        let weight = normal_raw.norm();
        let Some(mut normal) = normal_raw.try_normalize(NORMALIZE_EPSILON) else {
            continue;
        };

        if let Some((axis, axis_weight)) = axes
            .iter_mut()
            .find(|(axis, _)| normal.dot(axis).abs() > 0.98)
        {
            if normal.dot(axis) < 0.0 {
                normal = -normal;
            }
            if let Some(merged) =
                (*axis * *axis_weight + normal * weight).try_normalize(NORMALIZE_EPSILON)
            {
                *axis = merged;
                *axis_weight += weight;
            }
        } else {
            axes.push((normal, weight));
        }
    }

    if axes.len() < 3 {
        return extrusion_dir.and_then(|dir| OpeningFrame::from_depth(*dir));
    }

    let depth_index =
        if let Some(dir) = extrusion_dir.and_then(|d| d.try_normalize(NORMALIZE_EPSILON)) {
            axes.iter()
                .enumerate()
                .max_by(|(_, (a, _)), (_, (b, _))| a.dot(&dir).abs().total_cmp(&b.dot(&dir).abs()))
                .map(|(index, _)| index)?
        } else {
            axes.iter()
                .enumerate()
                .filter_map(|(index, (axis, _))| extent_along_axis(mesh, axis).map(|e| (index, e)))
                .min_by(|(_, a), (_, b)| a.total_cmp(b))
                .map(|(index, _)| index)?
        };

    let mut depth = axes[depth_index].0;
    if let Some(dir) = extrusion_dir {
        if depth.dot(dir) < 0.0 {
            depth = -depth;
        }
    }

    let mut cross_candidates: Vec<Vector3<f64>> = axes
        .iter()
        .enumerate()
        .filter_map(|(index, (axis, _))| {
            (index != depth_index && axis.dot(&depth).abs() < 0.25).then_some(*axis)
        })
        .collect();

    if cross_candidates.len() < 2 {
        return OpeningFrame::from_depth(depth);
    }

    let mut cross_a = cross_candidates.remove(0);
    cross_a = (cross_a - depth * cross_a.dot(&depth)).try_normalize(NORMALIZE_EPSILON)?;
    let mut cross_b = depth.cross(&cross_a).try_normalize(NORMALIZE_EPSILON)?;
    if cross_b.dot(&cross_candidates[0]) < 0.0 {
        cross_b = -cross_b;
    }

    Some(OpeningFrame {
        depth,
        cross_a,
        cross_b,
    })
}

/// Build a right-handed orthonormal wall frame `[len, up, depth]` from a
/// (roughly horizontal) opening depth axis: `depth` is the wall-thickness /
/// penetration axis, `up` is world +Z, `len` runs along the wall. Returns
/// `None` if `depth` is degenerate or too close to vertical (not a plan-rotated
/// wall). `len × up = depth`, so a box wound for world axes keeps its winding
/// when mapped back. Issue #1167: cutting the openings in this frame makes the
/// wall and its openings axis-aligned, where the exact subtract is clean — the
/// world-space tilted cut at large coordinates fragments badly.
pub(super) fn wall_frame_from_depth(depth: Vector3<f64>) -> Option<[Vector3<f64>; 3]> {
    let d = depth.try_normalize(NORMALIZE_EPSILON)?;
    if d.z.abs() > 0.2 {
        return None; // roof/floor/sloped — not a plan-rotated wall
    }
    let up = Vector3::new(0.0, 0.0, 1.0);
    let len = up.cross(&d).try_normalize(NORMALIZE_EPSILON)?;
    let up = d.cross(&len).try_normalize(NORMALIZE_EPSILON)?; // re-orthogonalise
    // [len, up, d] right-handed: len × up = d.
    Some([len, up, d])
}

/// Express `mesh` in the orthonormal frame `axes = [a, b, c]` about `center`:
/// `p' = [ (p-center)·a, (p-center)·b, (p-center)·c ]`. Centering keeps
/// coordinates small (f32-precise) and the rotation makes a frame-oriented box
/// axis-aligned. [`mesh_from_frame`] is the exact inverse.
pub(super) fn mesh_to_frame(mesh: &Mesh, axes: &[Vector3<f64>; 3], center: Vector3<f64>) -> Mesh {
    let mut positions = Vec::with_capacity(mesh.positions.len());
    for ch in mesh.positions.chunks_exact(3) {
        let p = Vector3::new(ch[0] as f64, ch[1] as f64, ch[2] as f64) - center;
        positions.push(p.dot(&axes[0]) as f32);
        positions.push(p.dot(&axes[1]) as f32);
        positions.push(p.dot(&axes[2]) as f32);
    }
    let mut normals = Vec::with_capacity(mesh.normals.len());
    for ch in mesh.normals.chunks_exact(3) {
        let n = Vector3::new(ch[0] as f64, ch[1] as f64, ch[2] as f64);
        normals.push(n.dot(&axes[0]) as f32);
        normals.push(n.dot(&axes[1]) as f32);
        normals.push(n.dot(&axes[2]) as f32);
    }
    Mesh {
        positions,
        normals,
        indices: mesh.indices.clone(),
        rtc_applied: mesh.rtc_applied,
        origin: mesh.origin,
        // Frame-transformed cut intermediate — not an instanceable occurrence.
        instance_meta: None,
        local_bounds: None,
        local_to_world: None,
    }
}

/// Inverse of [`mesh_to_frame`]: `p = center + x·a + y·b + z·c`.
pub(super) fn mesh_from_frame(mesh: &Mesh, axes: &[Vector3<f64>; 3], center: Vector3<f64>) -> Mesh {
    let mut positions = Vec::with_capacity(mesh.positions.len());
    for ch in mesh.positions.chunks_exact(3) {
        let q = center + axes[0] * ch[0] as f64 + axes[1] * ch[1] as f64 + axes[2] * ch[2] as f64;
        positions.push(q.x as f32);
        positions.push(q.y as f32);
        positions.push(q.z as f32);
    }
    let mut normals = Vec::with_capacity(mesh.normals.len());
    for ch in mesh.normals.chunks_exact(3) {
        let m = axes[0] * ch[0] as f64 + axes[1] * ch[1] as f64 + axes[2] * ch[2] as f64;
        normals.push(m.x as f32);
        normals.push(m.y as f32);
        normals.push(m.z as f32);
    }
    Mesh {
        positions,
        normals,
        indices: mesh.indices.clone(),
        rtc_applied: mesh.rtc_applied,
        origin: mesh.origin,
        // Frame-transformed cut intermediate — not an instanceable occurrence.
        instance_meta: None,
        local_bounds: None,
        local_to_world: None,
    }
}

/// Axis-aligned bounds of `mesh` expressed in the frame `axes` about `center`.
pub(super) fn project_aabb_in_frame(
    mesh: &Mesh,
    axes: &[Vector3<f64>; 3],
    center: Vector3<f64>,
) -> Option<(Point3<f64>, Point3<f64>)> {
    let mut lo = [f64::INFINITY; 3];
    let mut hi = [f64::NEG_INFINITY; 3];
    for ch in mesh.positions.chunks_exact(3) {
        let p = Vector3::new(ch[0] as f64, ch[1] as f64, ch[2] as f64) - center;
        for k in 0..3 {
            let v = p.dot(&axes[k]);
            lo[k] = lo[k].min(v);
            hi[k] = hi[k].max(v);
        }
    }
    // Validate BOTH bounds: a +inf projection lands only in `hi`, so checking
    // `lo` alone could return a non-finite AABB into the cutter path (#1259).
    (lo.iter().all(|v| v.is_finite()) && hi.iter().all(|v| v.is_finite()))
        .then(|| (Point3::new(lo[0], lo[1], lo[2]), Point3::new(hi[0], hi[1], hi[2])))
}
