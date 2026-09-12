// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Unit tests for [`super`] (polygon triangulation). Split into a `*_tests.rs`
//! file (module-size-ratchet exempt) and attached via `#[path]`.

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

/// Twice the signed area of a triangle, as `quad_indices` computes it.
fn tri_area2(p: &[Point2<f64>], i: &[usize]) -> f64 {
    let (a, b, c) = (p[i[0]], p[i[1]], p[i[2]]);
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}

/// Twice the signed area of a closed ring (shoelace).
fn ring_area2(p: &[Point2<f64>]) -> f64 {
    (0..p.len())
        .map(|i| {
            let (a, b) = (p[i], p[(i + 1) % p.len()]);
            a.x * b.y - b.x * a.y
        })
        .sum()
}

/// Regression: the `n == 4` fast path hard-coded the 0-2 diagonal with no
/// convexity test, so a CONCAVE quad was split across a diagonal lying
/// OUTSIDE the polygon. Concrete numbers for this dart (reflex at vertex 1):
/// ring `2*area` is +32.0, `tri(0,1,2)` is -8.0 (wound BACKWARDS, entirely
/// outside the ring) and `tri(0,2,3)` is +40.0, double-covering that outside
/// region. The valid split is the 1-3 diagonal: +24.0 and +8.0, summing to
/// the ring's own +32.0.
/// Regression for #4579.
#[test]
fn concave_quad_is_split_across_an_interior_diagonal() {
    let dart = vec![
        Point2::new(0.0, 0.0),
        Point2::new(2.0, 2.0),
        Point2::new(4.0, 0.0),
        Point2::new(2.0, 10.0),
    ];
    let ring = ring_area2(&dart);
    assert_eq!(ring, 32.0, "fixture precondition: the ring is CCW, 2*A = 32");
    // Fixture precondition: the OLD hard-coded 0-2 split really is outside.
    assert_eq!(tri_area2(&dart, &[0, 1, 2]), -8.0);
    assert_eq!(tri_area2(&dart, &[0, 2, 3]), 40.0);

    let idx = triangulate_polygon(&dart).unwrap();
    assert_eq!(idx.len(), 6, "a quad yields exactly two triangles");
    let areas: Vec<f64> = idx.chunks_exact(3).map(|t| tri_area2(&dart, t)).collect();
    for a in &areas {
        assert!(
            a.signum() == ring.signum() && *a != 0.0,
            "triangle 2*area {a} must carry the ring's winding {ring}, got {areas:?}"
        );
    }
    let total: f64 = areas.iter().sum();
    assert_eq!(
        total, ring,
        "the two triangles must tile the ring exactly, no double cover"
    );
}

/// The mirrored (CW) dart, ROTATED so the reflex vertex lands on index 1
/// again. Rotation matters: reversing the CCW dart alone puts the reflex
/// vertex on index 2, where the hard-coded 0-2 diagonal happens to be the
/// correct one, so that ring passes with the defect present and proves
/// nothing. Here `tri(0,1,2)` is +8.0 against a ring of -32.0 (backwards,
/// outside) and `tri(0,2,3)` is -40.0; the 1-3 split is -16.0 and -16.0.
/// Regression for #4579.
#[test]
fn concave_quad_split_is_correct_for_a_clockwise_ring() {
    let dart = vec![
        Point2::new(4.0, 0.0),
        Point2::new(2.0, 2.0),
        Point2::new(0.0, 0.0),
        Point2::new(2.0, 10.0),
    ];
    let ring = ring_area2(&dart);
    assert_eq!(ring, -32.0, "fixture precondition: this ring is CW");
    assert_eq!(tri_area2(&dart, &[0, 1, 2]), 8.0, "the old 0-2 split is backwards here");

    let idx = triangulate_polygon(&dart).unwrap();
    let areas: Vec<f64> = idx.chunks_exact(3).map(|t| tri_area2(&dart, t)).collect();
    for a in &areas {
        assert!(
            *a < 0.0,
            "triangle 2*area {a} must stay clockwise like the ring, got {areas:?}"
        );
    }
    assert_eq!(areas.iter().sum::<f64>(), ring);
}

/// Convex quads keep the exact indices the old unconditional arm emitted.
/// Regression for #4579.
#[test]
fn convex_quad_still_uses_the_zero_two_diagonal() {
    let square = vec![
        Point2::new(0.0, 0.0),
        Point2::new(1.0, 0.0),
        Point2::new(1.0, 1.0),
        Point2::new(0.0, 1.0),
    ];
    assert_eq!(triangulate_polygon(&square).unwrap(), vec![0, 1, 2, 0, 2, 3]);
    // ... and so does one with a collinear vertex (scores 0, agrees with
    // anything), which is the shape a degenerate profile cap reduces to.
    let flat = vec![
        Point2::new(0.0, 0.0),
        Point2::new(1.0, 0.0),
        Point2::new(2.0, 0.0),
        Point2::new(1.0, 1.0),
    ];
    assert_eq!(triangulate_polygon(&flat).unwrap(), vec![0, 1, 2, 0, 2, 3]);
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
        triangulate_polygon_with_holes_refined(&outer, std::slice::from_ref(&hole)).unwrap();

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
/// passes through the intermediate vertices and cannot be recovered), so the
/// function must bail to the earcut/fan fallback and still return `Ok` with
/// the `outer ++ holes` vertex set and in-range indices. This fallback is
/// independent of the (removed) Ruppert boundary-split path — it fires on
/// the CDT-decline branch before any refinement — so it still needs its own
/// regression coverage under the no-arg signature.
#[test]
fn test_refined_collinear_outer_falls_back() {
    let outer = vec![
        Point2::new(0.0, 0.0),
        Point2::new(1.0, 0.0),
        Point2::new(2.0, 0.0),
        Point2::new(3.0, 0.0),
    ];
    let (pts, idx) = triangulate_polygon_with_holes_refined(&outer, &[])
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

/// The production input that wedged earcutr 0.5 forever (Revit→Bonsai
/// IFC4X3 door): an `IfcArbitraryProfileDefWithVoids` whose two "voids"
/// are rectangles entirely OUTSIDE the outer boundary (sibling door
/// panels). Bridging an outside ring into the outer loop creates a
/// self-intersecting polygon on which `filter_points` never terminates —
/// one wedged rayon worker natively, a dead WASM worker (geometry-stream
/// stall) in the browser. `safe_earcut` must terminate AND render all
/// three rectangles as separate polygons.
#[test]
fn safe_earcut_terminates_on_outside_voids_and_renders_them() {
    // Captured verbatim from the wedged element (#5222).
    let data = vec![
        0.0, -0.0, 0.0, 83.0, -2325.0, 83.0, -2325.0, -0.0, // outer
        -2620.0, 83.0, -2620.0, -0.0, -2375.0, -0.0, -2375.0, 83.0, // "void" 1 (outside)
        -2326.0, 83.0, -2374.0, 83.0, -2374.0, -0.0, -2326.0, -0.0, // "void" 2 (outside)
    ];
    let holes = vec![4, 8];

    let indices = safe_earcut(&data, &holes, 2).expect("must triangulate");

    // Three disjoint rectangles → 2 triangles each.
    assert_eq!(indices.len(), 18, "3 rects × 2 tris × 3 idx");
    // Each triangle must stay within a single ring's vertex range.
    for tri in indices.chunks_exact(3) {
        let ring = |v: usize| {
            if v < 4 {
                0
            } else if v < 8 {
                1
            } else {
                2
            }
        };
        assert_eq!(ring(tri[0]), ring(tri[1]));
        assert_eq!(ring(tri[1]), ring(tri[2]));
    }
}

/// A genuine contained hole must still subtract (the classification must
/// not break valid profiles).
#[test]
fn safe_earcut_keeps_contained_holes() {
    // 10×10 outer, 2×2 hole in the middle.
    let data = vec![
        0.0, 0.0, 10.0, 0.0, 10.0, 10.0, 0.0, 10.0, // outer
        4.0, 4.0, 4.0, 6.0, 6.0, 6.0, 6.0, 4.0, // hole (CW)
    ];
    let indices = safe_earcut(&data, &[4], 2).expect("must triangulate");
    // A square with a square hole triangulates to 8 triangles.
    assert_eq!(indices.len() / 3, 8);
    // Hole vertices must participate (the hole was not dropped).
    assert!(indices.iter().any(|&i| i >= 4));
}

/// Closing wrap-around duplicates (P0 … P0) and consecutive duplicate
/// vertices must be tolerated, with indices remapped to the caller's
/// original vertex order.
#[test]
fn safe_earcut_drops_duplicate_vertices_and_remaps() {
    let data = vec![
        0.0, 0.0, 10.0, 0.0, 10.0, 0.0, // consecutive duplicate of v1
        10.0, 10.0, 0.0, 10.0, 0.0, 0.0, // closing duplicate of v0
    ];
    let indices = safe_earcut(&data, &[], 2).expect("must triangulate");
    assert_eq!(indices.len() / 3, 2, "a quad → 2 triangles");
    // Remapped indices reference the caller's original positions; the
    // dropped duplicates (2 and 5) must never appear.
    assert!(indices.iter().all(|&i| i != 2 && i != 5 && i < 6));
}

/// Non-finite coordinates are rejected, not hung on.
#[test]
fn safe_earcut_rejects_non_finite() {
    let data = vec![0.0, 0.0, 10.0, f64::NAN, 10.0, 10.0];
    assert!(safe_earcut(&data, &[], 2).is_err());
}
