// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Void Analysis Module
//!
//! Analyzes void geometry to determine optimal processing strategy:
//! - Coplanar voids can be subtracted in 2D at the profile level
//! - Non-planar voids require full 3D CSG operations
//!
//! This module implements the detection and projection logic needed to
//! efficiently route voids to the appropriate processing path.

use crate::bool2d::{ensure_ccw, is_valid_contour};
use crate::mesh::Mesh;
use crate::profile::VoidInfo;
use nalgebra::{Matrix4, Point2, Point3, Vector3};
use rustc_hash::FxHashMap;

/// Default epsilon for planarity detection
const DEFAULT_PLANARITY_EPSILON: f64 = 0.02;

/// Maximum depth tolerance for considering a void as "through"
const THROUGH_VOID_TOLERANCE: f64 = 0.01;

/// Classification of a void relative to a host extrusion
#[derive(Debug, Clone)]
pub enum VoidClassification {
    /// Void is coplanar with the profile plane and can be subtracted in 2D
    Coplanar {
        /// The 2D footprint of the void in profile space
        profile_hole: Vec<Point2<f64>>,
        /// Start depth in extrusion space (0.0 = bottom cap)
        depth_start: f64,
        /// End depth in extrusion space
        depth_end: f64,
        /// Whether the void extends through the full depth
        is_through: bool,
    },
    /// Void is at an angle to the extrusion direction - requires 3D CSG
    NonPlanar {
        /// The void mesh for 3D CSG subtraction
        mesh: Mesh,
    },
    /// Void doesn't intersect the host geometry - can be skipped
    NonIntersecting,
}

/// Analyzer for void geometry classification
pub struct VoidAnalyzer {
    /// Epsilon for planarity detection (dot product threshold)
    planarity_epsilon: f64,
    /// Whether to use adaptive epsilon refinement
    adaptive_epsilon: bool,
}

impl VoidAnalyzer {
    /// Create a new void analyzer with default settings
    pub fn new() -> Self {
        Self {
            planarity_epsilon: DEFAULT_PLANARITY_EPSILON,
            adaptive_epsilon: true,
        }
    }

    /// Create a void analyzer with custom planarity epsilon
    pub fn with_epsilon(epsilon: f64) -> Self {
        Self {
            planarity_epsilon: epsilon,
            adaptive_epsilon: false,
        }
    }

    /// Classify a void relative to host extrusion parameters
    ///
    /// # Arguments
    /// * `void_mesh` - The mesh geometry of the void/opening
    /// * `profile_transform` - Transform from profile space to world space
    /// * `extrusion_direction` - Direction of extrusion (normalized)
    /// * `extrusion_depth` - Total depth of extrusion
    ///
    /// # Returns
    /// Classification indicating how the void should be processed
    pub fn classify_void(
        &self,
        void_mesh: &Mesh,
        profile_transform: &Matrix4<f64>,
        extrusion_direction: &Vector3<f64>,
        extrusion_depth: f64,
    ) -> VoidClassification {
        if void_mesh.is_empty() {
            return VoidClassification::NonIntersecting;
        }

        // Get profile plane normal (Z-axis in profile space transformed to world)
        let profile_normal = transform_direction(profile_transform, &Vector3::new(0.0, 0.0, 1.0));

        // Check if void is coplanar with profile plane
        let is_coplanar = self.check_coplanarity(void_mesh, &profile_normal, extrusion_direction);

        if !is_coplanar {
            return VoidClassification::NonPlanar {
                mesh: void_mesh.clone(),
            };
        }

        // Extract 2D footprint
        let inverse_transform = match profile_transform.try_inverse() {
            Some(inv) => inv,
            None => {
                return VoidClassification::NonPlanar {
                    mesh: void_mesh.clone(),
                }
            }
        };

        match self.extract_footprint(void_mesh, &inverse_transform, extrusion_direction) {
            Some((footprint, depth_start, depth_end)) => {
                // Check if footprint is valid
                if !is_valid_contour(&footprint) {
                    return VoidClassification::NonPlanar {
                        mesh: void_mesh.clone(),
                    };
                }

                // Check if it's a through void
                let is_through = depth_start <= THROUGH_VOID_TOLERANCE
                    && depth_end >= extrusion_depth - THROUGH_VOID_TOLERANCE;

                VoidClassification::Coplanar {
                    profile_hole: footprint,
                    depth_start,
                    depth_end,
                    is_through,
                }
            }
            None => VoidClassification::NonPlanar {
                mesh: void_mesh.clone(),
            },
        }
    }

    /// Check if void geometry is coplanar with the profile plane
    fn check_coplanarity(
        &self,
        void_mesh: &Mesh,
        profile_normal: &Vector3<f64>,
        extrusion_direction: &Vector3<f64>,
    ) -> bool {
        // Get dominant faces of the void mesh
        let face_normals = self.extract_face_normals(void_mesh);

        if face_normals.is_empty() {
            return false;
        }

        // A void is coplanar if its dominant face normals are either:
        // 1. Parallel to the profile normal (top/bottom faces of void)
        // 2. Perpendicular to the extrusion direction (side faces)

        let mut has_parallel_face = false;
        let mut epsilon = self.planarity_epsilon;

        // Adaptive epsilon: try progressively smaller values
        let epsilons = if self.adaptive_epsilon {
            vec![0.02, 0.01, 0.005, 0.001]
        } else {
            vec![epsilon]
        };

        for eps in epsilons {
            epsilon = eps;
            has_parallel_face = false;

            for normal in &face_normals {
                let dot_profile = normal.dot(profile_normal).abs();
                let dot_extrusion = normal.dot(extrusion_direction).abs();

                // Face is parallel to profile plane (top/bottom of void)
                if dot_profile > 1.0 - epsilon {
                    has_parallel_face = true;
                    break;
                }

                // Face is perpendicular to extrusion (side of void, parallel to extrusion)
                if dot_extrusion < epsilon {
                    has_parallel_face = true;
                    break;
                }
            }

            if has_parallel_face {
                break;
            }
        }

        has_parallel_face
    }

    /// Extract face normals from mesh, grouped by direction
    fn extract_face_normals(&self, mesh: &Mesh) -> Vec<Vector3<f64>> {
        let mut normal_groups: FxHashMap<(i32, i32, i32), (Vector3<f64>, usize)> =
            FxHashMap::default();

        let quantize_normal = |n: &Vector3<f64>| -> (i32, i32, i32) {
            (
                (n.x * 100.0).round() as i32,
                (n.y * 100.0).round() as i32,
                (n.z * 100.0).round() as i32,
            )
        };

        for i in (0..mesh.indices.len()).step_by(3) {
            let i0 = mesh.indices[i] as usize;
            let i1 = mesh.indices[i + 1] as usize;
            let i2 = mesh.indices[i + 2] as usize;

            if i0 * 3 + 2 >= mesh.positions.len()
                || i1 * 3 + 2 >= mesh.positions.len()
                || i2 * 3 + 2 >= mesh.positions.len()
            {
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

            let edge1 = v1 - v0;
            let edge2 = v2 - v0;
            let normal = match edge1.cross(&edge2).try_normalize(1e-10) {
                Some(n) => n,
                None => continue,
            };

            let key = quantize_normal(&normal);
            normal_groups
                .entry(key)
                .and_modify(|(sum, count)| {
                    *sum += normal;
                    *count += 1;
                })
                .or_insert((normal, 1));
        }

        // Return normalized group averages
        normal_groups
            .values()
            .filter_map(|(sum, count)| {
                if *count > 0 {
                    (sum / *count as f64).try_normalize(1e-10)
                } else {
                    None
                }
            })
            .collect()
    }

    /// Extract 2D footprint from void mesh
    ///
    /// Projects the void mesh onto the profile plane and extracts the
    /// boundary contour.
    fn extract_footprint(
        &self,
        void_mesh: &Mesh,
        inverse_profile_transform: &Matrix4<f64>,
        _extrusion_direction: &Vector3<f64>,
    ) -> Option<(Vec<Point2<f64>>, f64, f64)> {
        if void_mesh.is_empty() {
            return None;
        }

        // Transform all vertices to profile space
        let mut min_z = f64::MAX;
        let mut max_z = f64::MIN;
        let mut projected_points: Vec<Point2<f64>> = Vec::new();

        for i in (0..void_mesh.positions.len()).step_by(3) {
            let world_point = Point3::new(
                void_mesh.positions[i] as f64,
                void_mesh.positions[i + 1] as f64,
                void_mesh.positions[i + 2] as f64,
            );

            // Transform to profile space
            let profile_point = inverse_profile_transform.transform_point(&world_point);

            // Track Z range for depth
            min_z = min_z.min(profile_point.z);
            max_z = max_z.max(profile_point.z);

            // Project to 2D (XY plane in profile space)
            projected_points.push(Point2::new(profile_point.x, profile_point.y));
        }

        if projected_points.len() < 3 {
            return None;
        }

        // Extract convex hull or boundary of projected points
        let hull = self.compute_convex_hull(&projected_points);

        if hull.len() < 3 {
            return None;
        }

        // Ensure counter-clockwise winding
        let footprint = ensure_ccw(&hull);

        // Clamp depth values
        let depth_start = min_z.max(0.0);
        let depth_end = max_z;

        Some((footprint, depth_start, depth_end))
    }

    /// Compute convex hull of 2D points using Graham scan
    fn compute_convex_hull(&self, points: &[Point2<f64>]) -> Vec<Point2<f64>> {
        if points.len() < 3 {
            return points.to_vec();
        }

        // Find bottom-most point (lowest Y, then leftmost X)
        let mut start_idx = 0;
        for (i, p) in points.iter().enumerate() {
            if p.y < points[start_idx].y
                || (p.y == points[start_idx].y && p.x < points[start_idx].x)
            {
                start_idx = i;
            }
        }

        let start = points[start_idx];

        // Sort points by polar angle with respect to start
        let mut sorted: Vec<Point2<f64>> =
            points.iter().filter(|p| **p != start).cloned().collect();

        sorted.sort_by(|a, b| {
            let angle_a = (a.y - start.y).atan2(a.x - start.x);
            let angle_b = (b.y - start.y).atan2(b.x - start.x);
            angle_a.total_cmp(&angle_b)
        });

        // Graham scan
        let mut hull = vec![start];

        for p in sorted {
            while hull.len() > 1 {
                let top = hull[hull.len() - 1];
                let second = hull[hull.len() - 2];

                // Cross product to check turn direction
                let cross =
                    (top.x - second.x) * (p.y - second.y) - (top.y - second.y) * (p.x - second.x);

                if cross <= 0.0 {
                    hull.pop();
                } else {
                    break;
                }
            }
            hull.push(p);
        }

        hull
    }

    /// Compute depth range of void in extrusion space
    pub fn compute_depth_range(
        &self,
        void_mesh: &Mesh,
        profile_origin: &Point3<f64>,
        extrusion_direction: &Vector3<f64>,
    ) -> (f64, f64) {
        if void_mesh.is_empty() {
            return (0.0, 0.0);
        }

        let mut min_depth = f64::MAX;
        let mut max_depth = f64::MIN;

        for i in (0..void_mesh.positions.len()).step_by(3) {
            let point = Point3::new(
                void_mesh.positions[i] as f64,
                void_mesh.positions[i + 1] as f64,
                void_mesh.positions[i + 2] as f64,
            );

            // Project onto extrusion direction
            let relative = point - profile_origin;
            let depth = relative.dot(extrusion_direction);

            min_depth = min_depth.min(depth);
            max_depth = max_depth.max(depth);
        }

        (min_depth.max(0.0), max_depth)
    }
}

impl Default for VoidAnalyzer {
    fn default() -> Self {
        Self::new()
    }
}

/// Transform a direction vector (ignoring translation)
fn transform_direction(transform: &Matrix4<f64>, direction: &Vector3<f64>) -> Vector3<f64> {
    let transformed = transform.transform_vector(direction);
    transformed.normalize()
}

/// Batch classify multiple voids for a single host
pub fn classify_voids_batch(
    void_meshes: &[Mesh],
    profile_transform: &Matrix4<f64>,
    extrusion_direction: &Vector3<f64>,
    extrusion_depth: f64,
) -> Vec<VoidClassification> {
    let analyzer = VoidAnalyzer::new();

    void_meshes
        .iter()
        .map(|mesh| {
            analyzer.classify_void(
                mesh,
                profile_transform,
                extrusion_direction,
                extrusion_depth,
            )
        })
        .collect()
}

/// Extract coplanar voids from a batch classification result
pub fn extract_coplanar_voids(classifications: &[VoidClassification]) -> Vec<VoidInfo> {
    classifications
        .iter()
        .filter_map(|c| match c {
            VoidClassification::Coplanar {
                profile_hole,
                depth_start,
                depth_end,
                is_through,
            } => Some(VoidInfo {
                contour: profile_hole.clone(),
                depth_start: *depth_start,
                depth_end: *depth_end,
                is_through: *is_through,
            }),
            _ => None,
        })
        .collect()
}

/// Extract non-planar void meshes from a batch classification result
pub fn extract_nonplanar_voids(classifications: Vec<VoidClassification>) -> Vec<Mesh> {
    classifications
        .into_iter()
        .filter_map(|c| match c {
            VoidClassification::NonPlanar { mesh } => Some(mesh),
            _ => None,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use nalgebra::{Rotation3, Unit};

    /// Same box topology as `create_box_mesh`, but every vertex is rotated by
    /// `rotation` about the origin before being added. Used to build voids
    /// whose faces are angled with respect to the profile/extrusion axes.
    fn create_rotated_box_mesh(min: Point3<f64>, max: Point3<f64>, rotation: &Matrix4<f64>) -> Mesh {
        let mut mesh = Mesh::with_capacity(8, 36);

        let vertices = [
            Point3::new(min.x, min.y, min.z),
            Point3::new(max.x, min.y, min.z),
            Point3::new(max.x, max.y, min.z),
            Point3::new(min.x, max.y, min.z),
            Point3::new(min.x, min.y, max.z),
            Point3::new(max.x, min.y, max.z),
            Point3::new(max.x, max.y, max.z),
            Point3::new(min.x, max.y, max.z),
        ];

        for v in &vertices {
            let rotated = rotation.transform_point(v);
            mesh.add_vertex(rotated, Vector3::new(0.0, 0.0, 1.0));
        }

        // Same triangle topology as create_box_mesh
        mesh.add_triangle(0, 1, 2);
        mesh.add_triangle(0, 2, 3);
        mesh.add_triangle(4, 6, 5);
        mesh.add_triangle(4, 7, 6);
        mesh.add_triangle(0, 3, 7);
        mesh.add_triangle(0, 7, 4);
        mesh.add_triangle(1, 5, 6);
        mesh.add_triangle(1, 6, 2);
        mesh.add_triangle(0, 4, 5);
        mesh.add_triangle(0, 5, 1);
        mesh.add_triangle(3, 2, 6);
        mesh.add_triangle(3, 6, 7);

        mesh
    }

    fn create_box_mesh(min: Point3<f64>, max: Point3<f64>) -> Mesh {
        let mut mesh = Mesh::with_capacity(8, 36);

        // 8 vertices of a box
        let vertices = [
            Point3::new(min.x, min.y, min.z),
            Point3::new(max.x, min.y, min.z),
            Point3::new(max.x, max.y, min.z),
            Point3::new(min.x, max.y, min.z),
            Point3::new(min.x, min.y, max.z),
            Point3::new(max.x, min.y, max.z),
            Point3::new(max.x, max.y, max.z),
            Point3::new(min.x, max.y, max.z),
        ];

        // Add all vertices with dummy normals
        for v in &vertices {
            mesh.add_vertex(*v, Vector3::new(0.0, 0.0, 1.0));
        }

        // 12 triangles (2 per face)
        // Front face
        mesh.add_triangle(0, 1, 2);
        mesh.add_triangle(0, 2, 3);
        // Back face
        mesh.add_triangle(4, 6, 5);
        mesh.add_triangle(4, 7, 6);
        // Left face
        mesh.add_triangle(0, 3, 7);
        mesh.add_triangle(0, 7, 4);
        // Right face
        mesh.add_triangle(1, 5, 6);
        mesh.add_triangle(1, 6, 2);
        // Bottom face
        mesh.add_triangle(0, 4, 5);
        mesh.add_triangle(0, 5, 1);
        // Top face
        mesh.add_triangle(3, 2, 6);
        mesh.add_triangle(3, 6, 7);

        mesh
    }

    #[test]
    fn test_void_analyzer_coplanar() {
        let analyzer = VoidAnalyzer::new();

        // Create a vertical box void (aligned with Z-axis extrusion)
        let void_mesh = create_box_mesh(Point3::new(2.0, 2.0, 0.0), Point3::new(4.0, 4.0, 10.0));

        let profile_transform = Matrix4::identity();
        let extrusion_direction = Vector3::new(0.0, 0.0, 1.0);
        let extrusion_depth = 10.0;

        let classification = analyzer.classify_void(
            &void_mesh,
            &profile_transform,
            &extrusion_direction,
            extrusion_depth,
        );

        match classification {
            VoidClassification::Coplanar { is_through, .. } => {
                assert!(is_through);
            }
            _ => panic!("Expected Coplanar classification"),
        }
    }

    #[test]
    fn test_void_analyzer_partial_depth() {
        let analyzer = VoidAnalyzer::new();

        // Create a box void that only goes halfway through
        let void_mesh = create_box_mesh(Point3::new(2.0, 2.0, 2.0), Point3::new(4.0, 4.0, 8.0));

        let profile_transform = Matrix4::identity();
        let extrusion_direction = Vector3::new(0.0, 0.0, 1.0);
        let extrusion_depth = 10.0;

        let classification = analyzer.classify_void(
            &void_mesh,
            &profile_transform,
            &extrusion_direction,
            extrusion_depth,
        );

        match classification {
            VoidClassification::Coplanar {
                depth_start,
                depth_end,
                is_through,
                ..
            } => {
                assert!(!is_through);
                assert!(depth_start >= 1.9 && depth_start <= 2.1);
                assert!(depth_end >= 7.9 && depth_end <= 8.1);
            }
            _ => panic!("Expected Coplanar classification"),
        }
    }

    #[test]
    fn test_extract_coplanar_voids() {
        let classifications = vec![
            VoidClassification::Coplanar {
                profile_hole: vec![
                    Point2::new(0.0, 0.0),
                    Point2::new(1.0, 0.0),
                    Point2::new(1.0, 1.0),
                    Point2::new(0.0, 1.0),
                ],
                depth_start: 0.0,
                depth_end: 10.0,
                is_through: true,
            },
            VoidClassification::NonPlanar { mesh: Mesh::new() },
            VoidClassification::NonIntersecting,
        ];

        let coplanar = extract_coplanar_voids(&classifications);
        assert_eq!(coplanar.len(), 1);
        assert!(coplanar[0].is_through);
    }

    #[test]
    fn test_compute_convex_hull() {
        let analyzer = VoidAnalyzer::new();

        let points = vec![
            Point2::new(0.0, 0.0),
            Point2::new(1.0, 0.0),
            Point2::new(0.5, 0.5), // Interior point
            Point2::new(1.0, 1.0),
            Point2::new(0.0, 1.0),
        ];

        let hull = analyzer.compute_convex_hull(&points);

        // Hull should have 4 points (excluding interior)
        assert_eq!(hull.len(), 4);
    }

    #[test]
    fn test_void_analyzer_nonplanar_angled_void() {
        // classify_void's NonPlanar branch was previously untested (existing
        // coverage only exercises Coplanar via axis-aligned boxes). Build a
        // void box rotated ~35deg about the (1,1,1) axis, which is skew to
        // both the profile normal and the extrusion direction (both +Z for
        // an identity profile transform). None of the rotated box's 3 pairs
        // of face normals land within the analyzer's adaptive-epsilon band
        // of "parallel to profile plane" (|dot(n, Z)| > 1-eps) or
        // "perpendicular to extrusion" (|dot(n, Z)| < eps) for eps as loose
        // as 0.02, so the void must be routed to 3D CSG.
        let analyzer = VoidAnalyzer::new();

        let angle = 35.0_f64.to_radians();
        let axis = Unit::new_normalize(Vector3::new(1.0, 1.0, 1.0));
        let rotation = Rotation3::from_axis_angle(&axis, angle).to_homogeneous();

        let void_mesh = create_rotated_box_mesh(
            Point3::new(-1.0, -1.0, -1.0),
            Point3::new(1.0, 1.0, 1.0),
            &rotation,
        );

        let profile_transform = Matrix4::identity();
        let extrusion_direction = Vector3::new(0.0, 0.0, 1.0);
        let extrusion_depth = 10.0;

        let classification = analyzer.classify_void(
            &void_mesh,
            &profile_transform,
            &extrusion_direction,
            extrusion_depth,
        );

        match classification {
            VoidClassification::NonPlanar { mesh } => {
                // Routed to 3D CSG with the original void geometry intact.
                assert_eq!(mesh.positions.len(), void_mesh.positions.len());
                assert_eq!(mesh.indices.len(), void_mesh.indices.len());
            }
            VoidClassification::Coplanar { .. } => {
                panic!("angled void was misclassified as Coplanar; expected NonPlanar (3D CSG)")
            }
            VoidClassification::NonIntersecting => {
                panic!("angled void was misclassified as NonIntersecting; expected NonPlanar")
            }
        }
    }
}
