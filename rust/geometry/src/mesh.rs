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
