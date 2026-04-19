// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! CSG (Constructive Solid Geometry) Operations
//!
//! Fast triangle clipping and boolean operations.

use crate::error::Result;
use crate::mesh::Mesh;
use crate::triangulation::{calculate_polygon_normal, project_to_2d, triangulate_polygon};
use nalgebra::{Point3, Vector3};
use rustc_hash::FxHashMap;
use smallvec::SmallVec;

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
/// Rectangular solids are 12 triangles, so this still allows the simple box-like
/// boolean cases we expect while avoiding the complex BSP trees that can overflow
/// the browser's native call stack in WASM.
const MAX_CSG_POLYGONS_PER_MESH: usize = 24;
/// Maximum combined polygon count for CSG operations.
const MAX_CSG_POLYGONS: usize = MAX_CSG_POLYGONS_PER_MESH * 2;

/// CSG Clipping Processor
pub struct ClippingProcessor {
    /// Epsilon for floating point comparisons
    pub epsilon: f64,
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
        Self { epsilon: 1e-6 }
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

    /// Extract opening profile from mesh (find largest face)
    /// Returns profile points as an ordered contour and the face normal
    /// Uses boundary extraction via edge counting to produce stable results
    #[allow(dead_code)]
    fn extract_opening_profile(
        &self,
        opening_mesh: &Mesh,
    ) -> Option<(Vec<Point3<f64>>, Vector3<f64>)> {
        if opening_mesh.is_empty() {
            return None;
        }

        // Group triangles by normal to find faces
        let mut face_groups: FxHashMap<u64, Vec<(Point3<f64>, Point3<f64>, Point3<f64>)>> =
            FxHashMap::default();
        let normal_epsilon = 0.01; // Tolerance for normal comparison

        let vertex_count = opening_mesh.positions.len() / 3;
        for i in (0..opening_mesh.indices.len()).step_by(3) {
            if i + 2 >= opening_mesh.indices.len() {
                break;
            }
            let i0 = opening_mesh.indices[i] as usize;
            let i1 = opening_mesh.indices[i + 1] as usize;
            let i2 = opening_mesh.indices[i + 2] as usize;

            // Bounds check vertex indices against positions
            if i0 >= vertex_count || i1 >= vertex_count || i2 >= vertex_count {
                continue;
            }

            let v0 = Point3::new(
                opening_mesh.positions[i0 * 3] as f64,
                opening_mesh.positions[i0 * 3 + 1] as f64,
                opening_mesh.positions[i0 * 3 + 2] as f64,
            );
            let v1 = Point3::new(
                opening_mesh.positions[i1 * 3] as f64,
                opening_mesh.positions[i1 * 3 + 1] as f64,
                opening_mesh.positions[i1 * 3 + 2] as f64,
            );
            let v2 = Point3::new(
                opening_mesh.positions[i2 * 3] as f64,
                opening_mesh.positions[i2 * 3 + 1] as f64,
                opening_mesh.positions[i2 * 3 + 2] as f64,
            );

            let edge1 = v1 - v0;
            let edge2 = v2 - v0;
            // Use try_normalize to handle degenerate triangles
            let normal = match edge1.cross(&edge2).try_normalize(1e-10) {
                Some(n) => n,
                None => continue, // Skip degenerate triangles
            };

            // Quantize normal for grouping (round to nearest 0.01)
            let nx = (normal.x / normal_epsilon).round() as i32;
            let ny = (normal.y / normal_epsilon).round() as i32;
            let nz = (normal.z / normal_epsilon).round() as i32;
            let key = ((nx as u64) << 32) | ((ny as u32 as u64) << 16) | (nz as u32 as u64);

            face_groups.entry(key).or_default().push((v0, v1, v2));
        }

        // Find largest face group (most triangles = largest face)
        let largest_face = face_groups
            .iter()
            .max_by_key(|(_, triangles)| triangles.len())?;

        let triangles = largest_face.1;
        if triangles.is_empty() {
            return None;
        }

        // Build edge count map to find boundary edges
        // An edge is a boundary if it appears exactly once (not shared between triangles)
        // Use quantized vertex positions as keys
        let quantize = |p: &Point3<f64>| -> (i64, i64, i64) {
            let scale = 1e6; // Quantize to micrometer precision
            (
                (p.x * scale).round() as i64,
                (p.y * scale).round() as i64,
                (p.z * scale).round() as i64,
            )
        };

        // Edge key: ordered pair of quantized vertices (smaller first for consistency)
        let make_edge_key =
            |a: (i64, i64, i64), b: (i64, i64, i64)| -> ((i64, i64, i64), (i64, i64, i64)) {
                if a < b {
                    (a, b)
                } else {
                    (b, a)
                }
            };

        // Count edges and store original vertices
        let mut edge_count: FxHashMap<
            ((i64, i64, i64), (i64, i64, i64)),
            (usize, Point3<f64>, Point3<f64>),
        > = FxHashMap::default();

        for (v0, v1, v2) in triangles {
            let q0 = quantize(v0);
            let q1 = quantize(v1);
            let q2 = quantize(v2);

            // Three edges per triangle
            for (qa, qb, pa, pb) in [(q0, q1, *v0, *v1), (q1, q2, *v1, *v2), (q2, q0, *v2, *v0)] {
                let key = make_edge_key(qa, qb);
                edge_count
                    .entry(key)
                    .and_modify(|(count, _, _)| *count += 1)
                    .or_insert((1, pa, pb));
            }
        }

        // Collect boundary edges (count == 1)
        let mut boundary_edges: Vec<(Point3<f64>, Point3<f64>)> = Vec::new();
        for (_, (count, pa, pb)) in &edge_count {
            if *count == 1 {
                boundary_edges.push((*pa, *pb));
            }
        }

        if boundary_edges.is_empty() {
            // No boundary found (closed surface with no edges) - fall back to using centroid
            return None;
        }

        // Build vertex adjacency map for boundary traversal
        let mut adjacency: FxHashMap<(i64, i64, i64), Vec<(i64, i64, i64, Point3<f64>)>> =
            FxHashMap::default();
        for (pa, pb) in &boundary_edges {
            let qa = quantize(pa);
            let qb = quantize(pb);
            adjacency
                .entry(qa)
                .or_default()
                .push((qb.0, qb.1, qb.2, *pb));
            adjacency
                .entry(qb)
                .or_default()
                .push((qa.0, qa.1, qa.2, *pa));
        }

        // Build ordered contour by walking the boundary
        let mut contour: Vec<Point3<f64>> = Vec::new();
        let mut visited: FxHashMap<(i64, i64, i64), bool> = FxHashMap::default();

        // Start from first boundary edge
        if let Some((start_p, _)) = boundary_edges.first() {
            let start_q = quantize(start_p);
            contour.push(*start_p);
            visited.insert(start_q, true);

            let mut current_q = start_q;

            // Walk around the boundary
            loop {
                let neighbors = match adjacency.get(&current_q) {
                    Some(n) => n,
                    None => break,
                };

                // Find unvisited neighbor
                let mut found_next = false;
                for (nqx, nqy, nqz, np) in neighbors {
                    let nq = (*nqx, *nqy, *nqz);
                    if !visited.get(&nq).unwrap_or(&false) {
                        contour.push(*np);
                        visited.insert(nq, true);
                        current_q = nq;
                        found_next = true;
                        break;
                    }
                }

                if !found_next {
                    break; // Closed loop or no more unvisited neighbors
                }
            }
        }

        if contour.len() < 3 {
            // Not enough points for a valid polygon
            return None;
        }

        // Calculate normal from the ordered contour
        let normal = calculate_polygon_normal(&contour);

        // Normalize the result
        let normalized_normal = match normal.try_normalize(1e-10) {
            Some(n) => n,
            None => return None, // Degenerate polygon
        };

        Some((contour, normalized_normal))
    }

    /// Convert our Mesh format to BSP polygon list
    fn mesh_to_polygons(mesh: &Mesh) -> Vec<crate::bsp_csg::Polygon> {
        use crate::bsp_csg::{Polygon, Vertex};

        if mesh.is_empty() || mesh.indices.len() < 3 {
            return Vec::new();
        }

        let vertex_count = mesh.positions.len() / 3;
        let triangle_count = mesh.indices.len() / 3;
        let mut polygons = Vec::with_capacity(triangle_count);

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

            if !v0.iter().all(|x| x.is_finite())
                || !v1.iter().all(|x| x.is_finite())
                || !v2.iter().all(|x| x.is_finite())
            {
                continue;
            }

            let edge1 = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]];
            let edge2 = [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]];
            let cross = [
                edge1[1] * edge2[2] - edge1[2] * edge2[1],
                edge1[2] * edge2[0] - edge1[0] * edge2[2],
                edge1[0] * edge2[1] - edge1[1] * edge2[0],
            ];
            let len = (cross[0] * cross[0] + cross[1] * cross[1] + cross[2] * cross[2]).sqrt();
            if len < 1e-10 {
                continue;
            }
            let n = [cross[0] / len, cross[1] / len, cross[2] / len];

            polygons.push(Polygon::new(vec![
                Vertex::new(v0, n),
                Vertex::new(v1, n),
                Vertex::new(v2, n),
            ]));
        }

        polygons
    }

    /// Convert BSP polygon list back to our Mesh format
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

    /// Subtract opening mesh from host mesh using BSP CSG boolean operations
    pub fn subtract_mesh(&self, host_mesh: &Mesh, opening_mesh: &Mesh) -> Result<Mesh> {
        if host_mesh.is_empty() {
            return Ok(Mesh::new());
        }
        if opening_mesh.is_empty() {
            return Ok(host_mesh.clone());
        }
        if !Self::bounds_overlap(host_mesh, opening_mesh) {
            return Ok(host_mesh.clone());
        }

        let host_polys = Self::mesh_to_polygons(host_mesh);
        let opening_polys = Self::mesh_to_polygons(opening_mesh);

        if host_polys.is_empty() || opening_polys.is_empty() {
            return Ok(host_mesh.clone());
        }

        if !Self::can_run_csg_operation(host_polys.len(), opening_polys.len()) {
            return Ok(host_mesh.clone());
        }

        let result_polys = crate::bsp_csg::difference(host_polys, opening_polys);

        match Self::polygons_to_mesh(&result_polys) {
            Ok(result) => {
                let cleaned = Self::remove_degenerate_triangles(&result, host_mesh);
                Ok(cleaned)
            }
            Err(_) => Ok(host_mesh.clone()),
        }
    }

    /// Remove degenerate triangles from CSG result
    ///
    /// CSG operations can create thin "sliver" triangles at intersection boundaries
    /// due to numerical precision issues. This function removes triangles that:
    /// 1. Have very small area (thin slivers)
    /// 2. Are located inside the original host mesh bounds (not on the surface)
    fn remove_degenerate_triangles(mesh: &Mesh, host_mesh: &Mesh) -> Mesh {
        let (host_min, host_max) = host_mesh.bounds();

        // Convert host bounds to f64 for calculations
        let host_min_x = host_min.x as f64;
        let host_min_y = host_min.y as f64;
        let host_min_z = host_min.z as f64;
        let host_max_x = host_max.x as f64;
        let host_max_y = host_max.y as f64;
        let host_max_z = host_max.z as f64;

        // Calculate host dimensions to determine appropriate thresholds
        let host_size_x = (host_max_x - host_min_x).abs();
        let host_size_y = (host_max_y - host_min_y).abs();
        let host_size_z = (host_max_z - host_min_z).abs();
        let min_dim = host_size_x.min(host_size_y).min(host_size_z);

        // Minimum area threshold - triangles smaller than this are likely artifacts
        // Use 0.1% of the smallest host dimension squared
        let min_area = (min_dim * 0.001).powi(2);

        // Distance threshold for "inside" detection
        let epsilon = min_dim * 0.01;

        let mut cleaned = Mesh::new();

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

            // Get vertex positions
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

            // Calculate triangle area using cross product
            let edge1 = v1 - v0;
            let edge2 = v2 - v0;
            let cross = edge1.cross(&edge2);
            let area = cross.norm() / 2.0;

            // Check if triangle is degenerate (very small area)
            if area < min_area {
                continue;
            }

            // Check if any vertex is significantly OUTSIDE the host bounds
            // This catches CSG artifacts that create long thin triangles extending far from the model
            let expansion = min_dim.max(1.0); // At least 1 meter expansion allowed
            let far_outside = v0.x < (host_min_x - expansion)
                || v0.x > (host_max_x + expansion)
                || v0.y < (host_min_y - expansion)
                || v0.y > (host_max_y + expansion)
                || v0.z < (host_min_z - expansion)
                || v0.z > (host_max_z + expansion)
                || v1.x < (host_min_x - expansion)
                || v1.x > (host_max_x + expansion)
                || v1.y < (host_min_y - expansion)
                || v1.y > (host_max_y + expansion)
                || v1.z < (host_min_z - expansion)
                || v1.z > (host_max_z + expansion)
                || v2.x < (host_min_x - expansion)
                || v2.x > (host_max_x + expansion)
                || v2.y < (host_min_y - expansion)
                || v2.y > (host_max_y + expansion)
                || v2.z < (host_min_z - expansion)
                || v2.z > (host_max_z + expansion);

            if far_outside {
                continue;
            }

            // Check if triangle center is strictly inside the host bounds
            // (not on the surface) - these are likely CSG artifacts
            let center = Point3::new(
                (v0.x + v1.x + v2.x) / 3.0,
                (v0.y + v1.y + v2.y) / 3.0,
                (v0.z + v1.z + v2.z) / 3.0,
            );

            // Check if center is inside host bounds (with epsilon margin)
            let inside_x = center.x > (host_min_x + epsilon) && center.x < (host_max_x - epsilon);
            let inside_y = center.y > (host_min_y + epsilon) && center.y < (host_max_y - epsilon);
            let inside_z = center.z > (host_min_z + epsilon) && center.z < (host_max_z - epsilon);

            // If triangle is strictly inside the host in ALL dimensions, it's likely an artifact
            // Only remove if it's also relatively small
            let max_area = min_dim * min_dim * 0.1; // 10% of smallest dimension squared
            if inside_x && inside_y && inside_z && area < max_area {
                continue;
            }

            // Get normals
            let n0 = Vector3::new(
                mesh.normals[i0 * 3] as f64,
                mesh.normals[i0 * 3 + 1] as f64,
                mesh.normals[i0 * 3 + 2] as f64,
            );
            let n1 = Vector3::new(
                mesh.normals[i1 * 3] as f64,
                mesh.normals[i1 * 3 + 1] as f64,
                mesh.normals[i1 * 3 + 2] as f64,
            );
            let n2 = Vector3::new(
                mesh.normals[i2 * 3] as f64,
                mesh.normals[i2 * 3 + 1] as f64,
                mesh.normals[i2 * 3 + 2] as f64,
            );

            // Add valid triangle to cleaned mesh
            let base_idx = cleaned.vertex_count() as u32;
            cleaned.add_vertex(v0, n0);
            cleaned.add_vertex(v1, n1);
            cleaned.add_vertex(v2, n2);
            cleaned.add_triangle(base_idx, base_idx + 1, base_idx + 2);
        }

        cleaned
    }

    /// Remove triangles that are completely inside the opening bounds
    ///
    /// This removes artifact faces that CSG operations may leave inside circular/curved openings.
    /// Note: Currently unused because it can incorrectly remove valid triangles for complex
    /// non-rectangular openings. Kept for potential future use with simple rectangular openings.
    #[allow(dead_code)]
    fn remove_triangles_inside_bounds(
        mesh: &Mesh,
        open_min: Point3<f64>,
        open_max: Point3<f64>,
    ) -> Mesh {
        let mut cleaned = Mesh::new();

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

            // Get vertex positions
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

            // Calculate triangle bounding box
            let tri_min_x = v0.x.min(v1.x).min(v2.x);
            let tri_max_x = v0.x.max(v1.x).max(v2.x);
            let tri_min_y = v0.y.min(v1.y).min(v2.y);
            let tri_max_y = v0.y.max(v1.y).max(v2.y);
            let tri_min_z = v0.z.min(v1.z).min(v2.z);
            let tri_max_z = v0.z.max(v1.z).max(v2.z);

            // Check if triangle is completely inside opening bounds (remove it)
            if tri_min_x >= open_min.x
                && tri_max_x <= open_max.x
                && tri_min_y >= open_min.y
                && tri_max_y <= open_max.y
                && tri_min_z >= open_min.z
                && tri_max_z <= open_max.z
            {
                // Triangle is inside opening - remove it
                continue;
            }

            // Triangle is not completely inside - keep it
            let n0 = Vector3::new(
                mesh.normals[i0 * 3] as f64,
                mesh.normals[i0 * 3 + 1] as f64,
                mesh.normals[i0 * 3 + 2] as f64,
            );
            let n1 = Vector3::new(
                mesh.normals[i1 * 3] as f64,
                mesh.normals[i1 * 3 + 1] as f64,
                mesh.normals[i1 * 3 + 2] as f64,
            );
            let n2 = Vector3::new(
                mesh.normals[i2 * 3] as f64,
                mesh.normals[i2 * 3 + 1] as f64,
                mesh.normals[i2 * 3 + 2] as f64,
            );

            let base_idx = cleaned.vertex_count() as u32;
            cleaned.add_vertex(v0, n0);
            cleaned.add_vertex(v1, n1);
            cleaned.add_vertex(v2, n2);
            cleaned.add_triangle(base_idx, base_idx + 1, base_idx + 2);
        }

        cleaned
    }

    /// Union two meshes together using BSP CSG boolean operations
    pub fn union_mesh(&self, mesh_a: &Mesh, mesh_b: &Mesh) -> Result<Mesh> {
        if mesh_a.is_empty() {
            return Ok(mesh_b.clone());
        }
        if mesh_b.is_empty() {
            return Ok(mesh_a.clone());
        }

        let polys_a = Self::mesh_to_polygons(mesh_a);
        let polys_b = Self::mesh_to_polygons(mesh_b);

        if polys_a.is_empty() || polys_b.is_empty() {
            let mut merged = mesh_a.clone();
            merged.merge(mesh_b);
            return Ok(merged);
        }

        if !Self::can_run_csg_operation(polys_a.len(), polys_b.len()) {
            let mut merged = mesh_a.clone();
            merged.merge(mesh_b);
            return Ok(merged);
        }

        let result_polys = crate::bsp_csg::union(polys_a, polys_b);
        Self::polygons_to_mesh(&result_polys)
    }

    /// Intersect two meshes using BSP CSG boolean operations
    ///
    /// Returns the intersection of two meshes (the volume where both overlap).
    pub fn intersection_mesh(&self, mesh_a: &Mesh, mesh_b: &Mesh) -> Result<Mesh> {
        if mesh_a.is_empty() || mesh_b.is_empty() {
            return Ok(Mesh::new());
        }

        let polys_a = Self::mesh_to_polygons(mesh_a);
        let polys_b = Self::mesh_to_polygons(mesh_b);

        if polys_a.is_empty() || polys_b.is_empty() {
            return Ok(Mesh::new());
        }

        if !Self::can_run_csg_operation(polys_a.len(), polys_b.len()) {
            return Ok(Mesh::new());
        }

        let result_polys = crate::bsp_csg::intersection(polys_a, polys_b);
        Self::polygons_to_mesh(&result_polys)
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
        match self.subtract_meshes_batched(host, voids) {
            Ok(result) => {
                // Validate result
                if result.is_empty() || !self.validate_mesh(&result) {
                    host.clone()
                } else {
                    result
                }
            }
            Err(_) => host.clone(),
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

    /// Clip mesh using bounding box (6 planes) - DEPRECATED: use subtract_box() instead
    /// Subtracts everything inside the box from the mesh
    #[deprecated(note = "Use subtract_box() for better performance")]
    pub fn clip_mesh_with_box(
        &self,
        mesh: &Mesh,
        min: Point3<f64>,
        max: Point3<f64>,
    ) -> Result<Mesh> {
        self.subtract_box(mesh, min, max)
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
        let box_mesh = aabb_to_mesh(Point3::new(0.0, 0.0, 0.0), Point3::new(1.0, 1.0, 1.0));
        let mut complex_mesh = Mesh::new();
        complex_mesh.merge(&box_mesh);
        complex_mesh.merge(&box_mesh);
        complex_mesh.merge(&box_mesh);

        let polys_complex = ClippingProcessor::mesh_to_polygons(&complex_mesh);
        let polys_box = ClippingProcessor::mesh_to_polygons(&box_mesh);

        assert!(!ClippingProcessor::can_run_csg_operation(polys_complex.len(), polys_box.len()));
    }
}
