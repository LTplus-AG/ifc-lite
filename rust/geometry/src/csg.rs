// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! CSG (Constructive Solid Geometry) Operations
//!
//! Fast triangle clipping and boolean operations.

use crate::diagnostics::{BoolFailure, BoolFailureReason, BoolOp};
use crate::error::Result;
use crate::mesh::Mesh;
use crate::triangulation::{calculate_polygon_normal, project_to_2d, triangulate_polygon};
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

/// Maximum polygon count for either operand in a csgrs boolean operation.
///
/// Rectangular solids are 12 triangles. A 16-segment circular prism — the
/// downsampled form of a round-window opening (issue #635) — is 60
/// triangles, and AC20-FZK-Haus packs two such prisms (outer + recessed)
/// into a single opening element, totalling ~120 triangles for the cut.
/// This budget accommodates that combined opening and the wall mesh
/// without letting the BSP tree explode: 128 is the upper bound past
/// which BSP CSG performance starts to degrade noticeably and the WASM
/// browser stack is at risk.
///
/// Do NOT raise this above 128.
const MAX_CSG_POLYGONS_PER_MESH: usize = 128;
/// Maximum combined polygon count for CSG operations.
const MAX_CSG_POLYGONS: usize = MAX_CSG_POLYGONS_PER_MESH * 2;

/// CSG Clipping Processor
pub struct ClippingProcessor {
    /// Epsilon for floating point comparisons
    pub epsilon: f64,
    /// Boolean / CSG failures recorded since the last `take_failures()`.
    /// Interior-mutable so the existing `&self` API stays unchanged.
    failures: RefCell<Vec<BoolFailure>>,
}

/// Coplanar triangle bucket entry used by `mesh_to_polygons` during the
/// pre-BSP merge pass.
#[cfg_attr(feature = "manifold-csg", allow(dead_code))]
struct BucketTri {
    v: [crate::bsp_csg::Vertex; 3],
    keys: [(i64, i64, i64); 3],
    normal: [f64; 3],
}

/// Merge the triangles in one coplanar bucket into the largest convex
/// boundary polygons the topology supports. Falls back to emitting each
/// triangle individually if (a) the bucket's boundary walk hits branching
/// — a single vertex with two outgoing boundary edges — or (b) any walked
/// ring turns out to be non-convex (BSP's `split_polygon` only behaves on
/// convex polygons). For the bath block this collapses each 2-tri face
/// into a 4-vertex quad and each 22-tri cap fan into a 28-vertex rounded
/// rect outline.
#[cfg_attr(feature = "manifold-csg", allow(dead_code))]
fn merge_coplanar_bucket(
    tris: &[BucketTri],
    indices: &[usize],
) -> Vec<crate::bsp_csg::Polygon> {
    use crate::bsp_csg::{Polygon, Vertex};
    use rustc_hash::{FxHashMap, FxHashSet};

    if indices.is_empty() {
        return Vec::new();
    }
    if indices.len() == 1 {
        let t = &tris[indices[0]];
        return vec![Polygon::new(t.v.to_vec())];
    }

    let fallback_per_triangle = |bucket: &[usize]| -> Vec<Polygon> {
        bucket
            .iter()
            .map(|&i| Polygon::new(tris[i].v.to_vec()))
            .collect()
    };

    type Key = (i64, i64, i64);

    // Per-vertex data — first occurrence wins. Within a coplanar bucket the
    // per-vertex normals are all the face normal anyway, so collisions are
    // benign.
    let mut vertex_data: FxHashMap<Key, Vertex> = FxHashMap::default();

    // Directed edge counts. An interior edge appears as both (u,v) and
    // (v,u); a boundary edge has the forward direction only.
    let mut edge_count: FxHashMap<(Key, Key), u32> = FxHashMap::default();

    for &i in indices {
        let t = &tris[i];
        for k in 0..3 {
            vertex_data
                .entry(t.keys[k])
                .or_insert_with(|| t.v[k].clone());
        }
        for (a, b) in [(0, 1), (1, 2), (2, 0)] {
            *edge_count.entry((t.keys[a], t.keys[b])).or_insert(0) += 1;
        }
    }

    // Build the next-edge map across all boundary edges. A vertex with
    // more than one outgoing boundary edge means the merged shape would
    // have to fork (think two coplanar faces touching at a single vertex),
    // which the simple ring walk cannot represent — bail out.
    let mut next_edge: FxHashMap<Key, Key> = FxHashMap::default();
    for ((u, v), _) in edge_count
        .iter()
        .filter(|((u, v), _)| !edge_count.contains_key(&(*v, *u)))
    {
        if next_edge.insert(*u, *v).is_some() {
            return fallback_per_triangle(indices);
        }
    }

    if next_edge.is_empty() {
        return fallback_per_triangle(indices);
    }

    let plane_normal = tris[indices[0]].normal;
    let starts: Vec<Key> = next_edge.keys().copied().collect();
    let mut visited: FxHashSet<Key> = FxHashSet::default();
    let mut rings: Vec<Vec<Vertex>> = Vec::new();
    for start in starts {
        if visited.contains(&start) {
            continue;
        }
        let mut ring: Vec<Vertex> = Vec::new();
        let mut current = start;
        let mut steps = 0;
        loop {
            if !visited.insert(current) {
                break;
            }
            if let Some(v) = vertex_data.get(&current) {
                ring.push(v.clone());
            } else {
                return fallback_per_triangle(indices);
            }
            let next = match next_edge.get(&current) {
                Some(&n) => n,
                None => break,
            };
            if next == start {
                break;
            }
            current = next;
            steps += 1;
            if steps > vertex_data.len() {
                // Cycle that did not close on `start` — give up.
                return fallback_per_triangle(indices);
            }
        }
        if ring.len() >= 3 {
            if !ring_is_convex(&ring, plane_normal) {
                return fallback_per_triangle(indices);
            }
            rings.push(ring);
        }
    }

    if rings.is_empty() {
        return fallback_per_triangle(indices);
    }
    rings
        .into_iter()
        .map(|r| simplify_collinear(r))
        .filter(|r| r.len() >= 3)
        .map(Polygon::new)
        .collect()
}

/// Drop ring vertices that are collinear with both neighbours. BSP
/// over-fragments host faces by splitting them at every extended cutter
/// plane, even when the cutter doesn't reach the face in 3D. The
/// pre/post-merge in `mesh_to_polygons` reassembles those fragments into
/// a single polygon — but the polygon then carries dozens of collinear
/// "phantom" vertices along the outer edges (each one introduced when a
/// cutter wall plane projection crossed the host outline). Without this
/// pass, earcut emits one sliver triangle per phantom vertex; with it,
/// the bath bottom face collapses back to the 4 corners it started with
/// and triangulates as 2 tris (issue #780).
#[cfg_attr(feature = "manifold-csg", allow(dead_code))]
fn simplify_collinear(
    ring: Vec<crate::bsp_csg::Vertex>,
) -> Vec<crate::bsp_csg::Vertex> {
    let n = ring.len();
    if n < 4 {
        return ring;
    }
    let mut keep: Vec<bool> = vec![true; n];
    let mut changed = true;
    while changed {
        changed = false;
        for i in 0..n {
            if !keep[i] {
                continue;
            }
            let prev = (1..n)
                .map(|k| (i + n - k) % n)
                .find(|&k| keep[k]);
            let next = (1..n).map(|k| (i + k) % n).find(|&k| keep[k]);
            let (prev, next) = match (prev, next) {
                (Some(p), Some(n)) if p != i && n != i && p != n => (p, n),
                _ => continue,
            };
            let a = ring[prev].pos;
            let b = ring[i].pos;
            let c = ring[next].pos;
            let e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
            let e2 = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
            let cross = [
                e1[1] * e2[2] - e1[2] * e2[1],
                e1[2] * e2[0] - e1[0] * e2[2],
                e1[0] * e2[1] - e1[1] * e2[0],
            ];
            let cross_mag =
                (cross[0].powi(2) + cross[1].powi(2) + cross[2].powi(2)).sqrt();
            let e1_len = (e1[0].powi(2) + e1[1].powi(2) + e1[2].powi(2)).sqrt();
            let e2_len = (e2[0].powi(2) + e2[1].powi(2) + e2[2].powi(2)).sqrt();
            let denom = e1_len * e2_len;
            if denom < 1.0e-18 || cross_mag / denom < 1.0e-6 {
                keep[i] = false;
                changed = true;
            }
        }
    }
    let kept: Vec<_> = ring
        .into_iter()
        .zip(keep.iter())
        .filter_map(|(v, k)| if *k { Some(v) } else { None })
        .collect();
    if kept.len() >= 3 {
        kept
    } else {
        Vec::new()
    }
}

/// Push a single triangle (with the supplied face normal applied to all
/// three vertices) onto `mesh`. Used by `consolidate_coplanar` for plane
/// buckets that have only one input triangle and don't need the 2D-union
/// round-trip.
#[cfg_attr(feature = "manifold-csg", allow(dead_code))]
fn emit_triangle(mesh: &mut Mesh, v: &[Point3<f64>; 3], normal: &Vector3<f64>) {
    let base = mesh.vertex_count() as u32;
    mesh.add_vertex(v[0], *normal);
    mesh.add_vertex(v[1], *normal);
    mesh.add_vertex(v[2], *normal);
    mesh.add_triangle(base, base + 1, base + 2);
}

/// Drop 2D contour vertices that are collinear with both neighbours. The
/// i_overlay union of many small fragments often leaves "phantom"
/// vertices on every fragment boundary that crosses the outer outline;
/// without this pass earcut would emit one sliver triangle per phantom.
#[cfg_attr(feature = "manifold-csg", allow(dead_code))]
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

/// Convexity test for a coplanar ring of vertices. All `(edge_i × edge_{i+1})`
/// products must have the same sign when projected onto the plane normal.
#[cfg_attr(feature = "manifold-csg", allow(dead_code))]
fn ring_is_convex(ring: &[crate::bsp_csg::Vertex], normal: [f64; 3]) -> bool {
    let n = ring.len();
    if n < 3 {
        return false;
    }
    let mut sign: i32 = 0;
    for i in 0..n {
        let a = ring[i].pos;
        let b = ring[(i + 1) % n].pos;
        let c = ring[(i + 2) % n].pos;
        let e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let e2 = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
        let cross = [
            e1[1] * e2[2] - e1[2] * e2[1],
            e1[2] * e2[0] - e1[0] * e2[2],
            e1[0] * e2[1] - e1[1] * e2[0],
        ];
        let dot = cross[0] * normal[0] + cross[1] * normal[1] + cross[2] * normal[2];
        let s = if dot > 1.0e-12 {
            1
        } else if dot < -1.0e-12 {
            -1
        } else {
            0
        };
        if s != 0 {
            if sign == 0 {
                sign = s;
            } else if sign != s {
                return false;
            }
        }
    }
    true
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
    #[cfg_attr(feature = "manifold-csg", allow(dead_code))]
    #[inline]
    fn can_run_csg_operation(polygons_a: usize, polygons_b: usize) -> bool {
        if polygons_a < 4 || polygons_b < 4 {
            return false;
        }

        if polygons_a > MAX_CSG_POLYGONS_PER_MESH || polygons_b > MAX_CSG_POLYGONS_PER_MESH {
            return false;
        }

        polygons_a + polygons_b <= MAX_CSG_POLYGONS
    }

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

                let t1 = d_front / (d_front - d_back1);
                let t2 = d_front / (d_front - d_back2);

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

                let t1 = d_front1 / (d_front1 - d_back);
                let t2 = d_front2 / (d_front2 - d_back);

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

    /// Convert our Mesh format to BSP polygon list. Used only by the
    /// legacy BSP path; under `manifold-csg` this is dead code.
    ///
    /// **Coplanar merge pass.** A naive triangle→polygon conversion forces
    /// BSP to split every cutter plane against the host's interior diagonal
    /// edges, producing sliver fans on subtraction (issue #780 bath: each
    /// of the cutter's 28 wall planes sliced the bath top face along the
    /// (0,0)→(2,0.8) diagonal, leaving thin "spike" triangles radiating to
    /// the bath outer edge). The fix is to recover the original N-gon
    /// faces by bucketing input triangles by plane and walking each
    /// bucket's boundary edges. BSP then operates on the actual face
    /// quads / cap polygons and the artifact disappears. Non-convex merge
    /// results fall back to per-triangle emission (BSP's `split_polygon`
    /// only behaves on convex input).
    #[cfg_attr(feature = "manifold-csg", allow(dead_code))]
    fn mesh_to_polygons(mesh: &Mesh) -> Vec<crate::bsp_csg::Polygon> {
        use crate::bsp_csg::{Polygon, Vertex};
        use rustc_hash::FxHashMap;

        if mesh.is_empty() || mesh.indices.len() < 3 {
            return Vec::new();
        }

        let vertex_count = mesh.positions.len() / 3;

        // Quantization: 1 µm. With BSP running in file units (mm for the
        // bath, m for most other models) this is far finer than the
        // BSP EPSILON (1e-5) and far coarser than f64 noise.
        const QUANT: f64 = 1.0e6;
        let quantize = |p: [f64; 3]| -> (i64, i64, i64) {
            (
                (p[0] * QUANT).round() as i64,
                (p[1] * QUANT).round() as i64,
                (p[2] * QUANT).round() as i64,
            )
        };

        // Step 1 — collect valid triangles with plane keys.
        let mut tris: Vec<BucketTri> = Vec::with_capacity(mesh.indices.len() / 3);
        for chunk in mesh.indices.chunks_exact(3) {
            let i0 = chunk[0] as usize;
            let i1 = chunk[1] as usize;
            let i2 = chunk[2] as usize;
            if i0 >= vertex_count || i1 >= vertex_count || i2 >= vertex_count {
                continue;
            }
            let p0 = i0 * 3;
            let p1 = i1 * 3;
            let p2 = i2 * 3;
            let v0 = [
                mesh.positions[p0] as f64,
                mesh.positions[p0 + 1] as f64,
                mesh.positions[p0 + 2] as f64,
            ];
            let v1 = [
                mesh.positions[p1] as f64,
                mesh.positions[p1 + 1] as f64,
                mesh.positions[p1 + 2] as f64,
            ];
            let v2 = [
                mesh.positions[p2] as f64,
                mesh.positions[p2 + 1] as f64,
                mesh.positions[p2 + 2] as f64,
            ];
            if !v0.iter().chain(&v1).chain(&v2).all(|x| x.is_finite()) {
                continue;
            }
            let e1 = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]];
            let e2 = [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]];
            let cross = [
                e1[1] * e2[2] - e1[2] * e2[1],
                e1[2] * e2[0] - e1[0] * e2[2],
                e1[0] * e2[1] - e1[1] * e2[0],
            ];
            let len =
                (cross[0] * cross[0] + cross[1] * cross[1] + cross[2] * cross[2]).sqrt();
            if len < 1e-10 {
                continue;
            }
            let n = [cross[0] / len, cross[1] / len, cross[2] / len];
            tris.push(BucketTri {
                v: [
                    Vertex::new(v0, n),
                    Vertex::new(v1, n),
                    Vertex::new(v2, n),
                ],
                keys: [quantize(v0), quantize(v1), quantize(v2)],
                normal: n,
            });
        }

        // Step 2 — bucket triangles by plane. Plane key = quantized normal
        // and quantized offset along that normal. Same-plane same-direction
        // triangles bucket together; opposite-facing coplanar triangles
        // stay in separate buckets (they are NOT the same surface — merging
        // would collapse a back-to-back fold into a degenerate polygon).
        let plane_key = |n: [f64; 3], anchor: [f64; 3]| -> (i64, i64, i64, i64) {
            let off = n[0] * anchor[0] + n[1] * anchor[1] + n[2] * anchor[2];
            let (a, b, c) = quantize(n);
            (a, b, c, (off * QUANT).round() as i64)
        };
        let mut buckets: FxHashMap<(i64, i64, i64, i64), Vec<usize>> = FxHashMap::default();
        for (i, t) in tris.iter().enumerate() {
            let key = plane_key(t.normal, t.v[0].pos);
            buckets.entry(key).or_default().push(i);
        }

        // Step 3 — for each bucket, walk boundary edges into rings; if any
        // resulting ring is non-convex or the topology is non-manifold,
        // fall back to emitting that bucket as individual triangles.
        let mut polygons: Vec<Polygon> = Vec::with_capacity(tris.len());
        for indices in buckets.values() {
            let merged = merge_coplanar_bucket(&tris, indices);
            polygons.extend(merged);
        }
        polygons
    }

    /// Convert BSP polygon list back to our Mesh format. Legacy-only.
    #[cfg_attr(feature = "manifold-csg", allow(dead_code))]
    fn polygons_to_mesh(polygons: &[crate::bsp_csg::Polygon]) -> Result<Mesh> {
        let mut mesh = Mesh::new();

        for polygon in polygons {
            let vertices = &polygon.vertices;
            if vertices.len() < 3 {
                continue;
            }

            let points_3d: Vec<Point3<f64>> = vertices
                .iter()
                .map(|v| Point3::new(v.pos[0], v.pos[1], v.pos[2]))
                .collect();

            let raw_normal =
                Vector3::new(vertices[0].normal[0], vertices[0].normal[1], vertices[0].normal[2]);

            let csg_normal = match raw_normal.try_normalize(1e-10) {
                Some(n) if n.x.is_finite() && n.y.is_finite() && n.z.is_finite() => n,
                _ => {
                    let computed = calculate_polygon_normal(&points_3d);
                    match computed.try_normalize(1e-10) {
                        Some(n) => n,
                        None => continue,
                    }
                }
            };

            if points_3d.len() == 3 {
                let base_idx = mesh.vertex_count();
                for v in vertices {
                    mesh.add_vertex(
                        Point3::new(v.pos[0], v.pos[1], v.pos[2]),
                        Vector3::new(v.normal[0], v.normal[1], v.normal[2]),
                    );
                }
                mesh.add_triangle(
                    base_idx as u32,
                    (base_idx + 1) as u32,
                    (base_idx + 2) as u32,
                );
                continue;
            }

            let (points_2d, _, _, _) = project_to_2d(&points_3d, &csg_normal);

            let indices = match triangulate_polygon(&points_2d) {
                Ok(idx) => idx,
                Err(_) => continue,
            };

            let base_idx = mesh.vertex_count();
            for v in vertices {
                mesh.add_vertex(
                    Point3::new(v.pos[0], v.pos[1], v.pos[2]),
                    Vector3::new(v.normal[0], v.normal[1], v.normal[2]),
                );
            }

            for tri in indices.chunks(3) {
                if tri.len() == 3 {
                    mesh.add_triangle(
                        (base_idx + tri[0]) as u32,
                        (base_idx + tri[1]) as u32,
                        (base_idx + tri[2]) as u32,
                    );
                }
            }
        }

        Ok(mesh)
    }

    /// Check if two meshes' bounding boxes overlap
    fn bounds_overlap(host_mesh: &Mesh, opening_mesh: &Mesh) -> bool {
        let (host_min, host_max) = host_mesh.bounds();
        let (open_min, open_max) = opening_mesh.bounds();

        // Check for overlap in all three dimensions
        let overlap_x = open_min.x < host_max.x && open_max.x > host_min.x;
        let overlap_y = open_min.y < host_max.y && open_max.y > host_min.y;
        let overlap_z = open_min.z < host_max.z && open_max.z > host_min.z;

        overlap_x && overlap_y && overlap_z
    }

    /// Subtract opening mesh from host mesh using CSG boolean operations.
    ///
    /// With the `manifold-csg` feature enabled, dispatches to Google's
    /// Manifold kernel — no operand-size cap, manifold-by-construction
    /// output. Without the feature, uses the legacy BSP port (`bsp_csg`)
    /// which silently falls back to the un-cut host when its 24-polygon
    /// cap is exceeded.
    ///
    /// On any failure path the host is returned un-cut and a [`BoolFailure`]
    /// record is appended to the processor's failure log (drainable via
    /// [`Self::take_failures`]). An empty host returns an empty mesh without
    /// recording a failure (it's a fast path, not a fallback).
    pub fn subtract_mesh(&self, host_mesh: &Mesh, opening_mesh: &Mesh) -> Result<Mesh> {
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

        #[cfg(feature = "manifold-csg")]
        {
            match crate::manifold_kernel::difference(host_mesh, opening_mesh) {
                Ok(result) => {
                    // An empty result is a legitimate outcome — the cutter
                    // can fully contain the host. Only treat non-finite /
                    // invalid kernel output as a failure.
                    if !self.validate_mesh(&result) {
                        self.record_failure(
                            BoolOp::Difference,
                            BoolFailureReason::KernelOutputInvalid,
                        );
                        return Ok(host_mesh.clone());
                    }
                    // Defensive: Manifold has been observed (Linux x86_64 CI,
                    // AC20-FZK-Haus gable walls #60012/#67828) to return an
                    // implausibly small result — e.g. 1 triangle from a
                    // 12-triangle box host clipped by a polygonal-bounded
                    // half-space prism that does NOT fully contain the host.
                    // macOS aarch64 produces the expected pentagon on the
                    // same input, so this is a cross-platform Manifold
                    // determinism issue. When we detect a clearly-truncated
                    // result, re-run the same op through the legacy BSP
                    // path and keep whichever output looks like a real
                    // clip. See `looks_degenerate` for the heuristic.
                    if Self::manifold_result_looks_degenerate(host_mesh, &result) {
                        let host_tris = host_mesh.indices.len() / 3;
                        let result_tris = result.indices.len() / 3;
                        eprintln!(
                            "[manifold-csg] difference result looks degenerate \
                             (host {} tris -> result {} tris); retrying via BSP fallback",
                            host_tris, result_tris,
                        );
                        if let Some(bsp_result) = self.try_bsp_difference(host_mesh, opening_mesh) {
                            if !Self::manifold_result_looks_degenerate(host_mesh, &bsp_result) {
                                self.record_failure(
                                    BoolOp::Difference,
                                    BoolFailureReason::ManifoldOutputDegenerate {
                                        host_tris,
                                        result_tris,
                                    },
                                );
                                return Ok(bsp_result);
                            }
                        }
                        // BSP also failed or produced suspicious output —
                        // record but keep Manifold's result (better than
                        // un-cut, in many cases).
                        self.record_failure(
                            BoolOp::Difference,
                            BoolFailureReason::ManifoldOutputDegenerate {
                                host_tris,
                                result_tris,
                            },
                        );
                    }
                    return Ok(result);
                }
                Err(reason) => {
                    self.record_failure(BoolOp::Difference, reason);
                    return Ok(host_mesh.clone());
                }
            }
        }

        #[cfg(not(feature = "manifold-csg"))]
        {
            let host_polys = Self::mesh_to_polygons(host_mesh);
            let opening_polys = Self::mesh_to_polygons(opening_mesh);

            if host_polys.is_empty() || opening_polys.is_empty() {
                self.record_failure(BoolOp::Difference, BoolFailureReason::DegenerateOperand);
                return Ok(host_mesh.clone());
            }

            if !Self::can_run_csg_operation(host_polys.len(), opening_polys.len()) {
                self.record_failure(
                    BoolOp::Difference,
                    BoolFailureReason::OperandTooLarge {
                        polys_a: host_polys.len(),
                        polys_b: opening_polys.len(),
                    },
                );
                return Ok(host_mesh.clone());
            }

            let result_polys = crate::bsp_csg::difference(host_polys, opening_polys);

            match Self::polygons_to_mesh(&result_polys) {
                Ok(result) => Ok(Self::consolidate_coplanar(result)),
                Err(e) => {
                    self.record_failure(
                        BoolOp::Difference,
                        BoolFailureReason::KernelError(e.to_string()),
                    );
                    Ok(host_mesh.clone())
                }
            }
        }
    }

    /// Re-merge BSP's per-plane fragments via 2D polygon union, then earcut
    /// each result back to triangles. BSP CSG over-fragments any host face
    /// whose plane is crossed by an extended cutter wall — even when the
    /// cutter doesn't reach that face in 3D — because `split_polygon` is
    /// plane-based, not solid-aware. A naive edge-walk merge fails on the
    /// "X" crossings that appear at cutter-outline corners (four fragments
    /// sharing only a vertex), so we project each plane bucket to 2D, run
    /// the i_overlay union the rest of the codebase already uses for
    /// `bool2d::union_contours`, and earcut the resulting (possibly
    /// annular) shapes. This is what brings the bath from 189 → ~50
    /// triangles on the BSP path with the cavity outline intact (issue
    /// #780).
    ///
    /// Returns the input mesh unchanged if the consolidate fails or yields
    /// nothing — never worse than the BSP-direct output.
    #[cfg_attr(feature = "manifold-csg", allow(dead_code))]
    fn consolidate_coplanar(mesh: Mesh) -> Mesh {
        use crate::triangulation::{
            project_to_2d_with_basis, triangulate_polygon_with_holes,
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
                // Force CCW for i_overlay's NonZero fill — BSP output can
                // carry inconsistent winding (an extra `flip()` during the
                // a_node/b_node invert dance), and mixed-winding subject +
                // clip cancel out instead of unioning.
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
            // holes (BSP's f64 noise leaves tiny spurious cavities after
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
                let outer_simplified = simplify_2d_collinear(&outer_2d);
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
                        let simplified = simplify_2d_collinear(&pts);
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

                let indices = match triangulate_polygon_with_holes(
                    &outer_simplified,
                    &holes_simplified,
                ) {
                    Ok(idx) => idx,
                    Err(_) => continue,
                };

                // Lift 2D points back to 3D.
                let mut all_2d: Vec<nalgebra::Point2<f64>> =
                    Vec::with_capacity(outer_simplified.len() + holes_simplified.iter().map(|h| h.len()).sum::<usize>());
                all_2d.extend(outer_simplified.iter().copied());
                for h in &holes_simplified {
                    all_2d.extend(h.iter().copied());
                }

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
        output
    }

    /// Union two meshes together using CSG boolean operations.
    ///
    /// With the `manifold-csg` feature, dispatches to the Manifold kernel
    /// (no operand cap). Without it, the legacy BSP path is used and
    /// silently falls back to mesh-merge (no overlap removal) when the
    /// 24-polygon cap is exceeded — recording a [`BoolFailure`].
    ///
    /// Empty operands are handled silently — they have a unique correct answer.
    pub fn union_mesh(&self, mesh_a: &Mesh, mesh_b: &Mesh) -> Result<Mesh> {
        if mesh_a.is_empty() {
            return Ok(mesh_b.clone());
        }
        if mesh_b.is_empty() {
            return Ok(mesh_a.clone());
        }

        #[cfg(feature = "manifold-csg")]
        {
            match crate::manifold_kernel::union(mesh_a, mesh_b) {
                Ok(result) if !result.is_empty() => return Ok(result),
                Ok(_) => {
                    self.record_failure(BoolOp::Union, BoolFailureReason::KernelOutputInvalid);
                    let mut merged = mesh_a.clone();
                    merged.merge(mesh_b);
                    return Ok(merged);
                }
                Err(reason) => {
                    self.record_failure(BoolOp::Union, reason);
                    let mut merged = mesh_a.clone();
                    merged.merge(mesh_b);
                    return Ok(merged);
                }
            }
        }

        #[cfg(not(feature = "manifold-csg"))]
        {
            let polys_a = Self::mesh_to_polygons(mesh_a);
            let polys_b = Self::mesh_to_polygons(mesh_b);

            if polys_a.is_empty() || polys_b.is_empty() {
                self.record_failure(BoolOp::Union, BoolFailureReason::DegenerateOperand);
                let mut merged = mesh_a.clone();
                merged.merge(mesh_b);
                return Ok(merged);
            }

            if !Self::can_run_csg_operation(polys_a.len(), polys_b.len()) {
                self.record_failure(
                    BoolOp::Union,
                    BoolFailureReason::OperandTooLarge {
                        polys_a: polys_a.len(),
                        polys_b: polys_b.len(),
                    },
                );
                let mut merged = mesh_a.clone();
                merged.merge(mesh_b);
                return Ok(merged);
            }

            let result_polys = crate::bsp_csg::union(polys_a, polys_b);
            Self::polygons_to_mesh(&result_polys)
        }
    }

    /// Intersect two meshes using CSG boolean operations.
    ///
    /// Returns the intersection of two meshes (the volume where both
    /// overlap). With `manifold-csg`, this is a real CSG intersection.
    /// Without the feature the legacy BSP path returns an empty mesh
    /// when its cap is exceeded — recording a [`BoolFailure`].
    pub fn intersection_mesh(&self, mesh_a: &Mesh, mesh_b: &Mesh) -> Result<Mesh> {
        if mesh_a.is_empty() || mesh_b.is_empty() {
            return Ok(Mesh::new());
        }

        #[cfg(feature = "manifold-csg")]
        {
            match crate::manifold_kernel::intersection(mesh_a, mesh_b) {
                Ok(result) => return Ok(result),
                Err(reason) => {
                    self.record_failure(BoolOp::Intersection, reason);
                    return Ok(Mesh::new());
                }
            }
        }

        #[cfg(not(feature = "manifold-csg"))]
        {
            let polys_a = Self::mesh_to_polygons(mesh_a);
            let polys_b = Self::mesh_to_polygons(mesh_b);

            if polys_a.is_empty() || polys_b.is_empty() {
                self.record_failure(BoolOp::Intersection, BoolFailureReason::DegenerateOperand);
                return Ok(Mesh::new());
            }

            if !Self::can_run_csg_operation(polys_a.len(), polys_b.len()) {
                self.record_failure(
                    BoolOp::Intersection,
                    BoolFailureReason::OperandTooLarge {
                        polys_a: polys_a.len(),
                        polys_b: polys_b.len(),
                    },
                );
                return Ok(Mesh::new());
            }

            let result_polys = crate::bsp_csg::intersection(polys_a, polys_b);
            Self::polygons_to_mesh(&result_polys)
        }
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
    /// Detects the Linux-specific Manifold pathology where a wall body
    /// clipped by an `IfcPolygonalBoundedHalfSpace` prism collapses to a
    /// near-empty result (e.g. 1 triangle from a 12-triangle host box).
    /// macOS aarch64 produces the full pentagon on identical input, so
    /// this is a kernel-determinism issue, not a malformed cutter.
    ///
    /// Rules:
    ///  * An empty result is a legit outcome (cutter contains host) —
    ///    NOT degenerate.
    ///  * A closed-volume result needs at least 4 triangles. Anything
    ///    below that is structurally broken.
    ///  * For hosts with >= 12 triangles (typical IFC solid input), the
    ///    output should retain at least 25 % of the host's triangle
    ///    count when the cutter is partial.
    #[cfg_attr(not(feature = "manifold-csg"), allow(dead_code))]
    fn manifold_result_looks_degenerate(host: &Mesh, result: &Mesh) -> bool {
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
        // 1 % of the host's longest edge — tight enough to catch a
        // truly-outside result, loose enough to absorb the floating-point
        // jitter Manifold introduces along intersection seams.
        let host_span = (host_max - host_min).abs();
        let slack = host_span.x.max(host_span.y).max(host_span.z) as f64 * 0.01;
        let slack = slack as f32;
        if res_min.x + slack < host_min.x
            || res_min.y + slack < host_min.y
            || res_min.z + slack < host_min.z
            || res_max.x > host_max.x + slack
            || res_max.y > host_max.y + slack
            || res_max.z > host_max.z + slack
        {
            return true;
        }
        false
    }

    /// Run `host - opening` through the legacy in-tree BSP CSG kernel.
    /// Returns `None` if the BSP path can't accept the inputs (operands
    /// past the per-mesh polygon cap, degenerate polygon extraction,
    /// etc.) — caller falls back to keeping the Manifold output.
    ///
    /// Used as a safety net under `manifold-csg` when Manifold's output
    /// looks structurally broken (see [`Self::manifold_result_looks_degenerate`]).
    /// The BSP path is more deterministic across OS/arch combos at the
    /// cost of a hard 128-polygon-per-mesh cap.
    #[cfg_attr(not(feature = "manifold-csg"), allow(dead_code))]
    fn try_bsp_difference(&self, host_mesh: &Mesh, opening_mesh: &Mesh) -> Option<Mesh> {
        let host_polys = Self::mesh_to_polygons(host_mesh);
        let opening_polys = Self::mesh_to_polygons(opening_mesh);
        if host_polys.is_empty() || opening_polys.is_empty() {
            return None;
        }
        if !Self::can_run_csg_operation(host_polys.len(), opening_polys.len()) {
            return None;
        }
        let result_polys = crate::bsp_csg::difference(host_polys, opening_polys);
        let _ = host_mesh;
        match Self::polygons_to_mesh(&result_polys) {
            Ok(mesh) => {
                let consolidated = Self::consolidate_coplanar(mesh);
                if consolidated.is_empty() {
                    None
                } else {
                    Some(consolidated)
                }
            }
            Err(_) => None,
        }
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
/// On desktop, this is a no-op because the frontend computes normals in JS
/// after decoding (normals are not sent over IPC to save bandwidth).
/// WASM path keeps full normal calculation.
#[cfg(not(target_arch = "wasm32"))]
#[inline]
pub fn calculate_normals(_mesh: &mut Mesh) {}

#[cfg(target_arch = "wasm32")]
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bsp_difference_preserves_rounded_rect_cap() {
        // Reproduce the bath case in isolation. Host: 2×0.8×0.8 m box.
        // Cutter: 28-vertex rounded-rect prism. After BSP DIFFERENCE the
        // cutter's bottom cap (becoming the cavity floor) must survive
        // intact — the actual bug behind issue #780's cap collapsing to 3
        // triangles is the BSP misclassifying SPANNING edges when many
        // cap-coplanar wall planes intersect the cap polygon at the cap's
        // own vertices.
        use crate::bsp_csg::{Polygon, Vertex};

        let host_polys = ClippingProcessor::mesh_to_polygons(&aabb_to_mesh(
            Point3::new(0.0, 0.0, 0.0),
            Point3::new(2.0, 0.8, 0.8),
        ));

        // Build a 28-vertex rounded rect cap manually (no IFC pipeline) and
        // its prism by extrusion. Centred at (1.0, 0.4) with half-extents
        // (0.9, 0.3), corner radius 0.2, depth 0.7, base at z=0.1.
        const N: usize = 6;
        let mut outline = Vec::with_capacity((N + 1) * 4);
        let corners = [
            (1.7, 0.3, -std::f64::consts::FRAC_PI_2, 0.0),
            (1.7, 0.5, 0.0, std::f64::consts::FRAC_PI_2),
            (0.3, 0.5, std::f64::consts::FRAC_PI_2, std::f64::consts::PI),
            (0.3, 0.3, std::f64::consts::PI, std::f64::consts::PI * 1.5),
        ];
        let r = 0.2_f64;
        for (cx, cy, a0, a1) in corners {
            for i in 0..=N {
                let t = i as f64 / N as f64;
                let a = a0 + (a1 - a0) * t;
                outline.push((cx + r * a.cos(), cy + r * a.sin()));
            }
        }
        let n = outline.len();
        let z_bot = 0.1_f64;
        let z_top = 0.8_f64;

        // Build cutter polygons: bottom cap, top cap, side quads.
        let mut cutter_polys: Vec<Polygon> = Vec::new();
        // Bottom cap — CCW from below ⇒ vertex order reversed in 2D
        // (looking from -Z direction); store as outline reversed to face -Z.
        let bot_verts: Vec<Vertex> = outline
            .iter()
            .rev()
            .map(|(x, y)| Vertex::new([*x, *y, z_bot], [0.0, 0.0, -1.0]))
            .collect();
        cutter_polys.push(Polygon::new(bot_verts));
        // Top cap — CCW from above
        let top_verts: Vec<Vertex> = outline
            .iter()
            .map(|(x, y)| Vertex::new([*x, *y, z_top], [0.0, 0.0, 1.0]))
            .collect();
        cutter_polys.push(Polygon::new(top_verts));
        // Side walls
        for i in 0..n {
            let j = (i + 1) % n;
            let (x0, y0) = outline[i];
            let (x1, y1) = outline[j];
            // Outward normal: perpendicular to (x1-x0, y1-y0) in XY plane,
            // pointing away from cavity centre (1.0, 0.4).
            let ex = x1 - x0;
            let ey = y1 - y0;
            let mut nx = ey;
            let mut ny = -ex;
            let nlen = (nx * nx + ny * ny).sqrt();
            if nlen > 0.0 {
                nx /= nlen;
                ny /= nlen;
            }
            // Flip if pointing inward
            let mx = (x0 + x1) * 0.5 - 1.0;
            let my = (y0 + y1) * 0.5 - 0.4;
            if nx * mx + ny * my < 0.0 {
                nx = -nx;
                ny = -ny;
            }
            let wall = vec![
                Vertex::new([x0, y0, z_bot], [nx, ny, 0.0]),
                Vertex::new([x1, y1, z_bot], [nx, ny, 0.0]),
                Vertex::new([x1, y1, z_top], [nx, ny, 0.0]),
                Vertex::new([x0, y0, z_top], [nx, ny, 0.0]),
            ];
            cutter_polys.push(Polygon::new(wall));
        }

        assert_eq!(
            cutter_polys.len(),
            2 + n,
            "expected 2 caps + {} walls",
            n
        );

        let result_polys =
            crate::bsp_csg::difference(host_polys, cutter_polys);

        // Find the cavity-floor polygon: at z = 0.1, normal +Z.
        let mut cap_polys: Vec<&Polygon> = result_polys
            .iter()
            .filter(|p| {
                p.vertices
                    .iter()
                    .all(|v| (v.pos[2] - z_bot).abs() < 1.0e-4)
            })
            .collect();
        // Sort by vertex count desc to find the largest survivor.
        cap_polys.sort_by_key(|p| std::cmp::Reverse(p.vertices.len()));
        let largest_cap_verts = cap_polys.first().map(|p| p.vertices.len()).unwrap_or(0);
        assert!(
            largest_cap_verts >= 20,
            "cavity floor cap collapsed: largest polygon at z={} has {} verts (need ≥20 for the rounded rect outline). All cap polys: {:?}",
            z_bot,
            largest_cap_verts,
            cap_polys.iter().map(|p| p.vertices.len()).collect::<Vec<_>>()
        );
    }

    #[test]
    fn bsp_difference_preserves_inner_cube_faces() {
        // Pin BSP behaviour for the "host minus cutter fully inside host" case
        // (issue #780 bath): the cutter's 6 cap/wall faces should reappear
        // as the cavity surface after difference. Pre-merge gives BSP one
        // quad per face on both operands.
        let host = aabb_to_mesh(Point3::new(0.0, 0.0, 0.0), Point3::new(2.0, 0.8, 0.8));
        let cutter = aabb_to_mesh(Point3::new(0.1, 0.1, 0.1), Point3::new(1.9, 0.7, 0.8));

        let host_polys = ClippingProcessor::mesh_to_polygons(&host);
        let cutter_polys = ClippingProcessor::mesh_to_polygons(&cutter);
        assert_eq!(host_polys.len(), 6, "host should pre-merge to 6 face quads");
        assert_eq!(
            cutter_polys.len(),
            6,
            "cutter should pre-merge to 6 face quads"
        );

        let result_polys = crate::bsp_csg::difference(host_polys, cutter_polys);
        let result = ClippingProcessor::polygons_to_mesh(&result_polys)
            .expect("polygons_to_mesh ok");

        let tris = result.indices.len() / 3;
        assert!(
            tris >= 12,
            "expected ≥ 12 tris (host bottom + 4 sides + annular top + cavity walls + floor); got {}",
            tris
        );

        // Cavity floor at z = 0.1: must exist and cover the cavity footprint.
        let mut floor_area = 0.0_f64;
        for tri in result.indices.chunks_exact(3) {
            let v: Vec<(f32, f32, f32)> = tri
                .iter()
                .map(|&i| {
                    let o = i as usize * 3;
                    (
                        result.positions[o],
                        result.positions[o + 1],
                        result.positions[o + 2],
                    )
                })
                .collect();
            if v.iter().all(|p| (p.2 - 0.1).abs() < 1.0e-4) {
                let ax = v[1].0 - v[0].0;
                let ay = v[1].1 - v[0].1;
                let bx = v[2].0 - v[0].0;
                let by = v[2].1 - v[0].1;
                floor_area += 0.5 * ((ax * by) - (ay * bx)).abs() as f64;
            }
        }
        let expected_floor_area = 1.8 * 0.6; // cavity footprint
        assert!(
            (floor_area - expected_floor_area).abs() < 1.0e-3,
            "cavity floor area = {:.4} m² (expected {:.4})",
            floor_area,
            expected_floor_area
        );
    }

    #[test]
    fn merge_coplanar_collapses_subdivided_quad() {
        // Quad on z=0 plane split into 4 triangles via a centroid vertex.
        // mesh_to_polygons should reassemble it into a single 4-vertex
        // polygon and polygons_to_mesh should triangulate that into 2
        // triangles.
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

        let polys = ClippingProcessor::mesh_to_polygons(&mesh);
        assert_eq!(
            polys.len(),
            1,
            "expected single merged polygon, got {}",
            polys.len()
        );
        assert_eq!(
            polys[0].vertices.len(),
            4,
            "expected 4-vertex quad after collinear-vertex cleanup, got {} verts",
            polys[0].vertices.len()
        );

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
        // (1.5, 0, 0). Simulates BSP's "extended cutter plane crossed the
        // host edge here" output. Must collapse back to 2 triangles.
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

    #[test]
    fn test_csg_operation_guard_allows_simple_boxes() {
        let box_a = aabb_to_mesh(Point3::new(0.0, 0.0, 0.0), Point3::new(1.0, 1.0, 1.0));
        let box_b = aabb_to_mesh(Point3::new(0.25, 0.25, 0.25), Point3::new(0.75, 0.75, 0.75));

        let polys_a = ClippingProcessor::mesh_to_polygons(&box_a);
        let polys_b = ClippingProcessor::mesh_to_polygons(&box_b);

        assert!(ClippingProcessor::can_run_csg_operation(polys_a.len(), polys_b.len()));
    }

    #[test]
    fn test_csg_operation_guard_rejects_complex_operands() {
        // Build a mesh with > MAX_CSG_POLYGONS_PER_MESH polygons. Twelve
        // axis-offset boxes — distinct positions so the coplanar-merge
        // pass keeps each face as its own polygon. (Stacking boxes at the
        // same origin used to work but the merge now collapses them.)
        let mut complex_mesh = Mesh::new();
        for i in 0..30 {
            let offset = i as f64 * 2.0;
            complex_mesh.merge(&aabb_to_mesh(
                Point3::new(offset, offset, offset),
                Point3::new(offset + 1.0, offset + 1.0, offset + 1.0),
            ));
        }
        let box_mesh =
            aabb_to_mesh(Point3::new(0.0, 0.0, 0.0), Point3::new(1.0, 1.0, 1.0));

        let polys_complex = ClippingProcessor::mesh_to_polygons(&complex_mesh);
        let polys_box = ClippingProcessor::mesh_to_polygons(&box_mesh);

        assert!(
            polys_complex.len() > MAX_CSG_POLYGONS_PER_MESH,
            "expected > {} polygons, got {} (merge regressed?)",
            MAX_CSG_POLYGONS_PER_MESH,
            polys_complex.len()
        );
        assert!(!ClippingProcessor::can_run_csg_operation(
            polys_complex.len(),
            polys_box.len()
        ));
    }
}
