// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! 2D Profile definitions and triangulation

use crate::error::{Error, Result};
use crate::tessellation::TessellationQuality;
use nalgebra::Point2;

/// 2D Profile with optional holes
#[derive(Debug, Clone)]
pub struct Profile2D {
    /// Outer boundary (counter-clockwise)
    pub outer: Vec<Point2<f64>>,
    /// Holes (clockwise)
    pub holes: Vec<Vec<Point2<f64>>>,
}

impl Profile2D {
    /// Create a new profile
    pub fn new(outer: Vec<Point2<f64>>) -> Self {
        Self {
            outer,
            holes: Vec::new(),
        }
    }

    /// Add a hole to the profile
    pub fn add_hole(&mut self, hole: Vec<Point2<f64>>) {
        self.holes.push(hole);
    }

    /// Translate the profile so the centre of its outer bounding box sits at the
    /// origin.
    ///
    /// IFC parameterised profiles (I/U/L/T/C/Z/…) are defined centred on their
    /// bounding box, and the swept-area `Position` placement is applied relative
    /// to that centred origin. Some per-shape builders are easier to read when
    /// written from a corner; centring them here in one place keeps every
    /// parametric profile consistent with the spec. Holes are shifted by the same
    /// offset so they stay aligned with the outer boundary. No-op for profiles
    /// that are already centred.
    pub fn center_on_bbox(&mut self) {
        if self.outer.is_empty() {
            return;
        }
        let mut min_x = f64::INFINITY;
        let mut min_y = f64::INFINITY;
        let mut max_x = f64::NEG_INFINITY;
        let mut max_y = f64::NEG_INFINITY;
        for p in &self.outer {
            min_x = min_x.min(p.x);
            min_y = min_y.min(p.y);
            max_x = max_x.max(p.x);
            max_y = max_y.max(p.y);
        }
        let cx = (min_x + max_x) / 2.0;
        let cy = (min_y + max_y) / 2.0;
        if cx == 0.0 && cy == 0.0 {
            return;
        }
        for p in &mut self.outer {
            p.x -= cx;
            p.y -= cy;
        }
        for hole in &mut self.holes {
            for p in hole {
                p.x -= cx;
                p.y -= cy;
            }
        }
    }

    /// Triangulate the profile using earcutr
    /// Returns triangle indices into the flattened vertex array
    pub fn triangulate(&self) -> Result<Triangulation> {
        if self.outer.len() < 3 {
            return Err(Error::InvalidProfile(
                "Profile must have at least 3 vertices".to_string(),
            ));
        }

        // Flatten vertices for earcutr
        let mut vertices = Vec::with_capacity(
            (self.outer.len() + self.holes.iter().map(|h| h.len()).sum::<usize>()) * 2,
        );

        // Add outer boundary
        for p in &self.outer {
            vertices.push(p.x);
            vertices.push(p.y);
        }

        // Add holes
        let mut hole_indices = Vec::with_capacity(self.holes.len());
        for hole in &self.holes {
            hole_indices.push(vertices.len() / 2);
            for p in hole {
                vertices.push(p.x);
                vertices.push(p.y);
            }
        }

        // Triangulate
        let indices = if hole_indices.is_empty() {
            earcutr::earcut(&vertices, &[], 2)
                .map_err(|e| Error::TriangulationError(format!("{:?}", e)))?
        } else {
            earcutr::earcut(&vertices, &hole_indices, 2)
                .map_err(|e| Error::TriangulationError(format!("{:?}", e)))?
        };

        // Convert to Point2 array
        let mut points = Vec::with_capacity(vertices.len() / 2);
        for i in (0..vertices.len()).step_by(2) {
            if i + 1 >= vertices.len() {
                break;
            }
            points.push(Point2::new(vertices[i], vertices[i + 1]));
        }

        Ok(Triangulation { points, indices })
    }
}

/// Triangulated profile result
#[derive(Debug, Clone)]
pub struct Triangulation {
    /// All vertices (outer + holes)
    pub points: Vec<Point2<f64>>,
    /// Triangle indices
    pub indices: Vec<usize>,
}

/// Void metadata for depth-aware extrusion
///
/// Tracks information about a void that has been projected to the 2D profile plane,
/// including its depth range for generating internal caps when the void doesn't
/// extend through the full extrusion depth.
#[derive(Debug, Clone)]
pub struct VoidInfo {
    /// Hole contour in 2D profile space (clockwise winding for holes)
    pub contour: Vec<Point2<f64>>,
    /// Start depth in extrusion space (0.0 = bottom cap)
    pub depth_start: f64,
    /// End depth in extrusion space (extrusion_depth = top cap)
    pub depth_end: f64,
    /// Whether void extends full depth (no internal caps needed)
    pub is_through: bool,
}

impl VoidInfo {
    /// Create a new void info
    pub fn new(
        contour: Vec<Point2<f64>>,
        depth_start: f64,
        depth_end: f64,
        is_through: bool,
    ) -> Self {
        Self {
            contour,
            depth_start,
            depth_end,
            is_through,
        }
    }

    /// Create a through void (extends full depth)
    pub fn through(contour: Vec<Point2<f64>>, depth: f64) -> Self {
        Self {
            contour,
            depth_start: 0.0,
            depth_end: depth,
            is_through: true,
        }
    }
}

/// Profile with void tracking for depth-aware extrusion
///
/// Extends Profile2D with metadata about voids that have been classified as
/// coplanar and can be handled at the profile level. This allows for:
/// - Through voids: Added as holes before single extrusion
/// - Partial-depth voids: Generate internal caps at depth boundaries
#[derive(Debug, Clone)]
pub struct Profile2DWithVoids {
    /// Base profile (outer boundary + any existing holes)
    pub profile: Profile2D,
    /// Void metadata for depth-aware extrusion
    pub voids: Vec<VoidInfo>,
}

impl Profile2DWithVoids {
    /// Create a new profile with voids
    pub fn new(profile: Profile2D, voids: Vec<VoidInfo>) -> Self {
        Self { profile, voids }
    }

    /// Create from a base profile with no voids
    pub fn from_profile(profile: Profile2D) -> Self {
        Self {
            profile,
            voids: Vec::new(),
        }
    }

    /// Add a void to the profile
    pub fn add_void(&mut self, void: VoidInfo) {
        self.voids.push(void);
    }

    /// Get all through voids (can be added as simple holes)
    pub fn through_voids(&self) -> impl Iterator<Item = &VoidInfo> {
        self.voids.iter().filter(|v| v.is_through)
    }

    /// Get all partial-depth voids (need internal caps)
    pub fn partial_voids(&self) -> impl Iterator<Item = &VoidInfo> {
        self.voids.iter().filter(|v| !v.is_through)
    }

    /// Check if there are any voids
    pub fn has_voids(&self) -> bool {
        !self.voids.is_empty()
    }

    /// Get number of voids
    pub fn void_count(&self) -> usize {
        self.voids.len()
    }

    /// Create a profile with through-voids merged as holes
    ///
    /// Returns a Profile2D where all through-voids have been added as holes,
    /// suitable for single-pass extrusion.
    pub fn profile_with_through_holes(&self) -> Profile2D {
        let mut profile = self.profile.clone();

        for void in self.through_voids() {
            profile.add_hole(void.contour.clone());
        }

        profile
    }
}

/// Common profile types
#[derive(Debug, Clone)]
pub enum ProfileType {
    Rectangle {
        width: f64,
        height: f64,
    },
    Circle {
        radius: f64,
    },
    HollowCircle {
        outer_radius: f64,
        inner_radius: f64,
    },
    Polygon {
        points: Vec<Point2<f64>>,
    },
}

impl ProfileType {
    /// Convert to Profile2D at the historical default tessellation density.
    pub fn to_profile(&self) -> Profile2D {
        self.to_profile_with_quality(TessellationQuality::Medium)
    }

    /// Convert to Profile2D, tessellating circular profiles at the given
    /// `quality` (rectangle and polygon profiles are unaffected).
    pub fn to_profile_with_quality(&self, quality: TessellationQuality) -> Profile2D {
        match self {
            Self::Rectangle { width, height } => create_rectangle(*width, *height),
            Self::Circle { radius } => create_circle(*radius, None, quality),
            Self::HollowCircle {
                outer_radius,
                inner_radius,
            } => create_circle(*outer_radius, Some(*inner_radius), quality),
            Self::Polygon { points } => Profile2D::new(points.clone()),
        }
    }
}

/// Create a rectangular profile
#[inline]
pub fn create_rectangle(width: f64, height: f64) -> Profile2D {
    let half_w = width / 2.0;
    let half_h = height / 2.0;

    Profile2D::new(vec![
        Point2::new(-half_w, -half_h),
        Point2::new(half_w, -half_h),
        Point2::new(half_w, half_h),
        Point2::new(-half_w, half_h),
    ])
}

/// Create a circular profile (with optional hole)
///
/// Segment count is derived from `radius` and the requested tessellation
/// `quality`; [`TessellationQuality::Medium`] reproduces the historical
/// radius-only segment count exactly.
pub fn create_circle(radius: f64, hole_radius: Option<f64>, quality: TessellationQuality) -> Profile2D {
    let segments = calculate_circle_segments(radius, quality);

    let mut outer = Vec::with_capacity(segments);

    for i in 0..segments {
        let angle = 2.0 * std::f64::consts::PI * (i as f64) / (segments as f64);
        outer.push(Point2::new(radius * angle.cos(), radius * angle.sin()));
    }

    let mut profile = Profile2D::new(outer);

    // Add hole if specified
    if let Some(hole_r) = hole_radius {
        let hole_segments = calculate_circle_segments(hole_r, quality);
        let mut hole = Vec::with_capacity(hole_segments);

        for i in 0..hole_segments {
            let angle = 2.0 * std::f64::consts::PI * (i as f64) / (hole_segments as f64);
            // Reverse winding for hole (clockwise)
            hole.push(Point2::new(hole_r * angle.cos(), hole_r * angle.sin()));
        }
        hole.reverse(); // Make clockwise

        profile.add_hole(hole);
    }

    profile
}

/// Calculate adaptive number of segments for a circular opening / profile.
///
/// The radius-based rule (`ceil(sqrt(radius) * 8)`, clamped to `[8, 32]`) is the
/// historical baseline returned at [`TessellationQuality::Medium`] and above —
/// opening circles never get *finer* (denser caps only add earcut bridge
/// slivers). Below Medium they coarsen via
/// [`TessellationQuality::circle_profile_segments`].
#[inline]
pub fn calculate_circle_segments(radius: f64, quality: TessellationQuality) -> usize {
    // Adaptive segment calculation - optimized for performance
    // Smaller circles need fewer segments
    let base = ((radius.sqrt() * 8.0).ceil() as usize).clamp(8, 32);

    quality.circle_profile_segments(base)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rectangle_profile() {
        let profile = create_rectangle(10.0, 5.0);
        assert_eq!(profile.outer.len(), 4);
        assert_eq!(profile.holes.len(), 0);

        // Check bounds
        assert_eq!(profile.outer[0], Point2::new(-5.0, -2.5));
        assert_eq!(profile.outer[1], Point2::new(5.0, -2.5));
        assert_eq!(profile.outer[2], Point2::new(5.0, 2.5));
        assert_eq!(profile.outer[3], Point2::new(-5.0, 2.5));
    }

    #[test]
    fn test_circle_profile() {
        let profile = create_circle(5.0, None, TessellationQuality::Medium);
        assert!(profile.outer.len() >= 8);
        assert_eq!(profile.holes.len(), 0);

        // Check first point is on circle
        let first = profile.outer[0];
        let dist = (first.x * first.x + first.y * first.y).sqrt();
        assert!((dist - 5.0).abs() < 0.001);
    }

    #[test]
    fn test_hollow_circle() {
        let profile = create_circle(10.0, Some(5.0), TessellationQuality::Medium);
        assert!(profile.outer.len() >= 8);
        assert_eq!(profile.holes.len(), 1);

        // Check hole
        let hole = &profile.holes[0];
        assert!(hole.len() >= 8);
    }

    #[test]
    fn test_triangulate_rectangle() {
        let profile = create_rectangle(10.0, 5.0);
        let tri = profile.triangulate().unwrap();

        assert_eq!(tri.points.len(), 4);
        assert_eq!(tri.indices.len(), 6); // 2 triangles = 6 indices
    }

    #[test]
    fn test_triangulate_circle() {
        let profile = create_circle(5.0, None, TessellationQuality::Medium);
        let tri = profile.triangulate().unwrap();

        assert!(tri.points.len() >= 8);
        // Triangle count should be points - 2
        assert_eq!(tri.indices.len(), (tri.points.len() - 2) * 3);
    }

    #[test]
    fn test_triangulate_hollow_circle() {
        let profile = create_circle(10.0, Some(5.0), TessellationQuality::Medium);
        let tri = profile.triangulate().unwrap();

        // Should have vertices from both outer and inner circles
        let outer_count = calculate_circle_segments(10.0, TessellationQuality::Medium);
        let inner_count = calculate_circle_segments(5.0, TessellationQuality::Medium);
        assert_eq!(tri.points.len(), outer_count + inner_count);
    }

    #[test]
    fn test_circle_segments() {
        use TessellationQuality::Medium;
        assert_eq!(calculate_circle_segments(1.0, Medium), 8); // sqrt(1)*8=8, clamped to min 8
        assert_eq!(calculate_circle_segments(4.0, Medium), 16); // sqrt(4)*8=16
        assert!(calculate_circle_segments(100.0, Medium) <= 32); // Max clamp at 32
        assert!(calculate_circle_segments(0.1, Medium) >= 8); // Min clamp
    }
}
