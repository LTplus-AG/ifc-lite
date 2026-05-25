// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Mesh data structures

use nalgebra::{Point3, Vector3};

/// Coordinate shift for RTC (Relative-to-Center) rendering
/// Stores the offset subtracted from coordinates to improve Float32 precision
#[derive(Debug, Clone, Copy, Default)]
pub struct CoordinateShift {
    /// X offset (subtracted from all X coordinates)
    pub x: f64,
    /// Y offset (subtracted from all Y coordinates)
    pub y: f64,
    /// Z offset (subtracted from all Z coordinates)
    pub z: f64,
}

impl CoordinateShift {
    /// Create a new coordinate shift
    #[inline]
    pub fn new(x: f64, y: f64, z: f64) -> Self {
        Self { x, y, z }
    }

    /// Create shift from a Point3
    #[inline]
    pub fn from_point(point: Point3<f64>) -> Self {
        Self {
            x: point.x,
            y: point.y,
            z: point.z,
        }
    }

    /// Check if shift is significant (>10km from origin)
    #[inline]
    pub fn is_significant(&self) -> bool {
        const THRESHOLD: f64 = 10000.0; // 10km
        self.x.abs() > THRESHOLD || self.y.abs() > THRESHOLD || self.z.abs() > THRESHOLD
    }

    /// Check if shift is zero (no shifting needed)
    #[inline]
    pub fn is_zero(&self) -> bool {
        self.x == 0.0 && self.y == 0.0 && self.z == 0.0
    }
}

/// Triangle mesh
#[derive(Debug, Clone)]
pub struct Mesh {
    /// Vertex positions (x, y, z)
    pub positions: Vec<f32>,
    /// Vertex normals (nx, ny, nz)
    pub normals: Vec<f32>,
    /// Triangle indices (i0, i1, i2)
    pub indices: Vec<u32>,
    /// Whether RTC offset has already been subtracted from positions.
    /// Set by `FacetedBrepProcessor::process_with_rtc` to prevent
    /// `transform_mesh` from double-subtracting RTC.
    pub rtc_applied: bool,
}

/// A sub-mesh with its source geometry item ID.
/// Used to track which geometry items contribute to an element's mesh,
/// allowing per-item color/style lookup.
#[derive(Debug, Clone)]
pub struct SubMesh {
    /// The geometry item ID (e.g., IfcFacetedBrep ID) for style lookup
    pub geometry_id: u32,
    /// The triangulated mesh data
    pub mesh: Mesh,
}

impl SubMesh {
    /// Create a new sub-mesh
    pub fn new(geometry_id: u32, mesh: Mesh) -> Self {
        Self { geometry_id, mesh }
    }
}

/// Collection of sub-meshes from an element, preserving per-item identity
#[derive(Debug, Clone, Default)]
pub struct SubMeshCollection {
    pub sub_meshes: Vec<SubMesh>,
}

impl SubMeshCollection {
    /// Create a new empty collection
    pub fn new() -> Self {
        Self {
            sub_meshes: Vec::new(),
        }
    }

    /// Add a sub-mesh
    pub fn add(&mut self, geometry_id: u32, mesh: Mesh) {
        if !mesh.is_empty() {
            self.sub_meshes.push(SubMesh::new(geometry_id, mesh));
        }
    }

    /// Check if collection is empty
    pub fn is_empty(&self) -> bool {
        self.sub_meshes.is_empty()
    }

    /// Get number of sub-meshes
    pub fn len(&self) -> usize {
        self.sub_meshes.len()
    }

    /// Merge all sub-meshes into a single mesh (loses per-item identity)
    pub fn into_combined_mesh(self) -> Mesh {
        let mut combined = Mesh::new();
        for sub in self.sub_meshes {
            combined.merge(&sub.mesh);
        }
        combined
    }

    /// Iterate over sub-meshes
    pub fn iter(&self) -> impl Iterator<Item = &SubMesh> {
        self.sub_meshes.iter()
    }
}

impl Mesh {
    /// Create a new empty mesh
    pub fn new() -> Self {
        Self {
            positions: Vec::new(),
            normals: Vec::new(),
            indices: Vec::new(),
            rtc_applied: false,
        }
    }

    /// Create a mesh with capacity
    pub fn with_capacity(vertex_count: usize, index_count: usize) -> Self {
        Self {
            positions: Vec::with_capacity(vertex_count * 3),
            normals: Vec::with_capacity(vertex_count * 3),
            indices: Vec::with_capacity(index_count),
            rtc_applied: false,
        }
    }

    /// Create a mesh from a single triangle
    pub fn from_triangle(
        v0: &Point3<f64>,
        v1: &Point3<f64>,
        v2: &Point3<f64>,
        normal: &Vector3<f64>,
    ) -> Self {
        let mut mesh = Self::with_capacity(3, 3);
        mesh.positions = vec![
            v0.x as f32,
            v0.y as f32,
            v0.z as f32,
            v1.x as f32,
            v1.y as f32,
            v1.z as f32,
            v2.x as f32,
            v2.y as f32,
            v2.z as f32,
        ];
        mesh.normals = vec![
            normal.x as f32,
            normal.y as f32,
            normal.z as f32,
            normal.x as f32,
            normal.y as f32,
            normal.z as f32,
            normal.x as f32,
            normal.y as f32,
            normal.z as f32,
        ];
        mesh.indices = vec![0, 1, 2];
        mesh
    }

    /// Add a vertex with normal
    #[inline]
    pub fn add_vertex(&mut self, position: Point3<f64>, normal: Vector3<f64>) {
        self.positions.push(position.x as f32);
        self.positions.push(position.y as f32);
        self.positions.push(position.z as f32);

        self.normals.push(normal.x as f32);
        self.normals.push(normal.y as f32);
        self.normals.push(normal.z as f32);
    }

    /// Add a vertex with normal, applying coordinate shift in f64 BEFORE f32 conversion
    /// This preserves precision for large coordinates (georeferenced models)
    ///
    /// # Arguments
    /// * `position` - Vertex position in world coordinates (f64)
    /// * `normal` - Vertex normal
    /// * `shift` - Coordinate shift to subtract (in f64) before converting to f32
    ///
    /// # Precision
    /// For coordinates like 5,000,000m (Swiss UTM), direct f32 conversion loses ~1m precision.
    /// By subtracting the centroid first (in f64), we convert small values (0-100m range)
    /// which preserves sub-millimeter precision.
    #[inline]
    pub fn add_vertex_with_shift(
        &mut self,
        position: Point3<f64>,
        normal: Vector3<f64>,
        shift: &CoordinateShift,
    ) {
        // Subtract shift in f64 precision BEFORE converting to f32
        // This is the key to preserving precision for large coordinates
        let shifted_x = position.x - shift.x;
        let shifted_y = position.y - shift.y;
        let shifted_z = position.z - shift.z;

        self.positions.push(shifted_x as f32);
        self.positions.push(shifted_y as f32);
        self.positions.push(shifted_z as f32);

        self.normals.push(normal.x as f32);
        self.normals.push(normal.y as f32);
        self.normals.push(normal.z as f32);
    }

    /// Apply coordinate shift to existing positions in-place
    /// Uses f64 intermediate for precision when subtracting large offsets
    #[inline]
    pub fn apply_shift(&mut self, shift: &CoordinateShift) {
        if shift.is_zero() {
            return;
        }
        for chunk in self.positions.chunks_exact_mut(3) {
            // Convert to f64, subtract, convert back to f32
            chunk[0] = (chunk[0] as f64 - shift.x) as f32;
            chunk[1] = (chunk[1] as f64 - shift.y) as f32;
            chunk[2] = (chunk[2] as f64 - shift.z) as f32;
        }
        self.rtc_applied = true;
    }

    /// Add a triangle
    #[inline]
    pub fn add_triangle(&mut self, i0: u32, i1: u32, i2: u32) {
        self.indices.push(i0);
        self.indices.push(i1);
        self.indices.push(i2);
    }

    /// Merge another mesh into this one
    #[inline]
    pub fn merge(&mut self, other: &Mesh) {
        if other.is_empty() {
            return;
        }

        let vertex_offset = (self.positions.len() / 3) as u32;

        // Pre-allocate for the incoming data
        self.positions.reserve(other.positions.len());
        self.normals.reserve(other.normals.len());
        self.indices.reserve(other.indices.len());

        self.positions.extend_from_slice(&other.positions);
        self.normals.extend_from_slice(&other.normals);

        // Vectorized index offset - more cache-friendly than loop
        self.indices
            .extend(other.indices.iter().map(|&i| i + vertex_offset));

        // Preserve RTC state: if either mesh has RTC applied, the merged result does too
        if other.rtc_applied {
            self.rtc_applied = true;
        }
    }

    /// Batch merge multiple meshes at once (more efficient than individual merges)
    #[inline]
    pub fn merge_all(&mut self, meshes: &[Mesh]) {
        // Calculate total size needed
        let total_positions: usize = meshes.iter().map(|m| m.positions.len()).sum();
        let total_indices: usize = meshes.iter().map(|m| m.indices.len()).sum();

        // Reserve capacity upfront to avoid reallocations
        self.positions.reserve(total_positions);
        self.normals.reserve(total_positions);
        self.indices.reserve(total_indices);

        // Merge all meshes
        for mesh in meshes {
            if !mesh.is_empty() {
                let vertex_offset = (self.positions.len() / 3) as u32;
                self.positions.extend_from_slice(&mesh.positions);
                self.normals.extend_from_slice(&mesh.normals);
                self.indices
                    .extend(mesh.indices.iter().map(|&i| i + vertex_offset));

                // Preserve RTC state: if any mesh has RTC applied, the merged result does too
                if mesh.rtc_applied {
                    self.rtc_applied = true;
                }
            }
        }
    }

    /// Get vertex count
    #[inline]
    pub fn vertex_count(&self) -> usize {
        self.positions.len() / 3
    }

    /// Get triangle count
    #[inline]
    pub fn triangle_count(&self) -> usize {
        self.indices.len() / 3
    }

    /// Remove triangle indices that reference vertices beyond the positions array.
    /// This prevents panics from malformed IFC data (e.g. Revit exports with invalid indices).
    #[inline]
    pub fn validate_indices(&mut self) {
        let vertex_count = self.positions.len() / 3;
        if vertex_count == 0 {
            self.indices.clear();
            return;
        }
        let mut valid = Vec::with_capacity(self.indices.len());
        for chunk in self.indices.chunks(3) {
            if chunk.len() == 3
                && (chunk[0] as usize) < vertex_count
                && (chunk[1] as usize) < vertex_count
                && (chunk[2] as usize) < vertex_count
            {
                valid.extend_from_slice(chunk);
            }
        }
        self.indices = valid;
    }

    /// Check if mesh is empty
    #[inline]
    pub fn is_empty(&self) -> bool {
        self.positions.is_empty()
    }

    /// Calculate bounds (min, max) - optimized with chunk iteration
    #[inline]
    pub fn bounds(&self) -> (Point3<f32>, Point3<f32>) {
        if self.is_empty() {
            return (Point3::origin(), Point3::origin());
        }

        let mut min = Point3::new(f32::MAX, f32::MAX, f32::MAX);
        let mut max = Point3::new(f32::MIN, f32::MIN, f32::MIN);

        // Use chunks for better cache locality
        self.positions.chunks_exact(3).for_each(|chunk| {
            let (x, y, z) = (chunk[0], chunk[1], chunk[2]);
            min.x = min.x.min(x);
            min.y = min.y.min(y);
            min.z = min.z.min(z);
            max.x = max.x.max(x);
            max.y = max.y.max(y);
            max.z = max.z.max(z);
        });

        (min, max)
    }

    /// Calculate centroid in f64 precision (for RTC offset calculation)
    /// Returns the average of all vertex positions
    #[inline]
    pub fn centroid_f64(&self) -> Point3<f64> {
        if self.is_empty() {
            return Point3::origin();
        }

        let mut sum = Point3::new(0.0f64, 0.0f64, 0.0f64);
        let count = self.positions.len() / 3;

        self.positions.chunks_exact(3).for_each(|chunk| {
            sum.x += chunk[0] as f64;
            sum.y += chunk[1] as f64;
            sum.z += chunk[2] as f64;
        });

        Point3::new(
            sum.x / count as f64,
            sum.y / count as f64,
            sum.z / count as f64,
        )
    }

    /// Clear the mesh
    #[inline]
    pub fn clear(&mut self) {
        self.positions.clear();
        self.normals.clear();
        self.indices.clear();
        self.rtc_applied = false;
    }

    /// Weld coincident vertices, preserving per-vertex normals.
    ///
    /// Returns a new mesh where vertices whose **position AND normal** both
    /// quantize to the same bucket are merged. Indices are remapped.
    /// Triangles that collapse to a degenerate edge or point (any two
    /// corners welded to the same vertex) are dropped.
    ///
    /// **Use this when shading must stay crisp.** A box corner shared by
    /// three faces has the same position but three different normals, so
    /// it stays as three vertices — flat shading and per-face colours
    /// survive the weld.
    ///
    /// `position_eps` and `normal_eps` are bucket sizes (in metres and
    /// normal-vector units respectively). 1 µm position / 1 mrad normal is
    /// usually right for IFC geometry: well below any meaningful BIM
    /// tolerance and below f32 precision at typical building scales.
    ///
    /// For watertight output that lets you compute volumes or run CSG,
    /// use [`Mesh::welded_by_position`] instead — it merges all vertices
    /// at the same position regardless of normal.
    pub fn welded(&self, position_eps: f32, normal_eps: f32) -> Mesh {
        weld_impl(self, position_eps, Some(normal_eps), /*average_normals=*/ false)
    }

    /// Weld vertices that share a position, regardless of normal.
    ///
    /// Returns a new mesh where vertices at the same position (within
    /// `position_eps`) collapse to one canonical vertex; the welded
    /// vertex's normal is the sum of contributing normals, re-normalized
    /// (or the first contributing normal if the sum is degenerate).
    /// Triangles that collapse to a degenerate edge or point are dropped.
    ///
    /// **Use this when you need a topologically connected, manifold-
    /// candidate mesh** — volume queries, CSG operands, watertight
    /// checks, mesh repair pipelines. Shading at sharp corners gets
    /// averaged; if you need crisp corners use [`Mesh::welded`] instead.
    ///
    /// `position_eps` is the bucket size in metres (1 µm is a safe
    /// default for IFC).
    pub fn welded_by_position(&self, position_eps: f32) -> Mesh {
        weld_impl(self, position_eps, None, /*average_normals=*/ true)
    }

    /// Filter out triangles with edges exceeding the threshold
    /// This removes "stretched" triangles that span unreasonably large distances,
    /// which can occur when disconnected geometry is incorrectly merged.
    ///
    /// Uses a conservative threshold (500m) to only catch clearly broken geometry,
    /// not legitimate large elements like long beams or walls.
    ///
    /// # Arguments
    /// * `max_edge_length` - Maximum allowed edge length in meters (default: 500m)
    ///
    /// # Returns
    /// Number of triangles removed
    pub fn filter_stretched_triangles(&mut self, max_edge_length: f32) -> usize {
        if self.is_empty() {
            return 0;
        }

        let max_edge_sq = max_edge_length * max_edge_length;
        let mut valid_indices = Vec::new();
        let mut removed_count = 0;

        // Check each triangle
        for i in (0..self.indices.len()).step_by(3) {
            if i + 2 >= self.indices.len() {
                break;
            }
            let i0 = self.indices[i] as usize;
            let i1 = self.indices[i + 1] as usize;
            let i2 = self.indices[i + 2] as usize;

            if i0 * 3 + 2 >= self.positions.len()
                || i1 * 3 + 2 >= self.positions.len()
                || i2 * 3 + 2 >= self.positions.len()
            {
                // Invalid indices - skip
                removed_count += 1;
                continue;
            }

            let p0 = (
                self.positions[i0 * 3],
                self.positions[i0 * 3 + 1],
                self.positions[i0 * 3 + 2],
            );
            let p1 = (
                self.positions[i1 * 3],
                self.positions[i1 * 3 + 1],
                self.positions[i1 * 3 + 2],
            );
            let p2 = (
                self.positions[i2 * 3],
                self.positions[i2 * 3 + 1],
                self.positions[i2 * 3 + 2],
            );

            // Calculate squared edge lengths
            let edge01_sq = (p1.0 - p0.0).powi(2) + (p1.1 - p0.1).powi(2) + (p1.2 - p0.2).powi(2);
            let edge12_sq = (p2.0 - p1.0).powi(2) + (p2.1 - p1.1).powi(2) + (p2.2 - p1.2).powi(2);
            let edge20_sq = (p0.0 - p2.0).powi(2) + (p0.1 - p2.1).powi(2) + (p0.2 - p2.2).powi(2);

            // Check if any edge exceeds threshold
            if edge01_sq <= max_edge_sq && edge12_sq <= max_edge_sq && edge20_sq <= max_edge_sq {
                // Triangle is valid - keep it
                valid_indices.push(self.indices[i]);
                valid_indices.push(self.indices[i + 1]);
                valid_indices.push(self.indices[i + 2]);
            } else {
                // Triangle has stretched edge - remove it
                removed_count += 1;
            }
        }

        self.indices = valid_indices;
        removed_count
    }
}

impl Default for Mesh {
    fn default() -> Self {
        Self::new()
    }
}

/// Shared welding implementation backing `Mesh::welded` and
/// `Mesh::welded_by_position`.
///
/// When `normal_eps` is `Some(eps)`, the dedupe key is
/// `(quantized_position, quantized_normal)` and `average_normals` is
/// ignored — the first encountered (position, normal) pair wins. When
/// `normal_eps` is `None`, the dedupe key is `quantized_position` only;
/// `average_normals=true` accumulates contributing normals into the
/// welded vertex and renormalizes at the end.
fn weld_impl(
    mesh: &Mesh,
    position_eps: f32,
    normal_eps: Option<f32>,
    average_normals: bool,
) -> Mesh {
    use rustc_hash::FxHashMap;

    let n_verts = mesh.positions.len() / 3;
    if n_verts == 0 {
        return Mesh::new();
    }

    let has_normals = mesh.normals.len() == mesh.positions.len();
    let pos_scale = 1.0 / position_eps.max(f32::MIN_POSITIVE);
    let q_pos = |v: f32| -> i64 { (v * pos_scale).round() as i64 };

    let nrm_scale = normal_eps.map(|e| 1.0 / e.max(f32::MIN_POSITIVE));
    let q_nrm = |v: f32| -> i64 {
        nrm_scale
            .map(|s| (v * s).round() as i64)
            .unwrap_or(0)
    };

    // Dedupe key. Pre-allocate to size 6 (pos + normal) — using a tuple
    // would require two distinct hash types; a small array keeps a single
    // hash map specialisation.
    type Key = [i64; 6];
    let mut canonical: FxHashMap<Key, u32> = FxHashMap::default();
    let mut old_to_new: Vec<u32> = Vec::with_capacity(n_verts);
    let mut new_positions: Vec<f32> = Vec::with_capacity(n_verts * 3);
    let mut new_normals: Vec<f32> = Vec::with_capacity(n_verts * 3);
    // For the average-normals path, accumulate the un-normalized sum so
    // a final pass can normalize. The sum buffer is parallel to
    // `new_positions` chunks.
    let mut normal_accum: Vec<(f64, f64, f64)> = Vec::new();
    if average_normals {
        normal_accum.reserve(n_verts);
    }

    for i in 0..n_verts {
        let px = mesh.positions[i * 3];
        let py = mesh.positions[i * 3 + 1];
        let pz = mesh.positions[i * 3 + 2];
        let (nx, ny, nz) = if has_normals {
            (
                mesh.normals[i * 3],
                mesh.normals[i * 3 + 1],
                mesh.normals[i * 3 + 2],
            )
        } else {
            (0.0, 0.0, 0.0)
        };
        let key: Key = [
            q_pos(px),
            q_pos(py),
            q_pos(pz),
            q_nrm(nx),
            q_nrm(ny),
            q_nrm(nz),
        ];

        if let Some(&new_idx) = canonical.get(&key) {
            old_to_new.push(new_idx);
            if average_normals {
                let slot = &mut normal_accum[new_idx as usize];
                slot.0 += nx as f64;
                slot.1 += ny as f64;
                slot.2 += nz as f64;
            }
        } else {
            let new_idx = (new_positions.len() / 3) as u32;
            canonical.insert(key, new_idx);
            old_to_new.push(new_idx);
            new_positions.push(px);
            new_positions.push(py);
            new_positions.push(pz);
            if has_normals {
                new_normals.push(nx);
                new_normals.push(ny);
                new_normals.push(nz);
            }
            if average_normals {
                normal_accum.push((nx as f64, ny as f64, nz as f64));
            }
        }
    }

    // For average-normals path: normalize the accumulated sums and
    // write them back over the first-vertex-wins values stored above.
    if average_normals && has_normals {
        new_normals.clear();
        new_normals.reserve(normal_accum.len() * 3);
        for (sx, sy, sz) in &normal_accum {
            let len_sq = sx * sx + sy * sy + sz * sz;
            if len_sq > 1e-24 {
                let inv = 1.0 / len_sq.sqrt();
                new_normals.push((*sx * inv) as f32);
                new_normals.push((*sy * inv) as f32);
                new_normals.push((*sz * inv) as f32);
            } else {
                // Degenerate accumulation (opposing normals cancelled);
                // fall back to a neutral up-Z so consumers don't see NaN.
                new_normals.push(0.0);
                new_normals.push(0.0);
                new_normals.push(1.0);
            }
        }
    }

    // Re-index triangles, dropping degenerates and out-of-bound input
    // triangles the same way `validate_indices` does so a malformed
    // input mesh weld-then-renders fine instead of panicking later.
    let mut new_indices: Vec<u32> = Vec::with_capacity(mesh.indices.len());
    for chunk in mesh.indices.chunks_exact(3) {
        let i0_raw = chunk[0] as usize;
        let i1_raw = chunk[1] as usize;
        let i2_raw = chunk[2] as usize;
        if i0_raw >= n_verts || i1_raw >= n_verts || i2_raw >= n_verts {
            continue;
        }
        let i0 = old_to_new[i0_raw];
        let i1 = old_to_new[i1_raw];
        let i2 = old_to_new[i2_raw];
        if i0 == i1 || i1 == i2 || i0 == i2 {
            continue;
        }
        new_indices.push(i0);
        new_indices.push(i1);
        new_indices.push(i2);
    }

    Mesh {
        positions: new_positions,
        normals: new_normals,
        indices: new_indices,
        rtc_applied: mesh.rtc_applied,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mesh_creation() {
        let mesh = Mesh::new();
        assert!(mesh.is_empty());
        assert_eq!(mesh.vertex_count(), 0);
        assert_eq!(mesh.triangle_count(), 0);
    }

    #[test]
    fn test_add_vertex() {
        let mut mesh = Mesh::new();
        mesh.add_vertex(Point3::new(1.0, 2.0, 3.0), Vector3::new(0.0, 0.0, 1.0));
        assert_eq!(mesh.vertex_count(), 1);
        assert_eq!(mesh.positions, vec![1.0, 2.0, 3.0]);
        assert_eq!(mesh.normals, vec![0.0, 0.0, 1.0]);
    }

    #[test]
    fn test_merge() {
        let mut mesh1 = Mesh::new();
        mesh1.add_vertex(Point3::new(0.0, 0.0, 0.0), Vector3::z());
        mesh1.add_triangle(0, 1, 2);

        let mut mesh2 = Mesh::new();
        mesh2.add_vertex(Point3::new(1.0, 1.0, 1.0), Vector3::y());
        mesh2.add_triangle(0, 1, 2);

        mesh1.merge(&mesh2);
        assert_eq!(mesh1.vertex_count(), 2);
        assert_eq!(mesh1.triangle_count(), 2);
    }

    #[test]
    fn test_coordinate_shift_creation() {
        let shift = CoordinateShift::new(500000.0, 5000000.0, 100.0);
        assert!(shift.is_significant());
        assert!(!shift.is_zero());

        let zero_shift = CoordinateShift::default();
        assert!(!zero_shift.is_significant());
        assert!(zero_shift.is_zero());
    }

    #[test]
    fn test_add_vertex_with_shift_preserves_precision() {
        // Test case: Swiss UTM coordinates (typical large coordinate scenario)
        // Without shifting: 5000000.123 as f32 = 5000000.0 (loses 0.123m precision!)
        // With shifting: (5000000.123 - 5000000.0) as f32 = 0.123 (full precision preserved)

        let mut mesh = Mesh::new();

        // Large coordinates typical of Swiss UTM (EPSG:2056)
        let p1 = Point3::new(2679012.123456, 1247892.654321, 432.111);
        let p2 = Point3::new(2679012.223456, 1247892.754321, 432.211);

        // Create shift from approximate centroid
        let shift = CoordinateShift::new(2679012.0, 1247892.0, 432.0);

        mesh.add_vertex_with_shift(p1, Vector3::z(), &shift);
        mesh.add_vertex_with_shift(p2, Vector3::z(), &shift);

        // Verify shifted positions have sub-millimeter precision
        // p1 shifted: (0.123456, 0.654321, 0.111)
        // p2 shifted: (0.223456, 0.754321, 0.211)
        assert!((mesh.positions[0] - 0.123456).abs() < 0.0001); // X1
        assert!((mesh.positions[1] - 0.654321).abs() < 0.0001); // Y1
        assert!((mesh.positions[2] - 0.111).abs() < 0.0001); // Z1
        assert!((mesh.positions[3] - 0.223456).abs() < 0.0001); // X2
        assert!((mesh.positions[4] - 0.754321).abs() < 0.0001); // Y2
        assert!((mesh.positions[5] - 0.211).abs() < 0.0001); // Z2

        // Verify relative distances are preserved with high precision
        let dx = mesh.positions[3] - mesh.positions[0];
        let dy = mesh.positions[4] - mesh.positions[1];
        let dz = mesh.positions[5] - mesh.positions[2];

        // Expected: dx=0.1, dy=0.1, dz=0.1
        assert!((dx - 0.1).abs() < 0.0001);
        assert!((dy - 0.1).abs() < 0.0001);
        assert!((dz - 0.1).abs() < 0.0001);
    }

    #[test]
    fn test_apply_shift_to_existing_mesh() {
        let mut mesh = Mesh::new();

        // Add vertices with large coordinates (already converted to f32 - some precision lost)
        mesh.positions = vec![500000.0, 5000000.0, 0.0, 500010.0, 5000010.0, 10.0];
        mesh.normals = vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0];

        // Apply shift
        let shift = CoordinateShift::new(500000.0, 5000000.0, 0.0);
        mesh.apply_shift(&shift);

        // Verify positions are shifted
        assert!((mesh.positions[0] - 0.0).abs() < 0.001);
        assert!((mesh.positions[1] - 0.0).abs() < 0.001);
        assert!((mesh.positions[3] - 10.0).abs() < 0.001);
        assert!((mesh.positions[4] - 10.0).abs() < 0.001);
    }

    #[test]
    fn test_centroid_f64() {
        let mut mesh = Mesh::new();
        mesh.positions = vec![0.0, 0.0, 0.0, 10.0, 10.0, 10.0, 20.0, 20.0, 20.0];
        mesh.normals = vec![0.0; 9];

        let centroid = mesh.centroid_f64();
        assert!((centroid.x - 10.0).abs() < 0.001);
        assert!((centroid.y - 10.0).abs() < 0.001);
        assert!((centroid.z - 10.0).abs() < 0.001);
    }

    #[test]
    fn test_precision_comparison_shifted_vs_unshifted() {
        // This test quantifies the precision improvement from shifting
        // Using Swiss UTM coordinates as example

        // Two points that are exactly 0.001m (1mm) apart
        let base_x = 2679012.0;
        let base_y = 1247892.0;
        let offset = 0.001; // 1mm

        let p1 = Point3::new(base_x, base_y, 0.0);
        let p2 = Point3::new(base_x + offset, base_y, 0.0);

        // Without shift - convert directly to f32
        let p1_f32_direct = (p1.x as f32, p1.y as f32);
        let p2_f32_direct = (p2.x as f32, p2.y as f32);
        let diff_direct = p2_f32_direct.0 - p1_f32_direct.0;

        // With shift - subtract centroid first, then convert
        let shift = CoordinateShift::new(base_x, base_y, 0.0);
        let p1_shifted = ((p1.x - shift.x) as f32, (p1.y - shift.y) as f32);
        let p2_shifted = ((p2.x - shift.x) as f32, (p2.y - shift.y) as f32);
        let diff_shifted = p2_shifted.0 - p1_shifted.0;

        println!("Direct f32 difference (should be ~0.001): {}", diff_direct);
        println!(
            "Shifted f32 difference (should be ~0.001): {}",
            diff_shifted
        );

        // The shifted version should be much closer to the true 1mm difference
        let error_direct = (diff_direct - offset as f32).abs();
        let error_shifted = (diff_shifted - offset as f32).abs();

        println!("Error without shift: {}m", error_direct);
        println!("Error with shift: {}m", error_shifted);

        // The shifted version should have significantly less error
        // (At least 100x better precision for typical Swiss coordinates)
        assert!(
            error_shifted < error_direct || error_shifted < 0.0001,
            "Shifted precision should be better than direct conversion"
        );
    }

    #[test]
    fn test_validate_indices_strips_out_of_bounds() {
        let mut mesh = Mesh {
            positions: vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0], // 3 vertices
            normals: vec![],
            indices: vec![
                0, 1, 2, // valid
                0, 1, 5, // invalid: vertex 5 out of bounds
                3, 4, 5, // invalid: all out of bounds
            ],
            rtc_applied: false,
        };
        mesh.validate_indices();
        assert_eq!(mesh.indices, vec![0, 1, 2]);
    }

    #[test]
    fn test_validate_indices_empty_positions() {
        let mut mesh = Mesh {
            positions: vec![],
            normals: vec![],
            indices: vec![0, 1, 2],
            rtc_applied: false,
        };
        mesh.validate_indices();
        assert!(mesh.indices.is_empty());
    }

    #[test]
    fn test_validate_indices_incomplete_triangle() {
        let mut mesh = Mesh {
            positions: vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            normals: vec![],
            indices: vec![0, 1, 2, 0, 1], // trailing incomplete triangle
            rtc_applied: false,
        };
        mesh.validate_indices();
        assert_eq!(mesh.indices, vec![0, 1, 2]);
    }

    fn make_unwelded_box() -> Mesh {
        // A 1×1×1 cube emitted as triangle soup: each face has its own 4
        // vertices (not shared with adjacent faces), so 6 faces × 4 verts
        // = 24 vertices, 12 triangles. This is what the extrusion path
        // produces today.
        let mut m = Mesh::new();
        let corners = [
            (0.0, 0.0, 0.0), (1.0, 0.0, 0.0), (1.0, 1.0, 0.0), (0.0, 1.0, 0.0),
            (0.0, 0.0, 1.0), (1.0, 0.0, 1.0), (1.0, 1.0, 1.0), (0.0, 1.0, 1.0),
        ];
        let faces: [([usize; 4], [f32; 3]); 6] = [
            ([0, 3, 2, 1], [0.0, 0.0, -1.0]), // bottom
            ([4, 5, 6, 7], [0.0, 0.0, 1.0]),  // top
            ([0, 1, 5, 4], [0.0, -1.0, 0.0]), // front
            ([2, 3, 7, 6], [0.0, 1.0, 0.0]),  // back
            ([0, 4, 7, 3], [-1.0, 0.0, 0.0]), // left
            ([1, 2, 6, 5], [1.0, 0.0, 0.0]),  // right
        ];
        for (idx, normal) in faces {
            let base = (m.positions.len() / 3) as u32;
            for &i in idx.iter() {
                let (x, y, z) = corners[i];
                m.positions.extend_from_slice(&[x, y, z]);
                m.normals.extend_from_slice(&normal);
            }
            m.indices.extend_from_slice(&[base, base + 1, base + 2]);
            m.indices.extend_from_slice(&[base, base + 2, base + 3]);
        }
        m
    }

    #[test]
    fn welded_preserves_corner_normals() {
        let m = make_unwelded_box();
        assert_eq!(m.vertex_count(), 24);
        assert_eq!(m.triangle_count(), 12);
        // With normal-preserving weld, each box corner has 3 incident
        // faces with 3 different normals, so each corner stays as 3
        // separate vertices. 6 faces × 4 vertices = 24 → 24 (no merge,
        // because no two of the 24 input vertices share BOTH position
        // and normal).
        let welded = m.welded(1e-6, 1e-3);
        assert_eq!(
            welded.vertex_count(),
            24,
            "normal-preserving weld must keep all per-face corner vertices"
        );
        assert_eq!(welded.triangle_count(), 12);
    }

    #[test]
    fn welded_by_position_collapses_corner_to_one_vertex() {
        let m = make_unwelded_box();
        // Position-only weld: all 24 input vertices map to the 8 box
        // corners. 8 vertices, 12 triangles (no degenerates since a
        // 1×1×1 box's corner-only mesh is non-degenerate).
        let welded = m.welded_by_position(1e-6);
        assert_eq!(
            welded.vertex_count(),
            8,
            "position-only weld must collapse 24 face-corner duplicates to 8 box corners"
        );
        assert_eq!(welded.triangle_count(), 12);
        // Averaged normal at each corner must be unit length (within f32
        // precision); we don't pin a specific direction because three
        // faces' normals sum to a face-diagonal direction.
        for chunk in welded.normals.chunks_exact(3) {
            let len_sq = chunk[0] * chunk[0] + chunk[1] * chunk[1] + chunk[2] * chunk[2];
            assert!(
                (len_sq - 1.0).abs() < 1e-4,
                "welded normal must be unit length, got |n|^2 = {}",
                len_sq
            );
        }
    }

    #[test]
    fn welded_drops_degenerate_triangles() {
        // A triangle whose three vertices all quantize to the same
        // position should be dropped after welding (it collapsed to a
        // point).
        let mut m = Mesh::new();
        m.positions = vec![
            0.0, 0.0, 0.0,
            // Two more "vertices" within position_eps of vertex 0:
            5e-8, 0.0, 0.0,
            0.0, 5e-8, 0.0,
            // A real non-degenerate triangle:
            1.0, 0.0, 0.0,
            1.0, 1.0, 0.0,
        ];
        m.normals = vec![
            0.0, 0.0, 1.0,
            0.0, 0.0, 1.0,
            0.0, 0.0, 1.0,
            0.0, 0.0, 1.0,
            0.0, 0.0, 1.0,
        ];
        m.indices = vec![
            0, 1, 2,   // collapses to a point after weld at eps=1e-6
            0, 3, 4,   // survives
        ];
        let welded = m.welded_by_position(1e-6);
        assert_eq!(welded.triangle_count(), 1);
    }

    #[test]
    fn welded_handles_empty_mesh() {
        let m = Mesh::new();
        let welded = m.welded(1e-6, 1e-3);
        assert!(welded.is_empty());
        let welded_pos = m.welded_by_position(1e-6);
        assert!(welded_pos.is_empty());
    }

    #[test]
    fn welded_strips_out_of_bound_indices() {
        let mut m = Mesh::new();
        m.positions = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
        m.normals = vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0];
        m.indices = vec![0, 1, 2, 0, 1, 99];
        let welded = m.welded_by_position(1e-6);
        assert_eq!(welded.triangle_count(), 1);
    }

    #[test]
    fn test_validate_indices_all_valid() {
        let mut mesh = Mesh {
            positions: vec![0.0; 12], // 4 vertices
            normals: vec![],
            indices: vec![0, 1, 2, 1, 2, 3],
            rtc_applied: false,
        };
        mesh.validate_indices();
        assert_eq!(mesh.indices, vec![0, 1, 2, 1, 2, 3]);
    }
}
