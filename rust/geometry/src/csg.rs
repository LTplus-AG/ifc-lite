// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! CSG (Constructive Solid Geometry) Operations
//!
//! Fast triangle clipping and boolean operations.

use crate::diagnostics::{BoolFailure, BoolFailureReason, BoolOp};
use crate::error::Result;
use crate::mesh::Mesh;
use nalgebra::{Point3, Vector3};
use rustc_hash::FxHashMap;
use smallvec::SmallVec;
use std::cell::RefCell;

/// Type alias for small triangle collections (typically 1-2 triangles from clipping)
pub type TriangleVec = SmallVec<[Triangle; 4]>;

/// Plane definition for clipping
#[derive(Debug, Clone, Copy)]
pub struct Plane {
    /// Point on the plane
    pub point: Point3<f64>,
    /// Normal vector (must be normalized)
    pub normal: Vector3<f64>,
}

impl Plane {
    /// Create a new plane
    pub fn new(point: Point3<f64>, normal: Vector3<f64>) -> Self {
        Self {
            point,
            normal: normal.normalize(),
        }
    }

    /// Calculate signed distance from point to plane
    /// Positive = in front, Negative = behind
    pub fn signed_distance(&self, point: &Point3<f64>) -> f64 {
        (point - self.point).dot(&self.normal)
    }

    /// Check if point is in front of plane
    pub fn is_front(&self, point: &Point3<f64>) -> bool {
        self.signed_distance(point) >= 0.0
    }
}

/// Triangle clipping result
#[derive(Debug, Clone)]
pub enum ClipResult {
    /// Triangle is completely in front (keep it)
    AllFront(Triangle),
    /// Triangle is completely behind (discard it)
    AllBehind,
    /// Triangle intersects plane - returns new triangles (uses SmallVec to avoid heap allocation)
    Split(TriangleVec),
}

/// Triangle definition
#[derive(Debug, Clone)]
pub struct Triangle {
    pub v0: Point3<f64>,
    pub v1: Point3<f64>,
    pub v2: Point3<f64>,
}

impl Triangle {
    /// Create a new triangle
    #[inline]
    pub fn new(v0: Point3<f64>, v1: Point3<f64>, v2: Point3<f64>) -> Self {
        Self { v0, v1, v2 }
    }

    /// Calculate triangle normal
    #[inline]
    pub fn normal(&self) -> Vector3<f64> {
        let edge1 = self.v1 - self.v0;
        let edge2 = self.v2 - self.v0;
        edge1.cross(&edge2).normalize()
    }

    /// Calculate the cross product of edges, which is twice the area vector.
    ///
    /// Returns a `Vector3<f64>` perpendicular to the triangle plane.
    /// For degenerate/collinear triangles, returns the zero vector.
    /// Use `is_degenerate()` or `try_normalize()` on the result if you need
    /// to detect and handle degenerate cases.
    #[inline]
    pub fn cross_product(&self) -> Vector3<f64> {
        let edge1 = self.v1 - self.v0;
        let edge2 = self.v2 - self.v0;
        edge1.cross(&edge2)
    }

    /// Calculate triangle area (half the magnitude of the cross product).
    #[inline]
    pub fn area(&self) -> f64 {
        self.cross_product().norm() * 0.5
    }

    /// Check if triangle is degenerate (zero area, collinear vertices).
    ///
    /// Uses `try_normalize` on the cross product with the specified epsilon.
    /// Returns `true` if the cross product cannot be normalized (i.e., degenerate).
    #[inline]
    pub fn is_degenerate(&self, epsilon: f64) -> bool {
        self.cross_product().try_normalize(epsilon).is_none()
    }
}

/// One recorded invocation of a CSG kernel op (perf-census diagnostics).
/// `op`: 0=subtract 1=union 2=intersection
/// 3=clip. `a_tris`/`b_tris` are the operand triangle counts — the arrangement
/// cost driver — so the census measures the *real* heavy-path workload reaching
/// the kernel (analytic AABB box clips never get here).
#[derive(Clone, Copy, Debug)]
pub struct CsgOpRecord {
    pub op: u8,
    pub a_tris: u32,
    pub b_tris: u32,
}

// Global (Mutex) so it captures ops on rayon worker threads, not just the caller.
static CSG_CENSUS: std::sync::Mutex<Vec<CsgOpRecord>> = std::sync::Mutex::new(Vec::new());

/// Clear the CSG op census (call before a measured run).
pub fn reset_csg_census() {
    if let Ok(mut g) = CSG_CENSUS.lock() {
        g.clear();
    }
}

/// Drain the CSG op census (call after a measured run).
pub fn take_csg_census() -> Vec<CsgOpRecord> {
    CSG_CENSUS
        .lock()
        .map(|mut g| std::mem::take(&mut *g))
        .unwrap_or_default()
}

#[inline]
fn record_csg_op(op: u8, a_tris: usize, b_tris: usize) {
    if let Ok(mut g) = CSG_CENSUS.lock() {
        g.push(CsgOpRecord {
            op,
            a_tris: a_tris as u32,
            b_tris: b_tris as u32,
        });
    }
}

/// CSG Clipping Processor
pub struct ClippingProcessor {
    /// Epsilon for floating point comparisons
    pub epsilon: f64,
    /// Boolean / CSG failures recorded since the last `take_failures()`.
    /// Interior-mutable so the existing `&self` API stays unchanged.
    failures: RefCell<Vec<BoolFailure>>,
}

/// Is `v` a degenerate NEEDLE — its shortest edge a hairline relative to its
/// longest? Such a triangle is a zero-area-intended sliver: the exact kernel
/// faithfully spans two near-coincident-but-distinct rim Vids (an f32-import /
/// shallow-dihedral near-duplicate the interner correctly does NOT weld) out to a
/// far vertex (issue #1007 / schependomlaan: the diagonal flap over an opening).
///
/// The test is `min_edge < floor_pow2(max_edge) · 2⁻¹³` — POWER-OF-TWO and
/// scale-relative, so it is bit-deterministic AND catches the needle (min 6.6 µm
/// vs max ~5 m ⇒ threshold ~5·10⁻⁴) while never touching a real thin sliver
/// (e.g. a 0.2 m × 2 m face, min 0.2 m ≫ 2·10⁻⁴). Dropping a needle cannot open a
/// real gap — the hole/seam is already framed by the neighbouring non-degenerate
/// triangles, exactly as Manifold (which welds the near-duplicate) produces.
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
/// otherwise pass the raw kernel needle through verbatim.
fn emit_triangle(mesh: &mut Mesh, v: &[Point3<f64>; 3], normal: &Vector3<f64>) {
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
    if mesh.positions.len() < 9 || mesh.indices.len() < 3 {
        return 0;
    }
    let q = |v: f32| (v as f64 * 1.0e3).round() as i64;
    let mut vid: FxHashMap<(i64, i64, i64), u32> = FxHashMap::default();
    let mut id_of = |i: usize| -> u32 {
        let k = (
            q(mesh.positions[i * 3]),
            q(mesh.positions[i * 3 + 1]),
            q(mesh.positions[i * 3 + 2]),
        );
        let next = vid.len() as u32;
        *vid.entry(k).or_insert(next)
    };
    let mut bal: FxHashMap<(u32, u32), i32> = FxHashMap::default();
    for tri in mesh.indices.chunks_exact(3) {
        let (a, b, c) = (
            id_of(tri[0] as usize),
            id_of(tri[1] as usize),
            id_of(tri[2] as usize),
        );
        for (x, y) in [(a, b), (b, c), (c, a)] {
            let (key, s) = if x < y { ((x, y), 1) } else { ((y, x), -1) };
            *bal.entry(key).or_insert(0) += s;
        }
    }
    bal.values().filter(|&&v| v != 0).count()
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

/// Drop 2D contour vertices that are collinear with both neighbours. The
/// i_overlay union of many small fragments often leaves "phantom"
/// vertices on every fragment boundary that crosses the outer outline;
/// without this pass earcut would emit one sliver triangle per phantom.
fn simplify_2d_collinear(ring: &[nalgebra::Point2<f64>]) -> Vec<nalgebra::Point2<f64>> {
    let n = ring.len();
    if n < 4 {
        return ring.to_vec();
    }
    let mut keep = vec![true; n];
    let mut changed = true;
    while changed {
        changed = false;
        for i in 0..n {
            if !keep[i] {
                continue;
            }
            let prev = (1..n).map(|k| (i + n - k) % n).find(|&k| keep[k]);
            let next = (1..n).map(|k| (i + k) % n).find(|&k| keep[k]);
            let (prev, next) = match (prev, next) {
                (Some(p), Some(n)) if p != i && n != i && p != n => (p, n),
                _ => continue,
            };
            let a = ring[prev];
            let b = ring[i];
            let c = ring[next];
            let e1x = b.x - a.x;
            let e1y = b.y - a.y;
            let e2x = c.x - b.x;
            let e2y = c.y - b.y;
            let cross = e1x * e2y - e1y * e2x;
            let len1 = (e1x * e1x + e1y * e1y).sqrt();
            let len2 = (e2x * e2x + e2y * e2y).sqrt();
            let denom = len1 * len2;
            // 1e-4 = sin(0.006°). Real arc samples sit well above this
            // (cavity 6-seg per quadrant ⇒ 15°/segment ⇒ sin ≈ 0.26); the
            // i_overlay union of split fragments leaves "phantom" vertices
            // whose sin(angle) ranges 1e-7..1e-5, all caught here.
            if denom < 1.0e-18 || (cross.abs() / denom) < 1.0e-4 {
                keep[i] = false;
                changed = true;
            }
        }
    }
    ring.iter()
        .zip(keep.iter())
        .filter_map(|(p, k)| if *k { Some(*p) } else { None })
        .collect()
}

/// Largest power of two ≤ `x` (x finite, > 0). The exponent is read straight
/// off the IEEE-754 bits, so the result is an EXACT f64 with a single set bit —
/// bit-identical across x86_64/aarch64/wasm (no rounding, no transcendental).
#[inline]
fn floor_pow2(x: f64) -> f64 {
    if !x.is_finite() || x <= 0.0 {
        return 0.0;
    }
    // 2^floor(log2(x)) via the unbiased exponent of the f64 representation.
    let exp = x.to_bits() >> 52 & 0x7ff; // biased exponent
    let unbiased = exp as i64 - 1023;
    // f64::powi keeps a power-of-two base exact; 2.0_f64.powi is exact for the
    // representable exponent range we hit (|coords| ≲ 1e7 ⇒ exponent ≲ 24).
    2.0_f64.powi(unbiased as i32)
}

/// Merge consecutive near-coincident 2D contour vertices BEFORE the union/earcut.
///
/// The exact mesh-arrangement kernel correctly preserves two distinct rim points
/// that the modeller intended as one but f32 import / a shallow-dihedral LPI
/// crossing split a few µm apart (issue #1007 / schependomlaan: the diagonal
/// sliver "flap" over an opening). They reach `consolidate_coplanar` as a hairline
/// notch on the hole/outer ring; `simplify_2d_collinear` (a TURN-ANGLE test) does
/// not remove them, so earcut frames the notch out to a far vertex → a degenerate
/// needle (aspect ≫ 10⁵) that renders as a flap across the opening.
///
/// This collapses any vertex within `eps` of its kept predecessor onto that
/// predecessor. `eps` is a POWER OF TWO scaled to the ring's bounding-box extent
/// (`floor_pow2(extent) · 2⁻¹³` ≈ extent/8192) and CAPPED at an absolute
/// 2⁻¹² m (244 µm) — bit-deterministic. On the #1007 fixture the rim
/// duplicates span 6–72 µm on ~2 m faces (~3·10⁻⁶ … 4·10⁻⁵ of the extent)
/// while the smallest REAL feature edge is 0.2 m (~0.1 of the extent), so eps
/// (~10⁻⁴ of the extent) sits three orders of magnitude above the duplicate
/// spread and three below any real edge — no over-weld. The absolute cap is
/// what protects mm-scale features on LARGE rings: the duplicate spread comes
/// from f32 import noise / shallow-dihedral LPI crossings whose magnitude does
/// NOT grow with ring extent (operands are snapped about their AABB centre),
/// but an uncapped extent-relative eps reaches 1 mm at 8 m and would swallow a
/// genuine 1 mm chamfer on a long steel member. This runs in the already-
/// non-exact consolidation post-pass; it does NOT touch the exact kernel's
/// interner/predicates (no float weld in the determinism path).
fn weld_near_coincident_2d(ring: &[nalgebra::Point2<f64>]) -> Vec<nalgebra::Point2<f64>> {
    let n = ring.len();
    if n < 4 {
        return ring.to_vec();
    }
    let (mut minx, mut miny, mut maxx, mut maxy) =
        (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for p in ring {
        minx = minx.min(p.x);
        miny = miny.min(p.y);
        maxx = maxx.max(p.x);
        maxy = maxy.max(p.y);
    }
    let extent = (maxx - minx).max(maxy - miny);
    if !extent.is_finite() || extent <= 0.0 {
        return ring.to_vec();
    }
    // extent · 2⁻¹³ rounded DOWN to a power of two, capped at an absolute
    // 2⁻¹² m so big rings can't swallow mm-scale features ⇒ exact, deterministic.
    let eps = (floor_pow2(extent) * 2.0_f64.powi(-13)).min(2.0_f64.powi(-12));
    let eps2 = eps * eps;
    let mut kept: Vec<nalgebra::Point2<f64>> = Vec::with_capacity(n);
    for &p in ring {
        let dup = kept.last().is_some_and(|q| {
            let dx = p.x - q.x;
            let dy = p.y - q.y;
            dx * dx + dy * dy < eps2
        });
        if !dup {
            kept.push(p);
        }
    }
    // close-the-loop check: last vs first.
    if kept.len() >= 2 {
        let (first, last) = (kept[0], *kept.last().unwrap());
        let dx = last.x - first.x;
        let dy = last.y - first.y;
        if dx * dx + dy * dy < eps2 {
            kept.pop();
        }
    }
    if kept.len() >= 3 {
        kept
    } else {
        ring.to_vec()
    }
}

/// Create a box mesh from AABB min/max bounds
/// Returns a mesh with 12 triangles (2 per face, 6 faces)
fn aabb_to_mesh(min: Point3<f64>, max: Point3<f64>) -> Mesh {
    let mut mesh = Mesh::with_capacity(8, 36);

    // Define the 8 vertices of the box
    let v0 = Point3::new(min.x, min.y, min.z); // 0: front-bottom-left
    let v1 = Point3::new(max.x, min.y, min.z); // 1: front-bottom-right
    let v2 = Point3::new(max.x, max.y, min.z); // 2: front-top-right
    let v3 = Point3::new(min.x, max.y, min.z); // 3: front-top-left
    let v4 = Point3::new(min.x, min.y, max.z); // 4: back-bottom-left
    let v5 = Point3::new(max.x, min.y, max.z); // 5: back-bottom-right
    let v6 = Point3::new(max.x, max.y, max.z); // 6: back-top-right
    let v7 = Point3::new(min.x, max.y, max.z); // 7: back-top-left

    // Add triangles for each face (counter-clockwise winding when viewed from outside)
    // Front face (z = min.z) - normal points toward -Z
    add_triangle_to_mesh(&mut mesh, &Triangle::new(v0, v2, v1));
    add_triangle_to_mesh(&mut mesh, &Triangle::new(v0, v3, v2));

    // Back face (z = max.z) - normal points toward +Z
    add_triangle_to_mesh(&mut mesh, &Triangle::new(v4, v5, v6));
    add_triangle_to_mesh(&mut mesh, &Triangle::new(v4, v6, v7));

    // Left face (x = min.x) - normal points toward -X
    add_triangle_to_mesh(&mut mesh, &Triangle::new(v0, v4, v7));
    add_triangle_to_mesh(&mut mesh, &Triangle::new(v0, v7, v3));

    // Right face (x = max.x) - normal points toward +X
    add_triangle_to_mesh(&mut mesh, &Triangle::new(v1, v2, v6));
    add_triangle_to_mesh(&mut mesh, &Triangle::new(v1, v6, v5));

    // Bottom face (y = min.y) - normal points toward -Y
    add_triangle_to_mesh(&mut mesh, &Triangle::new(v0, v1, v5));
    add_triangle_to_mesh(&mut mesh, &Triangle::new(v0, v5, v4));

    // Top face (y = max.y) - normal points toward +Y
    add_triangle_to_mesh(&mut mesh, &Triangle::new(v3, v7, v6));
    add_triangle_to_mesh(&mut mesh, &Triangle::new(v3, v6, v2));

    mesh
}

impl ClippingProcessor {
    /// Create a new clipping processor
    pub fn new() -> Self {
        Self {
            epsilon: 1e-6,
            failures: RefCell::new(Vec::new()),
        }
    }

    /// Drain and return the failures recorded by this processor since its
    /// creation (or the last `take_failures` call). The processor's internal
    /// log is cleared.
    pub fn take_failures(&self) -> Vec<BoolFailure> {
        std::mem::take(&mut *self.failures.borrow_mut())
    }

    /// Number of failures currently buffered (without draining).
    pub fn failure_count(&self) -> usize {
        self.failures.borrow().len()
    }

    /// Whether any failure recorded since index `since` (a prior
    /// [`failure_count`](Self::failure_count)) was an `OperandTooLarge`
    /// rejection. HISTORICAL: only the deleted BSP polygon cap ever
    /// emitted this from the boolean ops — the exact kernel has no operand
    /// cap, so this is now always `false` on the boolean path. Kept because
    /// the void router still keys its AABB-fallback decision on it
    /// (issue #635 / #947), which is conservative and correct either way.
    pub(crate) fn has_operand_too_large_since(&self, since: usize) -> bool {
        let failures = self.failures.borrow();
        let since = since.min(failures.len());
        failures[since..]
            .iter()
            .any(|f| matches!(f.reason, BoolFailureReason::OperandTooLarge { .. }))
    }

    /// Internal: append a failure record. Public-crate so the boolean
    /// processor in `processors/boolean.rs` can record fallbacks that
    /// happen above the kernel layer.
    pub(crate) fn record_failure(&self, op: BoolOp, reason: BoolFailureReason) {
        self.failures.borrow_mut().push(BoolFailure::new(op, reason));
    }

    /// Clip a triangle against a plane
    /// Returns triangles that are in front of the plane
    pub fn clip_triangle(&self, triangle: &Triangle, plane: &Plane) -> ClipResult {
        // Calculate signed distances for all vertices
        let d0 = plane.signed_distance(&triangle.v0);
        let d1 = plane.signed_distance(&triangle.v1);
        let d2 = plane.signed_distance(&triangle.v2);

        // Edge intersection parameter, clamped to the segment. Vertices are
        // classified front/back with an epsilon band (`d >= -epsilon`), so a
        // "front" vertex can sit slightly behind the plane (d in [-epsilon, 0)).
        // Feeding that raw distance into `d_front / (d_front - d_back)` yields a
        // t outside [0, 1] — and when the plane is nearly coincident with a host
        // face the denominator collapses, extrapolating the cut vertex far off
        // the edge (issue #1155: a clipped column flew ~97 m). Clamping keeps the
        // intersection on the edge; the near-zero guard avoids a NaN from a
        // degenerate (in-plane) edge.
        let edge_t = |d_front: f64, d_back: f64| -> f64 {
            let denom = d_front - d_back;
            if denom.abs() < 1.0e-12 {
                0.0
            } else {
                (d_front / denom).clamp(0.0, 1.0)
            }
        };

        // Count vertices in front of plane
        let mut front_count = 0;
        if d0 >= -self.epsilon {
            front_count += 1;
        }
        if d1 >= -self.epsilon {
            front_count += 1;
        }
        if d2 >= -self.epsilon {
            front_count += 1;
        }

        match front_count {
            // All vertices behind - discard triangle
            0 => ClipResult::AllBehind,

            // All vertices in front - keep triangle
            3 => ClipResult::AllFront(triangle.clone()),

            // One vertex in front - create 1 smaller triangle
            1 => {
                let (front, back1, back2) = if d0 >= -self.epsilon {
                    (triangle.v0, triangle.v1, triangle.v2)
                } else if d1 >= -self.epsilon {
                    (triangle.v1, triangle.v2, triangle.v0)
                } else {
                    (triangle.v2, triangle.v0, triangle.v1)
                };

                // Interpolate to find intersection points
                let d_front = if d0 >= -self.epsilon {
                    d0
                } else if d1 >= -self.epsilon {
                    d1
                } else {
                    d2
                };
                let d_back1 = if d0 >= -self.epsilon {
                    d1
                } else if d1 >= -self.epsilon {
                    d2
                } else {
                    d0
                };
                let d_back2 = if d0 >= -self.epsilon {
                    d2
                } else if d1 >= -self.epsilon {
                    d0
                } else {
                    d1
                };

                let t1 = edge_t(d_front, d_back1);
                let t2 = edge_t(d_front, d_back2);

                let p1 = front + (back1 - front) * t1;
                let p2 = front + (back2 - front) * t2;

                ClipResult::Split(smallvec::smallvec![Triangle::new(front, p1, p2)])
            }

            // Two vertices in front - create 2 triangles
            2 => {
                let (front1, front2, back) = if d0 < -self.epsilon {
                    (triangle.v1, triangle.v2, triangle.v0)
                } else if d1 < -self.epsilon {
                    (triangle.v2, triangle.v0, triangle.v1)
                } else {
                    (triangle.v0, triangle.v1, triangle.v2)
                };

                // Interpolate to find intersection points
                let d_back = if d0 < -self.epsilon {
                    d0
                } else if d1 < -self.epsilon {
                    d1
                } else {
                    d2
                };
                let d_front1 = if d0 < -self.epsilon {
                    d1
                } else if d1 < -self.epsilon {
                    d2
                } else {
                    d0
                };
                let d_front2 = if d0 < -self.epsilon {
                    d2
                } else if d1 < -self.epsilon {
                    d0
                } else {
                    d1
                };

                let t1 = edge_t(d_front1, d_back);
                let t2 = edge_t(d_front2, d_back);

                let p1 = front1 + (back - front1) * t1;
                let p2 = front2 + (back - front2) * t2;

                ClipResult::Split(smallvec::smallvec![
                    Triangle::new(front1, front2, p1),
                    Triangle::new(front2, p2, p1),
                ])
            }

            _ => unreachable!(),
        }
    }

    /// Box subtraction - removes everything inside the box from the mesh
    /// Uses proper CSG difference operation via subtract_mesh
    pub fn subtract_box(&self, mesh: &Mesh, min: Point3<f64>, max: Point3<f64>) -> Result<Mesh> {
        // Fast path: if mesh is empty, return empty mesh
        if mesh.is_empty() {
            return Ok(Mesh::new());
        }

        // Create a box mesh from the AABB bounds
        let box_mesh = aabb_to_mesh(min, max);

        // Use the CSG difference operation (mesh - box)
        self.subtract_mesh(mesh, &box_mesh)
    }

    /// Check if two meshes' bounding boxes overlap
    fn bounds_overlap(host_mesh: &Mesh, opening_mesh: &Mesh) -> bool {
        let (host_min, host_max) = host_mesh.bounds();
        let (open_min, open_max) = opening_mesh.bounds();

        // Issue #977: this runs on the *un-inflated* cutter, before
        // `manifold_kernel::difference` inflates it. A recess whose cut face is
        // exactly flush with a host face touches the host's AABB right at the
        // boundary; strict `<`/`>` would classify it as non-overlapping and drop
        // the cut before inflation ever runs. Use inclusive `<=`/`>=` with a small
        // *relative* epsilon (scaled to the operands, so it is unit-robust across
        // mm/m models) to keep flush cutters in play without admitting genuinely
        // disjoint operands.
        let span = (host_max.x - host_min.x)
            .max(host_max.y - host_min.y)
            .max(host_max.z - host_min.z)
            .max(open_max.x - open_min.x)
            .max(open_max.y - open_min.y)
            .max(open_max.z - open_min.z);
        let eps = span * 1e-6;

        let overlap_x = open_min.x - eps <= host_max.x && open_max.x + eps >= host_min.x;
        let overlap_y = open_min.y - eps <= host_max.y && open_max.y + eps >= host_min.y;
        let overlap_z = open_min.z - eps <= host_max.z && open_max.z + eps >= host_min.z;

        overlap_x && overlap_y && overlap_z
    }

    /// Subtract opening mesh from host mesh using CSG boolean operations
    /// on the pure-Rust exact mesh-arrangement kernel.
    ///
    /// On any failure path the host is returned un-cut and a [`BoolFailure`]
    /// record is appended to the processor's failure log (drainable via
    /// [`Self::take_failures`]). An empty host returns an empty mesh without
    /// recording a failure (it's a fast path, not a fallback).
    pub fn subtract_mesh(&self, host_mesh: &Mesh, opening_mesh: &Mesh) -> Result<Mesh> {
        record_csg_op(0, host_mesh.triangle_count(), opening_mesh.triangle_count());
        if host_mesh.is_empty() {
            return Ok(Mesh::new());
        }
        if opening_mesh.is_empty() {
            self.record_failure(BoolOp::Difference, BoolFailureReason::EmptyOperand);
            return Ok(host_mesh.clone());
        }
        if !Self::bounds_overlap(host_mesh, opening_mesh) {
            self.record_failure(BoolOp::Difference, BoolFailureReason::NoBoundsOverlap);
            return Ok(host_mesh.clone());
        }

        // Pure-Rust exact mesh-arrangement kernel, with consolidate_coplanar
        // merging per-face fragments to match Manifold's clean output.
        //
        // NB: the kernel output itself is the watertightness bar — the
        // crack-family fix lives upstream (`promote_cutter_verts_onto_host_faces`'s
        // exact-plane lift). `consolidate_coplanar` can still re-open a closed
        // cut along a µm-offset plane pair (each bucket earcuts independently,
        // breaking the shared boundary chain); a closure-preserving guard here
        // was tried and REJECTED — on FZK-Haus gable walls the raw kernel
        // output carries >50:1 needle fragments that consolidation legitimately
        // merges (the pinned `csg_quality_regression` spike bar). A
        // seam-preserving consolidation is the remaining follow-up.
        crate::kernel::budget::begin();
        let raw = crate::kernel::mesh_bridge::subtract(host_mesh, opening_mesh);
        // Deterministic escalation guardrail (#1109): if the exact predicate
        // cascade escalated past the per-boolean budget, the cut bailed mid-
        // arrangement. Discard the partial result and return the host un-cut so
        // the void router's #635 AABB box-cut fallback fires. The trip point is a
        // pure function of the snapped operands, so server (native) and client
        // (wasm) degrade the SAME element identically — parity preserved.
        if crate::kernel::budget::tripped() {
            self.record_failure(
                BoolOp::Difference,
                BoolFailureReason::OperandTooLarge {
                    polys_a: host_mesh.triangle_count(),
                    polys_b: opening_mesh.triangle_count(),
                },
            );
            return Ok(host_mesh.clone());
        }
        let result = Self::consolidate_coplanar(raw);
        if !result.is_empty() && !self.validate_mesh(&result) {
            self.record_failure(BoolOp::Difference, BoolFailureReason::KernelOutputInvalid);
            return Ok(host_mesh.clone());
        }
        Ok(result)
    }

    /// Subtract a GROUP of pairwise-disjoint opening cutters from the host in
    /// ONE conforming arrangement (disjoint-cutter batching).
    ///
    /// A REJECTED group (the N-ary arrangement could not fully conform, or no
    /// cutter overlaps the host) returns the host UN-CUT and records NO
    /// failure: rejection is the expected, handled outcome — the router's
    /// per-opening sequential loop (with the full #635 fallback machinery and
    /// its own diagnostics) immediately takes over for the group's members, so
    /// a failure record here would be pure noise on elements whose voids end
    /// up perfectly cut (the issue-582/583 zero-CSG-failure bar). Only a
    /// genuinely invalid kernel OUTPUT records, exactly like
    /// [`Self::subtract_mesh`].
    pub fn subtract_mesh_many(&self, host_mesh: &Mesh, cutters: &[&Mesh]) -> Result<Mesh> {
        let total: usize = cutters.iter().map(|c| c.triangle_count()).sum();
        record_csg_op(0, host_mesh.triangle_count(), total);
        if host_mesh.is_empty() {
            return Ok(Mesh::new());
        }
        let live: Vec<&Mesh> = cutters
            .iter()
            .copied()
            .filter(|c| !c.is_empty() && Self::bounds_overlap(host_mesh, c))
            .collect();
        if live.is_empty() {
            return Ok(host_mesh.clone()); // silent: sequential path takes over
        }
        crate::kernel::budget::begin();
        let raw = crate::kernel::mesh_bridge::subtract_many(host_mesh, &live);
        if crate::kernel::budget::tripped() {
            // Escalation budget exceeded on the batched arrangement (#1109).
            // Reject silently so the per-opening sequential path takes over —
            // each opening gets its own budget + #635 AABB fallback, so the few
            // hard cutters degrade while the rest cut exactly. Deterministic.
            return Ok(host_mesh.clone());
        }
        let Some(raw) = raw else {
            // Unrecovered constraint in the N-ary arrangement — reject the
            // group (silently, see above) so the sequential per-opening path
            // (few constraints per arrangement) takes over.
            return Ok(host_mesh.clone());
        };
        let result = Self::consolidate_coplanar(raw);
        if !result.is_empty() && !self.validate_mesh(&result) {
            self.record_failure(BoolOp::Difference, BoolFailureReason::KernelOutputInvalid);
            return Ok(host_mesh.clone());
        }
        Ok(result)
    }

    /// Re-merge the kernel's per-plane fragments via 2D polygon union, then
    /// earcut each result back to triangles. CSG over-fragments host faces
    /// along operand cut lines; a naive edge-walk merge fails on the
    /// "X" crossings that appear at cutter-outline corners (four fragments
    /// sharing only a vertex), so we project each plane bucket to 2D, run
    /// the i_overlay union the rest of the codebase already uses for
    /// `bool2d::union_contours`, and earcut the resulting (possibly
    /// annular) shapes. This is what brought the bath from 189 → ~50
    /// triangles with the cavity outline intact (issue #780); it also hosts
    /// the needle/weld cleanup passes for #1007.
    ///
    /// Returns the input mesh unchanged if the consolidate fails or yields
    /// nothing — never worse than the raw kernel output.
    pub(crate) fn consolidate_coplanar(mesh: Mesh) -> Mesh {
        use crate::triangulation::{
            project_to_2d_with_basis, triangulate_polygon_with_holes_refined,
        };
        use i_overlay::core::fill_rule::FillRule;
        use i_overlay::core::overlay_rule::OverlayRule;
        use i_overlay::float::single::SingleFloatOverlay;

        if mesh.indices.len() < 6 {
            return mesh;
        }

        // Quantization for plane bucketing — normals are coarser (1e3) than
        // positions because cross-product noise on near-coplanar tris can
        // wobble in the 6th decimal; offsets get the same coarsening so
        // bucket keys stay aligned with normal direction.
        //
        // NB (issue #1007): the offset key is deliberately FINE (1 µm) and must
        // NOT be coarsened. The exact-kernel opening cut on a faceted-BREP roof
        // emits the hole-boundary triangles on planes that jitter ~25–150 µm;
        // that jitter is what keeps each on its own bucket. Coalescing them (a
        // coarser offset grid, or projecting the whole roof slope to ONE canonical
        // plane) lets the i_overlay UNION close the opening hole — a bridging facet
        // over the footprint, caught by `issue_1007_real_opening_no_bridge`.
        const POS_QUANT: f64 = 1.0e6;
        const NORMAL_QUANT: f64 = 1.0e3;
        let qpos = |p: f64| (p * POS_QUANT).round() as i64;
        let qnorm = |n: f64| (n * NORMAL_QUANT).round() as i64;

        // Step 1 — group input triangles by plane.
        struct PlaneTri {
            v: [Point3<f64>; 3],
            normal: Vector3<f64>,
        }
        let positions = &mesh.positions;
        let vertex_count = positions.len() / 3;
        let mut buckets: FxHashMap<(i64, i64, i64, i64), Vec<PlaneTri>> =
            FxHashMap::default();
        for chunk in mesh.indices.chunks_exact(3) {
            let (i0, i1, i2) = (chunk[0] as usize, chunk[1] as usize, chunk[2] as usize);
            if i0 >= vertex_count || i1 >= vertex_count || i2 >= vertex_count {
                continue;
            }
            let v0 = Point3::new(
                positions[i0 * 3] as f64,
                positions[i0 * 3 + 1] as f64,
                positions[i0 * 3 + 2] as f64,
            );
            let v1 = Point3::new(
                positions[i1 * 3] as f64,
                positions[i1 * 3 + 1] as f64,
                positions[i1 * 3 + 2] as f64,
            );
            let v2 = Point3::new(
                positions[i2 * 3] as f64,
                positions[i2 * 3 + 1] as f64,
                positions[i2 * 3 + 2] as f64,
            );
            let edge1 = v1 - v0;
            let edge2 = v2 - v0;
            let cross = edge1.cross(&edge2);
            let len = cross.norm();
            if len < 1.0e-10 {
                continue;
            }
            let normal = cross / len;
            let offset = normal.dot(&v0.coords);
            let key = (
                qnorm(normal.x),
                qnorm(normal.y),
                qnorm(normal.z),
                qpos(offset),
            );
            buckets.entry(key).or_default().push(PlaneTri {
                v: [v0, v1, v2],
                normal,
            });
        }

        let mut output = Mesh::new();

        // Step 2 — per bucket, union triangles in 2D, triangulate result.
        for tris in buckets.values() {
            if tris.is_empty() {
                continue;
            }
            // Use the FIRST triangle's normal/anchor for a stable 2D basis;
            // all tris in this bucket share the plane by construction.
            let normal = tris[0].normal;
            let origin = tris[0].v[0];
            let abs = (normal.x.abs(), normal.y.abs(), normal.z.abs());
            let reference = if abs.0 <= abs.1 && abs.0 <= abs.2 {
                Vector3::new(1.0, 0.0, 0.0)
            } else if abs.1 <= abs.2 {
                Vector3::new(0.0, 1.0, 0.0)
            } else {
                Vector3::new(0.0, 0.0, 1.0)
            };
            let u_axis = normal.cross(&reference).normalize();
            let v_axis = normal.cross(&u_axis).normalize();
            // CCW-in-2D convention: i_overlay's NonZero fill needs each
            // input triangle wound CCW in (u, v). Our 3D triangles are CCW
            // looking down `normal`; the (u, v) basis above is right-handed
            // with `v = normal × u`, so projection preserves winding.

            // Project each triangle to 2D and build i_overlay paths.
            if tris.len() == 1 {
                // Single triangle — skip the union round-trip entirely.
                emit_triangle(&mut output, &tris[0].v, &normal);
                continue;
            }
            let mut subject: Vec<Vec<[f64; 2]>> = Vec::with_capacity(1);
            let mut clip: Vec<Vec<[f64; 2]>> = Vec::with_capacity(tris.len() - 1);
            for (idx, tri) in tris.iter().enumerate() {
                let pts_2d = project_to_2d_with_basis(&tri.v, &u_axis, &v_axis, &origin);
                // Force CCW for i_overlay's NonZero fill — kernel output
                // fragments can carry inconsistent winding, and mixed-winding
                // subject + clip cancel out instead of unioning.
                let signed_area = (pts_2d[1].x - pts_2d[0].x)
                    * (pts_2d[2].y - pts_2d[0].y)
                    - (pts_2d[2].x - pts_2d[0].x)
                        * (pts_2d[1].y - pts_2d[0].y);
                let path: Vec<[f64; 2]> = if signed_area >= 0.0 {
                    pts_2d.iter().map(|p| [p.x, p.y]).collect()
                } else {
                    pts_2d.iter().rev().map(|p| [p.x, p.y]).collect()
                };
                if idx == 0 {
                    subject.push(path);
                } else {
                    clip.push(path);
                }
            }

            let shapes = subject.overlay(&clip, OverlayRule::Union, FillRule::NonZero);
            if shapes.is_empty() {
                // Union collapsed everything — emit originals to avoid loss.
                for t in tris {
                    emit_triangle(&mut output, &t.v, &normal);
                }
                continue;
            }

            // Total bucket area — used to filter sub-resolution shapes /
            // holes (f64 noise leaves tiny spurious cavities after the
            // i_overlay union).
            let bucket_area: f64 = tris
                .iter()
                .map(|t| {
                    let pts =
                        project_to_2d_with_basis(&t.v, &u_axis, &v_axis, &origin);
                    0.5_f64
                        * ((pts[1].x - pts[0].x) * (pts[2].y - pts[0].y)
                            - (pts[2].x - pts[0].x) * (pts[1].y - pts[0].y))
                            .abs()
                })
                .sum();
            let min_significant = (bucket_area * 1.0e-4).max(1.0e-8);

            let signed_area_2d = |ring: &[nalgebra::Point2<f64>]| -> f64 {
                let n = ring.len();
                if n < 3 {
                    return 0.0;
                }
                let mut s = 0.0;
                for i in 0..n {
                    let j = (i + 1) % n;
                    s += ring[i].x * ring[j].y - ring[j].x * ring[i].y;
                }
                s * 0.5
            };

            for shape in shapes {
                if shape.is_empty() {
                    continue;
                }
                let outer_2d: Vec<nalgebra::Point2<f64>> = shape[0]
                    .iter()
                    .map(|p| nalgebra::Point2::new(p[0], p[1]))
                    .collect();
                // Weld µm-scale near-coincident rim duplicates FIRST (the #1007
                // diagonal-sliver source), THEN drop collinear phantoms.
                let outer_welded = weld_near_coincident_2d(&outer_2d);
                let outer_simplified = simplify_2d_collinear(&outer_welded);
                if outer_simplified.len() < 3 {
                    continue;
                }
                let outer_area = signed_area_2d(&outer_simplified).abs();
                if outer_area < min_significant {
                    continue;
                }
                let holes_simplified: Vec<Vec<nalgebra::Point2<f64>>> = shape
                    .iter()
                    .skip(1)
                    .filter_map(|c| {
                        let pts: Vec<_> = c
                            .iter()
                            .map(|p| nalgebra::Point2::new(p[0], p[1]))
                            .collect();
                        let welded = weld_near_coincident_2d(&pts);
                        let simplified = simplify_2d_collinear(&welded);
                        if simplified.len() < 3 {
                            return None;
                        }
                        let area = signed_area_2d(&simplified).abs();
                        if area < min_significant {
                            return None;
                        }
                        Some(simplified)
                    })
                    .collect();

                // Quality CDT + bounded Ruppert refinement. Returns the
                // (possibly Steiner-augmented) 2D vertex list `all_2d` plus
                // indices into it; the lift below maps EVERY returned vertex
                // (input + Steiner) back to 3D, so a Steiner point on a shared
                // edge is split on both sides → watertight, no T-junction.
                // allow_boundary_split = false: this region's outer/hole rings
                // are shared with neighbouring plane buckets triangulated
                // independently; a boundary Steiner point would tear that seam
                // (open edges / T-junctions). Interior-only refinement keeps the
                // seam watertight while still removing the rim-corner slivers.
                let (all_2d, indices) = match triangulate_polygon_with_holes_refined(
                    &outer_simplified,
                    &holes_simplified,
                    false,
                ) {
                    Ok((pts, idx)) => (pts, idx),
                    Err(_) => continue,
                };

                let lift = |p: nalgebra::Point2<f64>| -> Point3<f64> {
                    let off = u_axis * p.x + v_axis * p.y;
                    origin + off
                };
                let mut verts_3d: Vec<Point3<f64>> = Vec::with_capacity(all_2d.len());
                for p in &all_2d {
                    verts_3d.push(lift(*p));
                }

                let base = output.vertex_count() as u32;
                for vp in &verts_3d {
                    output.add_vertex(*vp, normal);
                }
                for tri in indices.chunks_exact(3) {
                    // Needle backstop: drop any residual sub-weld degenerate sliver
                    // ([`tri_is_needle`], the same scale-relative power-of-two rule
                    // as the single-triangle path). Cannot open a real gap — the
                    // hole/seam is framed by its non-degenerate neighbours.
                    let v = [
                        verts_3d[tri[0]],
                        verts_3d[tri[1]],
                        verts_3d[tri[2]],
                    ];
                    if tri_is_needle(&v) {
                        continue;
                    }
                    output.add_triangle(
                        base + tri[0] as u32,
                        base + tri[1] as u32,
                        base + tri[2] as u32,
                    );
                }
            }
        }

        if output.is_empty() {
            return mesh;
        }
        // WATERTIGHTNESS GUARD (curved / opening-dense wall hairline cracks). The
        // per-bucket re-triangulation above treats each coplanar plane bucket
        // independently. Where a FLAT bucket's boundary runs along a faceted surface
        // — an opening reveal, a cap, the rim of a curved or offset-jittered wall —
        // the i_overlay union + collinear simplify chords that boundary, dropping the
        // facet-boundary vertices the abutting buckets keep. The result is open
        // boundary edges + T-junctions at the cut seam that the raw kernel output
        // (which is watertight) did NOT have = the white horizontal hairlines that
        // shimmer under DoubleSide. Detect it directly and pick the better mesh by
        // (open edges + spike triangles): when consolidation introduced open edges
        // and the raw mesh is the cleaner one overall, return raw. A curved/offset-
        // jittered host's raw is watertight and well-formed (raw wins -> crack gone);
        // a host whose raw carries needle fans consolidation exists to merge keeps the
        // consolidated mesh. Watertight, spike-free hosts (the overwhelming majority,
        // incl. #780 bath and ordinary flat walls) have cons_open == 0 and return
        // immediately -> byte-identical, determinism snapshots unmoved. The exact
        // kernel (and `indirect_sign_manifest`) is untouched; this only repairs what
        // the post-kernel consolidation drops.
        // Cheap geometric pre-filter so the per-host open-edge scan (its hashmap is
        // the WASM load cost, not the rare fallback) stays OFF the hot path for the
        // ~13k ordinary box-like walls. A host can only have a chorded seam if it is
        // FACETED: either NON-ORTHOGONAL plane pairs (a curved wall, a sloped gable
        // roof clip — neither parallel nor perpendicular) or many PARALLEL offset
        // buckets per normal direction (an f32-jittered opening-dense wall like the
        // curved reception counter, distinct_normals=5 / 168 planes). A box wall has
        // only axis-aligned planes and consolidates watertight -> skipped.
        let mut bnorms: Vec<Vector3<f64>> = Vec::new();
        for tris in buckets.values() {
            if let Some(t0) = tris.first() {
                if !bnorms.iter().any(|m| m.dot(&t0.normal).abs() > 0.99999) {
                    bnorms.push(t0.normal);
                }
            }
        }
        let nonorthogonal = (0..bnorms.len()).any(|i| {
            ((i + 1)..bnorms.len()).any(|j| {
                let d = bnorms[i].dot(&bnorms[j]).abs();
                d > 0.01 && d < 0.9999 // angle in (~0.8°, ~89.4°)
            })
        });
        let offset_jittered = buckets.len() > 4 * bnorms.len().max(1);
        if nonorthogonal || offset_jittered {
            let cons_open = count_open_boundary_edges(&output);
            if cons_open > 0 {
                let raw_bad = count_open_boundary_edges(&mesh) + count_spike_triangles(&mesh);
                let cons_bad = cons_open + count_spike_triangles(&output);
                if raw_bad < cons_bad {
                    return mesh;
                }
            }
        }
        output
    }

    /// Union two meshes together using CSG boolean operations on the
    /// pure-Rust exact kernel.
    ///
    /// Empty operands are handled silently — they have a unique correct answer.
    pub fn union_mesh(&self, mesh_a: &Mesh, mesh_b: &Mesh) -> Result<Mesh> {
        record_csg_op(1, mesh_a.triangle_count(), mesh_b.triangle_count());
        if mesh_a.is_empty() {
            return Ok(mesh_b.clone());
        }
        if mesh_b.is_empty() {
            return Ok(mesh_a.clone());
        }

        // Pure-Rust exact kernel. On an empty/invalid kernel result
        // fall back to a plain merge (overlap not removed) + record the failure,
        // preserving the legacy never-Err contract.
        let raw_u = crate::kernel::mesh_bridge::union(mesh_a, mesh_b);
        let result = Self::consolidate_coplanar(raw_u);
        if result.is_empty() || !self.validate_mesh(&result) {
            self.record_failure(BoolOp::Union, BoolFailureReason::KernelOutputInvalid);
            let mut merged = mesh_a.clone();
            merged.merge(mesh_b);
            return Ok(merged);
        }
        Ok(result)
    }

    /// Intersect two meshes using CSG boolean operations on the pure-Rust
    /// exact kernel.
    ///
    /// Returns the intersection of two meshes (the volume where both
    /// overlap).
    pub fn intersection_mesh(&self, mesh_a: &Mesh, mesh_b: &Mesh) -> Result<Mesh> {
        record_csg_op(2, mesh_a.triangle_count(), mesh_b.triangle_count());
        if mesh_a.is_empty() || mesh_b.is_empty() {
            return Ok(Mesh::new());
        }

        // Pure-Rust exact kernel. An empty result is legitimate
        // (disjoint operands → empty intersection).
        let result =
            Self::consolidate_coplanar(crate::kernel::mesh_bridge::intersection(mesh_a, mesh_b));
        if !result.is_empty() && !self.validate_mesh(&result) {
            self.record_failure(BoolOp::Intersection, BoolFailureReason::KernelOutputInvalid);
            return Ok(Mesh::new());
        }
        Ok(result)
    }

    /// Union multiple meshes together
    ///
    /// Convenience method that sequentially unions all non-empty meshes.
    /// Skips empty meshes to avoid unnecessary CSG operations.
    pub fn union_meshes(&self, meshes: &[Mesh]) -> Result<Mesh> {
        if meshes.is_empty() {
            return Ok(Mesh::new());
        }

        if meshes.len() == 1 {
            return Ok(meshes[0].clone());
        }

        // Start with first non-empty mesh
        let mut result = Mesh::new();
        let mut found_first = false;

        for mesh in meshes {
            if mesh.is_empty() {
                continue;
            }

            if !found_first {
                result = mesh.clone();
                found_first = true;
                continue;
            }

            result = self.union_mesh(&result, mesh)?;
        }

        Ok(result)
    }

    /// Subtract multiple meshes efficiently
    ///
    /// When void count exceeds threshold, unions all voids first
    /// then performs a single subtraction. This is much more efficient
    /// for elements with many openings (e.g., floors with many penetrations).
    ///
    /// # Arguments
    /// * `host` - The host mesh to subtract from
    /// * `voids` - List of void meshes to subtract
    ///
    /// # Returns
    /// The host mesh with all voids subtracted
    pub fn subtract_meshes_batched(&self, host: &Mesh, voids: &[Mesh]) -> Result<Mesh> {
        // Filter out empty meshes
        let non_empty_voids: Vec<&Mesh> = voids.iter().filter(|m| !m.is_empty()).collect();

        if non_empty_voids.is_empty() {
            return Ok(host.clone());
        }

        if non_empty_voids.len() == 1 {
            return self.subtract_mesh(host, non_empty_voids[0]);
        }

        // Threshold for batching: if more than 10 voids, union them first
        const BATCH_THRESHOLD: usize = 10;

        if non_empty_voids.len() > BATCH_THRESHOLD {
            // Union all voids into a single mesh first
            let void_refs: Vec<Mesh> = non_empty_voids.iter().map(|m| (*m).clone()).collect();
            let combined = self.union_meshes(&void_refs)?;

            // Single subtraction
            self.subtract_mesh(host, &combined)
        } else {
            // Sequential subtraction for small counts
            let mut result = host.clone();

            for void in non_empty_voids {
                result = self.subtract_mesh(&result, void)?;
            }

            Ok(result)
        }
    }

    /// Subtract meshes with fallback on failure
    ///
    /// Attempts batched subtraction, but if it fails, returns the host mesh
    /// unchanged rather than propagating the error. This provides graceful
    /// degradation for problematic void geometries.
    pub fn subtract_meshes_with_fallback(&self, host: &Mesh, voids: &[Mesh]) -> Mesh {
        // Empty host has nothing to cut — short-circuit before invoking the
        // kernel. Recording a failure here would be a false positive.
        if host.is_empty() {
            return host.clone();
        }
        match self.subtract_meshes_batched(host, voids) {
            Ok(result) => {
                // An empty result is a legitimate outcome (cutters may fully
                // contain the host). Only non-finite / invalid kernel output
                // counts as a failure that warrants reverting to the un-cut
                // host.
                if !self.validate_mesh(&result) {
                    self.record_failure(
                        BoolOp::Difference,
                        BoolFailureReason::KernelOutputInvalid,
                    );
                    host.clone()
                } else {
                    result
                }
            }
            Err(e) => {
                self.record_failure(
                    BoolOp::Difference,
                    BoolFailureReason::KernelError(e.to_string()),
                );
                host.clone()
            }
        }
    }

    /// Heuristic: does this look like a botched CSG difference?
    ///
    /// Kernel-neutral check used by the boolean processor (e.g. the
    /// polygonal-bounded half-space clip) to fall back to a robust
    /// unbounded plane clip when a difference result looks collapsed
    /// relative to its host. Historically this caught a Linux-specific
    /// Manifold pathology where a wall body clipped by an
    /// `IfcPolygonalBoundedHalfSpace` prism collapsed to a near-empty
    /// result (1 triangle from a 12-triangle host box).
    ///
    /// Rules:
    ///  * An empty result is a legit outcome (cutter contains host) —
    ///    NOT degenerate.
    ///  * A closed-volume result needs at least 4 triangles. Anything
    ///    below that is structurally broken.
    ///  * For hosts with >= 12 triangles (typical IFC solid input), the
    ///    output should retain at least 25 % of the host's triangle
    ///    count when the cutter is partial.
    pub(crate) fn difference_result_looks_degenerate(host: &Mesh, result: &Mesh) -> bool {
        let result_tris = result.indices.len() / 3;
        if result_tris == 0 {
            return false;
        }
        if result_tris < 4 {
            return true;
        }
        let host_tris = host.indices.len() / 3;
        if host_tris >= 12 && result_tris * 4 < host_tris {
            return true;
        }

        // "Wrong piece" check: a difference result MUST be a subset of the
        // host volume, so the result's bounding box has to sit inside the
        // host's. When a malformed cutter (typical: IfcFacetedBrep with
        // inward-pointing face normals) inverts the kernel's
        // inside/outside test, Manifold returns the CUTTER mesh instead —
        // which lives partially or wholly outside the host bbox. House.ifc
        // wall #3448 (a 7 m extrusion clipped by a gable-shaped brep)
        // rendered as the gable triangle alone before this guard.
        let (host_min, host_max) = host.bounds();
        let (res_min, res_max) = result.bounds();
        // 1 % of the host's edge **per axis** — using a single tolerance
        // derived from the longest dimension lets thin walls/plates pass
        // a wrong-piece check on Y/Z that they shouldn't (CodeRabbit
        // review on PR #861). With per-axis slack, a 5 m × 0.4 m × 7 m
        // wall gets ±5 cm tolerance on X, ±4 mm on Y, ±7 cm on Z — so a
        // result that pokes >4 mm past the wall's thickness face is
        // correctly flagged even though it's well within 1 % of the X
        // span.
        let slack = (host_max - host_min).abs() * 0.01;
        if res_min.x + slack.x < host_min.x
            || res_min.y + slack.y < host_min.y
            || res_min.z + slack.z < host_min.z
            || res_max.x > host_max.x + slack.x
            || res_max.y > host_max.y + slack.y
            || res_max.z > host_max.z + slack.z
        {
            return true;
        }
        false
    }

    /// Validate mesh for common issues
    fn validate_mesh(&self, mesh: &Mesh) -> bool {
        // Check for NaN/Inf in positions
        if mesh.positions.iter().any(|v| !v.is_finite()) {
            return false;
        }

        // Check for NaN/Inf in normals
        if mesh.normals.iter().any(|v| !v.is_finite()) {
            return false;
        }

        // Check for valid triangle indices
        let vertex_count = mesh.vertex_count();
        for idx in &mesh.indices {
            if *idx as usize >= vertex_count {
                return false;
            }
        }

        true
    }

    /// Clip an entire mesh against a plane
    pub fn clip_mesh(&self, mesh: &Mesh, plane: &Plane) -> Result<Mesh> {
        record_csg_op(3, mesh.triangle_count(), 0);
        let mut result = Mesh::new();

        // Process each triangle
        let vert_count = mesh.positions.len() / 3;
        for i in (0..mesh.indices.len()).step_by(3) {
            if i + 2 >= mesh.indices.len() {
                break;
            }
            let i0 = mesh.indices[i] as usize;
            let i1 = mesh.indices[i + 1] as usize;
            let i2 = mesh.indices[i + 2] as usize;

            // Bounds check vertex indices
            if i0 >= vert_count || i1 >= vert_count || i2 >= vert_count {
                continue;
            }

            // Get triangle vertices
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

            let triangle = Triangle::new(v0, v1, v2);

            // Clip triangle
            match self.clip_triangle(&triangle, plane) {
                ClipResult::AllFront(tri) => {
                    // Keep original triangle
                    add_triangle_to_mesh(&mut result, &tri);
                }
                ClipResult::AllBehind => {
                    // Discard triangle
                }
                ClipResult::Split(triangles) => {
                    // Add clipped triangles
                    for tri in triangles {
                        add_triangle_to_mesh(&mut result, &tri);
                    }
                }
            }
        }

        Ok(result)
    }
}

impl Default for ClippingProcessor {
    fn default() -> Self {
        Self::new()
    }
}

/// Add a triangle to a mesh
fn add_triangle_to_mesh(mesh: &mut Mesh, triangle: &Triangle) {
    let base_idx = mesh.vertex_count() as u32;

    // Calculate normal
    let normal = triangle.normal();

    // Add vertices
    mesh.add_vertex(triangle.v0, normal);
    mesh.add_vertex(triangle.v1, normal);
    mesh.add_vertex(triangle.v2, normal);

    // Add triangle
    mesh.add_triangle(base_idx, base_idx + 1, base_idx + 2);
}

/// Calculate smooth normals for a mesh.
///
/// One real implementation on every target. This used to be a no-op on
/// native (a leftover of the decommissioned desktop IPC path, which
/// recomputed normals in JS): the server silently shipped EMPTY normal
/// buffers for brep/surface/swept meshes, which the parquet writer
/// zero-padded and the glTF exporter dropped — while the same model loaded
/// via wasm had real normals (alignment audit).
#[inline]
pub fn calculate_normals(mesh: &mut Mesh) {
    let vertex_count = mesh.vertex_count();
    if vertex_count == 0 {
        return;
    }

    let positions_len = mesh.positions.len();

    // Initialize normals to zero
    let mut normals = vec![Vector3::zeros(); vertex_count];

    // Accumulate face normals
    for i in (0..mesh.indices.len()).step_by(3) {
        // Bounds check for indices array
        if i + 2 >= mesh.indices.len() {
            break;
        }

        let i0 = mesh.indices[i] as usize;
        let i1 = mesh.indices[i + 1] as usize;
        let i2 = mesh.indices[i + 2] as usize;

        // Bounds check for vertex indices - skip invalid triangles
        if i0 >= vertex_count || i1 >= vertex_count || i2 >= vertex_count {
            continue;
        }
        if i0 * 3 + 2 >= positions_len || i1 * 3 + 2 >= positions_len || i2 * 3 + 2 >= positions_len
        {
            continue;
        }

        // Get triangle vertices
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

        // Calculate face normal
        let edge1 = v1 - v0;
        let edge2 = v2 - v0;
        let normal = edge1.cross(&edge2);

        // Accumulate normal for each vertex
        normals[i0] += normal;
        normals[i1] += normal;
        normals[i2] += normal;
    }

    // Normalize and write back
    mesh.normals.clear();
    mesh.normals.reserve(vertex_count * 3);

    for normal in normals {
        let normalized = normal
            .try_normalize(1e-6)
            .unwrap_or_else(|| Vector3::new(0.0, 0.0, 1.0));
        mesh.normals.push(normalized.x as f32);
        mesh.normals.push(normalized.y as f32);
        mesh.normals.push(normalized.z as f32);
    }
}

/// Crease-aware vertex normals.
///
/// Standard per-vertex normal averaging produces two failure modes after
/// boolean CSG:
/// - **Scar lines on coplanar surfaces.** Manifold splits cut faces into
///   adjacent strips with numerically near-coincident-but-distinct verts;
///   un-welded averaging then treats each strip as isolated and renders a
///   visible darker/lighter line at every strip boundary.
/// - **Over-rounded corners.** Welding by position alone fixes the scar
///   lines but the vertex at a wall-meets-floor corner now contributes to
///   both face normals; averaging them gives a 45° normal where the
///   designer authored a 90° crease, so the corner reads as "soft" /
///   smoothed.
///
/// `smooth_normals_with_creases` resolves both at once:
///
/// 1. Compute area-weighted face normals.
/// 2. For each vertex, partition incident triangles into "smooth groups"
///    via union-find over edge-adjacency, joining only when the two
///    triangles' face normals satisfy `face_normal_dot ≥ crease_cos`.
/// 3. For each `(vertex, group)`, emit a duplicated final vertex with
///    the position of the original and the group's averaged normal.
/// 4. Rewrite indices to reference the duplicated final vertices.
///
/// At the rendering stage the result behaves exactly as a designer
/// expects: coplanar adjacent strips share a vertex per smooth group →
/// uniform shading; wall-meets-floor corners get separate verts per face
/// → crisp 90° edge.
///
/// `crease_cos` is the cosine of the maximum smoothing angle (default
/// `cos(30°) ≈ 0.866`). Lower values (e.g. `cos(60°) ≈ 0.5`) smooth
/// across more corners; higher values (`cos(15°) ≈ 0.966`) create more
/// hard edges. The 30° default matches Blender's "auto smooth", 3ds
/// Max's "smoothing groups by angle" and most CAD viewers.
///
/// Vertex bloat: in the worst case (every vertex on a crease) the output
/// has `3T` verts (same as flat shading). In the best case (every face
/// coplanar with its neighbour) the output keeps the input vert count.
/// Typical post-CSG building geometry lands at ~1.5×.
///
/// Unlike `calculate_normals` this is NOT cfg-gated to wasm. The same
/// crease-resolution logic runs on both targets so native and browser
/// renderers see identical normals. Native callers that previously
/// relied on JS-side normal computation can continue to; this function
/// just writes the canonical answer to `mesh.normals` either way.
pub fn smooth_normals_with_creases(mesh: &mut Mesh, crease_cos: f64) {
    use rustc_hash::FxHashMap;

    let vertex_count = mesh.vertex_count();
    let tri_count = mesh.indices.len() / 3;
    if vertex_count == 0 || tri_count == 0 {
        return;
    }

    // ── 1. Compute area-weighted face normals (cross product magnitude
    //       is 2× area, which is exactly the weight area-weighting wants).
    let mut face_normals: Vec<Vector3<f64>> = Vec::with_capacity(tri_count);
    for tri in mesh.indices.chunks_exact(3) {
        let i0 = tri[0] as usize;
        let i1 = tri[1] as usize;
        let i2 = tri[2] as usize;
        if i0 >= vertex_count || i1 >= vertex_count || i2 >= vertex_count {
            face_normals.push(Vector3::zeros());
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
        let e1 = v1 - v0;
        let e2 = v2 - v0;
        face_normals.push(e1.cross(&e2));
    }

    // ── 2. Build vertex → list of (triangle_idx, corner_idx) adjacency.
    let mut vert_to_tris: Vec<smallvec::SmallVec<[(u32, u8); 6]>> =
        vec![smallvec::SmallVec::new(); vertex_count];
    for (t, tri) in mesh.indices.chunks_exact(3).enumerate() {
        for k in 0..3 {
            let v = tri[k] as usize;
            if v < vertex_count {
                vert_to_tris[v].push((t as u32, k as u8));
            }
        }
    }

    // ── 3. Per-vertex smooth-group partition via union-find over edge-
    //       adjacent triangles meeting at this vertex. Two triangles
    //       (t_a, k_a) and (t_b, k_b) sharing this vertex are in the
    //       same smooth group iff they share an EDGE incident to this
    //       vertex AND their face normals' normalised dot ≥ crease_cos.
    //
    //       We also emit one final vertex per (vertex, group) pair and
    //       remember the mapping triangle_corner → final_vertex_idx so
    //       the index-rewrite pass can produce the output triangle list.
    let mut new_positions: Vec<f32> = Vec::with_capacity(mesh.positions.len());
    let mut new_normals: Vec<f32> = Vec::with_capacity(mesh.positions.len());
    // corner_to_new_vertex[t * 3 + k] = the final vertex index for that
    // (triangle, corner) pair.
    let mut corner_to_new_vertex: Vec<u32> = vec![0; tri_count * 3];

    for (v, incident) in vert_to_tris.iter().enumerate() {
        if incident.is_empty() {
            continue;
        }

        // Union-find scratch. `parent[i]` indexes back into `incident`.
        let n = incident.len();
        let mut parent: smallvec::SmallVec<[u32; 6]> = (0..n as u32).collect();
        let find = |parent: &mut [u32], mut i: u32| -> u32 {
            while parent[i as usize] != i {
                parent[i as usize] = parent[parent[i as usize] as usize]; // path compress
                i = parent[i as usize];
            }
            i
        };

        // Index the triangles' two "other" corner vertices at this
        // vertex so we can detect shared edges cheaply: triangles
        // share an edge incident to `v` iff one of their non-`v`
        // corners matches.
        let other_corners = |corner_idx: u8, t: u32| -> [u32; 2] {
            let tri = &mesh.indices[(t as usize) * 3..(t as usize) * 3 + 3];
            let a = tri[((corner_idx + 1) % 3) as usize];
            let b = tri[((corner_idx + 2) % 3) as usize];
            [a, b]
        };

        // For small n (typical n ≤ 6) the O(n²) pairwise check is
        // faster than building a hash map of corner→incident-index;
        // BIM corner valences are bounded by mesh topology.
        for i in 0..n {
            let (t_i, k_i) = incident[i];
            let n_i = face_normals[t_i as usize]
                .try_normalize(1e-12)
                .unwrap_or_else(Vector3::zeros);
            if n_i == Vector3::zeros() {
                continue;
            }
            let oc_i = other_corners(k_i, t_i);
            for j in (i + 1)..n {
                let (t_j, k_j) = incident[j];
                let n_j = face_normals[t_j as usize]
                    .try_normalize(1e-12)
                    .unwrap_or_else(Vector3::zeros);
                if n_j == Vector3::zeros() {
                    continue;
                }
                let oc_j = other_corners(k_j, t_j);
                let shares_edge = oc_i[0] == oc_j[0]
                    || oc_i[0] == oc_j[1]
                    || oc_i[1] == oc_j[0]
                    || oc_i[1] == oc_j[1];
                if !shares_edge {
                    continue;
                }
                if n_i.dot(&n_j) < crease_cos {
                    continue;
                }
                // Union i and j.
                let ri = find(&mut parent, i as u32);
                let rj = find(&mut parent, j as u32);
                if ri != rj {
                    parent[ri as usize] = rj;
                }
            }
        }

        // Group incident triangles by root and emit one new vertex per
        // group with the group's area-weighted average normal.
        let mut group_to_new_vertex: FxHashMap<u32, u32> = FxHashMap::default();
        for i in 0..n {
            let root = find(&mut parent, i as u32);
            let new_v = *group_to_new_vertex.entry(root).or_insert_with(|| {
                let new_idx = (new_positions.len() / 3) as u32;
                new_positions.push(mesh.positions[v * 3]);
                new_positions.push(mesh.positions[v * 3 + 1]);
                new_positions.push(mesh.positions[v * 3 + 2]);
                // Group normal = area-weighted sum of contributing face
                // normals (not yet normalised — we accumulate raw
                // contributions and normalise after group is closed).
                new_normals.push(0.0);
                new_normals.push(0.0);
                new_normals.push(0.0);
                new_idx
            });
            // Accumulate this triangle's face normal (already area-weighted)
            // into the group's normal slot.
            let (t_i, _k_i) = incident[i];
            let n_i = face_normals[t_i as usize];
            new_normals[new_v as usize * 3] += n_i.x as f32;
            new_normals[new_v as usize * 3 + 1] += n_i.y as f32;
            new_normals[new_v as usize * 3 + 2] += n_i.z as f32;

            // Remember which final vertex this (triangle, corner) maps to.
            let (t, k) = incident[i];
            corner_to_new_vertex[t as usize * 3 + k as usize] = new_v;
        }
    }

    // ── 4. Normalise the accumulated normals.
    for chunk in new_normals.chunks_exact_mut(3) {
        let len_sq = (chunk[0] * chunk[0] + chunk[1] * chunk[1] + chunk[2] * chunk[2]) as f64;
        if len_sq > 1e-24 {
            let inv = (1.0 / len_sq.sqrt()) as f32;
            chunk[0] *= inv;
            chunk[1] *= inv;
            chunk[2] *= inv;
        } else {
            chunk[2] = 1.0;
        }
    }

    // ── 5. Rewrite indices to reference the new final vertices.
    let mut new_indices: Vec<u32> = Vec::with_capacity(mesh.indices.len());
    for t in 0..tri_count {
        new_indices.push(corner_to_new_vertex[t * 3]);
        new_indices.push(corner_to_new_vertex[t * 3 + 1]);
        new_indices.push(corner_to_new_vertex[t * 3 + 2]);
    }

    mesh.positions = new_positions;
    mesh.normals = new_normals;
    mesh.indices = new_indices;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn floor_pow2_is_exact_and_deterministic() {
        // Exact powers map to themselves; in-between rounds DOWN to the prev power.
        assert_eq!(floor_pow2(1.0), 1.0);
        assert_eq!(floor_pow2(2.0), 2.0);
        assert_eq!(floor_pow2(8.0), 8.0);
        assert_eq!(floor_pow2(1.9), 1.0);
        assert_eq!(floor_pow2(5.657), 4.0);
        assert_eq!(floor_pow2(0.2), 0.125);
        assert_eq!(floor_pow2(0.0), 0.0);
        assert_eq!(floor_pow2(-3.0), 0.0);
        // every result has exactly one set mantissa bit ⇒ bit-deterministic
        for x in [0.3_f64, 1.7, 3.0, 17.9, 1024.0, 1e-3, 1e6] {
            let p = floor_pow2(x);
            assert!(p > 0.0 && p <= x);
            assert_eq!(p.to_bits() & 0x000f_ffff_ffff_ffff, 0, "floor_pow2({x}) not a clean power of two");
        }
    }

    #[test]
    fn tri_is_needle_flags_hairline_slivers_not_real_thin_faces() {
        // The #1007 needle: 6.6 µm base, ~5 m apex span → drop.
        let needle = [
            Point3::new(4.672253608703613, -1.0, 12.385885238647461),
            Point3::new(1.047027587890625, -5.0, 14.07635498046875),
            Point3::new(4.672259330749512, -1.0, 12.385882377624512),
        ];
        assert!(tri_is_needle(&needle), "the #1007 diagonal sliver was not flagged");
        // A REAL thin sliver (0.2 m × 2 m face) must be KEPT.
        let real_thin = [
            Point3::new(0.0, 0.0, 0.0),
            Point3::new(2.0, 0.0, 0.0),
            Point3::new(2.0, 0.2, 0.0),
        ];
        assert!(!tri_is_needle(&real_thin), "a real 0.2×2 m sliver was wrongly flagged");
        // A healthy near-equilateral triangle is kept.
        let healthy = [
            Point3::new(0.0, 0.0, 0.0),
            Point3::new(1.0, 0.0, 0.0),
            Point3::new(0.5, 0.9, 0.0),
        ];
        assert!(!tri_is_needle(&healthy));
        // A fully-collapsed triangle (zero longest edge) is degenerate → drop.
        let collapsed = [Point3::new(1.0, 1.0, 1.0); 3];
        assert!(tri_is_needle(&collapsed));
    }

    #[test]
    fn weld_near_coincident_2d_collapses_um_rim_duplicates() {
        use nalgebra::Point2;
        // A unit-ish quad whose 4th corner is split into a 6.6 µm near-duplicate
        // (the rim-notch shape that earcut would otherwise frame as a needle).
        let ring = vec![
            Point2::new(0.0, 0.0),
            Point2::new(1.9, 0.0),
            Point2::new(1.9, 1.0),
            Point2::new(0.000_006_6, 1.0),
            Point2::new(0.0, 1.0),
        ];
        let welded = weld_near_coincident_2d(&ring);
        assert_eq!(welded.len(), 4, "near-coincident rim duplicate not welded: {welded:?}");
        // A ring with only genuine (≥0.2 m) edges is untouched.
        let clean = vec![
            Point2::new(0.0, 0.0),
            Point2::new(2.0, 0.0),
            Point2::new(2.0, 0.2),
            Point2::new(0.0, 0.2),
        ];
        assert_eq!(weld_near_coincident_2d(&clean).len(), 4, "a clean ring was over-welded");
    }

    #[test]
    fn weld_near_coincident_2d_keeps_mm_features_on_large_rings() {
        use nalgebra::Point2;
        // A 12 m × 1 m member face with a 1 mm corner chamfer (two vertices
        // 1 mm apart). Uncapped extent-relative eps (12/8192 ≈ 1.46 mm) would
        // weld the chamfer away; the absolute 2⁻¹² m cap must keep it.
        let chamfered = vec![
            Point2::new(0.0, 0.0),
            Point2::new(12.0, 0.0),
            Point2::new(12.0, 0.999),
            Point2::new(11.999, 1.0), // 1 mm chamfer edge
            Point2::new(0.0, 1.0),
        ];
        let welded = weld_near_coincident_2d(&chamfered);
        assert_eq!(
            welded.len(),
            5,
            "1 mm chamfer on a 12 m ring was over-welded: {welded:?}"
        );
        // µm-scale rim duplicates must still weld on the SAME large ring.
        let ring = vec![
            Point2::new(0.0, 0.0),
            Point2::new(12.0, 0.0),
            Point2::new(12.0, 1.0),
            Point2::new(0.000_02, 1.0), // 20 µm duplicate of the corner
            Point2::new(0.0, 1.0),
        ];
        assert_eq!(
            weld_near_coincident_2d(&ring).len(),
            4,
            "µm rim duplicate on a large ring not welded"
        );
    }

    #[test]
    fn merge_coplanar_collapses_subdivided_quad() {
        // Quad on z=0 plane split into 4 triangles via a centroid vertex.
        // consolidate_coplanar should reassemble it into a single quad and
        // triangulate that into 2 triangles.
        let mut mesh = Mesh::new();
        for p in [
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [1.0, 1.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.5, 0.5, 0.0],
        ] {
            mesh.add_vertex(
                Point3::new(p[0], p[1], p[2]),
                Vector3::new(0.0, 0.0, 1.0),
            );
        }
        mesh.add_triangle(0, 1, 4);
        mesh.add_triangle(1, 2, 4);
        mesh.add_triangle(2, 3, 4);
        mesh.add_triangle(3, 0, 4);

        let consolidated = ClippingProcessor::consolidate_coplanar(mesh);
        assert_eq!(
            consolidated.indices.len() / 3,
            2,
            "consolidated quad should triangulate to 2 tris, got {}",
            consolidated.indices.len() / 3
        );
    }

    #[test]
    fn merge_coplanar_collapses_edge_split_quad() {
        // Quad whose boundary edge from (0,0) → (2,0) is split into three
        // segments by inserted collinear vertices (0.5, 0, 0) and
        // (1.5, 0, 0). Simulates a CSG kernel's "cutter crossed the host
        // edge here" fragment output. Must collapse back to 2 triangles.
        let mut mesh = Mesh::new();
        for p in [
            [0.0, 0.0, 0.0],
            [0.5, 0.0, 0.0],
            [1.5, 0.0, 0.0],
            [2.0, 0.0, 0.0],
            [2.0, 1.0, 0.0],
            [0.0, 1.0, 0.0],
        ] {
            mesh.add_vertex(
                Point3::new(p[0], p[1], p[2]),
                Vector3::new(0.0, 0.0, 1.0),
            );
        }
        // Fan from corner 0 keeps everything CCW.
        mesh.add_triangle(0, 1, 5);
        mesh.add_triangle(1, 2, 5);
        mesh.add_triangle(2, 4, 5);
        mesh.add_triangle(2, 3, 4);

        let consolidated = ClippingProcessor::consolidate_coplanar(mesh);
        assert_eq!(
            consolidated.indices.len() / 3,
            2,
            "edge-split quad must collapse to 2 tris after collinear cleanup, got {}",
            consolidated.indices.len() / 3
        );
    }

    #[test]
    fn test_plane_signed_distance() {
        let plane = Plane::new(Point3::new(0.0, 0.0, 0.0), Vector3::new(0.0, 0.0, 1.0));

        assert_eq!(plane.signed_distance(&Point3::new(0.0, 0.0, 5.0)), 5.0);
        assert_eq!(plane.signed_distance(&Point3::new(0.0, 0.0, -5.0)), -5.0);
        assert_eq!(plane.signed_distance(&Point3::new(5.0, 5.0, 0.0)), 0.0);
    }

    #[test]
    fn test_clip_triangle_all_front() {
        let processor = ClippingProcessor::new();
        let triangle = Triangle::new(
            Point3::new(0.0, 0.0, 1.0),
            Point3::new(1.0, 0.0, 1.0),
            Point3::new(0.5, 1.0, 1.0),
        );
        let plane = Plane::new(Point3::new(0.0, 0.0, 0.0), Vector3::new(0.0, 0.0, 1.0));

        match processor.clip_triangle(&triangle, &plane) {
            ClipResult::AllFront(_) => {}
            _ => panic!("Expected AllFront"),
        }
    }

    #[test]
    fn test_clip_triangle_all_behind() {
        let processor = ClippingProcessor::new();
        let triangle = Triangle::new(
            Point3::new(0.0, 0.0, -1.0),
            Point3::new(1.0, 0.0, -1.0),
            Point3::new(0.5, 1.0, -1.0),
        );
        let plane = Plane::new(Point3::new(0.0, 0.0, 0.0), Vector3::new(0.0, 0.0, 1.0));

        match processor.clip_triangle(&triangle, &plane) {
            ClipResult::AllBehind => {}
            _ => panic!("Expected AllBehind"),
        }
    }

    #[test]
    fn test_clip_triangle_split_one_front() {
        let processor = ClippingProcessor::new();
        let triangle = Triangle::new(
            Point3::new(0.0, 0.0, 1.0),  // Front
            Point3::new(1.0, 0.0, -1.0), // Behind
            Point3::new(0.5, 1.0, -1.0), // Behind
        );
        let plane = Plane::new(Point3::new(0.0, 0.0, 0.0), Vector3::new(0.0, 0.0, 1.0));

        match processor.clip_triangle(&triangle, &plane) {
            ClipResult::Split(triangles) => {
                assert_eq!(triangles.len(), 1);
            }
            _ => panic!("Expected Split"),
        }
    }

    #[test]
    fn test_clip_triangle_split_two_front() {
        let processor = ClippingProcessor::new();
        let triangle = Triangle::new(
            Point3::new(0.0, 0.0, 1.0),  // Front
            Point3::new(1.0, 0.0, 1.0),  // Front
            Point3::new(0.5, 1.0, -1.0), // Behind
        );
        let plane = Plane::new(Point3::new(0.0, 0.0, 0.0), Vector3::new(0.0, 0.0, 1.0));

        match processor.clip_triangle(&triangle, &plane) {
            ClipResult::Split(triangles) => {
                assert_eq!(triangles.len(), 2);
            }
            _ => panic!("Expected Split with 2 triangles"),
        }
    }

    #[test]
    fn test_triangle_normal() {
        let triangle = Triangle::new(
            Point3::new(0.0, 0.0, 0.0),
            Point3::new(1.0, 0.0, 0.0),
            Point3::new(0.0, 1.0, 0.0),
        );

        let normal = triangle.normal();
        assert!((normal.z - 1.0).abs() < 1e-6);
    }

    #[test]
    fn test_triangle_area() {
        let triangle = Triangle::new(
            Point3::new(0.0, 0.0, 0.0),
            Point3::new(1.0, 0.0, 0.0),
            Point3::new(0.0, 1.0, 0.0),
        );

        let area = triangle.area();
        assert!((area - 0.5).abs() < 1e-6);
    }

    /// Build a unit cube as 8 verts × 12 triangles (each corner vertex
    /// shared by three perpendicular faces). Used by the crease-aware
    /// normal tests below.
    fn cube_for_crease_tests() -> Mesh {
        let mut m = Mesh::with_capacity(8, 36);
        let n = Vector3::new(0.0, 0.0, 0.0);
        let v = |x: f64, y: f64, z: f64| Point3::new(x, y, z);
        let corners = [
            v(0.0, 0.0, 0.0),
            v(1.0, 0.0, 0.0),
            v(1.0, 1.0, 0.0),
            v(0.0, 1.0, 0.0),
            v(0.0, 0.0, 1.0),
            v(1.0, 0.0, 1.0),
            v(1.0, 1.0, 1.0),
            v(0.0, 1.0, 1.0),
        ];
        for p in corners.iter() {
            m.add_vertex(*p, n);
        }
        for tri in [
            [0u32, 2, 1],
            [0, 3, 2],
            [4, 5, 6],
            [4, 6, 7],
            [0, 1, 5],
            [0, 5, 4],
            [2, 3, 7],
            [2, 7, 6],
            [1, 2, 6],
            [1, 6, 5],
            [3, 0, 4],
            [3, 4, 7],
        ] {
            m.add_triangle(tri[0], tri[1], tri[2]);
        }
        m
    }

    /// Build a watertight curved (arc-extruded) wall solid with `n` facets over a
    /// quarter turn, radius `r`, thickness `t`, height `h`. Each facet is its own
    /// plane bucket in `consolidate_coplanar` — the curved-wall seam case.
    fn curved_wall(n: usize, r: f64, t: f64, h: f64) -> Mesh {
        use std::f64::consts::PI;
        let mut m = Mesh::with_capacity(0, 0);
        let nrm = Vector3::new(0.0, 0.0, 0.0);
        let mut verts = Vec::new();
        for i in 0..=n {
            let a = (i as f64) / (n as f64) * (PI / 2.0);
            let (c, s) = (a.cos(), a.sin());
            verts.push(Point3::new(r * c, r * s, 0.0)); // 4i+0 O_bot
            verts.push(Point3::new(r * c, r * s, h)); //   4i+1 O_top
            verts.push(Point3::new((r - t) * c, (r - t) * s, 0.0)); // 4i+2 I_bot
            verts.push(Point3::new((r - t) * c, (r - t) * s, h)); //   4i+3 I_top
        }
        for p in &verts {
            m.add_vertex(*p, nrm);
        }
        let (ob, ot, ib, it) = (
            |i: usize| 4 * i as u32,
            |i: usize| 4 * i as u32 + 1,
            |i: usize| 4 * i as u32 + 2,
            |i: usize| 4 * i as u32 + 3,
        );
        let mut quad = |a: u32, b: u32, c: u32, d: u32, m: &mut Mesh| {
            m.add_triangle(a, b, c);
            m.add_triangle(a, c, d);
        };
        for i in 0..n {
            quad(ob(i), ob(i + 1), ot(i + 1), ot(i), &mut m); // outer
            quad(ib(i + 1), ib(i), it(i), it(i + 1), &mut m); // inner
            quad(ot(i), ot(i + 1), it(i + 1), it(i), &mut m); // top
            quad(ib(i), ib(i + 1), ob(i + 1), ob(i), &mut m); // bottom
        }
        quad(ob(0), ot(0), it(0), ib(0), &mut m); // cap @ a=0
        quad(ib(n), it(n), ot(n), ob(n), &mut m); // cap @ a=90
        m
    }

    fn axis_box(lo: [f64; 3], hi: [f64; 3]) -> Mesh {
        let mut m = Mesh::with_capacity(8, 36);
        let n = Vector3::new(0.0, 0.0, 0.0);
        let c = [
            Point3::new(lo[0], lo[1], lo[2]),
            Point3::new(hi[0], lo[1], lo[2]),
            Point3::new(hi[0], hi[1], lo[2]),
            Point3::new(lo[0], hi[1], lo[2]),
            Point3::new(lo[0], lo[1], hi[2]),
            Point3::new(hi[0], lo[1], hi[2]),
            Point3::new(hi[0], hi[1], hi[2]),
            Point3::new(lo[0], hi[1], hi[2]),
        ];
        for p in c.iter() {
            m.add_vertex(*p, n);
        }
        for tri in [
            [0u32, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
            [0, 1, 5], [0, 5, 4], [2, 3, 7], [2, 7, 6],
            [1, 2, 6], [1, 6, 5], [3, 0, 4], [3, 4, 7],
        ] {
            m.add_triangle(tri[0], tri[1], tri[2]);
        }
        m
    }

    /// Count open boundary edges (undirected edges whose directed half-edges do
    /// not pair forward+reverse) on a micron-snapped vertex topology — a watertight
    /// closed mesh has 0.
    fn count_open_edges(mesh: &Mesh) -> usize {
        use std::collections::HashMap;
        let q = |v: f32| (v as f64 * 1.0e6).round() as i64;
        let mut vid: HashMap<(i64, i64, i64), u32> = HashMap::new();
        let mut id = |i: usize| -> u32 {
            let k = (
                q(mesh.positions[i * 3]),
                q(mesh.positions[i * 3 + 1]),
                q(mesh.positions[i * 3 + 2]),
            );
            let n = vid.len() as u32;
            *vid.entry(k).or_insert(n)
        };
        let mut edge: HashMap<(u32, u32), i32> = HashMap::new();
        for tri in mesh.indices.chunks_exact(3) {
            let (a, b, c) = (id(tri[0] as usize), id(tri[1] as usize), id(tri[2] as usize));
            for (x, y) in [(a, b), (b, c), (c, a)] {
                let (k, s) = if x < y { ((x, y), 1) } else { ((y, x), -1) };
                *edge.entry(k).or_insert(0) += s;
            }
        }
        edge.values().filter(|&&v| v != 0).count()
    }

    #[test]
    fn curved_wall_opening_seam_is_watertight() {
        let host = curved_wall(8, 5.0, 0.3, 3.0); // 11.25°/facet
        assert_eq!(count_open_edges(&host), 0, "host must be watertight");
        // a window box straddling the arc around 30°..60°
        let cutter = axis_box([2.4, 2.4, 1.0], [4.4, 4.4, 2.0]);
        let raw = crate::kernel::mesh_bridge::subtract(&host, &cutter);
        let raw_open = count_open_edges(&raw);
        let consolidated = ClippingProcessor::consolidate_coplanar(raw.clone());
        let cons_open = count_open_edges(&consolidated);
        eprintln!(
            "SEAMTEST raw_tris={} raw_open={} cons_tris={} cons_open={}",
            raw.triangle_count(),
            raw_open,
            consolidated.triangle_count(),
            cons_open
        );
        assert_eq!(raw_open, 0, "raw kernel output must be watertight");
        assert_eq!(
            cons_open, 0,
            "consolidate must preserve the curved-wall opening seam (was torn)"
        );
    }

    /// On a cube with 8 shared corner vertices, the naive averaging
    /// produces (1, 1, 1)/√3 normals at every corner (45° from each
    /// face) — corners read as "soft" balls. Crease-aware smoothing
    /// must split each corner into three separate verts (one per
    /// incident face) so the renderer paints crisp 90° edges.
    ///
    /// 8 corners × 3 faces = 24 final verts (one per (corner, face)),
    /// matching the per-face vertex emission a designer would author.
    #[test]
    fn crease_split_keeps_cube_corners_crisp() {
        let mut cube = cube_for_crease_tests();
        smooth_normals_with_creases(&mut cube, 0.866); // cos(30°)
        assert_eq!(
            cube.positions.len() / 3,
            24,
            "expected one vertex per (corner, face): 8 corners × 3 faces = 24, got {}",
            cube.positions.len() / 3,
        );
        // Every final vertex's normal must be axis-aligned (a face
        // normal) within tolerance. If averaging leaked across the
        // crease the normal would have all three components ≈ 1/√3.
        for chunk in cube.normals.chunks_exact(3) {
            let nx = chunk[0].abs();
            let ny = chunk[1].abs();
            let nz = chunk[2].abs();
            // Exactly one component should be ~1.0; the others ~0.
            let nontrivial = [nx, ny, nz].iter().filter(|&&v| v > 0.5).count();
            assert_eq!(
                nontrivial, 1,
                "vertex normal ({nx:.3}, {ny:.3}, {nz:.3}) leaked across crease",
            );
        }
    }

    /// On a single flat quad (two triangles sharing an edge), the two
    /// faces have identical normals, so crease-aware must keep them in
    /// one smooth group and emit just 4 shared-vertex output verts —
    /// not the worst-case 6 (one per triangle corner). Validates that
    /// coplanar adjacent strips shade uniformly after a CSG cut.
    #[test]
    fn crease_keeps_coplanar_quad_as_4_verts() {
        let mut quad = Mesh::with_capacity(4, 6);
        let n = Vector3::new(0.0, 0.0, 0.0);
        let v = |x: f64, y: f64| Point3::new(x, y, 0.0);
        quad.add_vertex(v(0.0, 0.0), n);
        quad.add_vertex(v(1.0, 0.0), n);
        quad.add_vertex(v(1.0, 1.0), n);
        quad.add_vertex(v(0.0, 1.0), n);
        quad.add_triangle(0, 1, 2);
        quad.add_triangle(0, 2, 3);

        smooth_normals_with_creases(&mut quad, 0.866);

        assert_eq!(
            quad.positions.len() / 3,
            4,
            "coplanar quad must keep 4 shared verts, got {}",
            quad.positions.len() / 3,
        );
        // All normals should point +Z.
        for chunk in quad.normals.chunks_exact(3) {
            assert!((chunk[0]).abs() < 1e-5);
            assert!((chunk[1]).abs() < 1e-5);
            assert!((chunk[2] - 1.0).abs() < 1e-5);
        }
    }
}
