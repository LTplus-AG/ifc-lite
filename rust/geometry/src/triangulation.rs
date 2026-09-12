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

#[cfg(feature = "triangulation-alt")]
pub(crate) mod alt_oracle;
mod ring_geom;
use ring_geom::{point_in_ring, ring_bbox};

use crate::{Error, Point2, Point3, Result, Vector3};

/// Guarded ear-clipping — the ONLY sanctioned way to call `earcutr` in this
/// crate.
///
/// `earcutr` 0.5's hole elimination bridges every "hole" into the outer ring
/// and assumes the hole lies inside it. Real-world exports violate that:
/// a Revit→Bonsai IFC4X3 door (found in production) authors an
/// `IfcArbitraryProfileDefWithVoids` whose "voids" are disjoint rectangles
/// entirely OUTSIDE the outer boundary (sibling door panels). Bridging an
/// outside ring produces a self-intersecting loop on which earcutr's
/// `filter_points` spins FOREVER — wedging the rayon worker (native) or the
/// whole WASM worker (the browser's geometry-stream stall). There is no
/// upstream fix to take (0.5.0 is current), so this wrapper makes the input
/// safe first:
///
/// - any non-finite coordinate ⇒ the face is rejected (an error, like any
///   other failed triangulation — callers already handle that);
/// - consecutive bitwise-duplicate vertices are dropped per ring, including
///   the wrap-around closing duplicate (`P0 … P0`) many exporters write;
/// - rings that collapse below 3 vertices are dropped (a collapsed hole is
///   simply ignored; a collapsed outer ring yields zero triangles);
/// - each "hole" is classified before earcut sees it: contained in the outer
///   ring ⇒ a real hole; fully disjoint from it ⇒ a SEPARATE polygon,
///   triangulated independently so the (malformed but renderable) geometry
///   still shows; straddling the boundary ⇒ dropped (no safe interpretation).
///
/// Returned indices are remapped to the CALLER's original vertex order, so
/// call sites keep indexing their own arrays.
/// Ear-clip one sanitised ring group. The ONLY place `safe_earcut` reaches a
/// triangulator, so the test-only oracle can stand in here and see byte-identical
/// input to the production path.
fn ear_clip(data: &[f64], hole_indices: &[usize]) -> std::result::Result<Vec<usize>, String> {
    #[cfg(feature = "triangulation-alt")]
    if let Some(alt) = alt_oracle::maybe_earcut(data, hole_indices) {
        return Ok(alt);
    }
    earcutr::earcut(data, hole_indices, 2).map_err(|e| format!("{e:?}"))
}

pub(crate) fn safe_earcut(
    data: &[f64],
    hole_indices: &[usize],
    dims: usize,
) -> std::result::Result<Vec<usize>, String> {
    debug_assert_eq!(dims, 2, "safe_earcut is used for 2D rings only");
    let n = data.len() / dims;

    if data.iter().any(|c| !c.is_finite()) {
        return Err("non-finite coordinate in polygon ring".to_string());
    }

    // FAST PATH (the overwhelming majority of calls): a single ring with no
    // consecutive/closing duplicates needs no sanitisation, no classification,
    // and no index remap — hand it straight to earcutr, zero-copy. Profile
    // triangulation sits on the hot path for EVERY face in the pipeline.
    if hole_indices.is_empty() {
        let has_dup = n >= 2
            && ((0..n - 1).any(|v| {
                data[v * 2] == data[v * 2 + 2] && data[v * 2 + 1] == data[v * 2 + 3]
            }) || (data[0] == data[(n - 1) * 2] && data[1] == data[(n - 1) * 2 + 1]));
        if !has_dup {
            return ear_clip(data, &[]);
        }
    }

    // Ring boundaries in vertex indices: [start, end) per ring.
    let mut ring_bounds: Vec<(usize, usize)> = Vec::with_capacity(hole_indices.len() + 1);
    {
        let mut start = 0usize;
        for &h in hole_indices {
            ring_bounds.push((start, h));
            start = h;
        }
        ring_bounds.push((start, n));
    }

    // Sanitize each ring into its own (coords, original-indices) pair:
    // drop consecutive duplicates incl. the closing wrap-around duplicate.
    let mut rings: Vec<(Vec<f64>, Vec<usize>)> = Vec::with_capacity(ring_bounds.len());
    for &(start, end) in &ring_bounds {
        let mut coords: Vec<f64> = Vec::with_capacity((end - start) * 2);
        let mut orig: Vec<usize> = Vec::with_capacity(end - start);
        for v in start..end {
            let (x, y) = (data[v * 2], data[v * 2 + 1]);
            if let (Some(&px), Some(&py)) = (
                coords.len().checked_sub(2).and_then(|i| coords.get(i)),
                coords.len().checked_sub(1).and_then(|i| coords.get(i)),
            ) {
                if px == x && py == y {
                    continue;
                }
            }
            coords.push(x);
            coords.push(y);
            orig.push(v);
        }
        // Wrap-around closing duplicate.
        if orig.len() >= 2
            && coords[0] == coords[coords.len() - 2]
            && coords[1] == coords[coords.len() - 1]
        {
            coords.truncate(coords.len() - 2);
            orig.pop();
        }
        rings.push((coords, orig));
    }

    let (outer_coords, outer_orig) = &rings[0];
    if outer_orig.len() < 3 {
        // The outer boundary collapsed — nothing to triangulate.
        return Ok(Vec::new());
    }
    let outer_bbox = ring_bbox(outer_coords);

    // Classify each candidate hole.
    let mut real_holes: Vec<usize> = Vec::new(); // index into `rings`
    let mut separate_polys: Vec<usize> = Vec::new();
    for (ring_no, (coords, orig)) in rings.iter().enumerate().skip(1) {
        if orig.len() < 3 {
            continue; // collapsed ring
        }
        let bbox = ring_bbox(coords);
        let bbox_disjoint = bbox.2 < outer_bbox.0
            || bbox.0 > outer_bbox.2
            || bbox.3 < outer_bbox.1
            || bbox.1 > outer_bbox.3;
        if bbox_disjoint {
            separate_polys.push(ring_no);
        } else if coords
            .chunks_exact(2)
            .any(|p| point_in_ring(p[0], p[1], outer_coords))
        {
            // ANY vertex strictly inside ⇒ a real hole. The any-vertex vote
            // keeps valid holes that touch the outer boundary (a vertex ON
            // the boundary ray-casts as outside, but a touching hole's other
            // vertices are interior).
            real_holes.push(ring_no);
        }
        // else: overlapping bboxes but no vertex inside — straddles or sits
        // against the outer boundary from outside. Drop it: there is no safe
        // interpretation, and this is exactly the shape that wedges
        // earcutr's bridge walk.
    }

    let mut out: Vec<usize> = Vec::new();

    // Outer ring + its real holes in one earcut call.
    {
        let mut coords: Vec<f64> =
            Vec::with_capacity(outer_coords.len() + real_holes.len() * 8);
        let mut orig: Vec<usize> = Vec::with_capacity(outer_orig.len());
        coords.extend_from_slice(outer_coords);
        orig.extend_from_slice(outer_orig);
        let mut holes: Vec<usize> = Vec::with_capacity(real_holes.len());
        for &ring_no in &real_holes {
            holes.push(orig.len());
            coords.extend_from_slice(&rings[ring_no].0);
            orig.extend_from_slice(&rings[ring_no].1);
        }
        let indices = ear_clip(&coords, &holes)?;
        out.extend(indices.into_iter().map(|i| orig[i]));
    }

    // Disjoint "holes" render as their own hole-less polygons.
    for &ring_no in &separate_polys {
        let (coords, orig) = &rings[ring_no];
        let indices = ear_clip(coords, &[])?;
        out.extend(indices.into_iter().map(|i| orig[i]));
    }

    Ok(out)
}

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

/// Split a quad across the diagonal that lies INSIDE the ring.
///
/// This arm used to hard-code the 0-2 diagonal with no test at all, while the
/// very next arm tested convexity. A fan is only valid from a vertex that SEES
/// the whole ring, so on a CONCAVE quad the 0-2 split can cross outside the
/// polygon: for the dart `[(0,0), (2,2), (4,0), (2,10)]` (reflex at vertex 1) the
/// ring's signed area is +16.0 while `tri(0,1,2)` is -4.0 and `tri(0,2,3)` is
/// +20.0, so the first triangle is wound BACKWARDS and lies entirely outside the
/// polygon while the second covers that outside region twice. Every extruded
/// profile cap reaches this (`extrusion.rs` via `triangulate_polygon_with_holes`),
/// as do the faceted-brep, advanced-face and sectioned processors.
///
/// `orient(a, b, c)` is twice the signed area of that triangle. `c1` is the
/// convexity of vertex 1, `c3` that of vertex 3, and `c1 + c3` is twice the
/// ring's own signed area. A simple quad has at most ONE reflex vertex and the
/// only interior diagonal is the one incident to it, so: the two agreeing in sign
/// means neither 1 nor 3 is reflex and 0-2 is interior; disagreeing means one of
/// them is, and 1-3 is. Either way both emitted triangles carry the ring's
/// winding. A degenerate (collinear) vertex scores 0, which agrees with anything
/// and keeps the old 0-2 split.
///
/// Kept as an orientation test rather than deleted in favour of the `is_convex`
/// arm below, and not for speed: the delete measured 4 ns per call, under the
/// cost of the `vec!` this call already pays. The reason that binds is winding.
/// A concave quad that fell through would reach `safe_earcut`, and earcutr
/// re-winds EVERY output counter-clockwise regardless of input, so a
/// clockwise concave quad would come back flipped. This arm splits it across
/// the interior diagonal in the ring's own winding, which
/// `concave_quad_split_is_correct_for_a_clockwise_ring` pins; deleting the
/// arm fails that test with both triangles at +16. Convex quads keep
/// byte-identical output either way.
#[inline]
fn quad_indices(p: &[Point2<f64>]) -> Vec<usize> {
    let orient = |a: &Point2<f64>, b: &Point2<f64>, c: &Point2<f64>| {
        (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
    };
    let c1 = orient(&p[0], &p[1], &p[2]);
    let c3 = orient(&p[2], &p[3], &p[0]);
    if c1 * c3 >= 0.0 {
        vec![0, 1, 2, 0, 2, 3]
    } else {
        vec![1, 2, 3, 1, 3, 0]
    }
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

    // FAST PATH: Quad - fan across the diagonal that lies INSIDE the ring.
    if n == 4 {
        return Ok(quad_indices(points));
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
    let indices = safe_earcut(&vertices, &[], 2).map_err(Error::TriangulationError)?;

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
    let indices =
        safe_earcut(&vertices, &hole_indices, 2).map_err(Error::TriangulationError)?;

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
/// Refinement is interior-only and NEVER touches the outer/hole rings, so a
/// region whose boundary is SHARED with neighbouring plane buckets (the
/// consolidate path — the only caller) stays watertight at the seam (no
/// boundary Steiner T-junction). See [`crate::cdt::triangulate_refined`] for
/// why this is the only supported mode.
pub fn triangulate_polygon_with_holes_refined(
    outer: &[Point2<f64>],
    holes: &[Vec<Point2<f64>>],
) -> Result<(Vec<Point2<f64>>, Vec<usize>)> {
    if outer.len() < 3 {
        return Err(Error::TriangulationError(
            "Need at least 3 points in outer boundary".to_string(),
        ));
    }
    let valid_holes: Vec<Vec<Point2<f64>>> =
        holes.iter().filter(|h| h.len() >= 3).cloned().collect();

    // Quality CDT + bounded refinement.
    if let Some((pts, idx)) = crate::cdt::triangulate_refined(outer, &valid_holes) {
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
#[path = "triangulation_tests.rs"]
mod tests;
