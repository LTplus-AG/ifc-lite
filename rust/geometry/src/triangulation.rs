// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Polygon triangulation utilities
//!
//! Primary path: a deterministic Constrained Delaunay Triangulation
//! (`crate::cdt`) that avoids the high-aspect sliver fans greedy ear-clipping
//! produces. `earcutr` is retained as a robustness fallback for any degenerate
//! input the CDT declines (self-touching rings, fully-collinear loops). See
//! `crate::cdt` for the determinism / watertightness / bounded-refinement
//! contract.

use crate::{Error, Point2, Point3, Result, Vector3};

/// Check if a polygon is convex (all cross products have same sign)
#[inline]
fn is_convex(points: &[Point2<f64>]) -> bool {
    if points.len() < 3 {
        return false;
    }

    let n = points.len();
    let mut sign = 0i8;

    for i in 0..n {
        let p0 = &points[i];
        let p1 = &points[(i + 1) % n];
        let p2 = &points[(i + 2) % n];

        // Cross product of edges
        let cross = (p1.x - p0.x) * (p2.y - p1.y) - (p1.y - p0.y) * (p2.x - p1.x);

        if cross.abs() > 1e-10 {
            let current_sign = if cross > 0.0 { 1i8 } else { -1i8 };
            if sign == 0 {
                sign = current_sign;
            } else if sign != current_sign {
                return false; // Sign changed - not convex
            }
        }
    }

    true
}

/// Simple fan triangulation for convex polygons
#[inline]
fn fan_triangulate(n: usize) -> Vec<usize> {
    let mut indices = Vec::with_capacity((n - 2) * 3);
    for i in 1..n - 1 {
        indices.push(0);
        indices.push(i);
        indices.push(i + 1);
    }
    indices
}

/// Triangulate a simple polygon (no holes)
/// Returns triangle indices into the input points
#[inline]
pub fn triangulate_polygon(points: &[Point2<f64>]) -> Result<Vec<usize>> {
    let n = points.len();

    if n < 3 {
        return Err(Error::TriangulationError(
            "Need at least 3 points to triangulate".to_string(),
        ));
    }

    // FAST PATH: Triangle - no triangulation needed
    if n == 3 {
        return Ok(vec![0, 1, 2]);
    }

    // FAST PATH: Quad - simple fan
    if n == 4 {
        return Ok(vec![0, 1, 2, 0, 2, 3]);
    }

    // FAST PATH: Convex polygon - use fan triangulation
    if n <= 8 && is_convex(points) {
        return Ok(fan_triangulate(n));
    }

    // earcutr. (A no-Steiner CDT was tried here and reverted: this function is
    // on the hot path for EVERY profile/face in the pipeline, and Bowyer-Watson
    // costs ~2x total CSG time on opening-heavy models. The quality CDT runs
    // only on the consolidate path via triangulate_polygon_with_holes_refined,
    // which is where the sliver-prone cut faces are re-triangulated.)
    let mut vertices = Vec::with_capacity(n * 2);
    for p in points {
        vertices.push(p.x);
        vertices.push(p.y);
    }
    let indices = earcutr::earcut(&vertices, &[], 2)
        .map_err(|e| Error::TriangulationError(format!("{:?}", e)))?;

    Ok(indices)
}

/// Triangulate a polygon with holes
/// Returns triangle indices into the combined vertex array (outer + all holes)
#[inline]
pub fn triangulate_polygon_with_holes(
    outer: &[Point2<f64>],
    holes: &[Vec<Point2<f64>>],
) -> Result<Vec<usize>> {
    if outer.len() < 3 {
        return Err(Error::TriangulationError(
            "Need at least 3 points in outer boundary".to_string(),
        ));
    }

    // FAST PATH: No holes - use optimized simple triangulation
    // Filter out empty or invalid holes
    let valid_holes: Vec<&Vec<Point2<f64>>> = holes.iter().filter(|h| h.len() >= 3).collect();

    if valid_holes.is_empty() {
        return triangulate_polygon(outer);
    }

    // earcutr. (See triangulate_polygon: the no-Steiner CDT here was reverted
    // for hot-path cost; the consolidate path uses the quality CDT via
    // triangulate_polygon_with_holes_refined.)
    let total_points: usize = outer.len() + valid_holes.iter().map(|h| h.len()).sum::<usize>();
    let mut vertices = Vec::with_capacity(total_points * 2);
    for p in outer {
        vertices.push(p.x);
        vertices.push(p.y);
    }
    let mut hole_indices = Vec::with_capacity(valid_holes.len());
    for hole in valid_holes {
        hole_indices.push(vertices.len() / 2);
        for p in hole {
            vertices.push(p.x);
            vertices.push(p.y);
        }
    }
    let indices = earcutr::earcut(&vertices, &hole_indices, 2)
        .map_err(|e| Error::TriangulationError(format!("{:?}", e)))?;

    Ok(indices)
}

/// Quality-triangulate a polygon-with-holes WITH bounded Ruppert min-angle
/// refinement (Steiner points allowed). Returns the augmented 2D vertex list
/// (input vertices in `outer ++ holes` order, followed by Steiner points) and
/// triangle indices into it.
///
/// Use this ONLY from callers that lift a generic vertex list to 3D (the
/// coplanar-consolidation path), NOT from callers that map indices onto a fixed
/// input ring — those must use [`triangulate_polygon_with_holes`]. Returns the
/// outer+holes vertex list and an earcut index list (no Steiner) if the CDT
/// declines, so the caller always gets a usable result.
///
/// `allow_boundary_split = false` keeps refinement OFF the outer/hole rings so a
/// region whose boundary is SHARED with neighbouring plane buckets stays
/// watertight at the seam (no boundary Steiner T-junction). The consolidate path
/// passes `false`; a standalone single-region caller can pass `true` for full
/// Ruppert.
pub fn triangulate_polygon_with_holes_refined(
    outer: &[Point2<f64>],
    holes: &[Vec<Point2<f64>>],
    allow_boundary_split: bool,
) -> Result<(Vec<Point2<f64>>, Vec<usize>)> {
    if outer.len() < 3 {
        return Err(Error::TriangulationError(
            "Need at least 3 points in outer boundary".to_string(),
        ));
    }
    let valid_holes: Vec<Vec<Point2<f64>>> =
        holes.iter().filter(|h| h.len() >= 3).cloned().collect();

    // Quality CDT + bounded refinement.
    if let Some((pts, idx)) =
        crate::cdt::triangulate_refined(outer, &valid_holes, allow_boundary_split)
    {
        return Ok((pts, idx));
    }

    // FALLBACK: earcut over the un-refined vertex set (outer ++ holes).
    let mut all: Vec<Point2<f64>> = outer.to_vec();
    for h in &valid_holes {
        all.extend_from_slice(h);
    }
    let idx = if valid_holes.is_empty() {
        triangulate_polygon(outer)?
    } else {
        triangulate_polygon_with_holes(outer, &valid_holes)?
    };
    Ok((all, idx))
}

/// Project 3D points onto a 2D plane defined by a normal
/// Returns 2D points and the coordinate system (u_axis, v_axis, origin)
#[inline]
pub fn project_to_2d(
    points_3d: &[Point3<f64>],
    normal: &Vector3<f64>,
) -> (Vec<Point2<f64>>, Vector3<f64>, Vector3<f64>, Point3<f64>) {
    if points_3d.is_empty() {
        return (
            Vec::new(),
            Vector3::zeros(),
            Vector3::zeros(),
            Point3::origin(),
        );
    }

    // Use first point as origin
    let origin = points_3d[0];

    // Create orthonormal basis on the plane
    // Find the axis least parallel to the normal for stable cross product
    let abs_x = normal.x.abs();
    let abs_y = normal.y.abs();
    let abs_z = normal.z.abs();

    let reference = if abs_x <= abs_y && abs_x <= abs_z {
        Vector3::new(1.0, 0.0, 0.0)
    } else if abs_y <= abs_z {
        Vector3::new(0.0, 1.0, 0.0)
    } else {
        Vector3::new(0.0, 0.0, 1.0)
    };

    let u_axis = normal.cross(&reference).normalize();
    let v_axis = normal.cross(&u_axis).normalize();

    // Project all points to 2D
    let points_2d = points_3d
        .iter()
        .map(|p| {
            let v = p - origin;
            Point2::new(v.dot(&u_axis), v.dot(&v_axis))
        })
        .collect();

    (points_2d, u_axis, v_axis, origin)
}

/// Project 3D points using an existing coordinate system
/// This ensures multiple sets of points use the same 2D space
#[inline]
pub fn project_to_2d_with_basis(
    points_3d: &[Point3<f64>],
    u_axis: &Vector3<f64>,
    v_axis: &Vector3<f64>,
    origin: &Point3<f64>,
) -> Vec<Point2<f64>> {
    points_3d
        .iter()
        .map(|p| {
            let v = p - origin;
            Point2::new(v.dot(u_axis), v.dot(v_axis))
        })
        .collect()
}

/// Calculate the normal of a polygon from its vertices
/// Optimized for triangles and quads using simple cross product
#[inline]
pub fn calculate_polygon_normal(points: &[Point3<f64>]) -> Vector3<f64> {
    let n = points.len();

    if n < 3 {
        return Vector3::new(0.0, 0.0, 1.0);
    }

    // FAST PATH: Triangle or quad - use simple cross product
    if n <= 4 {
        let v1 = points[1] - points[0];
        let v2 = points[2] - points[0];
        let normal = v1.cross(&v2);
        let len = normal.norm();
        if len > 1e-10 {
            return normal / len;
        }
        // Fallback for degenerate triangles
        if n == 4 {
            // Try different edges for quad
            let v3 = points[3] - points[0];
            let normal = v2.cross(&v3);
            let len = normal.norm();
            if len > 1e-10 {
                return normal / len;
            }
        }
        return Vector3::new(0.0, 0.0, 1.0);
    }

    // Use Newell's method for robust normal calculation on complex polygons
    let mut normal = Vector3::<f64>::zeros();

    for i in 0..n {
        let current = &points[i];
        let next = &points[(i + 1) % n];

        normal.x += (current.y - next.y) * (current.z + next.z);
        normal.y += (current.z - next.z) * (current.x + next.x);
        normal.z += (current.x - next.x) * (current.y + next.y);
    }

    let len = normal.norm();
    if len > 1e-10 {
        normal.normalize()
    } else {
        Vector3::new(0.0, 0.0, 1.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_triangulate_square() {
        let points = vec![
            Point2::new(0.0, 0.0),
            Point2::new(1.0, 0.0),
            Point2::new(1.0, 1.0),
            Point2::new(0.0, 1.0),
        ];

        let indices = triangulate_polygon(&points).unwrap();

        // Square should be split into 2 triangles = 6 indices
        assert_eq!(indices.len(), 6);
    }

    #[test]
    fn test_triangulate_triangle() {
        let points = vec![
            Point2::new(0.0, 0.0),
            Point2::new(1.0, 0.0),
            Point2::new(0.5, 1.0),
        ];

        let indices = triangulate_polygon(&points).unwrap();

        // Triangle should have 3 indices
        assert_eq!(indices.len(), 3);
    }

    #[test]
    fn test_triangulate_insufficient_points() {
        let points = vec![Point2::new(0.0, 0.0), Point2::new(1.0, 0.0)];

        let result = triangulate_polygon(&points);
        assert!(result.is_err());
    }

    #[test]
    fn test_triangulate_square_with_hole() {
        // Outer square: 0-10
        let outer = vec![
            Point2::new(0.0, 0.0),
            Point2::new(10.0, 0.0),
            Point2::new(10.0, 10.0),
            Point2::new(0.0, 10.0),
        ];

        // Inner square (hole): 3-7
        let hole = vec![
            Point2::new(3.0, 3.0),
            Point2::new(7.0, 3.0),
            Point2::new(7.0, 7.0),
            Point2::new(3.0, 7.0),
        ];

        let indices = triangulate_polygon_with_holes(&outer, &[hole]).unwrap();

        // With a hole, we should get more triangles than without
        // The result should have indices for triangles around the hole
        assert!(indices.len() > 6); // More than the 2 triangles for a simple square
        assert_eq!(indices.len() % 3, 0); // Must be a multiple of 3 (triangles)
    }

    #[test]
    fn test_triangulate_with_multiple_holes() {
        // Outer square: 0-20
        let outer = vec![
            Point2::new(0.0, 0.0),
            Point2::new(20.0, 0.0),
            Point2::new(20.0, 20.0),
            Point2::new(0.0, 20.0),
        ];

        // Two holes
        let hole1 = vec![
            Point2::new(2.0, 2.0),
            Point2::new(5.0, 2.0),
            Point2::new(5.0, 5.0),
            Point2::new(2.0, 5.0),
        ];

        let hole2 = vec![
            Point2::new(10.0, 10.0),
            Point2::new(15.0, 10.0),
            Point2::new(15.0, 15.0),
            Point2::new(10.0, 15.0),
        ];

        let indices = triangulate_polygon_with_holes(&outer, &[hole1, hole2]).unwrap();

        assert!(indices.len() > 6);
        assert_eq!(indices.len() % 3, 0);
    }

    /// `triangulate_polygon_with_holes_refined`, normal path: the returned
    /// vertex list starts with exactly the input vertices (`outer ++ holes`;
    /// Steiner points only after them), every index is in range, and — with
    /// boundary splits off — every hole-ring constraint edge survives as an
    /// edge of the output triangulation (the hole stays a hole).
    #[test]
    fn test_refined_vertex_layout_and_hole_constraints() {
        let outer = vec![
            Point2::new(0.0, 0.0),
            Point2::new(10.0, 0.0),
            Point2::new(10.0, 10.0),
            Point2::new(0.0, 10.0),
        ];
        let hole = vec![
            Point2::new(3.0, 3.0),
            Point2::new(7.0, 3.0),
            Point2::new(7.0, 7.0),
            Point2::new(3.0, 7.0),
        ];
        let (pts, idx) =
            triangulate_polygon_with_holes_refined(&outer, &[hole.clone()], false).unwrap();

        let n_input = outer.len() + hole.len();
        assert!(pts.len() >= n_input, "input vertices must all be present");
        for (i, p) in outer.iter().chain(hole.iter()).enumerate() {
            assert_eq!(
                (pts[i].x, pts[i].y),
                (p.x, p.y),
                "vertex {i} must be the input vertex (outer ++ holes order)"
            );
        }
        assert!(!idx.is_empty());
        assert_eq!(idx.len() % 3, 0);
        assert!(idx.iter().all(|&i| i < pts.len()), "index out of range");

        let mut edges = std::collections::BTreeSet::new();
        for t in idx.chunks_exact(3) {
            for (a, b) in [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
                edges.insert(if a < b { (a, b) } else { (b, a) });
            }
        }
        for k in 0..hole.len() {
            let a = outer.len() + k;
            let b = outer.len() + (k + 1) % hole.len();
            let key = if a < b { (a, b) } else { (b, a) };
            assert!(
                edges.contains(&key),
                "hole-ring constraint edge {key:?} missing from the triangulation"
            );
        }
    }

    /// `triangulate_polygon_with_holes_refined`, degenerate path: a fully
    /// collinear outer ring is declined by the CDT (its closing constraint
    /// passes through the intermediate vertices and cannot be recovered); the
    /// earcut/fan fallback must still return `Ok` with the `outer ++ holes`
    /// vertex set and in-range indices.
    #[test]
    fn test_refined_collinear_outer_falls_back() {
        let outer = vec![
            Point2::new(0.0, 0.0),
            Point2::new(1.0, 0.0),
            Point2::new(2.0, 0.0),
            Point2::new(3.0, 0.0),
        ];
        let (pts, idx) = triangulate_polygon_with_holes_refined(&outer, &[], true)
            .expect("degenerate input must fall back, not error");
        assert_eq!(pts.len(), outer.len(), "fallback must return the input vertex set");
        for (i, p) in outer.iter().enumerate() {
            assert_eq!((pts[i].x, pts[i].y), (p.x, p.y));
        }
        assert_eq!(idx.len() % 3, 0);
        assert!(idx.iter().all(|&i| i < pts.len()));
    }

    #[test]
    fn test_calculate_polygon_normal() {
        // XY plane polygon - normal should be Z
        let points = vec![
            Point3::new(0.0, 0.0, 0.0),
            Point3::new(1.0, 0.0, 0.0),
            Point3::new(1.0, 1.0, 0.0),
            Point3::new(0.0, 1.0, 0.0),
        ];

        let normal = calculate_polygon_normal(&points);
        assert!((normal.z.abs() - 1.0).abs() < 0.001);
    }

    #[test]
    fn test_project_to_2d() {
        // Points on the XY plane
        let points = vec![
            Point3::new(0.0, 0.0, 5.0),
            Point3::new(1.0, 0.0, 5.0),
            Point3::new(1.0, 1.0, 5.0),
            Point3::new(0.0, 1.0, 5.0),
        ];

        let normal = Vector3::new(0.0, 0.0, 1.0);
        let (projected, _, _, _) = project_to_2d(&points, &normal);

        assert_eq!(projected.len(), 4);
        // After projection, all Z values are ignored, and we get 2D coords
    }
}
