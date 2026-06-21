// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Void (opening) subtraction: 3D CSG, AABB clipping, and triangle-box intersection.

use super::GeometryRouter;
use crate::csg::{tri_is_needle, ClippingProcessor, Plane, Triangle, TriangleVec};
use crate::mesh::{SubMesh, SubMeshCollection};
use crate::{Error, Mesh, Point3, Result, TessellationQuality, Vector3};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use nalgebra::{Matrix3, Matrix4};
use rustc_hash::{FxHashMap, FxHashSet};

/// Epsilon for normalizing direction vectors (guards against zero-length).
const NORMALIZE_EPSILON: f64 = 1e-12;
/// Minimum opening volume (m³) below which CSG is skipped (degenerate-void filter).
/// 0.0001 m³ ≈ 0.1 litre — filters artefacts while allowing small real openings (e.g. sleeves).
const MIN_OPENING_VOLUME: f64 = 0.0001;
/// Fraction of pre-CSG triangles the result must retain. CSG outputs with fewer
/// triangles than `pre_count / CSG_TRIANGLE_RETENTION_DIVISOR` are rejected as
/// kernel blowups.
const CSG_TRIANGLE_RETENTION_DIVISOR: usize = 4;
/// Minimum triangle count for a valid CSG result.
const MIN_VALID_TRIANGLES: usize = 4;
/// Maximum wrapper depth when drilling through mapped/boolean items to find an extrusion.
const MAX_EXTRUSION_EXTRACT_DEPTH: usize = 32;

/// Extract rotation columns from a 4x4 transform matrix.
fn extract_rotation_columns(m: &Matrix4<f64>) -> (Vector3<f64>, Vector3<f64>, Vector3<f64>) {
    (
        Vector3::new(m[(0, 0)], m[(1, 0)], m[(2, 0)]),
        Vector3::new(m[(0, 1)], m[(1, 1)], m[(2, 1)]),
        Vector3::new(m[(0, 2)], m[(1, 2)], m[(2, 2)]),
    )
}

/// Apply rotation from columns to a direction and normalize.
fn rotate_and_normalize(
    rot: &(Vector3<f64>, Vector3<f64>, Vector3<f64>),
    dir: &Vector3<f64>,
) -> Result<Vector3<f64>> {
    (rot.0 * dir.x + rot.1 * dir.y + rot.2 * dir.z)
        .try_normalize(NORMALIZE_EPSILON)
        .ok_or_else(|| Error::geometry("Zero-length direction vector".to_string()))
}


/// Whether the representation type is geometry we can process.
fn is_body_representation(rep_type: &str) -> bool {
    matches!(
        rep_type,
        "Body"
            | "SweptSolid"
            | "Brep"
            | "CSG"
            | "Clipping"
            | "Tessellation"
            | "MappedRepresentation"
            | "SolidModel"
            | "SurfaceModel"
            | "AdvancedSweptSolid"
            | "AdvancedBrep"
    )
}

/// Pick a unit-vector along the wall's thinnest AABB axis. Used as a
/// last-ditch extrusion direction for the issue #635 AABB fallback when
/// the opening doesn't carry an explicit `IfcDirection`.
#[inline]
fn wall_thinnest_axis_dir(wall_min: &Point3<f64>, wall_max: &Point3<f64>) -> Vector3<f64> {
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

/// World-axis along the opening MESH's THINNEST AABB extent — the depth direction
/// used to extend a cutter through the host when the opening carries no explicit
/// extrusion direction. (A box opening's thinnest axis is its depth.)
fn opening_mesh_thinnest_axis_dir(opening_mesh: &Mesh) -> Vector3<f64> {
    let (mn, mx) = opening_mesh.bounds();
    wall_thinnest_axis_dir(
        &Point3::new(mn.x as f64, mn.y as f64, mn.z as f64),
        &Point3::new(mx.x as f64, mx.y as f64, mx.z as f64),
    )
}

/// Closed-surface check on exact f32 bit coords: every directed edge paired,
/// no degenerate edges. The #2176 lesson — only per-component-watertight solid
/// cutters may join a batched group; an open component poisons the whole
/// group's ray parity (batch admission).
fn mesh_is_closed_exact(m: &Mesh) -> bool {
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


/// Classification of an opening for void subtraction.
#[derive(Clone)]
enum OpeningType {
    /// Rectangular opening with AABB clipping
    /// Fields: (min_bounds, max_bounds, extrusion_direction)
    Rectangular(Point3<f64>, Point3<f64>, Option<Vector3<f64>>),
    /// Diagonal rectangular opening with mesh geometry and a full oriented frame.
    /// The frame preserves roof-window roll, not just the penetration direction.
    DiagonalRectangular(Mesh, OpeningFrame),
    /// Non-rectangular opening (circular, arched, or floor openings with
    /// rotated footprint). Uses full CSG subtraction with the actual mesh
    /// geometry. The AABB + extrusion direction are kept so that callers can
    /// fall back to a rectangular box cut when CSG can't run (issue #635 —
    /// e.g. circular windows whose triangulated profile blows past
    /// `MAX_CSG_POLYGONS_PER_MESH`).
    NonRectangular(Mesh, Point3<f64>, Point3<f64>, Option<Vector3<f64>>),
}

/// World-space basis for an oriented rectangular opening.
#[derive(Clone, Copy)]
struct OpeningFrame {
    depth: Vector3<f64>,
    cross_a: Vector3<f64>,
    cross_b: Vector3<f64>,
}

impl OpeningFrame {
    fn from_depth(depth: Vector3<f64>) -> Option<Self> {
        let depth = depth.try_normalize(NORMALIZE_EPSILON)?;
        let seed = if depth.z.abs() < 0.9 {
            Vector3::new(0.0, 0.0, 1.0)
        } else {
            Vector3::new(0.0, 1.0, 0.0)
        };
        let cross_a = seed.cross(&depth).try_normalize(NORMALIZE_EPSILON)?;
        let cross_b = depth.cross(&cross_a).try_normalize(NORMALIZE_EPSILON)?;
        Some(Self {
            depth,
            cross_a,
            cross_b,
        })
    }

    fn is_axis_aligned(&self) -> bool {
        is_axis_aligned_direction(&self.depth)
            && is_axis_aligned_direction(&self.cross_a)
            && is_axis_aligned_direction(&self.cross_b)
    }
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
fn is_axis_aligned_direction(dir: &Vector3<f64>) -> bool {
    // cos(1°). Deliberately tight — see the doc comment (issue #1167).
    const AXIS_THRESHOLD: f64 = 0.999_847_695;
    dir.x.abs().max(dir.y.abs()).max(dir.z.abs()) > AXIS_THRESHOLD
}

// ── Parametric placement-frame cut helpers (see `try_param_rect_cut`). ───────────

/// Rotate `(x,y,z)` by the orthonormal 3×3 `r` with an explicit, non-FMA dot product
/// so the result is bit-identical native==wasm (the byte-identity contract forbids the
/// fused-multiply-add `nalgebra`'s matrix product may emit).
#[inline]
fn rotate_point(r: &Matrix3<f64>, x: f64, y: f64, z: f64) -> [f64; 3] {
    [
        r[(0, 0)] * x + r[(0, 1)] * y + r[(0, 2)] * z,
        r[(1, 0)] * x + r[(1, 1)] * y + r[(1, 2)] * z,
        r[(2, 0)] * x + r[(2, 1)] * y + r[(2, 2)] * z,
    ]
}

/// Index of the smallest half-extent (the wall thickness / penetration axis).
fn thin_axis(half: &[f64; 3]) -> usize {
    (0..3)
        .min_by(|&a, &b| half[a].partial_cmp(&half[b]).unwrap())
        .unwrap()
}

/// If `m` is a signed permutation matrix (each row one entry ≈±1, the rest ≈0, with
/// distinct dominant columns), return the per-row `(source-column, sign)` map; else
/// `None`. Used to align an opening's axes with the host frame.
fn signed_permutation_map(m: &Matrix3<f64>, tol: f64) -> Option<[(usize, f64); 3]> {
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
fn rotate_mesh_into_frame(mesh: &Mesh, rt: &Matrix3<f64>, center: &Point3<f64>) -> Mesh {
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
    instance_meta: None, }
}

/// Rotate a frame-F mesh into a LOCAL-FRAME world mesh: positions are `R·v_F` (small,
/// near origin — NOT shifted by `center`) and `origin = center`, so `world = origin +
/// position` for the renderer. Keeping positions small is what makes the cut survive
/// f32 storage + `clean_degenerate` at building/national-grid magnitude (a world-coord
/// store there erodes opening seams into holes — see `Mesh::clean_degenerate`).
fn rotate_mesh_from_frame(mesh: &Mesh, r: &Matrix3<f64>, center: &Point3<f64>) -> Mesh {
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
    instance_meta: None, }
}

/// Signed volume of a (closed) triangle mesh via the divergence theorem. Used to
/// reconcile a union of parametric boxes against the meshed opening solid by volume.
fn mesh_signed_volume(mesh: &Mesh) -> f64 {
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
fn param_cut_watertight(mesh: &Mesh) -> bool {
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
fn mesh_point(mesh: &Mesh, index: u32) -> Option<Point3<f64>> {
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
fn ray_triangle_param(
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
fn axis_line_crosses_mesh(mesh: &Mesh, point: Point3<f64>, axis: &Vector3<f64>) -> bool {
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
fn opening_redundant_with_host(host: &Mesh, opening: &Mesh, axis: &Vector3<f64>) -> bool {
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

/// Centroid (vertex average) of a mesh, or `None` when it has no vertices.
fn mesh_vertex_centroid(mesh: &Mesh) -> Option<Point3<f64>> {
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

fn extent_along_axis(mesh: &Mesh, axis: &Vector3<f64>) -> Option<f64> {
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
fn is_rectangular_box_mesh(mesh: &Mesh) -> bool {
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

fn infer_opening_frame(mesh: &Mesh, extrusion_dir: Option<&Vector3<f64>>) -> Option<OpeningFrame> {
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
fn wall_frame_from_depth(depth: Vector3<f64>) -> Option<[Vector3<f64>; 3]> {
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
fn mesh_to_frame(mesh: &Mesh, axes: &[Vector3<f64>; 3], center: Vector3<f64>) -> Mesh {
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
    }
}

/// Inverse of [`mesh_to_frame`]: `p = center + x·a + y·b + z·c`.
fn mesh_from_frame(mesh: &Mesh, axes: &[Vector3<f64>; 3], center: Vector3<f64>) -> Mesh {
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
    }
}

/// Axis-aligned bounds of `mesh` expressed in the frame `axes` about `center`.
fn project_aabb_in_frame(
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

/// Reusable buffers for triangle clipping operations
///
/// This struct eliminates per-triangle allocations in clip_triangle_against_box
/// by reusing Vec buffers across multiple clipping operations.
struct ClipBuffers {
    /// Triangles to output (outside the box)
    result: TriangleVec,
    /// Triangles remaining to be processed
    remaining: TriangleVec,
    /// Next iteration's remaining triangles (swap buffer)
    next_remaining: TriangleVec,
}

impl ClipBuffers {
    /// Create new empty buffers
    fn new() -> Self {
        Self {
            result: TriangleVec::new(),
            remaining: TriangleVec::new(),
            next_remaining: TriangleVec::new(),
        }
    }

    /// Clear all buffers for reuse
    #[inline]
    fn clear(&mut self) {
        self.result.clear();
        self.remaining.clear();
        self.next_remaining.clear();
    }
}

/// Pre-computed per-element void subtraction data.
///
/// Building this is expensive: `classify_openings` re-runs `process_element`
/// on each `IfcOpeningElement`, and clipping-plane extraction resolves the
/// element's representation. Once built, it can be reused across every
/// sub-mesh of the same element without re-doing any of that work, so the
/// per-sub-mesh void path in
/// [`GeometryRouter::process_element_with_submeshes_and_voids`] pays the
/// classification cost once per element rather than once per sub-mesh.
pub(super) struct VoidContext {
    /// All classified openings. The diagonal-opening pass needs the raw list
    /// (unmerged) so its per-item box rotation stays accurate.
    openings: Vec<OpeningType>,
    /// Rectangular openings merged into larger boxes to prevent O(2^N)
    /// triangle growth when many adjacent openings tile a surface.
    merged_openings: Vec<OpeningType>,
    /// Parametric placement-frame cut data (host + reconciled opening boxes),
    /// captured only when `rect_fast::param_enabled()`. Drives the analytic fast
    /// path in `apply_void_context`; `None` defers to the exact kernel.
    param: Option<ParamRectCut>,
}

impl VoidContext {
    fn is_noop(&self) -> bool {
        self.openings.is_empty()
    }

    /// Return a copy of this context with every opening (raw + merged)
    /// translated by `-origin`, i.e. moved from the world frame into the host's
    /// per-element local frame. Used by [`GeometryRouter::apply_void_context`]
    /// so the cutters share the host's local frame for the CSG — the missing
    /// piece that previously made relativizing only the host silently drop cuts.
    fn relativized_by(&self, origin: [f64; 3]) -> VoidContext {
        VoidContext {
            openings: self.openings.iter().map(|o| o.translated(origin)).collect(),
            merged_openings: self
                .merged_openings
                .iter()
                .map(|o| o.translated(origin))
                .collect(),
            // The parametric path runs in the OUTER apply_void_context on the
            // non-relativized world mesh (it makes its own frame), so the
            // relativized context never uses `param` — drop it.
            param: None,
        }
    }
}

/// Translate a cutter mesh's positions by `-origin` in f64 before the f32 store,
/// moving it into the host's local frame. `origin` is carried on the result as
/// zero (the mesh is now expressed in the shared local frame).
fn translate_cutter_mesh(mesh: &Mesh, origin: [f64; 3]) -> Mesh {
    let mut positions = Vec::with_capacity(mesh.positions.len());
    for c in mesh.positions.chunks_exact(3) {
        positions.push((c[0] as f64 - origin[0]) as f32);
        positions.push((c[1] as f64 - origin[1]) as f32);
        positions.push((c[2] as f64 - origin[2]) as f32);
    }
    Mesh {
        positions,
        normals: mesh.normals.clone(),
        indices: mesh.indices.clone(),
        rtc_applied: mesh.rtc_applied,
        origin: [0.0; 3],
    instance_meta: None, }
}

impl OpeningType {
    /// Return a copy translated by `-origin` (world → host-local frame). Bounds
    /// (`Point3`) shift; direction vectors and the oriented `OpeningFrame` are
    /// translation-invariant and pass through unchanged.
    fn translated(&self, origin: [f64; 3]) -> OpeningType {
        let sub = |p: &Point3<f64>| Point3::new(p.x - origin[0], p.y - origin[1], p.z - origin[2]);
        match self {
            OpeningType::Rectangular(min, max, dir) => {
                OpeningType::Rectangular(sub(min), sub(max), *dir)
            }
            OpeningType::DiagonalRectangular(mesh, frame) => {
                OpeningType::DiagonalRectangular(translate_cutter_mesh(mesh, origin), *frame)
            }
            OpeningType::NonRectangular(mesh, min, max, dir) => {
                OpeningType::NonRectangular(translate_cutter_mesh(mesh, origin), sub(min), sub(max), *dir)
            }
        }
    }
}

/// EXACT parametric oriented box of a rectangular extrusion, in WORLD space.
/// `r` columns are the orthonormal world axes (profile-X', profile-Y', extrude);
/// `half` are the half-extents along those axes (XDim/2, YDim/2, Depth/2).
/// Produced by [`GeometryRouter::parametric_rect_probe`].
#[derive(Clone, Copy)]
pub struct RectParam {
    pub r: Matrix3<f64>,
    pub center: Point3<f64>,
    pub half: [f64; 3],
}

/// Captured parametric boxes for a host + its openings (all reconciled to their
/// meshes and sharing the host frame), enabling the analytic placement-frame cut.
/// Built in [`GeometryRouter::build_void_context`] only when `param_enabled()`.
#[derive(Clone)]
struct ParamRectCut {
    host: RectParam,
    openings: Vec<RectParam>,
}

impl GeometryRouter {
    /// Get individual bounding boxes for each representation item in an opening element.
    /// This handles disconnected geometry (e.g., two separate window openings in one IfcOpeningElement)
    /// by returning separate bounds for each item instead of one combined bounding box.

    /// Extract extrusion direction and position transform from IfcExtrudedAreaSolid
    /// Returns (local_direction, position_transform)
    fn extract_extrusion_direction_from_solid(
        &self,
        solid: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Option<(Vector3<f64>, Option<Matrix4<f64>>)> {
        // Get ExtrudedDirection (attribute 2: IfcDirection)
        let direction_attr = solid.get(2)?;
        let direction_entity = decoder.resolve_ref(direction_attr).ok()??;
        let local_dir = self.parse_direction(&direction_entity).ok()?;

        // Get Position transform (attribute 1: IfcAxis2Placement3D)
        let position_transform = if let Some(pos_attr) = solid.get(1) {
            if !pos_attr.is_null() {
                if let Ok(Some(pos_entity)) = decoder.resolve_ref(pos_attr) {
                    if pos_entity.ifc_type == IfcType::IfcAxis2Placement3D {
                        self.parse_axis2_placement_3d(&pos_entity, decoder).ok()
                    } else {
                        None
                    }
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            None
        };

        Some((local_dir, position_transform))
    }

    /// Recursively extract extrusion direction and position transform from representation item
    /// Handles IfcExtrudedAreaSolid, IfcBooleanClippingResult, and IfcMappedItem
    /// Returns (local_direction, position_transform) where direction is in local space
    fn extract_extrusion_direction_recursive(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Option<(Vector3<f64>, Option<Matrix4<f64>>)> {
        let mut current = item.clone();
        let mut visited = FxHashSet::default();
        let mut mapping_chain: Option<Matrix4<f64>> = None;

        for _depth in 0..MAX_EXTRUSION_EXTRACT_DEPTH {
            if !visited.insert(current.id) {
                return None;
            }

            match current.ifc_type {
                IfcType::IfcExtrudedAreaSolid => {
                    let (dir, position_transform) =
                        self.extract_extrusion_direction_from_solid(&current, decoder)?;
                    let combined = match (mapping_chain.as_ref(), position_transform) {
                        (Some(chain), Some(pos)) => Some(chain * pos),
                        (Some(chain), None) => Some(chain.clone()),
                        (None, Some(pos)) => Some(pos),
                        (None, None) => None,
                    };
                    return Some((dir, combined));
                }
                IfcType::IfcBooleanClippingResult | IfcType::IfcBooleanResult => {
                    // FirstOperand (attribute 1) contains base geometry
                    let first_attr = current.get(1)?;
                    current = decoder.resolve_ref(first_attr).ok()??;
                }
                IfcType::IfcMappedItem => {
                    // MappingSource (attribute 0) -> MappedRepresentation -> Items
                    let source_attr = current.get(0)?;
                    let source = decoder.resolve_ref(source_attr).ok()??;
                    // RepresentationMap.MappedRepresentation is attribute 1
                    let rep_attr = source.get(1)?;
                    let rep = decoder.resolve_ref(rep_attr).ok()??;

                    // MappingTarget (attribute 1) -> instance transform
                    if let Some(target_attr) = current.get(1) {
                        if !target_attr.is_null() {
                            if let Ok(Some(target)) = decoder.resolve_ref(target_attr) {
                                if let Ok(map) =
                                    self.parse_cartesian_transformation_operator(&target, decoder)
                                {
                                    mapping_chain = Some(match mapping_chain.take() {
                                        Some(chain) => chain * map,
                                        None => map,
                                    });
                                }
                            }
                        }
                    }

                    // Get first item from representation
                    let items_attr = rep.get(3)?;
                    let items = decoder.resolve_ref_list(items_attr).ok()?;
                    current = items.first()?.clone();
                }
                _ => return None,
            }
        }

        None
    }

    /// Read a rectangular swept area as `(x_dim, y_dim, off_x, off_y, cos, sin)` in the
    /// profile plane. Handles `IfcRectangleProfileDef` (XDim/YDim + 2D Position rotation)
    /// AND an `IfcArbitraryClosedProfileDef` whose outer curve is an axis-aligned 4-point
    /// rectangle polyline (the common Tekla/structural authoring of a rectangular wall).
    /// `None` for any non-rectangular profile → the caller defers to the exact kernel.
    fn read_rect_profile_2d(
        &self,
        profile: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Option<(f64, f64, f64, f64, f64, f64)> {
        match profile.ifc_type {
            IfcType::IfcRectangleProfileDef => {
                let x_dim = profile.get_float(3)?;
                let y_dim = profile.get_float(4)?;
                // Position (attr 2 = IfcAxis2Placement2D): in-plane rotation + offset.
                let (mut cos_t, mut sin_t, mut off_x, mut off_y) = (1.0, 0.0, 0.0, 0.0);
                if let Some(pos_attr) = profile.get(2) {
                    if !pos_attr.is_null() {
                        if let Ok(Some(pos)) = decoder.resolve_ref(pos_attr) {
                            if let Some(loc_attr) = pos.get(0) {
                                if let Ok(Some(loc)) = decoder.resolve_ref(loc_attr) {
                                    if let Some(c) = loc.get(0).and_then(|x| x.as_list()) {
                                        off_x = c.first().and_then(|x| x.as_float()).unwrap_or(0.0);
                                        off_y = c.get(1).and_then(|x| x.as_float()).unwrap_or(0.0);
                                    }
                                }
                            }
                            if let Some(rd_attr) = pos.get(1) {
                                if !rd_attr.is_null() {
                                    if let Ok(Some(rd)) = decoder.resolve_ref(rd_attr) {
                                        if let Some(c) = rd.get(0).and_then(|x| x.as_list()) {
                                            let dx =
                                                c.first().and_then(|x| x.as_float()).unwrap_or(1.0);
                                            let dy =
                                                c.get(1).and_then(|x| x.as_float()).unwrap_or(0.0);
                                            let n = (dx * dx + dy * dy).sqrt();
                                            if n > 1e-12 {
                                                cos_t = dx / n;
                                                sin_t = dy / n;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                Some((x_dim, y_dim, off_x, off_y, cos_t, sin_t))
            }
            IfcType::IfcArbitraryClosedProfileDef => {
                // OuterCurve (attr 2) must be an axis-aligned rectangle polyline.
                let curve = decoder.resolve_ref(profile.get(2)?).ok()??;
                if curve.ifc_type != IfcType::IfcPolyline {
                    return None;
                }
                let pts = decoder.resolve_ref_list(curve.get(0)?).ok()?;
                let mut coords: Vec<(f64, f64)> = Vec::with_capacity(pts.len());
                for p in &pts {
                    let c = p.get(0).and_then(|x| x.as_list())?;
                    coords.push((c.first()?.as_float()?, c.get(1)?.as_float()?));
                }
                // Drop a repeated closing vertex.
                if coords.len() >= 2 {
                    let (f, l) = (coords[0], coords[coords.len() - 1]);
                    if (f.0 - l.0).abs() < 1e-9 && (f.1 - l.1).abs() < 1e-9 {
                        coords.pop();
                    }
                }
                if coords.len() != 4 {
                    return None;
                }
                // General 4-point RECTANGLE — axis-aligned OR rotated in-plane. Compute the
                // oriented box from its edges and fold the in-plane rotation into the frame
                // (`cos_t`/`sin_t`). Tekla / IFC2X3 routinely author rotated-rectangle
                // openings this way, so the old axis-aligned-only check rejected ~90% of
                // them. Axis-aligned is just the cos_t=1, sin_t=0 special case.
                let p = &coords;
                let edge = |i: usize| (p[(i + 1) % 4].0 - p[i].0, p[(i + 1) % 4].1 - p[i].1);
                let len = |e: (f64, f64)| (e.0 * e.0 + e.1 * e.1).sqrt();
                let e0 = edge(0);
                let e1 = edge(1);
                let e2 = edge(2);
                let (xd, yd) = (len(e0), len(e1));
                if xd <= 1e-9 || yd <= 1e-9 {
                    return None;
                }
                // Rectangle: adjacent edges perpendicular AND opposite edges equal length.
                let dot = (e0.0 * e1.0 + e0.1 * e1.1) / (xd * yd);
                if dot.abs() > 0.01 || (len(e2) - xd).abs() > xd * 0.01 + 1e-6 {
                    return None;
                }
                // Local X' = first-edge direction; centre = polygon centroid.
                let (cos_t, sin_t) = (e0.0 / xd, e0.1 / xd);
                let cx = (p[0].0 + p[1].0 + p[2].0 + p[3].0) * 0.25;
                let cy = (p[0].1 + p[1].1 + p[2].1 + p[3].1) * 0.25;
                Some((xd, yd, cx, cy, cos_t, sin_t))
            }
            _ => None,
        }
    }

    /// Items of the element's first non-empty Body/SweptSolid shape representation.
    fn body_representation_items(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Option<Vec<DecodedEntity>> {
        let rep = decoder.resolve_ref(element.get(6)?).ok()??;
        if rep.ifc_type != IfcType::IfcProductDefinitionShape {
            return None;
        }
        let reps = decoder.resolve_ref_list(rep.get(2)?).ok()?;
        for sr in reps {
            if sr.ifc_type != IfcType::IfcShapeRepresentation {
                continue;
            }
            let rt = sr.get(2).and_then(|a| a.as_string()).unwrap_or("");
            if matches!(
                rt,
                "Body" | "SweptSolid" | "SolidModel" | "Clipping" | "AdvancedSweptSolid"
                    | "MappedRepresentation"
            ) {
                if let Ok(items) = decoder.resolve_ref_list(sr.get(3)?) {
                    if !items.is_empty() {
                        return Some(items);
                    }
                }
            }
        }
        None
    }

    /// One representation item → its EXACT oriented box, unwrapping IfcBooleanClippingResult
    /// / IfcMappedItem to the IfcExtrudedAreaSolid. `None` unless it is a rectangular prism.
    /// Frame + extents from the parametrics (× unit_scale, − rtc_offset to match the mesh).
    fn rect_param_from_item(
        &self,
        item: DecodedEntity,
        placement: &Matrix4<f64>,
        decoder: &mut EntityDecoder,
    ) -> Option<RectParam> {
        let mut current = item;
        let mut chain = Matrix4::<f64>::identity();
        let mut visited = FxHashSet::default();
        let solid = loop {
            if !visited.insert(current.id) || visited.len() > MAX_EXTRUSION_EXTRACT_DEPTH {
                return None;
            }
            match current.ifc_type {
                IfcType::IfcExtrudedAreaSolid => break current,
                IfcType::IfcBooleanClippingResult | IfcType::IfcBooleanResult => {
                    current = decoder.resolve_ref(current.get(1)?).ok()??;
                }
                IfcType::IfcMappedItem => {
                    let source = decoder.resolve_ref(current.get(0)?).ok()??;
                    let mapped_rep = decoder.resolve_ref(source.get(1)?).ok()??;
                    if let Some(t) = current.get(1) {
                        if !t.is_null() {
                            if let Ok(Some(te)) = decoder.resolve_ref(t) {
                                if let Ok(m) =
                                    self.parse_cartesian_transformation_operator(&te, decoder)
                                {
                                    chain *= m;
                                }
                            }
                        }
                    }
                    current =
                        decoder.resolve_ref_list(mapped_rep.get(3)?).ok()?.into_iter().next()?;
                }
                _ => return None,
            }
        };

        let profile = decoder.resolve_ref(solid.get(0)?).ok()??;
        let (x_dim, y_dim, off_x, off_y, cos_t, sin_t) =
            self.read_rect_profile_2d(&profile, decoder)?;
        let depth = solid.get_float(3)?;
        if !(x_dim > 0.0 && y_dim > 0.0 && depth > 0.0) {
            return None;
        }
        let solid_pos = match solid.get(1) {
            Some(a) if !a.is_null() => {
                let e = decoder.resolve_ref(a).ok()??;
                self.parse_axis2_placement_3d(&e, decoder).ok()?
            }
            _ => Matrix4::identity(),
        };
        let dir_local = {
            let e = decoder.resolve_ref(solid.get(2)?).ok()??;
            self.parse_direction(&e).ok()?
        };

        let u = Vector3::new(cos_t, sin_t, 0.0);
        let v = Vector3::new(-sin_t, cos_t, 0.0);
        let w = dir_local.try_normalize(1e-12)?;
        let m = placement * chain * solid_pos;
        let rot = m.fixed_view::<3, 3>(0, 0).into_owned();
        let uu = (rot * u).try_normalize(1e-9)?;
        let vv = (rot * v).try_normalize(1e-9)?;
        let ww = (rot * w).try_normalize(1e-9)?;
        let center_local = Point3::new(off_x, off_y, 0.0) + w * (depth * 0.5);
        let center_native = m.transform_point(&center_local);
        let s = self.unit_scale;
        let (rx, ry, rz) = self.rtc_offset;
        Some(RectParam {
            r: Matrix3::from_columns(&[uu, vv, ww]),
            center: Point3::new(
                center_native.x * s - rx,
                center_native.y * s - ry,
                center_native.z * s - rz,
            ),
            half: [x_dim * 0.5 * s, y_dim * 0.5 * s, depth * 0.5 * s],
        })
    }

    /// EXACT boxes for a body that is a UNION OF RECTANGULAR PRISMS (the common Tekla
    /// multi-solid opening): one box per representation item, or `None` if any item is not a
    /// rectangular extrusion. The cellular `rect_fast` cut subtracts the N boxes natively.
    pub fn parametric_rect_probe_all(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Option<Vec<RectParam>> {
        let placement = self
            .get_placement_transform_from_element(element, decoder)
            .ok()?;
        let items = self.body_representation_items(element, decoder)?;
        if items.is_empty() {
            return None;
        }
        let mut boxes = Vec::with_capacity(items.len());
        for item in items {
            boxes.push(self.rect_param_from_item(item, &placement, decoder)?);
        }
        Some(boxes)
    }

    /// PHASE-0 CENSUS (read-only): the EXACT oriented rectangular box of an extruded
    /// element, read from the IFC parametrics (IfcRectangleProfileDef XDim/YDim/Depth +
    /// composed placement axes), NOT inferred from the f32 mesh. Returns `None` unless the
    /// element's body is a single clean IfcRectangleProfileDef extrusion (after unwrapping
    /// IfcBooleanClippingResult / IfcMappedItem). This is the parametric frame + extents the
    /// failed oriented attempt should have used instead of `infer_opening_frame` + mesh-AABB.
    pub fn parametric_rect_probe(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Option<RectParam> {
        let placement = self
            .get_placement_transform_from_element(element, decoder)
            .ok()?;

        // element → IfcProductDefinitionShape → first Body/SweptSolid item.
        let rep = decoder.resolve_ref(element.get(6)?).ok()??;
        if rep.ifc_type != IfcType::IfcProductDefinitionShape {
            return None;
        }
        let reps = decoder.resolve_ref_list(rep.get(2)?).ok()?;
        let mut item = None;
        for sr in reps {
            if sr.ifc_type != IfcType::IfcShapeRepresentation {
                continue;
            }
            let rt = sr.get(2).and_then(|a| a.as_string()).unwrap_or("");
            if !matches!(
                rt,
                "Body" | "SweptSolid" | "SolidModel" | "Clipping" | "AdvancedSweptSolid"
                    | "MappedRepresentation"
            ) {
                continue;
            }
            if let Ok(items) = decoder.resolve_ref_list(sr.get(3)?) {
                // A clean rectangular extrusion is ONE item. A multi-solid body
                // (the probe would otherwise read only the first) must defer so the
                // exact kernel cuts all of it.
                let mut iter = items.into_iter();
                let Some(first) = iter.next() else {
                    continue;
                };
                if iter.next().is_some() {
                    return None;
                }
                item = Some(first);
                break;
            }
        }

        // Unwrap to the IfcExtrudedAreaSolid, accumulating the mapped/clip transform chain.
        let mut current = item?;
        let mut chain = Matrix4::<f64>::identity();
        let mut visited = FxHashSet::default();
        let solid = loop {
            if !visited.insert(current.id) || visited.len() > MAX_EXTRUSION_EXTRACT_DEPTH {
                return None;
            }
            match current.ifc_type {
                IfcType::IfcExtrudedAreaSolid => break current,
                IfcType::IfcBooleanClippingResult | IfcType::IfcBooleanResult => {
                    current = decoder.resolve_ref(current.get(1)?).ok()??;
                }
                IfcType::IfcMappedItem => {
                    let source = decoder.resolve_ref(current.get(0)?).ok()??;
                    let mapped_rep = decoder.resolve_ref(source.get(1)?).ok()??;
                    if let Some(t) = current.get(1) {
                        if !t.is_null() {
                            if let Ok(Some(te)) = decoder.resolve_ref(t) {
                                if let Ok(m) =
                                    self.parse_cartesian_transformation_operator(&te, decoder)
                                {
                                    chain *= m;
                                }
                            }
                        }
                    }
                    current = decoder.resolve_ref_list(mapped_rep.get(3)?).ok()?.into_iter().next()?;
                }
                _ => return None,
            }
        };

        // IfcExtrudedAreaSolid: 0 SweptArea, 1 Position, 2 ExtrudedDirection, 3 Depth.
        let profile = decoder.resolve_ref(solid.get(0)?).ok()??;
        let (x_dim, y_dim, off_x, off_y, cos_t, sin_t) =
            self.read_rect_profile_2d(&profile, decoder)?;
        let depth = solid.get_float(3)?;
        if !(x_dim > 0.0 && y_dim > 0.0 && depth > 0.0) {
            return None;
        }
        let solid_pos = match solid.get(1) {
            Some(a) if !a.is_null() => {
                let e = decoder.resolve_ref(a).ok()??;
                self.parse_axis2_placement_3d(&e, decoder).ok()?
            }
            _ => Matrix4::identity(),
        };
        let dir_local = {
            let e = decoder.resolve_ref(solid.get(2)?).ok()??;
            self.parse_direction(&e).ok()?
        };

        // Box axes in the SOLID-local frame: profile X' / Y' (rotated by the 2D Position)
        // and the extrude direction. Center = profile offset in the solid XY plane, then
        // half the depth along the extrude axis.
        let u = Vector3::new(cos_t, sin_t, 0.0);
        let v = Vector3::new(-sin_t, cos_t, 0.0);
        let w = dir_local.try_normalize(1e-12)?;
        let m = placement * chain * solid_pos;
        let rot = m.fixed_view::<3, 3>(0, 0).into_owned();
        let uu = (rot * u).try_normalize(1e-9)?;
        let vv = (rot * v).try_normalize(1e-9)?;
        let ww = (rot * w).try_normalize(1e-9)?;
        let center_local = Point3::new(off_x, off_y, 0.0) + w * (depth * 0.5);
        let center_native = m.transform_point(&center_local);
        // The whole pipeline applies the model length-unit scale uniformly to final
        // positions; a uniform scale leaves the orthonormal frame R unchanged and scales
        // the center + half-extents. Without this the box is off by the unit factor
        // (e.g. 1000x on a millimetre IFC2X3 Revit model).
        // Match the mesh frame: the mesh/bounds path scales by `unit_scale` AND subtracts
        // the RTC offset (georef re-basing). The center must do BOTH or it is framed
        // around a different origin than the host vertices → spurious defers / wrong cut.
        let s = self.unit_scale;
        let (rx, ry, rz) = self.rtc_offset;
        Some(RectParam {
            r: Matrix3::from_columns(&[uu, vv, ww]),
            center: Point3::new(
                center_native.x * s - rx,
                center_native.y * s - ry,
                center_native.z * s - rz,
            ),
            half: [x_dim * 0.5 * s, y_dim * 0.5 * s, depth * 0.5 * s],
        })
    }

    /// Get per-item meshes for an opening element, transformed to world coordinates.
    /// Uses the same `transform_mesh` path as `process_element` to ensure identical
    /// coordinate handling (ObjectPlacement, unit scaling, conditional RTC offset).
    pub fn get_opening_item_meshes_world(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Vec<Mesh>> {
        let representation_attr = element.get(6).ok_or_else(|| {
            Error::geometry("Element has no representation attribute".to_string())
        })?;
        if representation_attr.is_null() {
            return Ok(vec![]);
        }

        let representation = decoder
            .resolve_ref(representation_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve representation".to_string()))?;
        let representations_attr = representation.get(2).ok_or_else(|| {
            Error::geometry("ProductDefinitionShape missing Representations".to_string())
        })?;
        let representations = decoder.resolve_ref_list(representations_attr)?;

        // Get the same placement transform that apply_placement uses
        let mut placement_transform = self
            .get_placement_transform_from_element(element, decoder)
            .unwrap_or_else(|_| Matrix4::identity());
        self.scale_transform(&mut placement_transform);

        let mut item_meshes = Vec::new();

        for shape_rep in representations {
            if shape_rep.ifc_type != IfcType::IfcShapeRepresentation {
                continue;
            }
            if let Some(rep_type_attr) = shape_rep.get(2) {
                if let Some(rep_type) = rep_type_attr.as_string() {
                    if !is_body_representation(rep_type) {
                        continue;
                    }
                }
            }
            let items_attr = match shape_rep.get(3) {
                Some(attr) => attr,
                None => continue,
            };
            let items = match decoder.resolve_ref_list(items_attr) {
                Ok(items) => items,
                Err(_) => continue,
            };

            for item in items {
                let mut mesh = match self.process_representation_item(&item, decoder) {
                    Ok(m) if !m.is_empty() => m,
                    _ => continue,
                };

                // Keep the host in absolute world/RTC coordinates here: the void cut
                // (`apply_void_context`) matches it against world-coordinate opening
                // cutters, so relativizing the host now would silently break every
                // cut. The per-element local-origin relativization is applied to the
                // CSG OUTPUT instead (shared host+cutter frame).
                self.transform_mesh_world_framed(&mut mesh, &placement_transform, false);

                item_meshes.push(mesh);
            }
        }

        Ok(item_meshes)
    }

    /// Extrusion direction is in world coordinates, normalized
    /// Returns None for extrusion direction if it cannot be extracted (fallback to bounds-only)
    pub fn get_opening_item_bounds_with_direction(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Vec<(Point3<f64>, Point3<f64>, Option<Vector3<f64>>)>> {
        // Get representation (attribute 6 for most building elements)
        let representation_attr = element.get(6).ok_or_else(|| {
            Error::geometry("Element has no representation attribute".to_string())
        })?;

        if representation_attr.is_null() {
            return Ok(vec![]);
        }

        let representation = decoder
            .resolve_ref(representation_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve representation".to_string()))?;

        // Get representations list
        let representations_attr = representation.get(2).ok_or_else(|| {
            Error::geometry("ProductDefinitionShape missing Representations".to_string())
        })?;

        let representations = decoder.resolve_ref_list(representations_attr)?;

        // Get placement transform
        let mut placement_transform = self
            .get_placement_transform_from_element(element, decoder)
            .unwrap_or_else(|_| Matrix4::identity());
        self.scale_transform(&mut placement_transform);

        let mut bounds_list = Vec::new();

        for shape_rep in representations {
            if shape_rep.ifc_type != IfcType::IfcShapeRepresentation {
                continue;
            }

            // Check representation type
            if let Some(rep_type_attr) = shape_rep.get(2) {
                if let Some(rep_type) = rep_type_attr.as_string() {
                    if !is_body_representation(rep_type) {
                        continue;
                    }
                }
            }

            // Get items list
            let items_attr = match shape_rep.get(3) {
                Some(attr) => attr,
                None => continue,
            };

            let items = match decoder.resolve_ref_list(items_attr) {
                Ok(items) => items,
                Err(_) => continue,
            };

            // Process each item separately to get individual bounds
            for item in items {
                // Try to extract extrusion direction recursively (handles wrappers)
                let extrusion_direction = if let Some((local_dir, position_transform)) =
                    self.extract_extrusion_direction_recursive(&item, decoder)
                {
                    // Transform extrusion direction from local to world coordinates
                    if let Some(pos_transform) = position_transform {
                        let pos_rot = extract_rotation_columns(&pos_transform);
                        let world_dir = rotate_and_normalize(&pos_rot, &local_dir)?;

                        let element_rot = extract_rotation_columns(&placement_transform);
                        let final_dir = rotate_and_normalize(&element_rot, &world_dir)?;

                        Some(final_dir)
                    } else {
                        let element_rot = extract_rotation_columns(&placement_transform);
                        let final_dir = rotate_and_normalize(&element_rot, &local_dir)?;

                        Some(final_dir)
                    }
                } else {
                    None
                };

                // Get mesh bounds (same as original function)
                let mesh = match self.process_representation_item(&item, decoder) {
                    Ok(m) if !m.is_empty() => m,
                    _ => continue,
                };

                // Get bounds and transform to world coordinates
                let (mesh_min, mesh_max) = mesh.bounds();

                // Transform corner points to world coordinates
                let corners = [
                    Point3::new(mesh_min.x as f64, mesh_min.y as f64, mesh_min.z as f64),
                    Point3::new(mesh_max.x as f64, mesh_min.y as f64, mesh_min.z as f64),
                    Point3::new(mesh_min.x as f64, mesh_max.y as f64, mesh_min.z as f64),
                    Point3::new(mesh_max.x as f64, mesh_max.y as f64, mesh_min.z as f64),
                    Point3::new(mesh_min.x as f64, mesh_min.y as f64, mesh_max.z as f64),
                    Point3::new(mesh_max.x as f64, mesh_min.y as f64, mesh_max.z as f64),
                    Point3::new(mesh_min.x as f64, mesh_max.y as f64, mesh_max.z as f64),
                    Point3::new(mesh_max.x as f64, mesh_max.y as f64, mesh_max.z as f64),
                ];

                // Transform all corners and compute new AABB
                let transformed: Vec<Point3<f64>> = corners
                    .iter()
                    .map(|p| placement_transform.transform_point(p))
                    .collect();

                let world_min = Point3::new(
                    transformed
                        .iter()
                        .map(|p| p.x)
                        .fold(f64::INFINITY, f64::min),
                    transformed
                        .iter()
                        .map(|p| p.y)
                        .fold(f64::INFINITY, f64::min),
                    transformed
                        .iter()
                        .map(|p| p.z)
                        .fold(f64::INFINITY, f64::min),
                );
                let world_max = Point3::new(
                    transformed
                        .iter()
                        .map(|p| p.x)
                        .fold(f64::NEG_INFINITY, f64::max),
                    transformed
                        .iter()
                        .map(|p| p.y)
                        .fold(f64::NEG_INFINITY, f64::max),
                    transformed
                        .iter()
                        .map(|p| p.z)
                        .fold(f64::NEG_INFINITY, f64::max),
                );

                // Apply RTC offset to opening bounds so they match wall mesh coordinate system
                // Wall mesh positions have RTC subtracted during transform_mesh, so opening bounds must match
                let rtc = self.rtc_offset;
                let rtc_min = Point3::new(
                    world_min.x - rtc.0,
                    world_min.y - rtc.1,
                    world_min.z - rtc.2,
                );
                let rtc_max = Point3::new(
                    world_max.x - rtc.0,
                    world_max.y - rtc.1,
                    world_max.z - rtc.2,
                );

                bounds_list.push((rtc_min, rtc_max, extrusion_direction));
            }
        }

        Ok(bounds_list)
    }

    /// Process element with void subtraction (openings)
    /// Process element with voids using optimized plane clipping
    ///
    /// This approach is more efficient than full 3D CSG for rectangular openings:
    /// 1. Get chamfered wall mesh (preserves chamfered corners)
    /// 2. For each opening, use optimized box cutting with internal face generation
    /// 3. Apply any clipping operations (roof clips) from original representation
    #[inline]
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
    pub fn process_element_with_voids(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
        void_index: &FxHashMap<u32, Vec<u32>>,
    ) -> Result<Mesh> {
        let opening_ids = match void_index.get(&element.id) {
            Some(ids) if !ids.is_empty() => ids,
            _ => {
                return self.process_element(element, decoder);
            }
        };

        let wall_mesh = match self.process_element(element, decoder) {
            Ok(m) => m,
            Err(_) => {
                return self.process_element(element, decoder);
            }
        };

        let mut voided = self.apply_voids_to_mesh(wall_mesh, element, opening_ids, decoder);
        // Clean slivers the CSG cut can introduce at opening seams — same
        // hygiene as the tessellation chokepoints (Mesh::clean_degenerate).
        voided.clean_degenerate();
        // Instancing: a void-cut mesh no longer reproduces its representation's
        // canonical geometry, so it can never be shared. Drop any metadata that
        // rode along from the (pre-cut) mapped item.
        voided.instance_meta = None;
        Ok(voided)
    }

    /// Apply opening subtraction and clipping planes to an already-built mesh.
    ///
    /// Shared entry point used by both the single-mesh path
    /// ([`process_element_with_voids`]) and the per-sub-mesh path
    /// ([`process_element_with_submeshes_and_voids`]). The incoming mesh is
    /// expected to be in the same (world) coordinate space as the element —
    /// i.e. placement already applied — because opening and clip geometry are
    /// resolved in world coordinates.
    ///
    /// Returns the input mesh unchanged when it is invalid or when no
    /// openings/clips apply, so callers never lose their input on a
    /// degenerate opening set.
    pub(super) fn apply_voids_to_mesh(
        &self,
        mesh: Mesh,
        element: &DecodedEntity,
        opening_ids: &[u32],
        decoder: &mut EntityDecoder,
    ) -> Mesh {
        let ctx = self.build_void_context(element, opening_ids, decoder);
        self.apply_void_context(mesh, &ctx, element.id)
    }

    /// Classify openings and extract clipping planes for an element.
    ///
    /// This is the expensive half of void subtraction — it decodes every
    /// `IfcOpeningElement` (running `process_element` on each), classifies
    /// them as rectangular / diagonal / non-rectangular, merges adjacent
    /// rectangles, and transforms clipping planes to world space. The
    /// output is reusable across every sub-mesh of the same element.
    pub(super) fn build_void_context(
        &self,
        element: &DecodedEntity,
        opening_ids: &[u32],
        decoder: &mut EntityDecoder,
    ) -> VoidContext {
        // NOTE (issue #635): we no longer extract `IfcBooleanClippingResult`
        // planes here. They are applied by `BooleanClippingProcessor::process`
        // when building the input mesh (the wall-inversion fix in
        // `processors/boolean.rs` makes the bounded-prism construction
        // correct per IFC); re-applying them as unbounded planes discarded
        // the polygonal bound and chopped off gable peaks (see
        // `apply_void_context` for the full rationale).
        let openings = self.classify_openings(element, opening_ids, decoder);
        let merged_openings = Self::merge_rectangular_openings(&openings);

        // PARAMETRIC fast-path capture (flag-gated, zero cost when off): probe the
        // host + every opening for an exact rectangular box, reconcile each opening
        // box against its mesh, and require all openings to share the host frame. Any
        // miss -> `None` -> the host defers to the exact kernel.
        let param = if crate::rect_fast::param_enabled() {
            self.capture_param_rect(element, opening_ids, decoder)
        } else {
            None
        };

        VoidContext {
            openings,
            merged_openings,
            param,
        }
    }

    /// Build the parametric-cut data for a host + its openings, or `None` if any
    /// precondition fails (host/opening not a clean rect extrusion, opening box
    /// disagrees with its mesh, or an opening does not share the host frame).
    fn capture_param_rect(
        &self,
        element: &DecodedEntity,
        opening_ids: &[u32],
        decoder: &mut EntityDecoder,
    ) -> Option<ParamRectCut> {
        if opening_ids.is_empty() {
            return None;
        }
        let host = self.parametric_rect_probe(element, decoder)?;
        let rt = host.r.transpose();
        let mut openings = Vec::with_capacity(opening_ids.len());
        for &oid in opening_ids {
            let opening = decoder.decode_by_id(oid).ok()?;
            if opening.ifc_type != IfcType::IfcOpeningElement {
                return None;
            }
            // An opening may be a UNION OF RECTANGULAR PRISMS (Tekla multi-solid). Extract
            // every box; each must share the host frame (signed permutation).
            let op_boxes = self.parametric_rect_probe_all(&opening, decoder)?;
            for op in &op_boxes {
                signed_permutation_map(&(rt * op.r), 1.0e-3)?;
            }
            // Reconcile the boxes against the meshed opening by VOLUME: the boxes must
            // account for the opening solid (catches non-rect / overlapping / partial parts).
            if !self.opening_boxes_reconcile(&opening, &op_boxes, decoder) {
                return None;
            }
            openings.extend(op_boxes);
        }
        Some(ParamRectCut { host, openings })
    }

    /// True iff the parametric `boxes` account for the actual meshed opening by VOLUME
    /// (Σ box volume ≈ Σ mesh-shell volume within 3%). For a union of non-overlapping
    /// rectangular prisms (the Tekla multi-solid opening) the mesh volume equals the
    /// box-volume sum; a mismatch flags a non-rect / overlapping / partial part → defer.
    fn opening_boxes_reconcile(
        &self,
        opening: &DecodedEntity,
        boxes: &[RectParam],
        decoder: &mut EntityDecoder,
    ) -> bool {
        if boxes.is_empty() {
            return false;
        }
        let Ok(meshes) = self.get_opening_item_meshes_world(opening, decoder) else {
            return false;
        };
        let mesh_vol: f64 = meshes.iter().map(|m| mesh_signed_volume(m).abs()).sum();
        if mesh_vol < 1.0e-9 {
            return false;
        }
        let box_vol: f64 = boxes
            .iter()
            .map(|b| 8.0 * b.half[0] * b.half[1] * b.half[2])
            .sum();
        let ratio = box_vol / mesh_vol;
        (0.97..1.03).contains(&ratio)
    }

    /// Apply a pre-built `VoidContext` to a single mesh.
    ///
    /// This is the cheap per-mesh half of void subtraction: it re-reads the
    /// mesh bounds (which differ per sub-mesh), extends rectangular openings
    /// along their extrusion axis so they fully penetrate the mesh, then
    /// subtracts every opening through the unified exact-kernel path (with the
    /// per-opening #635 AABB fallback). All the classification work has
    /// already been done in [`GeometryRouter::build_void_context`].
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
    /// PARAMETRIC analytic fast path: subtract the openings as EXACT parametric boxes
    /// in the host's own placement frame (where the rotated wall + windows are
    /// axis-aligned), using the watertight cellular `rect_fast` cut, then rotate the
    /// result back to world. Frame + extents come from the IFC parametrics (not the
    /// mesh), so the cut is the analytic box-minus-boxes solid — ground-truth exact and
    /// MORE correct than the exact kernel on engulfing-opening walls. Fires only on the
    /// gated subset (`ctx.param` captured; host/opening reconciliation, shared-frame,
    /// in-bounds, no-overlap, watertight self-check); any miss returns `None` → exact
    /// kernel. Deterministic f64 → byte-identical native==wasm.
    fn try_param_rect_cut(&self, mesh: &Mesh, ctx: &VoidContext) -> Option<Mesh> {
        let param = ctx.param.as_ref()?;
        let host = &param.host;
        let rt = host.r.transpose();

        // Host expressed in F (small coords) + reconciliation against the real mesh.
        // ORIGIN-AWARE: the mesh may already be in a per-element local frame (wasm
        // defaults `local_frame_enabled()` ON), where positions are relative to
        // `mesh.origin` (world = origin + position). Frame the cut around
        // `center - origin` so host_f = Rᵀ·(world_vertex - center) either way.
        let o = mesh.origin;
        let eff_center = Point3::new(
            host.center.x - o[0],
            host.center.y - o[1],
            host.center.z - o[2],
        );
        let host_f = rotate_mesh_into_frame(mesh, &rt, &eff_center);
        if host_f.positions.is_empty() {
            return None;
        }
        let mut hmn = [f64::INFINITY; 3];
        let mut hmx = [f64::NEG_INFINITY; 3];
        for c in host_f.positions.chunks_exact(3) {
            for k in 0..3 {
                hmn[k] = hmn[k].min(c[k] as f64);
                hmx[k] = hmx[k].max(c[k] as f64);
            }
        }
        for k in 0..3 {
            let ext = hmx[k] - hmn[k];
            let lo = ext.min(2.0 * host.half[k]);
            let hi = ext.max(2.0 * host.half[k]).max(1.0e-9);
            if lo / hi < 0.99 {
                return None;
            }
        }

        // Opening boxes in F with the in-bounds + through-cut handling.
        let mut boxes: Vec<([f64; 3], [f64; 3])> = Vec::with_capacity(param.openings.len());
        for op in &param.openings {
            let map = signed_permutation_map(&(rt * op.r), 1.0e-3)?;
            let cf = rotate_point(
                &rt,
                op.center.x - host.center.x,
                op.center.y - host.center.y,
                op.center.z - host.center.z,
            );
            // The opening must penetrate along the wall's THIN (thickness) axis. If its
            // extrude axis maps to a length/height axis, extending it across the host
            // would wipe out a full slab — defer that case to the exact kernel.
            let pen = (0..3).find(|&i| map[i].0 == 2)?;
            if host.half[pen] > host.half[thin_axis(&host.half)] * 1.05 {
                return None;
            }
            let mut half_f = [0.0f64; 3];
            for i in 0..3 {
                half_f[i] = op.half[map[i].0];
            }
            // In-bounds: the opening must lie within the wall on the in-face axes; an
            // overrun is a partial intersection where box-clamp ≠ exact mesh-intersect.
            for i in 0..3 {
                if i == pen {
                    continue;
                }
                let tol = host.half[i] * 0.01 + 1.0e-4;
                if cf[i] - half_f[i] < -host.half[i] - tol
                    || cf[i] + half_f[i] > host.half[i] + tol
                {
                    return None;
                }
            }
            // Cut the box AS AUTHORED (it is reconciled to equal the opening void), with a
            // tiny margin on the penetration axis to avoid a flush-face coincidence. The
            // earlier full-thickness override over-cut multi-prism openings (each authored
            // box is a thin slice; extending each to the full thickness removes too much).
            let eps = 1.0e-4;
            let mut bmin = [cf[0] - half_f[0], cf[1] - half_f[1], cf[2] - half_f[2]];
            let mut bmax = [cf[0] + half_f[0], cf[1] + half_f[1], cf[2] + half_f[2]];
            bmin[pen] -= eps;
            bmax[pen] += eps;
            boxes.push((bmin, bmax));
        }

        // No-overlap: overlapping cutter boxes can diverge from the union-subtract.
        for a in 0..boxes.len() {
            for b in (a + 1)..boxes.len() {
                let (amn, amx) = boxes[a];
                let (bmn, bmx) = boxes[b];
                if (0..3).all(|i| amn[i] < bmx[i] - 1.0e-4 && bmn[i] < amx[i] - 1.0e-4) {
                    return None;
                }
            }
        }

        let mut stats = crate::rect_fast::RectFastStats::default();
        let cut_f = crate::rect_fast::subtract_rect_openings(&host_f, &boxes, &mut stats)?;
        crate::rect_fast::record_global(&stats);
        let merged = crate::csg::ClippingProcessor::consolidate_coplanar(cut_f);
        // Emit as a local-frame mesh (small positions + origin), then run the SAME
        // hygiene the production output applies — in the small frame, where it is
        // precise — so the self-check sees exactly what downstream will keep.
        let mut out = rotate_mesh_from_frame(&merged, &host.r, &host.center);
        out.clean_degenerate();

        // Self-check: never emit a non-watertight cut; defer to the exact kernel.
        if !param_cut_watertight(&out) {
            return None;
        }
        crate::rect_fast::param_record_fire();
        Some(out)
    }

    pub(super) fn apply_void_context(
        &self,
        mut mesh: Mesh,
        ctx: &VoidContext,
        element_id: u32,
    ) -> Mesh {
        // PARAMETRIC fast path (flag-gated). ORIGIN-AWARE: it handles both the world
        // mesh (origin 0, native default) AND a per-element local-frame mesh (origin != 0,
        // the wasm default — the precision-critical case this path is FOR), since it
        // builds its own frame from the parametrics. Any miss falls through to the exact
        // kernel below unchanged.
        if crate::rect_fast::param_enabled() {
            if let Some(fast) = self.try_param_rect_cut(&mesh, ctx) {
                return fast;
            }
        }

        let origin = mesh.origin;
        if origin == [0.0, 0.0, 0.0] {
            // Legacy/world frame: no relativization needed.
            return self.apply_void_context_inner(mesh, ctx, element_id);
        }
        // Work entirely in the host's local frame (origin 0 on every operand).
        mesh.origin = [0.0, 0.0, 0.0];
        let local_ctx = ctx.relativized_by(origin);
        let mut result = self.apply_void_context_inner(mesh, &local_ctx, element_id);
        result.origin = origin;
        result
    }

    /// Try the analytic rectangular-opening fast path. Returns the watertight
    /// cut mesh iff EVERY merged opening is an axis-aligned `Rectangular`
    /// through-cut and the host is a clean axis-aligned box; otherwise `None`
    /// (→ the exact kernel handles it). A mixed opening set defers the whole
    /// host rather than composing analytic + exact cuts.
    fn try_rect_fast(&self, host: &Mesh, ctx: &VoidContext) -> Option<Mesh> {
        let (wmn, wmx) = host.bounds();
        let wall_min = Point3::new(wmn.x as f64, wmn.y as f64, wmn.z as f64);
        let wall_max = Point3::new(wmx.x as f64, wmx.y as f64, wmx.z as f64);
        let mut boxes: Vec<([f64; 3], [f64; 3])> =
            Vec::with_capacity(ctx.merged_openings.len());
        for op in &ctx.merged_openings {
            match op {
                OpeningType::Rectangular(omn, omx, dir) => {
                    let (fmn, fmx) = match dir {
                        Some(d) => self.extend_opening_along_direction(
                            *omn, *omx, wall_min, wall_max, *d,
                        ),
                        None => (*omn, *omx),
                    };
                    boxes.push(([fmn.x, fmn.y, fmn.z], [fmx.x, fmx.y, fmx.z]));
                }
                _ => return None,
            }
        }
        let mut stats = crate::rect_fast::RectFastStats::default();
        let out = crate::rect_fast::subtract_rect_openings(host, &boxes, &mut stats);
        crate::rect_fast::record_global(&stats);
        // The cellular cut conformingly splits EVERY face by ALL grid lines (so
        // adjacent cells share edges → watertight), which over-fragments faces an
        // opening doesn't reach. Run the result through the SAME coplanar merge
        // the exact path uses (i_overlay union per plane) to collapse those back
        // to minimal triangles — keeps it watertight and un-bloated.
        out.map(crate::csg::ClippingProcessor::consolidate_coplanar)
    }

    /// Cut a plan-rotated wall's openings in the wall's own axis-aligned,
    /// origin-centred frame (issue #1167). Returns `None` (caller uses the
    /// world path) unless an opening supplies a non-axis-aligned, ~horizontal
    /// depth axis (a vertical wall rotated in plan) and every opening carries a
    /// cutter mesh.
    ///
    /// In the wall frame the host and its openings are axis-aligned and near the
    /// origin, so the exact subtract runs in the clean, f32-precise regime a
    /// straight wall enjoys — clean-box openings even reclassify to the
    /// watertight `rect_fast` path. Curved / brep openings keep their mesh and
    /// are subtracted there too. The result is rotated back; the orthonormal,
    /// origin-centred round-trip is identity for untouched geometry. Recursing
    /// into [`Self::apply_void_context_inner`] is safe: in the frame every
    /// opening's depth is +Z (axis-aligned), so this guard returns `None` on the
    /// inner call.
    fn try_cut_wall_local_frame(
        &self,
        mesh: &Mesh,
        ctx: &VoidContext,
        element_id: u32,
    ) -> Option<Mesh> {
        if ctx.merged_openings.is_empty() {
            return None;
        }
        let depth_of = |op: &OpeningType| -> Option<Vector3<f64>> {
            match op {
                OpeningType::DiagonalRectangular(_, f) => Some(f.depth),
                OpeningType::NonRectangular(_, _, _, d) => *d,
                OpeningType::Rectangular(_, _, d) => *d,
            }
        };
        // Define the wall frame from the first opening whose depth is a
        // genuinely rotated, ~horizontal axis. Axis-aligned walls find none and
        // keep their (unchanged) world path.
        let axes = ctx
            .merged_openings
            .iter()
            .filter_map(depth_of)
            .find(|d| !is_axis_aligned_direction(d) && d.z.abs() <= 0.2)
            .and_then(wall_frame_from_depth)?;

        // AABB-only `Rectangular` openings can't be rotated into the frame; a
        // plan-rotated wall never has them (they'd be diagonal), so bail.
        if ctx
            .merged_openings
            .iter()
            .any(|op| matches!(op, OpeningType::Rectangular(..)))
        {
            return None;
        }

        let (mn, mx) = mesh.bounds();
        let center = Vector3::new(
            ((mn.x + mx.x) * 0.5) as f64,
            ((mn.y + mx.y) * 0.5) as f64,
            ((mn.z + mx.z) * 0.5) as f64,
        );
        let host_local = mesh_to_frame(mesh, &axes, center);

        let z = Vector3::new(0.0, 0.0, 1.0);
        let mut local_openings: Vec<OpeningType> = Vec::with_capacity(ctx.merged_openings.len());
        for op in &ctx.merged_openings {
            let cutter = match op {
                OpeningType::DiagonalRectangular(m, _) => m,
                OpeningType::NonRectangular(m, _, _, _) => m,
                OpeningType::Rectangular(..) => return None,
            };
            let (lmn, lmx) = project_aabb_in_frame(cutter, &axes, center)?;
            let in_frame =
                |v: Vector3<f64>| Vector3::new(v.dot(&axes[0]), v.dot(&axes[1]), v.dot(&axes[2]));
            // The cutter's own penetration (depth) axis expressed in the wall
            // frame. Drives both the alignment test and — for the exact fallback
            // — the cap-extension direction, which MUST stay faithful to THIS
            // cutter: hardcoding the wall normal would push a misaligned
            // opening's flush/short cap along the wrong axis and carve the wrong
            // prism (#1270 review).
            let frame_depth = match op {
                OpeningType::DiagonalRectangular(_, f) => Some(in_frame(f.depth)),
                OpeningType::NonRectangular(_, _, _, d) => d.map(in_frame),
                OpeningType::Rectangular(..) => None,
            };
            // Whether THIS opening's own oriented box is axis-aligned in the
            // wall frame. The frame is seeded from the FIRST rotated opening
            // (#1167); a second opening tilted differently *in plane* is NOT
            // axis-aligned here, so projecting its frame AABB would over-cut it
            // (#1259 review). Only a clean box whose full frame aligns with the
            // wall frame may take the fast rectangular cut; everything else —
            // brep/curved voids and frame-misaligned boxes alike — keeps its
            // exact (un-rotated, centred) mesh for the subtract.
            let frame_aligned = match op {
                OpeningType::DiagonalRectangular(_, f) => {
                    is_axis_aligned_direction(&in_frame(f.depth))
                        && is_axis_aligned_direction(&in_frame(f.cross_a))
                        && is_axis_aligned_direction(&in_frame(f.cross_b))
                }
                _ => false,
            };
            if frame_aligned {
                local_openings.push(OpeningType::Rectangular(lmn, lmx, Some(z)));
            } else {
                let mesh_local = mesh_to_frame(cutter, &axes, center);
                // Keep this cutter's true depth in the frame; fall back to the
                // wall normal (+Z) only when the opening carried no direction.
                let dir = frame_depth.unwrap_or(z);
                local_openings.push(OpeningType::NonRectangular(mesh_local, lmn, lmx, Some(dir)));
            }
        }
        let local_ctx = VoidContext {
            merged_openings: Self::merge_rectangular_openings(&local_openings),
            openings: local_openings,
            // The local-frame recursion never re-captures the parametric cut
            // (issue #1209): it operates on already-classified openings, so the
            // analytic `param` path is irrelevant here — defer to the exact path.
            param: None,
        };

        let result_local = self.apply_void_context_inner(host_local, &local_ctx, element_id);
        Some(mesh_from_frame(&result_local, &axes, center))
    }

    fn apply_void_context_inner(&self, mesh: Mesh, ctx: &VoidContext, element_id: u32) -> Mesh {
        // Capture the input triangle count + bounds so the per-host
        // diagnostic can flag the "cuts attempted but produced no
        // change" case — the silent-no-op signature when an opening
        // box doesn't intersect the host mesh.
        let tris_before = mesh.triangle_count();
        let host_bounds_capture = {
            let (mn, mx) = mesh.bounds();
            ((mn.x, mn.y, mn.z), (mx.x, mx.y, mx.z))
        };
        if ctx.is_noop() {
            return mesh;
        }

        // LOCAL-FRAME CUT (issue #1167): a vertical wall rotated in plan is cut
        // in its own axis-aligned, origin-centred frame — where the exact
        // subtract is clean and f32-precise — then the result is rotated back.
        // The world-space tilted cut at large coordinates over-cuts and
        // fragments badly. Scoped to plan-rotated walls; everything else falls
        // through to the world path unchanged.
        if let Some(cut) = self.try_cut_wall_local_frame(&mesh, ctx, element_id) {
            return cut;
        }

        let clipper = ClippingProcessor::new();
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
        // snapped; a no-op for already-planar extrusion hosts.
        let mut result = crate::facet_weld::weld_near_coplanar_facets(&mesh);

        // ANALYTIC FAST PATH: an axis-aligned box host whose openings are ALL
        // axis-aligned rectangular through-cuts is subtracted analytically
        // (`rect_fast`), skipping the exact mesh-arrangement kernel — the
        // ~80 s memory-bandwidth-bound void-cut window's dominant cost. Pure
        // optimization: any precondition miss (non-box host, mixed/non-rect
        // openings, near-edge feature) returns `None` and the host falls through
        // to the exact path below unchanged. Fired BEFORE the dense-host
        // subdivision (that workaround is only for the exact kernel).
        if crate::rect_fast::enabled() {
            if let Some(fast) = self.try_rect_fast(&result, ctx) {
                // Same per-host cut-effect snapshot the exact path records below,
                // so fast-path hosts aren't missing from the diagnostics.
                self.record_host_cut_effect(
                    element_id,
                    tris_before,
                    fast.triangle_count(),
                    ctx.merged_openings.len(),
                    host_bounds_capture,
                );
                return fast;
            }
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
        // borrowed `&OpeningType`s below.
        let mut synth_rect: Vec<OpeningType> = Vec::new();
        let mut non_rect_openings: Vec<&OpeningType> = Vec::new();
        for opening in &ctx.merged_openings {
            match opening {
                OpeningType::Rectangular(open_min, open_max, extrusion_dir) => {
                    let (final_min, final_max) = if let Some(dir) = extrusion_dir {
                        self.extend_opening_along_direction(
                            *open_min, *open_max, wall_min, wall_max, *dir,
                        )
                    } else {
                        (*open_min, *open_max)
                    };
                    let box_mesh = Self::make_box_mesh(final_min, final_max);
                    synth_rect.push(OpeningType::NonRectangular(
                        box_mesh,
                        final_min,
                        final_max,
                        *extrusion_dir,
                    ));
                }
                other => non_rect_openings.push(other),
            }
        }
        let all_openings: Vec<&OpeningType> =
            synth_rect.iter().chain(non_rect_openings.iter().copied()).collect();

        // DISJOINT-CUTTER BATCHING: group cutters whose pad-inflated
        // AABBs are pairwise disjoint and subtract each group in ONE conforming
        // arrangement (`ClippingProcessor::subtract_mesh_many`). Sequential
        // per-opening subtraction re-arranges the whole (growing) host once per
        // cutter, and each intermediate f64→f32→snap round-trip re-jitters
        // carve vertices off shared planes so cut N+1 re-cracks what cut N
        // reconciled — many-void walls' compounding open edges and the
        // 16-void slab's ~3.5 s cost. Batching admits only openings that pass
        // the SAME guards as the sequential loop plus per-component
        // watertightness (#2176: an open component poisons the group's ray
        // parity); per-component outward orientation happens inside
        // `mesh_bridge::subtract_many`. Singletons and any group whose batched
        // cut fails its guards — or the kernel's conformity gate:
        // `subtract_mesh_many` rejects a group whose N-ary arrangement left an
        // unrecovered constraint — stay unconsumed and fall through to the
        // per-opening sequential loop below with its full #635 fallback /
        // engulf / redundant-void machinery.
        let mut batch_consumed: Vec<bool> = vec![false; all_openings.len()];
        // Disjoint groups of opening indices (len ≥ 2 only); each is cut
        // INLINE at its first member's position in the sequential loop below,
        // so the relative order of batched vs sequential cutters matches the
        // pure sequential pass — only the order WITHIN a group (mutually
        // disjoint cutters, the provably order-free case) is collapsed.
        let mut batch_groups: Vec<Vec<(usize, Mesh)>> = Vec::new();
        let mut batch_group_of: FxHashMap<usize, usize> = FxHashMap::default();
        // Set on every successful cut; while false, a group's admission-time
        // extended cutters are still valid and reused verbatim.
        let mut host_mutated = false;
        if all_openings.len() >= 2 {
            // Inflation pad: ≥ 2×(promote band 8·2⁻¹⁶ ≈ 122 µm + snap radius);
            // 1 mm is conservative and far below any real opening separation.
            // Touching/overlapping cutters land in DIFFERENT groups, cut in
            // sequence — overlap degrades gracefully to sequential behavior.
            const BATCH_PAD: f64 = 1.0e-3;
            struct Cand {
                idx: usize,
                /// The admission-time extended cutter (host PRE-cut). Reused at
                /// cut time while the host is still unmutated — the common case
                /// (groups are cut at their FIRST member, usually before any
                /// sequential cut) — so extension isn't paid twice.
                mesh: Mesh,
                lo: [f64; 3],
                hi: [f64; 3],
            }
            let mut cands: Vec<Cand> = Vec::new();
            for (idx, opening) in all_openings.iter().enumerate() {
                let norm: Option<(&Mesh, Option<Vector3<f64>>)> = match **opening {
                    OpeningType::Rectangular(..) => None,
                    OpeningType::DiagonalRectangular(ref m, ref f) => Some((m, Some(f.depth))),
                    OpeningType::NonRectangular(ref m, _, _, ref d) => Some((m, *d)),
                };
                let Some((opening_mesh, extrusion_dir)) = norm else { continue };
                // Same admission guards as the sequential loop.
                let opening_valid = !opening_mesh.is_empty()
                    && opening_mesh.positions.iter().all(|&v| v.is_finite())
                    && opening_mesh.positions.len() >= 9;
                if !opening_valid {
                    continue;
                }
                let (result_min, result_max) = result.bounds();
                let (omn, omx) = opening_mesh.bounds();
                let no_overlap = omx.x < result_min.x
                    || omn.x > result_max.x
                    || omx.y < result_min.y
                    || omn.y > result_max.y
                    || omx.z < result_min.z
                    || omn.z > result_max.z;
                if no_overlap {
                    continue;
                }
                let open_vol = (omx.x - omn.x) as f64
                    * (omx.y - omn.y) as f64
                    * (omx.z - omn.z) as f64;
                if open_vol < MIN_OPENING_VOLUME {
                    continue;
                }
                let depth_dir = extrusion_dir
                    .filter(|d| d.norm() > NORMALIZE_EPSILON)
                    .unwrap_or_else(|| opening_mesh_thinnest_axis_dir(opening_mesh));
                let ext =
                    Self::extend_opening_mesh_through_host(opening_mesh, &result, depth_dir);
                // #2176: only per-component-watertight solids may join a group.
                if !mesh_is_closed_exact(&ext) {
                    continue;
                }
                let (lo, hi) = ext.bounds();
                // Engulf-class exclusion: a cutter whose extended AABB covers
                // the whole host on EVERY axis (3% slack, the sequential
                // engulf test) stays on the sequential path, where the
                // near-engulf and redundant-void guards live — batched it can
                // shave the host's outer shell (the #559171-family residual).
                let engulfs = {
                    let tol = 0.03_f64;
                    let covers = |omin: f64, omax: f64, wmin: f64, wmax: f64| {
                        let slack = (wmax - wmin).abs().max(1.0e-9) * tol;
                        omin <= wmin + slack && omax >= wmax - slack
                    };
                    covers(lo.x as f64, hi.x as f64, wall_min.x, wall_max.x)
                        && covers(lo.y as f64, hi.y as f64, wall_min.y, wall_max.y)
                        && covers(lo.z as f64, hi.z as f64, wall_min.z, wall_max.z)
                };
                if engulfs {
                    continue;
                }
                cands.push(Cand {
                    idx,
                    mesh: ext,
                    lo: [
                        lo.x as f64 - BATCH_PAD,
                        lo.y as f64 - BATCH_PAD,
                        lo.z as f64 - BATCH_PAD,
                    ],
                    hi: [
                        hi.x as f64 + BATCH_PAD,
                        hi.y as f64 + BATCH_PAD,
                        hi.z as f64 + BATCH_PAD,
                    ],
                });
            }
            // Greedy disjoint grouping, deterministic in opening order: a
            // candidate joins the first group whose EVERY member's inflated
            // AABB is disjoint from its own.
            let mut groups: Vec<Vec<usize>> = Vec::new();
            'cand: for ci in 0..cands.len() {
                for g in groups.iter_mut() {
                    let disjoint_from_all = g.iter().all(|&cj| {
                        let (a, b) = (&cands[ci], &cands[cj]);
                        a.hi[0] < b.lo[0]
                            || a.lo[0] > b.hi[0]
                            || a.hi[1] < b.lo[1]
                            || a.lo[1] > b.hi[1]
                            || a.hi[2] < b.lo[2]
                            || a.lo[2] > b.hi[2]
                    });
                    if disjoint_from_all {
                        g.push(ci);
                        continue 'cand;
                    }
                }
                groups.push(vec![ci]);
            }
            for g in &groups {
                if g.len() < 2 {
                    continue; // singleton: sequential loop handles it (full guards)
                }
                let gid = batch_groups.len();
                for &ci in g {
                    batch_group_of.insert(cands[ci].idx, gid);
                }
                batch_groups
                    .push(g.iter().map(|&ci| (cands[ci].idx, cands[ci].mesh.clone())).collect());
            }
        }

        for (opening_idx, opening) in all_openings.iter().enumerate() {
            if batch_consumed[opening_idx] {
                continue; // already cut as part of a batched disjoint group
            }
            // Batched group cut, attempted ONCE, inline at the group's first
            // member — so the relative order of batched vs sequential cutters
            // matches the pure sequential pass. On any failure (admission,
            // guards, or the kernel's conformity gate) the members fall back
            // to the per-opening sequential path below.
            if let Some(&gid) = batch_group_of.get(&opening_idx) {
                let members = std::mem::take(&mut batch_groups[gid]);
                if members.len() >= 2 {
                    // While the host is unmutated, the admission-time extended
                    // cutters (built against this exact host) are reused as-is;
                    // after any cut, members are re-extended against the
                    // CURRENT host — matching the sequential loop's reference,
                    // which extends each cutter against the (k−1)-cut host.
                    let mut extended: Vec<(usize, Mesh)> = Vec::with_capacity(members.len());
                    let mut admissible = true;
                    if !host_mutated {
                        extended = members;
                    } else {
                        for &(m_idx, _) in &members {
                            let norm: Option<(&Mesh, Option<Vector3<f64>>)> =
                                match *all_openings[m_idx] {
                                    OpeningType::Rectangular(..) => None,
                                    OpeningType::DiagonalRectangular(ref m, ref f) => {
                                        Some((m, Some(f.depth)))
                                    }
                                    OpeningType::NonRectangular(ref m, _, _, ref d) => {
                                        Some((m, *d))
                                    }
                                };
                            let Some((opening_mesh, extrusion_dir)) = norm else {
                                admissible = false;
                                break;
                            };
                            let depth_dir = extrusion_dir
                                .filter(|d| d.norm() > NORMALIZE_EPSILON)
                                .unwrap_or_else(|| opening_mesh_thinnest_axis_dir(opening_mesh));
                            let ext = Self::extend_opening_mesh_through_host(
                                opening_mesh,
                                &result,
                                depth_dir,
                            );
                            // the re-extended cutter must stay watertight (#2176)
                            if !mesh_is_closed_exact(&ext) {
                                admissible = false;
                                break;
                            }
                            extended.push((m_idx, ext));
                        }
                    }
                    if admissible {
                        let cutters: Vec<&Mesh> = extended.iter().map(|(_, m)| m).collect();
                        let tri_before = result.triangle_count();
                        if let Ok(csg_result) = clipper.subtract_mesh_many(&result, &cutters) {
                            let min_tris = (tri_before / CSG_TRIANGLE_RETENTION_DIVISOR)
                                .max(MIN_VALID_TRIANGLES);
                            let changed = csg_result.triangle_count() != tri_before;
                            if !csg_result.is_empty()
                                && csg_result.triangle_count() >= min_tris
                                && changed
                            {
                                result = csg_result;
                                host_mutated = true;
                                for &(m_idx, _) in &extended {
                                    batch_consumed[m_idx] = true;
                                }
                            }
                        }
                    }
                }
                if batch_consumed[opening_idx] {
                    continue; // this opening was cut with its group
                }
            }
            // Normalize both exact-subtract variants into the same (mesh, min,
            // max, dir) shape. `DiagonalRectangular` (a clean but tilted box —
            // e.g. a roof-slope window or a slanted roof opening, #1007 defect B)
            // is a REAL solid cutter, so it MUST be subtracted exactly, never
            // approximated by a frame-rotated AABB: that legacy path
            // (`apply_diagonal_openings`) tore the host (101 boundary edges) and
            // left the void uncut. Route it through the same exact-mesh subtract
            // as `NonRectangular`; the kernel cuts the tilted box cleanly
            // (winding-robust after the defect-A orient-outward fix). The
            // mesh-bounds AABB + frame-depth direction still seed the #635
            // fallback, which only fires if the exact subtract no-ops.
            let normalized: Option<(&Mesh, Point3<f64>, Point3<f64>, Option<Vector3<f64>>)> =
                match *opening {
                    OpeningType::Rectangular(..) => None,
                    OpeningType::DiagonalRectangular(ref opening_mesh, ref frame) => {
                        let (mn, mx) = opening_mesh.bounds();
                        Some((
                            opening_mesh,
                            Point3::new(mn.x as f64, mn.y as f64, mn.z as f64),
                            Point3::new(mx.x as f64, mx.y as f64, mx.z as f64),
                            Some(frame.depth),
                        ))
                    }
                    OpeningType::NonRectangular(
                        ref opening_mesh,
                        ref open_min_pt,
                        ref open_max_pt,
                        ref extrusion_dir,
                    ) => Some((opening_mesh, *open_min_pt, *open_max_pt, *extrusion_dir)),
                };
            if let Some((opening_mesh, open_min_pt, open_max_pt, extrusion_dir)) = normalized {
                let open_min_pt = &open_min_pt;
                let open_max_pt = &open_max_pt;
                {
                    let opening_valid = !opening_mesh.is_empty()
                        && opening_mesh.positions.iter().all(|&v| v.is_finite())
                        && opening_mesh.positions.len() >= 9;

                    if !opening_valid {
                        continue;
                    }

                    let (result_min, result_max) = result.bounds();
                    let (open_min_f32, open_max_f32) = opening_mesh.bounds();
                    let no_overlap = open_max_f32.x < result_min.x
                        || open_min_f32.x > result_max.x
                        || open_max_f32.y < result_min.y
                        || open_min_f32.y > result_max.y
                        || open_max_f32.z < result_min.z
                        || open_min_f32.z > result_max.z;
                    if no_overlap {
                        continue;
                    }

                    let open_vol = (open_max_f32.x - open_min_f32.x)
                        * (open_max_f32.y - open_min_f32.y)
                        * (open_max_f32.z - open_min_f32.z);
                    // The 0.1 L volume floor filtered legacy-BSP CSG artefacts but
                    // also drops genuine small openings — bolt holes / sleeves in
                    // thin plates. At the two highest quality levels keep those
                    // holes (the exact kernel is stable on small cutters); only
                    // reject numerically degenerate cutters there. (issue #976)
                    let min_open_vol = match self.tessellation_quality {
                        TessellationQuality::High | TessellationQuality::Highest => 1e-9_f32,
                        _ => MIN_OPENING_VOLUME as f32,
                    };
                    if open_vol < min_open_vol {
                        continue;
                    }

                    let tri_before = result.triangle_count();
                    let failures_before = clipper.failure_count();
                    let mut csg_succeeded = false;
                    // Tracks whether CSG returned the host *unchanged* (the kernel
                    // either found no real intersection, or errored on a grazing/
                    // coplanar cutter and returned the un-cut host).
                    let mut csg_unchanged = false;
                    // PENETRATING CUTTER (PART A): push the opening's caps a hair
                    // PAST the host along its depth axis so a flush cap becomes a
                    // clean transversal crossing — the exact kernel then cuts the
                    // tilted, faceted roof opening with no bridging sliver (#1007
                    // host #1112). Falls back to the raw opening mesh when no depth
                    // direction is known (the kernel handles a true through-cutter
                    // anyway; the extension only matters for the flush-cap case).
                    let depth_dir = extrusion_dir
                        .filter(|d| d.norm() > NORMALIZE_EPSILON)
                        .unwrap_or_else(|| opening_mesh_thinnest_axis_dir(opening_mesh));
                    let extended_opening = Self::extend_opening_mesh_through_host(
                        opening_mesh,
                        &result,
                        depth_dir,
                    );
                    let cutter = &extended_opening;
                    match clipper.subtract_mesh(&result, cutter) {
                        Ok(csg_result) => {
                            let min_tris = (tri_before / CSG_TRIANGLE_RETENTION_DIVISOR)
                                .max(MIN_VALID_TRIANGLES);
                            // CSG only counts as a success when the result actually
                            // changed (either fewer triangles, indicating polygons
                            // were removed, or more triangles, indicating the
                            // opening was carved as new boundary tris). When the
                            // safety thresholds in `subtract_mesh` short-circuit —
                            // e.g. `MAX_CSG_POLYGONS_PER_MESH` rejects a high-poly
                            // round/curved opening (issue #635) — the host mesh is
                            // returned unchanged, leaving the void uncut.
                            let changed = csg_result.triangle_count() != tri_before;
                            csg_unchanged = !changed;
                            if !csg_result.is_empty()
                                && csg_result.triangle_count() >= min_tris
                                && changed
                            {
                                result = csg_result;
                                host_mutated = true;
                                csg_succeeded = true;
                            }
                        }
                        Err(_) => {}
                    }

                    // AABB fallback (issue #635): when CSG can't subtract the
                    // opening (most commonly because its triangulated profile
                    // exceeds `MAX_CSG_POLYGONS_PER_MESH`, i.e. circular /
                    // arched / arbitrary curved openings), cut the opening's
                    // axis-aligned bounding box instead. This leaves a square
                    // hole in place of a round one, but a square hole is
                    // dramatically less wrong than a missing void on a wall
                    // that is supposed to host a window or door.
                    if !csg_succeeded {
                        let dir = extrusion_dir.or_else(|| {
                            Some(wall_thinnest_axis_dir(&wall_min, &wall_max))
                        });
                        let (final_min, final_max) = if let Some(dir) = dir {
                            self.extend_opening_along_direction(
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
                        let engulfs_host = {
                            let tol = 0.03_f64;
                            let covers = |omin: f64, omax: f64, wmin: f64, wmax: f64| {
                                let slack = (wmax - wmin).abs().max(1.0e-9) * tol;
                                omin <= wmin + slack && omax >= wmax - slack
                            };
                            covers(final_min.x, final_max.x, wall_min.x, wall_max.x)
                                && covers(final_min.y, final_max.y, wall_min.y, wall_max.y)
                                && covers(final_min.z, final_max.z, wall_min.z, wall_max.z)
                        };
                        // Only suppress the fallback when "unchanged" means the
                        // kernel found no real cut (a kernel error / no-overlap on
                        // a grazing engulfing cutter). `capped` keys on the
                        // historical `OperandTooLarge` rejection (issue #635 /
                        // #947): the exact kernel has no operand cap so it is
                        // now always false, but keeping the term costs
                        // nothing and stays correct if a complexity budget ever
                        // records it again.
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
                            opening_redundant_with_host(&result, opening_mesh, &probe_axis);
                        let suppress_fallback =
                            redundant_void || (csg_unchanged && engulfs_host && !capped);
                        if !suppress_fallback {
                            // Diagnostic for issue #635: log the opening
                            // triangle count when the AABB fallback actually
                            // fires, so round windows (post profile
                            // simplification) can be confirmed to hit CSG and
                            // only genuinely-uncut voids land on the box cut.
                            #[cfg(any(debug_assertions, test))]
                            {
                                eprintln!(
                                    "[issue-635] AABB fallback used: opening={} tris (CSG produced no change)",
                                    opening_mesh.triangle_count()
                                );
                            }
                            // Deliberate degraded mode: this fallback removes
                            // the wall material inside the opening AABB but no
                            // longer emits reveal/recess quads (deleted with
                            // the legacy clip path), so its output has an open
                            // rim. Acceptable for a safety net that fired 0x
                            // across the regression corpus — the exact-kernel
                            // path ahead of it emits the reveals itself.
                            let aabb_cut =
                                self.cut_rectangular_opening(&result, final_min, final_max);
                            if !aabb_cut.is_empty() && aabb_cut.triangle_count() != tri_before {
                                result = aabb_cut;
                                host_mutated = true;
                            }
                        }
                    }
                }
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

        // Drain whatever fallbacks the kernel logged during this element's
        // void / clip pass, attribute them to the host product, and stash on
        // the router so the caller can surface them (e.g. flagged in a
        // viewer overlay or asserted in regression tests).
        let kernel_failures = clipper.take_failures();
        if !kernel_failures.is_empty() {
            self.record_host_failure_summary(element_id, &kernel_failures);
            self.record_csg_failures(element_id, kernel_failures);
        }

        // WATERTIGHT SLIVER REFINEMENT (issue #1007): the exact-kernel cut of a
        // long, tilted faceted-BREP host facet can emit a high-aspect corner
        // sliver (a far-corner triangle fanned to two new rim vertices a few cm
        // apart) that lands ALONE in its plane bucket and so bypasses the
        // coplanar CDT. Bisect any >8:1 triangle's longest edge at its midpoint,
        // splitting BOTH incident triangles in lockstep so the mesh stays
        // watertight (no T-junction) and the midpoint lies ON the original edge
        // ⇒ cut volume is preserved exactly. A no-op on clean cuts (no triangle
        // exceeds 8:1), so it does not perturb the frozen corpus. Only runs when
        // a cut was actually attempted (`!ctx.is_noop()` guarantees this path).
        let result = crate::facet_weld::refine_high_aspect_slivers(&result);

        // Per-host cut-effect snapshot: tris_before / tris_after lets the
        // diagnostic surface the silent-no-op case (rectangular boxes
        // processed but the host mesh came out unchanged — the box
        // probably didn't intersect the wall, e.g. wrong placement).
        self.record_host_cut_effect(
            element_id,
            tris_before,
            result.triangle_count(),
            synth_rect.len(),
            host_bounds_capture,
        );

        result
    }

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
        // Layered single-solid path: slice the element's base mesh by its
        // material-layer buildup AFTER subtracting voids. This produces one
        // sub-mesh per layer keyed by IfcMaterial id, so layers show up as
        // individual colors even when the underlying geometry is a single
        // swept solid.
        if let Some(layered) = self.try_layered_sub_meshes(element, decoder, Some(void_index)) {
            return Ok(layered);
        }

        let opening_ids = match void_index.get(&element.id) {
            Some(ids) if !ids.is_empty() => ids.clone(),
            _ => return Ok(SubMeshCollection::new()),
        };

        let sub_meshes = self.process_element_with_submeshes(element, decoder)?;
        if sub_meshes.is_empty() {
            return Ok(SubMeshCollection::new());
        }

        // Classify openings + resolve clipping planes ONCE per element. Doing
        // this per sub-mesh would re-run `process_element` on every opening
        // and re-extract clipping planes N times, multiplying the expensive
        // parsing/CSG setup by the sub-mesh count on the exact elements this
        // path targets (multi-layer walls with windows).
        let ctx = self.build_void_context(element, &opening_ids, decoder);

        let mut voided = SubMeshCollection::new();
        for sub in sub_meshes.sub_meshes {
            let geometry_id = sub.geometry_id;
            let mut voided_mesh = self.apply_void_context(sub.mesh, &ctx, element.id);
            // Same CSG-seam hygiene as the single-mesh void path.
            voided_mesh.clean_degenerate();
            if !voided_mesh.is_empty() {
                voided
                    .sub_meshes
                    .push(SubMesh::new(geometry_id, voided_mesh));
            }
        }

        Ok(voided)
    }

    /// Resolve an AABB + extrusion direction for an opening, used as the
    /// fallback rectangular cut for high-vertex non-rectangular openings
    /// (issue #635). The opening's full mesh AABB is the only safe choice
    /// when we are about to over-approximate with an axis-aligned box —
    /// a per-item bound can miss part of a multi-item opening (e.g. AC20
    /// round windows store two extrusions with offset depths and the
    /// first one alone wouldn't reach all the way through the wall).
    /// The extrusion direction is best-effort from the first item.
    fn fallback_aabb_for_opening(
        &self,
        opening_entity: &DecodedEntity,
        opening_mesh: &Mesh,
        decoder: &mut EntityDecoder,
    ) -> (Point3<f64>, Point3<f64>, Option<Vector3<f64>>) {
        let dir = self
            .get_opening_item_bounds_with_direction(opening_entity, decoder)
            .ok()
            .and_then(|items| items.into_iter().find_map(|(_, _, d)| d));
        let (mn, mx) = opening_mesh.bounds();
        (
            Point3::new(mn.x as f64, mn.y as f64, mn.z as f64),
            Point3::new(mx.x as f64, mx.y as f64, mx.z as f64),
            dir,
        )
    }

    fn classify_openings(
        &self,
        host: &DecodedEntity,
        opening_ids: &[u32],
        decoder: &mut EntityDecoder,
    ) -> Vec<OpeningType> {
        use super::{ClassificationKind, OpeningDiagnostic, OpeningKindDiag};

        // Only treat vertical-extrusion openings as "floor openings" when
        // the host is an actual horizontal-surface element. For walls, a
        // vertical (Z) opening extrusion is just how Revit/Archicad encode
        // door / window openings — it should still take the rectangular
        // AABB clip path. Pre-this-change the heuristic mis-tagged every
        // vertical-extrusion opening as a floor opening, routing wall
        // openings through the (cap-limited, error-prone) CSG path.
        let host_is_horizontal_surface = matches!(
            host.ifc_type,
            IfcType::IfcSlab | IfcType::IfcRoof | IfcType::IfcCovering
        );

        // Per-opening diagnostic accumulator for this host. Pushed to the
        // router's `host_opening_diagnostics` map before we return.
        let mut host_diag: Vec<OpeningDiagnostic> = Vec::with_capacity(opening_ids.len());

        let mut openings: Vec<OpeningType> = Vec::new();
        for &opening_id in opening_ids.iter() {
            let opening_entity = match decoder.decode_by_id(opening_id) {
                Ok(e) => e,
                Err(_) => continue,
            };

            let opening_mesh = match self.process_element(&opening_entity, decoder) {
                Ok(m) if !m.is_empty() => m,
                _ => continue,
            };

            let vertex_count = opening_mesh.positions.len() / 3;

            // Local helper: record both the aggregate counter bump and a
            // per-host diagnostic line in one place. `guard_saved` is the
            // per-opening flag (whether the host-aware floor-opening guard
            // kept this opening on the rectangular path).
            let mut bump = |router: &Self,
                            ck: ClassificationKind,
                            kind: OpeningKindDiag,
                            guard_saved: bool| {
                router.bump_classification(ck);
                host_diag.push(OpeningDiagnostic {
                    opening_id,
                    kind,
                    vertex_count,
                    guard_saved,
                });
            };

            if vertex_count > 100 {
                // High-vertex-count openings (circular / arched / faceted
                // sweeps) won't fit through the BSP CSG safety thresholds,
                // so always carry the per-item AABB + extrusion direction
                // as a fallback (issue #635).
                let (fallback_min, fallback_max, fallback_dir) =
                    self.fallback_aabb_for_opening(&opening_entity, &opening_mesh, decoder);
                bump(
                    self,
                    ClassificationKind::NonRectangular,
                    OpeningKindDiag::NonRectangular,
                    false,
                );
                openings.push(OpeningType::NonRectangular(
                    opening_mesh,
                    fallback_min,
                    fallback_max,
                    fallback_dir,
                ));
            } else {
                let item_bounds_with_dir = self
                    .get_opening_item_bounds_with_direction(&opening_entity, decoder)
                    .unwrap_or_default();

                if !item_bounds_with_dir.is_empty() {
                    // Per-item geometry-driven classification (origin/main).
                    // The earlier "is_floor_opening" host-aware heuristic
                    // (preserved here only via diagnostics) routed every
                    // Z-extruded opening through full CSG, which silently
                    // failed for roof windows on shallow-slope roofs and
                    // left the host uncut. The frame-based DiagonalRectangular
                    // path handles tilted rectangular openings — including
                    // rotated-footprint floor openings — so reserve
                    // NonRectangular for genuinely curved or arched voids.
                    //
                    // The host-is-horizontal flag is no longer used as a
                    // routing signal but is retained as a diagnostic field
                    // so we can still observe the historic guard population
                    // in regression sweeps.
                    let _host_is_horizontal = host_is_horizontal_surface;

                    let item_meshes = self
                        .get_opening_item_meshes_world(&opening_entity, decoder)
                        .unwrap_or_default();

                    if item_meshes.len() == item_bounds_with_dir.len() {
                        for ((min_pt, max_pt, extrusion_dir), item_mesh) in item_bounds_with_dir
                            .into_iter()
                            .zip(item_meshes.into_iter())
                        {
                            let frame = infer_opening_frame(&item_mesh, extrusion_dir.as_ref());
                            let direction_is_diagonal = extrusion_dir
                                .map(|d| !is_axis_aligned_direction(&d))
                                .unwrap_or(false);
                            let is_clean_box = is_rectangular_box_mesh(&item_mesh);

                            if let Some(frame) = frame {
                                if !is_clean_box {
                                    bump(
                                        self,
                                        ClassificationKind::NonRectangular,
                                        OpeningKindDiag::NonRectangular,
                                        false,
                                    );
                                    openings.push(OpeningType::NonRectangular(
                                        item_mesh,
                                        min_pt,
                                        max_pt,
                                        extrusion_dir,
                                    ));
                                } else if direction_is_diagonal || !frame.is_axis_aligned() {
                                    bump(
                                        self,
                                        ClassificationKind::Diagonal,
                                        OpeningKindDiag::Diagonal,
                                        false,
                                    );
                                    openings.push(OpeningType::DiagonalRectangular(
                                        item_mesh, frame,
                                    ));
                                } else {
                                    bump(
                                        self,
                                        ClassificationKind::Rectangular,
                                        OpeningKindDiag::Rectangular,
                                        false,
                                    );
                                    openings.push(OpeningType::Rectangular(
                                        min_pt,
                                        max_pt,
                                        extrusion_dir,
                                    ));
                                }
                            } else if is_clean_box {
                                bump(
                                    self,
                                    ClassificationKind::Rectangular,
                                    OpeningKindDiag::Rectangular,
                                    false,
                                );
                                openings.push(OpeningType::Rectangular(
                                    min_pt,
                                    max_pt,
                                    extrusion_dir,
                                ));
                            } else {
                                bump(
                                    self,
                                    ClassificationKind::NonRectangular,
                                    OpeningKindDiag::NonRectangular,
                                    false,
                                );
                                openings.push(OpeningType::NonRectangular(
                                    item_mesh,
                                    min_pt,
                                    max_pt,
                                    extrusion_dir,
                                ));
                            }
                        }
                    } else {
                        for (min_pt, max_pt, extrusion_dir) in item_bounds_with_dir {
                            bump(
                                self,
                                ClassificationKind::Rectangular,
                                OpeningKindDiag::Rectangular,
                                false,
                            );
                            openings.push(OpeningType::Rectangular(
                                min_pt, max_pt, extrusion_dir,
                            ));
                        }
                    }
                } else {
                    let (open_min, open_max) = opening_mesh.bounds();
                    let min_f64 =
                        Point3::new(open_min.x as f64, open_min.y as f64, open_min.z as f64);
                    let max_f64 =
                        Point3::new(open_max.x as f64, open_max.y as f64, open_max.z as f64);

                    bump(
                        self,
                        ClassificationKind::Rectangular,
                        OpeningKindDiag::Rectangular,
                        false,
                    );
                    openings.push(OpeningType::Rectangular(min_f64, max_f64, None));
                }
            }
        }

        // Stash the per-host diagnostic before returning. `host.ifc_type`
        // implements `Display` to its STEP name (e.g. "IFCWALLSTANDARDCASE").
        if !host_diag.is_empty() {
            self.record_host_opening_diagnostic(
                host.id,
                &format!("{}", host.ifc_type),
                host_diag,
            );
        }

        openings
    }

    /// Merge adjacent/overlapping rectangular openings into larger boxes.
    /// This prevents exponential triangle growth when many small openings
    /// tile a wall surface — each clip creates boundary triangles that get
    /// re-split by the next clip, causing O(2^N) growth.
    fn merge_rectangular_openings(openings: &[OpeningType]) -> Vec<OpeningType> {
        const MERGE_TOLERANCE: f64 = 0.01; // 1cm tolerance for adjacency

        // Separate rectangular and non-rectangular openings
        let mut rects: Vec<(Point3<f64>, Point3<f64>, Option<Vector3<f64>>)> = Vec::new();
        let mut others: Vec<OpeningType> = Vec::new();

        for opening in openings {
            match opening {
                OpeningType::Rectangular(min, max, dir) => {
                    rects.push((*min, *max, *dir));
                }
                other => others.push(other.clone()),
            }
        }

        // Iteratively merge overlapping/adjacent rectangles
        let mut merged = true;
        while merged {
            merged = false;
            let mut i = 0;
            while i < rects.len() {
                let mut j = i + 1;
                while j < rects.len() {
                    let (a_min, a_max, _) = &rects[i];
                    let (b_min, b_max, _) = &rects[j];

                    // Check if boxes overlap or are adjacent (within tolerance)
                    let overlaps_x = a_min.x <= b_max.x + MERGE_TOLERANCE
                        && a_max.x >= b_min.x - MERGE_TOLERANCE;
                    let overlaps_y = a_min.y <= b_max.y + MERGE_TOLERANCE
                        && a_max.y >= b_min.y - MERGE_TOLERANCE;
                    let overlaps_z = a_min.z <= b_max.z + MERGE_TOLERANCE
                        && a_max.z >= b_min.z - MERGE_TOLERANCE;

                    // Check direction compatibility before merging
                    let dirs_compatible = match (&rects[i].2, &rects[j].2) {
                        (Some(a), Some(b)) => {
                            let dot = a.x * b.x + a.y * b.y + a.z * b.z;
                            dot.abs() > 0.99 // Nearly parallel directions
                        }
                        (None, None) => true,
                        _ => false, // One has direction, other doesn't
                    };

                    if overlaps_x && overlaps_y && overlaps_z && dirs_compatible {
                        // Merge into box i
                        let dir = rects[i].2;
                        rects[i] = (
                            Point3::new(
                                a_min.x.min(b_min.x),
                                a_min.y.min(b_min.y),
                                a_min.z.min(b_min.z),
                            ),
                            Point3::new(
                                a_max.x.max(b_max.x),
                                a_max.y.max(b_max.y),
                                a_max.z.max(b_max.z),
                            ),
                            dir,
                        );
                        rects.remove(j);
                        merged = true;
                    } else {
                        j += 1;
                    }
                }
                i += 1;
            }
        }

        // Reconstruct the opening list
        let mut result: Vec<OpeningType> = rects
            .into_iter()
            .map(|(min, max, dir)| OpeningType::Rectangular(min, max, dir))
            .collect();
        result.extend(others);
        result
    }

    /// Cut a rectangular opening from a mesh using optimized plane clipping
    ///
    /// This is more efficient than full CSG because:
    /// 1. Only processes triangles that intersect the opening bounds
    /// Extend opening bounds along extrusion direction to match wall extent
    ///
    /// Projects wall corners onto the extrusion axis and extends the opening
    /// min/max to cover the wall's full extent along that direction.
    /// This ensures openings penetrate multi-layer walls correctly without
    /// causing artifacts for angled walls.
    fn extend_opening_along_direction(
        &self,
        open_min: Point3<f64>,
        open_max: Point3<f64>,
        wall_min: Point3<f64>,
        wall_max: Point3<f64>,
        extrusion_direction: Vector3<f64>, // World-space, normalized
    ) -> (Point3<f64>, Point3<f64>) {
        // Use opening center as reference point for projection
        let open_center = Point3::new(
            (open_min.x + open_max.x) * 0.5,
            (open_min.y + open_max.y) * 0.5,
            (open_min.z + open_max.z) * 0.5,
        );

        // Project all 8 corners of the wall box onto the extrusion axis
        let wall_corners = [
            Point3::new(wall_min.x, wall_min.y, wall_min.z),
            Point3::new(wall_max.x, wall_min.y, wall_min.z),
            Point3::new(wall_min.x, wall_max.y, wall_min.z),
            Point3::new(wall_max.x, wall_max.y, wall_min.z),
            Point3::new(wall_min.x, wall_min.y, wall_max.z),
            Point3::new(wall_max.x, wall_min.y, wall_max.z),
            Point3::new(wall_min.x, wall_max.y, wall_max.z),
            Point3::new(wall_max.x, wall_max.y, wall_max.z),
        ];

        // Find min/max projections of wall corners onto extrusion axis
        let mut wall_min_proj = f64::INFINITY;
        let mut wall_max_proj = f64::NEG_INFINITY;

        for corner in &wall_corners {
            // Project corner onto extrusion axis relative to opening center
            let proj = (corner - open_center).dot(&extrusion_direction);
            wall_min_proj = wall_min_proj.min(proj);
            wall_max_proj = wall_max_proj.max(proj);
        }

        // Project opening corners onto extrusion axis
        let open_corners = [
            Point3::new(open_min.x, open_min.y, open_min.z),
            Point3::new(open_max.x, open_min.y, open_min.z),
            Point3::new(open_min.x, open_max.y, open_min.z),
            Point3::new(open_max.x, open_max.y, open_min.z),
            Point3::new(open_min.x, open_min.y, open_max.z),
            Point3::new(open_max.x, open_min.y, open_max.z),
            Point3::new(open_min.x, open_max.y, open_max.z),
            Point3::new(open_max.x, open_max.y, open_max.z),
        ];

        let mut open_min_proj = f64::INFINITY;
        let mut open_max_proj = f64::NEG_INFINITY;

        for corner in &open_corners {
            let proj = (corner - open_center).dot(&extrusion_direction);
            open_min_proj = open_min_proj.min(proj);
            open_max_proj = open_max_proj.max(proj);
        }

        // Extension is a Revit/ArchiCAD heuristic for openings whose authored
        // extrusion depth doesn't quite reach the wall faces — extending the
        // opening along its own extrusion direction makes the cut land
        // cleanly. The heuristic assumes the extrusion direction IS the
        // wall-thickness axis. That assumption breaks in two distinct ways
        // that this gate has to catch:
        //
        // 1. The opening already spans the wall in the extrusion direction
        //    (advanced_model #553029 — a 300 mm horizontal slab extruded
        //    along +Z, the wall's height axis, that already covers the full
        //    wall cross-section). Extension stretches the opening to span
        //    the entire wall.
        //
        // 2. The opening's extrusion direction maps (after the opening's
        //    own `IfcAxis2Placement3D` rotation) to the wall's LONG axis,
        //    not the wall thickness axis (advanced_model #612334 — a 115 mm
        //    column whose IfcExtrudedAreaSolid extrudes a 3.4 m profile by
        //    115 mm, with a Position transform that rotates local +Z to
        //    world +X = the wall's 11.8 m long axis). Pre-fix, the opening
        //    depth equalled wall thickness so the symmetric form of (1)
        //    didn't catch it; extension along +X stretched the opening to
        //    cover the full 11.8 m wall length and the boolean cut wiped
        //    the host.
        let opening_proj_extent = (open_max_proj - open_min_proj).abs();
        let wall_extent_x = (wall_max.x - wall_min.x).abs();
        let wall_extent_y = (wall_max.y - wall_min.y).abs();
        let wall_extent_z = (wall_max.z - wall_min.z).abs();
        let wall_min_extent = wall_extent_x.min(wall_extent_y).min(wall_extent_z);
        // Case (1): opening already spans the wall in the extrusion
        // direction. 5% slack covers openings modelled at exactly wall
        // thickness, which we still want on the extension path so a tiny
        // coplanarity pad gets applied.
        if opening_proj_extent > wall_min_extent * 1.05 {
            return (open_min, open_max);
        }
        // Case (2): the wall extends much further along the extrusion
        // direction than ANY dimension of the opening itself. A typical
        // window/door extrusion makes the wall thickness comparable to the
        // opening's other dimensions; an off-axis extrusion makes the wall
        // length or height tower over the opening box. The opening's own
        // longest dimension is the right reference here: if the wall along
        // extrusion exceeds it, we'd be stretching the opening across an
        // axis that wasn't authored to penetrate the wall.
        let opening_max_dim = (open_max.x - open_min.x)
            .abs()
            .max((open_max.y - open_min.y).abs())
            .max((open_max.z - open_min.z).abs());
        let wall_proj_extent = (wall_max_proj - wall_min_proj).abs();
        if wall_proj_extent > opening_max_dim {
            return (open_min, open_max);
        }
        // Case (3): the opening was authored to extend past the wall on at
        // least one side in extrusion direction. This is a partial-overlap
        // "bite" — issue #832, a 1 × 1 × 0.2 m opening offset so half the
        // 0.2 m depth pokes out the wall's +X face. The Revit "extend to
        // reach the opposite wall face" heuristic that follows is only
        // sound when the opening sits ENTIRELY INSIDE the wall along the
        // extrusion axis (the "opening too short" pattern); when the
        // opening already pokes out one side, applying it stretches the
        // box across the full wall thickness and the AABB clip removes
        // BOTH faces — the punched-through slot the bug reporter saw.
        // Compare projections rather than raw coords so the sign of the
        // extrusion direction is irrelevant.
        const POKE_TOL: f64 = 1e-6;
        let opening_pokes_past_wall = open_min_proj < wall_min_proj - POKE_TOL
            || open_max_proj > wall_max_proj + POKE_TOL;
        if opening_pokes_past_wall {
            return (open_min, open_max);
        }

        // Case (4): RECESS / POCKET pattern (issue #853). The opening starts
        // exactly at one of the wall's faces and ends in the interior — the
        // authored intent is a partial-depth bite from one side, not a
        // through-hole. Extending to reach the opposite face converts the
        // pocket into a through-hole (the user's screenshot on #853).
        //
        // IFC4+ models can author this with `IfcOpeningElement.PredefinedType
        // = .RECESS.`, but we don't have a clean path to read that here —
        // and geometry alone disambiguates the case: in a true "opening too
        // short" pattern the opening floats inside the wall (neither end on
        // a face); in a recess one end is on a face and the other is inside.
        // Use coplanarity-pad tolerance so a tiny float-error offset doesn't
        // mask the alignment.
        let face_align_tol = (wall_max_proj - wall_min_proj).abs() * 1e-5;
        let near_at_min_face = (open_min_proj - wall_min_proj).abs() < face_align_tol;
        let near_at_max_face = (open_max_proj - wall_max_proj).abs() < face_align_tol;
        let far_inside_min = open_min_proj > wall_min_proj + face_align_tol;
        let far_inside_max = open_max_proj < wall_max_proj - face_align_tol;
        let is_recess = (near_at_min_face && far_inside_max) || (near_at_max_face && far_inside_min);
        if is_recess {
            return (open_min, open_max);
        }

        // Calculate how much to extend in each direction along the extrusion axis
        // If wall extends beyond opening, we need to extend the opening
        let extend_backward = (open_min_proj - wall_min_proj).max(0.0); // How much wall extends before opening
        let extend_forward = (wall_max_proj - open_max_proj).max(0.0); // How much wall extends after opening

        // Add a tiny padding past the wall on both sides so the opening's near/far
        // faces never end up exactly coplanar with the wall's near/far faces.
        // Exact coplanarity leaves 0-thickness sliver artifacts in the rectangular
        // clip path (the "completely inside" check in cut_rectangular_opening_no_faces
        // uses a tolerance of 1e-6 on each axis). Scaled to wall depth so the pad
        // stays imperceptible across mm/m unit systems.
        //
        // NOTE: the floor MUST be strictly greater than the clipper's EPSILON
        // (1e-6, see `cut_rectangular_opening_no_faces`) — otherwise sub-cm walls
        // can still land on the equality boundary and re-introduce slivers
        // (per CodeRabbit review on PR #605). We pick 1e-5 (10x EPSILON) for a
        // safe margin. For typical walls the *scaled* term dominates anyway
        // (200 mm wall → 2 µm pad).
        // See issue #604.
        let wall_extent_along_dir = (wall_max_proj - wall_min_proj).abs();
        let coplanarity_pad = (wall_extent_along_dir * 1e-5).max(1e-5);
        let extend_backward = extend_backward + coplanarity_pad;
        let extend_forward = extend_forward + coplanarity_pad;

        // Extend opening bounds along the extrusion direction
        let extended_min = open_min - extrusion_direction * extend_backward;
        let extended_max = open_max + extrusion_direction * extend_forward;

        // Create new AABB that encompasses both original opening and extended points
        // This ensures we don't shrink the opening in other dimensions
        let all_points = [open_min, open_max, extended_min, extended_max];

        let new_min = Point3::new(
            all_points.iter().map(|p| p.x).fold(f64::INFINITY, f64::min),
            all_points.iter().map(|p| p.y).fold(f64::INFINITY, f64::min),
            all_points.iter().map(|p| p.z).fold(f64::INFINITY, f64::min),
        );
        let new_max = Point3::new(
            all_points
                .iter()
                .map(|p| p.x)
                .fold(f64::NEG_INFINITY, f64::max),
            all_points
                .iter()
                .map(|p| p.y)
                .fold(f64::NEG_INFINITY, f64::max),
            all_points
                .iter()
                .map(|p| p.z)
                .fold(f64::NEG_INFINITY, f64::max),
        );

        (new_min, new_max)
    }

    /// Push the opening MESH's caps a hair PAST the host along `dir` so a FLUSH
    /// cap interface becomes a clean TRANSVERSAL crossing before the exact-kernel
    /// subtract. Returns the mesh UNCHANGED unless a real flush-cap condition is
    /// present — the conservative default, so a normal through-opening, an
    /// off-axis `dir`, a recess, or an already-poking-through opening is untouched.
    ///
    /// WHY (the #1007 flush roof-opening sliver, PART A): an opening solid whose
    /// cap is authored EXACTLY flush with a host surface meets that surface as a
    /// near-coplanar interface, not a crossing. On a TILTED, f32-imported, faceted
    /// BREP roof the host facets under the cap each sit a fraction of a degree off
    /// the cap plane (~0.1° measured on #1112), so the exact kernel neither sees a
    /// clean transversal crossing NOR an exactly-coplanar pair — it leaves a sliver
    /// bridging the hole. Pushing the flush cap a hair past the surface makes EVERY
    /// host facet under the footprint a genuine transversal crossing, which the
    /// exact kernel cuts cleanly and deterministically (0% footprint coverage on
    /// both #1112 openings; plain f32 vertex translation ⇒ native==wasm).
    ///
    /// FLUSH DETECTION is against the host SURFACE, not its AABB: a cap is extended
    /// only when a host TRIANGLE parallel to it (`|n·dir| ≈ 1`) lies ON the cap's
    /// plane. That is what separates the #1112 roof cap (flush with a roof facet
    /// INTERIOR to the host's projected extent) from a wall #552611 horizontal slot
    /// whose caps float inside the wall with no host facet there — extending the
    /// latter along its authored +Z extrusion would cut the wall in half. A
    /// non-flush cap (a recess inner cap, a clean transversal cap) is left in place,
    /// so a pocket is never converted to a through-hole.
    /// An axis-aligned box `[min,max]` as a closed 12-triangle outward-wound mesh —
    /// the cutter solid for a RECTANGULAR opening routed through the exact subtract
    /// (PART B). 24 verts (4 per face) so each face carries its own outward normal.
    fn make_box_mesh(min: Point3<f64>, max: Point3<f64>) -> Mesh {
        let mut m = Mesh::with_capacity(24, 36);
        let corners = [
            Point3::new(min.x, min.y, min.z),
            Point3::new(max.x, min.y, min.z),
            Point3::new(max.x, max.y, min.z),
            Point3::new(min.x, max.y, min.z),
            Point3::new(min.x, min.y, max.z),
            Point3::new(max.x, min.y, max.z),
            Point3::new(max.x, max.y, max.z),
            Point3::new(min.x, max.y, max.z),
        ];
        let faces: [(Vector3<f64>, [usize; 4]); 6] = [
            // Parity-sweep fix: the -Z cap was [0, 2, 1, 3] — a CROSSED
            // (bowtie) quad whose two triangles overlap with opposite
            // orientation, making every synthesized rectangular cutter a
            // self-intersecting solid. The exact kernel then emits
            // orientation-corrupted results (volume > un-cut host) and
            // Manifold silently under-cuts. [0, 3, 2, 1] is the proper
            // outward (-Z) winding, mirroring the +Z face reversed.
            (Vector3::new(0.0, 0.0, -1.0), [0, 3, 2, 1]),
            (Vector3::new(0.0, 0.0, 1.0), [4, 5, 6, 7]),
            (Vector3::new(0.0, -1.0, 0.0), [0, 1, 5, 4]),
            (Vector3::new(0.0, 1.0, 0.0), [2, 3, 7, 6]),
            (Vector3::new(-1.0, 0.0, 0.0), [0, 4, 7, 3]),
            (Vector3::new(1.0, 0.0, 0.0), [1, 2, 6, 5]),
        ];
        for (n, idx) in &faces {
            let b = m.vertex_count() as u32;
            m.add_vertex(corners[idx[0]], *n);
            m.add_vertex(corners[idx[1]], *n);
            m.add_vertex(corners[idx[2]], *n);
            m.add_vertex(corners[idx[3]], *n);
            m.add_triangle(b, b + 1, b + 2);
            m.add_triangle(b, b + 2, b + 3);
        }
        m
    }

    fn extend_opening_mesh_through_host(
        opening_mesh: &Mesh,
        host_mesh: &Mesh,
        dir: Vector3<f64>,
    ) -> Mesh {
        let len = dir.norm();
        if len < NORMALIZE_EPSILON {
            return opening_mesh.clone();
        }
        let d = dir / len;

        // Opening span along `d`.
        let (mut omn, mut omx) = (f64::INFINITY, f64::NEG_INFINITY);
        for c in opening_mesh.positions.chunks_exact(3) {
            let s = c[0] as f64 * d.x + c[1] as f64 * d.y + c[2] as f64 * d.z;
            omn = omn.min(s);
            omx = omx.max(s);
        }
        let open_span = (omx - omn).abs();
        if open_span < NORMALIZE_EPSILON {
            return opening_mesh.clone();
        }

        // FLUSH-CAP DETECTION against the host SURFACE (not its AABB): is there a
        // host triangle whose plane is ~parallel to a cap (normal·d ≈ ±1) and whose
        // plane the cap's projection `omn`/`omx` sits ON (within `flush_band`)? Only
        // then is that cap a real flush interface to extend. This is what tells a
        // #1112 roof-opening cap (flush with a roof facet that is INTERIOR to the
        // host's projected extent) apart from a wall #552611 horizontal slot whose
        // caps float inside the wall (no host facet there) — extending the latter
        // along its authored +Z extrusion would cut the wall in half.
        let flush_band = open_span.max(1.0) * 1e-3; // 0.1% of opening depth, scale-rel
        let (mut cap_min_flush, mut cap_max_flush) = (false, false);
        // Farthest host surface coincident with each cap, along `d` (for the push).
        let (mut host_at_min, mut host_at_max) = (omn, omx);
        let vat = |i: u32| {
            let b = i as usize * 3;
            [
                host_mesh.positions[b] as f64,
                host_mesh.positions[b + 1] as f64,
                host_mesh.positions[b + 2] as f64,
            ]
        };
        let vc = host_mesh.positions.len() / 3;
        for t in host_mesh.indices.chunks_exact(3) {
            if (t[0] as usize) >= vc || (t[1] as usize) >= vc || (t[2] as usize) >= vc {
                continue;
            }
            let (a, b, c) = (vat(t[0]), vat(t[1]), vat(t[2]));
            let e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
            let e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
            let n = [
                e1[1] * e2[2] - e1[2] * e2[1],
                e1[2] * e2[0] - e1[0] * e2[2],
                e1[0] * e2[1] - e1[1] * e2[0],
            ];
            let nl = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
            if nl < 1e-12 {
                continue;
            }
            // |n·d| ≈ 1 ⇒ host facet parallel to the caps (normal along the
            // penetration axis). 0.985 ≈ 10° — absorbs the ~0.1° facet scatter and
            // a tilted roof's facet wobble without admitting a perpendicular wall.
            let nd = (n[0] * d.x + n[1] * d.y + n[2] * d.z) / nl;
            if nd.abs() < 0.985 {
                continue;
            }
            // the facet's offset along d (any vertex; it's ~constant on the facet)
            let s = a[0] * d.x + a[1] * d.y + a[2] * d.z;
            if (s - omn).abs() <= flush_band {
                cap_min_flush = true;
                host_at_min = host_at_min.min(s);
            }
            if (s - omx).abs() <= flush_band {
                cap_max_flush = true;
                host_at_max = host_at_max.max(s);
            }
        }
        if !cap_min_flush && !cap_max_flush {
            return opening_mesh.clone(); // no flush cap ⇒ a clean transversal cut
        }

        // Push each FLUSH cap a clearance margin PAST its coincident host facet, so
        // the interface becomes a transversal crossing. The margin is NOT a hairline
        // pad: a near-grazing exit (cap a few µm past a TILTED faceted surface)
        // re-creates a coarse T-junction at the facet seam — two rim vertices a few
        // mm apart spanned to a far roof corner, i.e. a high-aspect sliver (the
        // issue #1007 rim-corner CHAMFER on the roof slope, a thin visible flap).
        //
        // The exit must clear the host's FACET VERTICES, not just the surface: on a
        // faceted-BREP roof slope the seam crossing's aspect is set by how close the
        // pushed exit lands to the next facet vertex along the cut. Empirically (host
        // #1112, openings #2150/#2154) the worst rim-incident aspect vs the pad as a
        // fraction of the opening depth is non-monotonic and only settles into the
        // genuine-geometry floor (≈25:1, no >30:1 rim sliver) once the cap clears the
        // surface by ≳ 30 % of the opening's own depth: 5 % → 74:1 (the residual
        // chamfer), 15 % → a near-grazing 1250:1 resonance, 30–40 % → ~25:1 clean.
        // 30 % is the conservative floor of that clean band; it is still small in
        // absolute terms (a few cm on a ~1 m-deep opening, ~9 cm on a 0.3 m window),
        // fires ONLY on a detected flush cap (a floating wall-slot cap is untouched),
        // pushes INTO the host away from neighbouring elements, and stays well short
        // of the engulf guard. Verified: the whole rect-opening + #1007 + #960 suite
        // stays green and `issue_1007_real_opening_no_bridge`'s footprint coverage
        // stays 0 (no bridge).
        let pad = (open_span * 0.30).max(0.01);
        let push_back = if cap_min_flush { (omn - host_at_min).max(0.0) + pad } else { 0.0 };
        let push_fwd = if cap_max_flush { (host_at_max - omx).max(0.0) + pad } else { 0.0 };
        // Only the flush cap ring(s) move; interior loops are untouched (band = a
        // quarter of the opening's own depth).
        let band = (open_span * 0.25).max(1e-6);
        let mut out = opening_mesh.clone();
        for c in out.positions.chunks_exact_mut(3) {
            let p = Point3::new(c[0] as f64, c[1] as f64, c[2] as f64);
            let s = p.x * d.x + p.y * d.y + p.z * d.z;
            let shift = if cap_min_flush && s <= omn + band {
                -push_back
            } else if cap_max_flush && s >= omx - band {
                push_fwd
            } else {
                0.0
            };
            if shift != 0.0 {
                c[0] = (p.x + d.x * shift) as f32;
                c[1] = (p.y + d.y * shift) as f32;
                c[2] = (p.z + d.z * shift) as f32;
            }
        }
        out
    }

    /// Cut a rectangular opening from a mesh using AABB clipping — the LEGACY
    /// Sutherland-Hodgman box clip, now retained ONLY as the issue-#635
    /// no-op fallback (a genuinely round/curved opening, or a grazing/coplanar
    /// engulfing cutter, that the exact kernel returns un-cut). The PRIMARY path
    /// for every opening — axis-aligned rectangular included — is the exact mesh
    /// subtract in `apply_void_context` (PART B); this clip is no longer on it.
    pub(super) fn cut_rectangular_opening(
        &self,
        mesh: &Mesh,
        open_min: Point3<f64>,
        open_max: Point3<f64>,
    ) -> Mesh {
        self.cut_rectangular_opening_no_faces(mesh, open_min, open_max)
    }

    /// Cut a rectangular opening using AABB clipping WITHOUT generating internal faces.
    /// Used for diagonal openings where internal face generation causes rotation artifacts.
    fn cut_rectangular_opening_no_faces(
        &self,
        mesh: &Mesh,
        open_min: Point3<f64>,
        open_max: Point3<f64>,
    ) -> Mesh {
        use nalgebra::Vector3;

        const EPSILON: f64 = 1e-6;

        let mut result = Mesh::with_capacity(mesh.positions.len() / 3, mesh.indices.len() / 3);

        let mut clip_buffers = ClipBuffers::new();

        let num_vertices = mesh.positions.len() / 3;
        for chunk in mesh.indices.chunks_exact(3) {
            let i0 = chunk[0] as usize;
            let i1 = chunk[1] as usize;
            let i2 = chunk[2] as usize;

            // Bounds check: skip triangles with out-of-range vertex indices
            if i0 >= num_vertices || i1 >= num_vertices || i2 >= num_vertices {
                continue;
            }

            let v0 = Point3::new(
                mesh.positions[i0 * 3] as f64,
                mesh.positions[i0 * 3 + 1] as f64,
                mesh.positions[i0 * 3 + 2] as f64,
            );
            let v1 = Point3::new(
                mesh.positions[i1 * 3] as f64,
                mesh.positions[i1 * 3 + 1] as f64,
                mesh.positions[i1 * 3 + 2] as f64,
            );
            let v2 = Point3::new(
                mesh.positions[i2 * 3] as f64,
                mesh.positions[i2 * 3 + 1] as f64,
                mesh.positions[i2 * 3 + 2] as f64,
            );

            let n0 = if mesh.normals.len() >= mesh.positions.len() {
                Vector3::new(
                    mesh.normals[i0 * 3] as f64,
                    mesh.normals[i0 * 3 + 1] as f64,
                    mesh.normals[i0 * 3 + 2] as f64,
                )
            } else {
                let edge1 = v1 - v0;
                let edge2 = v2 - v0;
                edge1
                    .cross(&edge2)
                    .try_normalize(1e-10)
                    .unwrap_or(Vector3::new(0.0, 0.0, 1.0))
            };

            let tri_min_x = v0.x.min(v1.x).min(v2.x);
            let tri_max_x = v0.x.max(v1.x).max(v2.x);
            let tri_min_y = v0.y.min(v1.y).min(v2.y);
            let tri_max_y = v0.y.max(v1.y).max(v2.y);
            let tri_min_z = v0.z.min(v1.z).min(v2.z);
            let tri_max_z = v0.z.max(v1.z).max(v2.z);

            // Per-axis "completely outside" slack, scaled by the box-plane
            // coordinate magnitude. The host mesh is stored f32 and promoted to
            // f64 here, while the opening box bounds are pure f64; at
            // building-scale world coordinates (tens of metres) the f32 quantum
            // (|coord| * 2^-23 ≈ 1.2e-7 * |coord|, ~4e-6 m at 33 m) exceeds a
            // fixed 1e-6 m EPSILON. A wall face authored exactly flush with the
            // opening's near plane (door extruded from the back surface —
            // ISSUE_126 #77438 / #83694) then rounds ~1.4e-6 m *outside* the
            // box, so a fixed-epsilon test mis-classifies it as "completely
            // outside", the back face survives un-cut, and the opening is sealed
            // (non-manifold). Track the f32 round-trip error per axis.
            let eps_x = EPSILON.max(open_min.x.abs().max(open_max.x.abs()) * 1e-6);
            let eps_y = EPSILON.max(open_min.y.abs().max(open_max.y.abs()) * 1e-6);
            let eps_z = EPSILON.max(open_min.z.abs().max(open_max.z.abs()) * 1e-6);

            // If triangle is completely outside opening, keep it as-is
            if tri_max_x <= open_min.x - eps_x
                || tri_min_x >= open_max.x + eps_x
                || tri_max_y <= open_min.y - eps_y
                || tri_min_y >= open_max.y + eps_y
                || tri_max_z <= open_min.z - eps_z
                || tri_min_z >= open_max.z + eps_z
            {
                let base = result.vertex_count() as u32;
                result.add_vertex(v0, n0);
                result.add_vertex(v1, n0);
                result.add_vertex(v2, n0);
                result.add_triangle(base, base + 1, base + 2);
                continue;
            }

            // Check if triangle is completely inside opening (remove it)
            if tri_min_x >= open_min.x + EPSILON
                && tri_max_x <= open_max.x - EPSILON
                && tri_min_y >= open_min.y + EPSILON
                && tri_max_y <= open_max.y - EPSILON
                && tri_min_z >= open_min.z + EPSILON
                && tri_max_z <= open_max.z - EPSILON
            {
                continue;
            }

            // Triangle may intersect opening - clip it
            if self.triangle_intersects_box(&v0, &v1, &v2, &open_min, &open_max) {
                self.clip_triangle_against_box(
                    &mut result,
                    &mut clip_buffers,
                    &v0,
                    &v1,
                    &v2,
                    &n0,
                    &open_min,
                    &open_max,
                );
            } else {
                let base = result.vertex_count() as u32;
                result.add_vertex(v0, n0);
                result.add_vertex(v1, n0);
                result.add_vertex(v2, n0);
                result.add_triangle(base, base + 1, base + 2);
            }
        }

        // Reveal faces are generated by the caller (see generate_reveal_quads)
        result
    }

    /// Test if a triangle intersects an axis-aligned bounding box using Separating Axis Theorem (SAT)
    /// Returns true if triangle and box intersect, false if they are separated.
    ///
    /// All separation tests use a small `SAT_EPSILON` slack so that a triangle
    /// **lying exactly on a box face** (e.g. an extruded wall's outer face
    /// that is coplanar with the opening AABB's `max.x` face after the opening
    /// has been extended through the wall thickness) is reported as
    /// intersecting and gets routed into the actual clipping path. Without
    /// this slack, FP rounding can produce a tiny gap (the wall mesh is
    /// stored in f32 and re-promoted to f64 here, while the opening box is
    /// computed in pure f64) that the strict `<` reads as a separation — and
    /// the wall's outer face survives un-clipped, leaving the wall solid
    /// around its opening (issue #584 / Smiley-West balconies, follow-up:
    /// the per-axis 1e-6 epsilon was correct for the box-axis tests but
    /// undersized for the triangle-plane test, which uses an un-normalized
    /// `triangle_normal` whose magnitude scales with triangle area).
    fn triangle_intersects_box(
        &self,
        v0: &Point3<f64>,
        v1: &Point3<f64>,
        v2: &Point3<f64>,
        box_min: &Point3<f64>,
        box_max: &Point3<f64>,
    ) -> bool {
        use nalgebra::Vector3;

        /// Float slack for SAT separation tests (1 micrometre at the IFC's
        /// length unit). Big enough to absorb double-precision rounding
        /// (`v.z - box_center.z` vs `(box_max.z - box_min.z) * 0.5`) on
        /// box-coplanar triangles, small enough to not pull genuinely
        /// separated triangles into the clipper.
        const SAT_EPSILON: f64 = 1e-6;

        // Box center and half-extents
        let box_center = Point3::new(
            (box_min.x + box_max.x) * 0.5,
            (box_min.y + box_max.y) * 0.5,
            (box_min.z + box_max.z) * 0.5,
        );
        let box_half_extents = Vector3::new(
            (box_max.x - box_min.x) * 0.5,
            (box_max.y - box_min.y) * 0.5,
            (box_max.z - box_min.z) * 0.5,
        );

        // Translate triangle to box-local space
        let t0 = v0 - box_center;
        let t1 = v1 - box_center;
        let t2 = v2 - box_center;

        // Triangle edges
        let e0 = t1 - t0;
        let e1 = t2 - t1;
        let e2 = t0 - t2;

        // Test 1: Box axes (X, Y, Z)
        // Project triangle onto each axis and check overlap
        for axis_idx in 0..3 {
            let axis = match axis_idx {
                0 => Vector3::new(1.0, 0.0, 0.0),
                1 => Vector3::new(0.0, 1.0, 0.0),
                2 => Vector3::new(0.0, 0.0, 1.0),
                _ => unreachable!(),
            };

            let p0 = t0.dot(&axis);
            let p1 = t1.dot(&axis);
            let p2 = t2.dot(&axis);

            let tri_min = p0.min(p1).min(p2);
            let tri_max = p0.max(p1).max(p2);
            let box_extent = box_half_extents[axis_idx];

            // Scale the separation slack by the world-coordinate magnitude on
            // this axis so it absorbs the f32 round-trip slop of the host mesh
            // (stored f32, promoted to f64 here) at building-scale coordinates;
            // a fixed 1e-6 m is below the f32 quantum at tens of metres, so a
            // triangle exactly coplanar with the box face (ISSUE_126 #77438 back
            // face, flush with the door opening's near plane) reads as separated
            // and survives the cut un-clipped.
            let axis_eps =
                SAT_EPSILON.max(box_center[axis_idx].abs().max(box_extent.abs()) * 1e-6);
            if tri_max < -box_extent - axis_eps || tri_min > box_extent + axis_eps {
                return false; // Separated on this axis
            }
        }

        // Test 2: Triangle face normal
        let triangle_normal = e0.cross(&e2);
        let triangle_offset = t0.dot(&triangle_normal);

        // Project box onto triangle normal
        let mut box_projection = 0.0;
        for i in 0..3 {
            let axis = match i {
                0 => Vector3::new(1.0, 0.0, 0.0),
                1 => Vector3::new(0.0, 1.0, 0.0),
                2 => Vector3::new(0.0, 0.0, 1.0),
                _ => unreachable!(),
            };
            box_projection += box_half_extents[i] * triangle_normal.dot(&axis).abs();
        }

        // Normalize the per-axis epsilon by the triangle-normal magnitude.
        //
        // `triangle_normal` is the un-normalized cross product `e0 × e2`, so
        // `|triangle_normal| ≈ 2 * triangle_area`. Both `triangle_offset` and
        // `box_projection` scale linearly with that magnitude, but the
        // physical-space rounding error a "near-coplanar" face needs to absorb
        // does NOT scale with triangle area. Without scaling SAT_EPSILON, a
        // tall/wide wall face sitting ~3e-7 m outside the opening box (well
        // within the f32 → f64 round-trip slop introduced by the mesh
        // pipeline) becomes a separation gap of ~1.7e-6 in projection units,
        // which a fixed 1e-6 epsilon misses — leaving the wall's outer face
        // un-clipped (Smiley-West uncut walls, follow-up to #584).
        //
        // The *physical* slack must additionally absorb the f32 round-trip slop
        // of the host mesh: at building-scale world coordinates (tens of metres)
        // the f32 quantum is |coord| * 2^-23 ≈ 1.2e-7 * |coord|, which exceeds a
        // fixed 1e-6 m. A wall face flush with the opening's near plane (door
        // extruded from the back surface — ISSUE_126 #77438 / #83694, coords
        // ~33 m) lands ~1.4e-6 m outside the box; a fixed 1e-6 physical slack
        // still reports separation and the back face survives un-cut, sealing
        // the opening. Scale the physical slack by the box-center magnitude so
        // it tracks the f32 error, then by the normal magnitude as before.
        let phys_slack = SAT_EPSILON
            .max(box_center.x.abs().max(box_center.y.abs()).max(box_center.z.abs()) * 1e-6);
        let normal_magnitude = triangle_normal.norm();
        let t2_epsilon = phys_slack * normal_magnitude.max(1.0);
        if triangle_offset.abs() > box_projection + t2_epsilon {
            return false; // Separated by triangle plane
        }

        // Test 3: 9 cross-product axes (3 box edges x 3 triangle edges)
        let box_axes = [
            Vector3::new(1.0, 0.0, 0.0),
            Vector3::new(0.0, 1.0, 0.0),
            Vector3::new(0.0, 0.0, 1.0),
        ];
        let tri_edges = [e0, e1, e2];

        for box_axis in &box_axes {
            for tri_edge in &tri_edges {
                let axis = box_axis.cross(tri_edge);

                // Skip degenerate axes (parallel edges)
                if axis.norm_squared() < 1e-10 {
                    continue;
                }

                let axis_normalized = axis.normalize();

                // Project triangle onto axis
                let p0 = t0.dot(&axis_normalized);
                let p1 = t1.dot(&axis_normalized);
                let p2 = t2.dot(&axis_normalized);
                let tri_min = p0.min(p1).min(p2);
                let tri_max = p0.max(p1).max(p2);

                // Project box onto axis
                let mut box_projection = 0.0;
                for i in 0..3 {
                    let box_axis_vec = box_axes[i];
                    box_projection +=
                        box_half_extents[i] * axis_normalized.dot(&box_axis_vec).abs();
                }

                // Same f32-round-trip-aware physical slack as Test 2: the
                // cross-product axis is normalized, so projections are physical
                // units and a fixed 1e-6 m misses building-scale f32 slop on a
                // triangle coplanar with a box face (ISSUE_126 #77438 back face
                // — box-edge × triangle-edge yields a ±X axis, the very axis the
                // coplanar back face is separated on).
                if tri_max < -box_projection - phys_slack
                    || tri_min > box_projection + phys_slack
                {
                    return false; // Separated on this axis
                }
            }
        }

        // No separating axis found - triangle and box intersect
        true
    }

    /// Clip a triangle against an opening box using clip-and-collect algorithm.
    /// Removes the part of the triangle that's inside the box.
    /// Collects "outside" parts directly to result, continues processing "inside" parts.
    ///
    /// Uses reusable ClipBuffers to avoid per-triangle allocations (6+ Vec allocations
    /// per intersecting triangle without buffers).
    ///
    /// ## FIX (2026-03-18): Direct back-part computation
    ///
    /// The previous implementation clipped the original triangle against a **flipped plane**
    /// to obtain "outside" parts. When triangle vertices were within epsilon (1e-6) of the
    /// clipping plane, `clip_triangle` classified them as "front" for **both** the original
    /// and flipped planes — returning `Split` on the original but `AllFront` on the flipped.
    /// This added the **entire original triangle** to the result as an "outside" piece while
    /// the clipped front parts also continued processing, duplicating geometry.
    ///
    fn clip_triangle_against_box(
        &self,
        result: &mut Mesh,
        buffers: &mut ClipBuffers,
        v0: &Point3<f64>,
        v1: &Point3<f64>,
        v2: &Point3<f64>,
        normal: &Vector3<f64>,
        open_min: &Point3<f64>,
        open_max: &Point3<f64>,
    ) {
        let clipper = ClippingProcessor::new();
        // The plane classification (`d >= -epsilon` = inside/front) must absorb
        // the host mesh's f32 round-trip slop: the mesh is stored f32 and
        // promoted to f64 here while the box planes are pure f64. At
        // building-scale world coordinates (tens of metres) the f32 quantum
        // (|coord| * 2^-23 ≈ 1.2e-7 * |coord|) exceeds a fixed 1e-6 m, so a wall
        // face flush with a box plane (ISSUE_126 #77438 back face, ~33 m,
        // ~1.4e-6 m off the +X plane) is classified entirely "outside" and the
        // whole triangle survives un-clipped — the opening is sealed by the
        // un-cut back face. Scale the classification epsilon by the box-plane
        // coordinate magnitude so it tracks that f32 error.
        let coord_mag = open_min
            .x
            .abs()
            .max(open_max.x.abs())
            .max(open_min.y.abs())
            .max(open_max.y.abs())
            .max(open_min.z.abs())
            .max(open_max.z.abs());
        let epsilon = clipper.epsilon.max(coord_mag * 1e-6);

        // Clear buffers for reuse (retains capacity)
        buffers.clear();

        // Planes with INWARD normals (so "front" = inside box, "behind" = outside box)
        // We clip to keep geometry OUTSIDE the box (behind these planes)
        let planes = [
            // +X inward: inside box where x >= open_min.x
            Plane::new(
                Point3::new(open_min.x, 0.0, 0.0),
                Vector3::new(1.0, 0.0, 0.0),
            ),
            // -X inward: inside box where x <= open_max.x
            Plane::new(
                Point3::new(open_max.x, 0.0, 0.0),
                Vector3::new(-1.0, 0.0, 0.0),
            ),
            // +Y inward: inside box where y >= open_min.y
            Plane::new(
                Point3::new(0.0, open_min.y, 0.0),
                Vector3::new(0.0, 1.0, 0.0),
            ),
            // -Y inward: inside box where y <= open_max.y
            Plane::new(
                Point3::new(0.0, open_max.y, 0.0),
                Vector3::new(0.0, -1.0, 0.0),
            ),
            // +Z inward: inside box where z >= open_min.z
            Plane::new(
                Point3::new(0.0, 0.0, open_min.z),
                Vector3::new(0.0, 0.0, 1.0),
            ),
            // -Z inward: inside box where z <= open_max.z
            Plane::new(
                Point3::new(0.0, 0.0, open_max.z),
                Vector3::new(0.0, 0.0, -1.0),
            ),
        ];

        // Guard: skip if input vertices contain NaN (from degenerate prior clips)
        if !v0.x.is_finite()
            || !v0.y.is_finite()
            || !v0.z.is_finite()
            || !v1.x.is_finite()
            || !v1.y.is_finite()
            || !v1.z.is_finite()
            || !v2.x.is_finite()
            || !v2.y.is_finite()
            || !v2.z.is_finite()
        {
            // Keep the triangle as-is (don't clip degenerate geometry)
            let base = result.vertex_count() as u32;
            result.add_vertex(*v0, *normal);
            result.add_vertex(*v1, *normal);
            result.add_vertex(*v2, *normal);
            result.add_triangle(base, base + 1, base + 2);
            return;
        }
        // Initialize remaining with the input triangle
        buffers.remaining.push(Triangle::new(*v0, *v1, *v2));

        // Clip-and-collect: collect "outside" parts, continue processing "inside" parts
        for plane in &planes {
            buffers.next_remaining.clear();

            for tri in &buffers.remaining {
                // Compute signed distances
                let d0 = plane.signed_distance(&tri.v0);
                let d1 = plane.signed_distance(&tri.v1);
                let d2 = plane.signed_distance(&tri.v2);

                // Guard: NaN distances from degenerate vertices (from prior interpolation)
                if !d0.is_finite() || !d1.is_finite() || !d2.is_finite() {
                    buffers.result.push(tri.clone()); // keep as-is
                    continue;
                }

                let f0 = d0 >= -epsilon;
                let f1 = d1 >= -epsilon;
                let f2 = d2 >= -epsilon;
                let front_count = f0 as u8 + f1 as u8 + f2 as u8;

                match front_count {
                    3 => {
                        buffers.next_remaining.push(tri.clone());
                    }
                    0 => {
                        buffers.result.push(tri.clone());
                    }
                    1 => {
                        let (front, back1, back2, d_f, d_b1, d_b2) = if f0 {
                            (tri.v0, tri.v1, tri.v2, d0, d1, d2)
                        } else if f1 {
                            (tri.v1, tri.v2, tri.v0, d1, d2, d0)
                        } else {
                            (tri.v2, tri.v0, tri.v1, d2, d0, d1)
                        };

                        let denom1 = d_f - d_b1;
                        let denom2 = d_f - d_b2;
                        if denom1.abs() < 1e-12 || denom2.abs() < 1e-12 {
                            buffers.next_remaining.push(tri.clone());
                            continue;
                        }
                        let t1 = (d_f / denom1).clamp(0.0, 1.0);
                        let t2 = (d_f / denom2).clamp(0.0, 1.0);
                        let p1 = front + (back1 - front) * t1;
                        let p2 = front + (back2 - front) * t2;

                        // Validate interpolated points
                        if !p1.x.is_finite()
                            || !p1.y.is_finite()
                            || !p1.z.is_finite()
                            || !p2.x.is_finite()
                            || !p2.y.is_finite()
                            || !p2.z.is_finite()
                        {
                            buffers.next_remaining.push(tri.clone());
                            continue;
                        }

                        buffers.next_remaining.push(Triangle::new(front, p1, p2));
                        buffers.result.push(Triangle::new(p1, back1, back2));
                        buffers.result.push(Triangle::new(p1, back2, p2));
                    }
                    2 => {
                        let (front1, front2, back, d_f1, d_f2, d_b) = if !f0 {
                            (tri.v1, tri.v2, tri.v0, d1, d2, d0)
                        } else if !f1 {
                            (tri.v2, tri.v0, tri.v1, d2, d0, d1)
                        } else {
                            (tri.v0, tri.v1, tri.v2, d0, d1, d2)
                        };

                        let denom1 = d_f1 - d_b;
                        let denom2 = d_f2 - d_b;
                        if denom1.abs() < 1e-12 || denom2.abs() < 1e-12 {
                            buffers.next_remaining.push(tri.clone());
                            continue;
                        }
                        let t1 = (d_f1 / denom1).clamp(0.0, 1.0);
                        let t2 = (d_f2 / denom2).clamp(0.0, 1.0);
                        let p1 = front1 + (back - front1) * t1;
                        let p2 = front2 + (back - front2) * t2;

                        // Validate interpolated points
                        if !p1.x.is_finite()
                            || !p1.y.is_finite()
                            || !p1.z.is_finite()
                            || !p2.x.is_finite()
                            || !p2.y.is_finite()
                            || !p2.z.is_finite()
                        {
                            buffers.next_remaining.push(tri.clone());
                            continue;
                        }

                        buffers
                            .next_remaining
                            .push(Triangle::new(front1, front2, p1));
                        buffers.next_remaining.push(Triangle::new(front2, p2, p1));
                        buffers.result.push(Triangle::new(p1, p2, back));
                    }
                    _ => {
                        // Should be unreachable, but guard against corruption
                        buffers.result.push(tri.clone());
                    }
                }
            }

            // Swap buffers instead of reallocating
            std::mem::swap(&mut buffers.remaining, &mut buffers.next_remaining);
        }

        // 'remaining' triangles are inside ALL planes = inside box = discard
        // Add collected result_triangles to mesh
        for tri in &buffers.result {
            // Drop hairline needle slivers the Sutherland-Hodgman box clip leaves
            // on a host edge near-tangent to an opening face (the diagonal
            // window-wedge artifact, e.g. schependomlaan). Same scale-relative
            // power-of-two needle test the exact-kernel consolidate pass uses; a
            // ~zero-area needle can't open a real gap — the frame around the
            // opening is closed by the neighbouring non-degenerate triangles.
            if tri_is_needle(&[tri.v0, tri.v1, tri.v2]) {
                continue;
            }
            let base = result.vertex_count() as u32;
            result.add_vertex(tri.v0, *normal);
            result.add_vertex(tri.v1, *normal);
            result.add_vertex(tri.v2, *normal);
            result.add_triangle(base, base + 1, base + 2);
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod reveal_tests {
    use super::*;
    use crate::Mesh;

    /// Build a simple box mesh (12 triangles) for testing.
    #[allow(dead_code)]
    fn make_box_mesh(min: Point3<f64>, max: Point3<f64>) -> Mesh {
        let mut m = Mesh::with_capacity(24, 36);

        let corners = [
            Point3::new(min.x, min.y, min.z), // 0
            Point3::new(max.x, min.y, min.z), // 1
            Point3::new(max.x, max.y, min.z), // 2
            Point3::new(min.x, max.y, min.z), // 3
            Point3::new(min.x, min.y, max.z), // 4
            Point3::new(max.x, min.y, max.z), // 5
            Point3::new(max.x, max.y, max.z), // 6
            Point3::new(min.x, max.y, max.z), // 7
        ];

        // 6 faces × 4 vertices each with face normals
        let faces: [(Vector3<f64>, [usize; 4]); 6] = [
            // Parity-sweep fix: [0, 2, 1, 3] was a crossed (bowtie) quad —
            // see the sibling `make_box_mesh` above for the full rationale.
            (Vector3::new(0.0, 0.0, -1.0), [0, 3, 2, 1]), // -Z
            (Vector3::new(0.0, 0.0, 1.0), [4, 5, 6, 7]),  // +Z
            (Vector3::new(0.0, -1.0, 0.0), [0, 1, 5, 4]), // -Y
            (Vector3::new(0.0, 1.0, 0.0), [2, 3, 7, 6]),  // +Y
            (Vector3::new(-1.0, 0.0, 0.0), [0, 4, 7, 3]), // -X
            (Vector3::new(1.0, 0.0, 0.0), [1, 2, 6, 5]),  // +X
        ];
        for (n, idx) in &faces {
            let b = m.vertex_count() as u32;
            m.add_vertex(corners[idx[0]], *n);
            m.add_vertex(corners[idx[1]], *n);
            m.add_vertex(corners[idx[2]], *n);
            m.add_vertex(corners[idx[3]], *n);
            m.add_triangle(b, b + 1, b + 2);
            m.add_triangle(b, b + 2, b + 3);
        }
        m
    }

    fn make_framed_box_mesh(
        origin: Point3<f64>,
        depth_axis: Vector3<f64>,
        cross_a: Vector3<f64>,
        cross_b: Vector3<f64>,
        depth: (f64, f64),
        a: (f64, f64),
        b: (f64, f64),
    ) -> Mesh {
        let point =
            |d: f64, av: f64, bv: f64| origin + depth_axis * d + cross_a * av + cross_b * bv;

        let corners = [
            point(depth.0, a.0, b.0),
            point(depth.1, a.0, b.0),
            point(depth.1, a.1, b.0),
            point(depth.0, a.1, b.0),
            point(depth.0, a.0, b.1),
            point(depth.1, a.0, b.1),
            point(depth.1, a.1, b.1),
            point(depth.0, a.1, b.1),
        ];

        let mut m = Mesh::with_capacity(24, 36);
        let faces: [[usize; 4]; 6] = [
            // Parity-sweep fix: [0, 2, 1, 3] was a crossed (bowtie) quad —
            // see `make_box_mesh` above for the full rationale.
            [0, 3, 2, 1],
            [4, 5, 6, 7],
            [0, 1, 5, 4],
            [2, 3, 7, 6],
            [0, 4, 7, 3],
            [1, 2, 6, 5],
        ];

        for idx in &faces {
            let edge1 = corners[idx[1]] - corners[idx[0]];
            let edge2 = corners[idx[2]] - corners[idx[0]];
            let normal = edge1
                .cross(&edge2)
                .try_normalize(1e-10)
                .unwrap_or(Vector3::new(0.0, 0.0, 1.0));
            let b = m.vertex_count() as u32;
            m.add_vertex(corners[idx[0]], normal);
            m.add_vertex(corners[idx[1]], normal);
            m.add_vertex(corners[idx[2]], normal);
            m.add_vertex(corners[idx[3]], normal);
            m.add_triangle(b, b + 1, b + 2);
            m.add_triangle(b, b + 2, b + 3);
        }

        m
    }

    /// Build a Z-extruded L-shaped prism. The six vertical walls share the
    /// same ±X/±Y normals as a box but sit at three different X (or Y)
    /// offsets, so a box detector that only counts axes would misclassify it.
    fn make_l_shape_prism_mesh() -> Mesh {
        // Footprint corners CCW in XY plane:
        // (0,0) -> (4,0) -> (4,2) -> (2,2) -> (2,4) -> (0,4) -> back to (0,0)
        let z0 = 0.0;
        let z1 = 1.0;
        let footprint = [
            (0.0_f64, 0.0_f64),
            (4.0, 0.0),
            (4.0, 2.0),
            (2.0, 2.0),
            (2.0, 4.0),
            (0.0, 4.0),
        ];

        let mut m = Mesh::new();
        let n = footprint.len();

        // Vertical walls — each footprint edge becomes one rectangular face.
        for i in 0..n {
            let (x0, y0) = footprint[i];
            let (x1, y1) = footprint[(i + 1) % n];
            let edge = Vector3::new(x1 - x0, y1 - y0, 0.0);
            let z_up = Vector3::new(0.0, 0.0, 1.0);
            let normal = edge
                .cross(&z_up)
                .try_normalize(1e-10)
                .unwrap_or(Vector3::new(1.0, 0.0, 0.0));
            let p0 = Point3::new(x0, y0, z0);
            let p1 = Point3::new(x1, y1, z0);
            let p2 = Point3::new(x1, y1, z1);
            let p3 = Point3::new(x0, y0, z1);
            let b = m.vertex_count() as u32;
            m.add_vertex(p0, normal);
            m.add_vertex(p1, normal);
            m.add_vertex(p2, normal);
            m.add_vertex(p3, normal);
            m.add_triangle(b, b + 1, b + 2);
            m.add_triangle(b, b + 2, b + 3);
        }

        // Caps: fan-triangulate the L footprint at top and bottom.
        let bottom_n = Vector3::new(0.0, 0.0, -1.0);
        let top_n = Vector3::new(0.0, 0.0, 1.0);
        let bottom_base = m.vertex_count() as u32;
        for &(x, y) in &footprint {
            m.add_vertex(Point3::new(x, y, z0), bottom_n);
        }
        let top_base = m.vertex_count() as u32;
        for &(x, y) in &footprint {
            m.add_vertex(Point3::new(x, y, z1), top_n);
        }
        for i in 1..(n as u32 - 1) {
            // Bottom cap winds clockwise so its normal points -Z.
            m.add_triangle(bottom_base, bottom_base + i + 1, bottom_base + i);
            m.add_triangle(top_base, top_base + i, top_base + i + 1);
        }

        m
    }

    #[test]
    fn test_rectangular_box_detector_accepts_clean_box() {
        let opening = make_framed_box_mesh(
            Point3::new(0.0, 0.0, 0.0),
            Vector3::new(0.0, 1.0, 0.0),
            Vector3::new(1.0, 0.0, 0.0),
            Vector3::new(0.0, 0.0, 1.0),
            (-0.15, 0.15),
            (-1.0, 1.0),
            (0.0, 2.0),
        );
        assert!(is_rectangular_box_mesh(&opening));
    }

    #[test]
    fn test_rectangular_box_detector_rejects_l_shape() {
        // An L-shaped vertical shaft has only three face-normal axes
        // (±X, ±Y, ±Z) — the same as a box — but its ±X / ±Y walls sit at
        // three different offsets. Without a per-axis plane-count check the
        // detector would misclassify it as a box and the rectangular cutter
        // would over-cut the AABB of the L.
        let opening = make_l_shape_prism_mesh();
        assert!(
            !is_rectangular_box_mesh(&opening),
            "rectilinear non-box footprints must fall through to NonRectangular CSG"
        );
    }

    /// Regression for #547: a trapezoid extrusion has exactly 3 face-normal
    /// axes after anti-parallel merging (front/back, top/bottom, and the two
    /// slanted sides which merge into one axis), but two of those axes are
    /// not perpendicular. Without an orthogonality check the detector would
    /// classify it as a box and the AABB cutter would over-cut the host wall.
    #[test]
    fn test_rectangular_box_detector_rejects_trapezoid_extrusion() {
        // Trapezoid extruded along +Y: narrow at z=0 (x ∈ [-0.3, 0.3]),
        // wide at z=2 (x ∈ [-0.5, 0.5]), thickness 0.6 in y.
        let mut positions: Vec<f32> = Vec::new();
        let mut indices: Vec<u32> = Vec::new();
        let push_v = |positions: &mut Vec<f32>, x: f32, y: f32, z: f32| {
            positions.extend_from_slice(&[x, y, z]);
        };
        // 8 corners: 4 of trapezoid at y=0, 4 at y=0.6.
        // Order: bl, br, tr, tl on each face (b=bottom narrow, t=top wide).
        push_v(&mut positions, -0.3, 0.0, 0.0); // 0
        push_v(&mut positions, 0.3, 0.0, 0.0); // 1
        push_v(&mut positions, 0.5, 0.0, 2.0); // 2
        push_v(&mut positions, -0.5, 0.0, 2.0); // 3
        push_v(&mut positions, -0.3, 0.6, 0.0); // 4
        push_v(&mut positions, 0.3, 0.6, 0.0); // 5
        push_v(&mut positions, 0.5, 0.6, 2.0); // 6
        push_v(&mut positions, -0.5, 0.6, 2.0); // 7
        // Front (y=0): 0,1,2 + 0,2,3
        indices.extend_from_slice(&[0, 1, 2, 0, 2, 3]);
        // Back (y=0.6): 5,4,7 + 5,7,6
        indices.extend_from_slice(&[5, 4, 7, 5, 7, 6]);
        // Bottom narrow (z=0): 4,5,1 + 4,1,0
        indices.extend_from_slice(&[4, 5, 1, 4, 1, 0]);
        // Top wide (z=2): 3,2,6 + 3,6,7
        indices.extend_from_slice(&[3, 2, 6, 3, 6, 7]);
        // Right slanted: 1,5,6 + 1,6,2
        indices.extend_from_slice(&[1, 5, 6, 1, 6, 2]);
        // Left slanted: 4,0,3 + 4,3,7
        indices.extend_from_slice(&[4, 0, 3, 4, 3, 7]);

        let mut mesh = Mesh::new();
        mesh.positions = positions;
        mesh.indices = indices;
        assert!(
            !is_rectangular_box_mesh(&mesh),
            "trapezoid extrusion must be rejected — its slanted-side axis is \
             not perpendicular to the top/bottom axis, so the AABB cutter would \
             over-cut the host"
        );
    }

    /// A box rotated 45° around Z should still be classified as a box: its
    /// three face-normal axes are mutually orthogonal even though none align
    /// with world axes. The diagonal cutter then handles the rotation.
    #[test]
    fn test_rectangular_box_detector_accepts_rotated_box() {
        let opening = make_framed_box_mesh(
            Point3::new(0.0, 0.0, 0.0),
            Vector3::new(0.7071067811865476, 0.7071067811865476, 0.0),
            Vector3::new(-0.7071067811865476, 0.7071067811865476, 0.0),
            Vector3::new(0.0, 0.0, 1.0),
            (-0.15, 0.15),
            (-1.0, 1.0),
            (0.0, 2.0),
        );
        assert!(
            is_rectangular_box_mesh(&opening),
            "axis-rotated boxes must still be detected — rotation alone does \
             not make them non-rectangular"
        );
    }

    #[test]
    fn test_infers_sloped_brep_opening_frame() {
        // Roof openings exported as BReps do not expose an extrusion direction.
        // The frame must be inferred from the box faces so reveal generation
        // preserves the roof pitch/roll instead of falling back to world axes.
        let depth_axis = Vector3::new(0.0, -0.5, 0.8660254037844386);
        let cross_a = Vector3::new(1.0, 0.0, 0.0);
        let cross_b = depth_axis.cross(&cross_a).normalize();
        let opening = make_framed_box_mesh(
            Point3::new(10.0, 20.0, 5.0),
            depth_axis,
            cross_a,
            cross_b,
            (-0.2, 0.2),
            (-0.8, 0.8),
            (-0.4, 0.4),
        );

        let frame = infer_opening_frame(&opening, None).unwrap();

        assert!(
            frame.depth.dot(&depth_axis).abs() > 0.99,
            "shortest inferred axis should be the sloped roof-window depth"
        );
        assert!(
            frame.cross_a.dot(&cross_a).abs() > 0.99 || frame.cross_b.dot(&cross_a).abs() > 0.99,
            "inferred frame should preserve the opening roll axis"
        );
        assert!(
            !frame.is_axis_aligned(),
            "sloped BRep opening should use the diagonal frame path"
        );
    }

    #[test]
    fn test_extend_opening_pads_past_wall_on_exact_match() {
        // Regression test for issue #604: when an opening's depth exactly matches
        // its wall's depth along the extrusion axis, the extended bounds must NOT
        // sit exactly on the wall faces — that produces 0-thickness CSG/clip
        // artifacts. The extension should always overshoot the wall slightly.
        let router = crate::router::GeometryRouter::new();

        // Wall: 0.2 m thick along Y
        let wall_min = Point3::new(0.0, 0.0, 0.0);
        let wall_max = Point3::new(10.0, 0.2, 3.0);
        // Opening exactly fills the wall in Y (0.0..0.2) — the failing case
        let open_min = Point3::new(4.0, 0.0, 1.0);
        let open_max = Point3::new(6.0, 0.2, 2.5);
        let dir = Vector3::new(0.0, 1.0, 0.0);

        let (new_min, new_max) =
            router.extend_opening_along_direction(open_min, open_max, wall_min, wall_max, dir);

        // Both faces must overshoot the wall, not sit exactly on it
        assert!(
            new_min.y < wall_min.y,
            "extended opening min Y {} must be strictly below wall min Y {}",
            new_min.y,
            wall_min.y,
        );
        assert!(
            new_max.y > wall_max.y,
            "extended opening max Y {} must be strictly above wall max Y {}",
            new_max.y,
            wall_max.y,
        );
        // Padding must stay imperceptibly small (<< 1 mm for a 0.2 m wall)
        let back_pad = wall_min.y - new_min.y;
        let fwd_pad = new_max.y - wall_max.y;
        assert!(back_pad > 0.0 && back_pad < 1e-3);
        assert!(fwd_pad > 0.0 && fwd_pad < 1e-3);
        // Cross-axis bounds untouched
        assert_eq!(new_min.x, open_min.x);
        assert_eq!(new_max.x, open_max.x);
        assert_eq!(new_min.z, open_min.z);
        assert_eq!(new_max.z, open_max.z);
    }

    #[test]
    fn test_extend_opening_skipped_when_opening_pokes_past_wall() {
        // Regression for issue #832: a 1×1×0.2 m opening offset so its
        // 0.2 m extrusion depth pokes 0.1 m past the wall's +X face. The
        // Revit "extend to reach the opposite wall face" heuristic would
        // stretch the opening through the wall thickness and the AABB
        // clip would remove BOTH the +X (touched) and -X (un-touched)
        // wall faces — the "punched-through slot" the user reported.
        // The extension must bail out and return the authored bounds.
        let router = crate::router::GeometryRouter::new();

        // Wall: 0.2 m thick along X, 3 m × 3 m face.
        let wall_min = Point3::new(7.9, 0.0, 0.0);
        let wall_max = Point3::new(8.1, 3.0, 3.0);
        // Opening starts inside the wall (x=8.0) and pokes past +X (x=8.2).
        let open_min = Point3::new(8.0, 0.5, 1.0);
        let open_max = Point3::new(8.2, 1.5, 2.0);
        let dir = Vector3::new(1.0, 0.0, 0.0);

        let (new_min, new_max) =
            router.extend_opening_along_direction(open_min, open_max, wall_min, wall_max, dir);

        // Authored bounds must come back UNCHANGED — no extension, no pad.
        assert_eq!(new_min, open_min, "X-poke-out: extension must not change min");
        assert_eq!(new_max, open_max, "X-poke-out: extension must not change max");

        // Same shape mirrored: opening pokes past -X face, extrusion -X.
        let wall_min = Point3::new(5.9, 0.0, 0.0);
        let wall_max = Point3::new(6.1, 3.0, 3.0);
        let open_min = Point3::new(5.8, 0.5, 1.0);
        let open_max = Point3::new(6.0, 1.5, 2.0);
        let dir = Vector3::new(-1.0, 0.0, 0.0);

        let (new_min, new_max) =
            router.extend_opening_along_direction(open_min, open_max, wall_min, wall_max, dir);

        assert_eq!(new_min, open_min, "-X-poke-out: extension must not change min");
        assert_eq!(new_max, open_max, "-X-poke-out: extension must not change max");
    }

    /// DETERMINISM (CI-safe, no fixture): the parametric cut on a rotated, building-scale
    /// wall must FIRE, be watertight, emit a local-frame mesh (small positions + origin),
    /// and produce BIT-IDENTICAL output across runs. Bit-identical-across-runs + the
    /// FMA-free f64 arithmetic (`rotate_point`, snap grid) is the native==wasm contract:
    /// every operation is a deterministic f64 op with a single f32 store, so the two
    /// targets cannot diverge.
    #[test]
    fn param_cut_is_deterministic_watertight_and_local_framed() {
        let router = GeometryRouter::new();
        // 37° about Z, right-handed frame (cross_b = depth × cross_a).
        let yaw = 37.0_f64.to_radians();
        let (c, s) = (yaw.cos(), yaw.sin());
        let cross_a = Vector3::new(c, s, 0.0); // wall length axis
        let depth = Vector3::new(-s, c, 0.0); // wall thickness axis
        let cross_b = depth.cross(&cross_a); // wall height axis
        // The cut path sees RTC-rebased (small) coordinates — a national-grid model is
        // re-based to near origin before meshing, so the host f32 mesh is precise. (An
        // un-rebased building-scale mesh correctly FAILS host reconciliation and defers.)
        let center = Point3::new(3.0, 2.0, 5.0);

        // World rotated wall: 4 m (cross_a) × 3 m (cross_b) × 0.3 m thick (depth).
        let host_world = make_framed_box_mesh(
            center, depth, cross_a, cross_b, (-0.15, 0.15), (-2.0, 2.0), (-1.5, 1.5),
        );
        let host = RectParam {
            r: Matrix3::from_columns(&[cross_a, cross_b, depth]),
            center,
            half: [2.0, 1.5, 0.15],
        };
        // A centred window, over-spanning the thickness (through-cut) and well within
        // the wall in-face — fires all the gates.
        let opening = RectParam {
            r: host.r,
            center,
            half: [0.5, 0.5, 0.25],
        };
        let ctx = VoidContext {
            openings: Vec::new(),
            merged_openings: Vec::new(),
            param: Some(ParamRectCut {
                host,
                openings: vec![opening],
            }),
        };

        let out1 = router
            .try_param_rect_cut(&host_world, &ctx)
            .expect("parametric cut must fire on a clean rotated wall");
        let out2 = router
            .try_param_rect_cut(&host_world, &ctx)
            .expect("parametric cut must fire on a clean rotated wall");

        // Bit-identical across runs (⇒ native==wasm by the FMA-free construction).
        assert_eq!(out1.positions, out2.positions, "positions must be deterministic");
        assert_eq!(out1.indices, out2.indices, "indices must be deterministic");
        assert_eq!(out1.normals, out2.normals, "normals must be deterministic");
        assert_eq!(out1.origin, out2.origin, "origin must be deterministic");

        // Local-frame output: origin = wall centre, positions stay SMALL (near 0) so the
        // f32 store survives at national-grid magnitude.
        assert_eq!(out1.origin, [center.x, center.y, center.z]);
        let max_abs = out1
            .positions
            .iter()
            .fold(0.0f32, |m, &v| m.max(v.abs()));
        assert!(max_abs < 10.0, "local-frame positions must stay small (got {max_abs})");

        assert!(param_cut_watertight(&out1), "cut must be watertight");
        assert!(out1.triangle_count() > 12, "the opening must add faces");
    }
}
