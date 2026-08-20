// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Extrusion operations - converting 2D profiles to 3D meshes

use crate::error::{Error, Result};
use crate::mesh::Mesh;
use crate::profile::{Profile2D, Profile2DWithVoids, Triangulation, VoidInfo};
use crate::extrusion_generic::{
    apply_transform_generic, create_cap_mesh, create_side_walls, extrude_rings_into,
};
use nalgebra::{Matrix4, Point2, Point3, Vector3};

/// Extrude a 2D profile along the Z axis
#[inline]
pub fn extrude_profile(
    profile: &Profile2D,
    depth: f64,
    transform: Option<Matrix4<f64>>,
) -> Result<Mesh> {
    let mut mesh = Mesh::new();
    extrude_rings_into(&profile.outer, &profile.holes, depth, transform, &mut mesh)?;
    Ok(mesh)
}

/// Watertight polygon-with-holes extrude for the 2D opening-subtraction path
/// ([`crate::router`]'s `bool2d_path`). The caps are triangulated by the
/// boundary-preserving constrained triangulator
/// ([`crate::cdt::triangulate_constrained`]) instead of earcut: an earcut cap
/// over a many-hole profile sprouts hole-bridge slivers that leave it
/// non-manifold and that `clean_degenerate` later drops into cracks. The
/// constrained triangulator performs NO refinement and adds NO Steiner points;
/// it keeps every profile-ring edge un-subdivided, so the caps close bit-for-bit
/// against the side walls and the cap↔wall seam stays watertight.
#[inline]
pub fn extrude_profile_watertight(
    profile: &Profile2D,
    depth: f64,
    transform: Option<Matrix4<f64>>,
) -> Result<Mesh> {
    if depth <= 0.0 {
        return Err(Error::InvalidExtrusion(
            "Depth must be positive".to_string(),
        ));
    }
    if profile.outer.len() < 3 {
        return Err(Error::InvalidExtrusion(
            "Outer boundary needs >= 3 vertices".to_string(),
        ));
    }
    // Reject degenerate hole rings BEFORE triangulation: `triangulate_constrained`
    // silently drops a < 3-vertex ring from the cap, but `create_side_walls` below
    // would still emit its walls (cap/wall mismatch → cracked mesh). Erroring here
    // defers the whole cut to the exact kernel (`bool2d_path`'s `.ok()?`).
    if profile.holes.iter().any(|h| h.len() < 3) {
        return Err(Error::InvalidExtrusion(
            "Hole ring needs >= 3 vertices".to_string(),
        ));
    }
    // Unrefined CDT caps: manifold (no earcut hole-bridge slivers) and fast (no
    // Ruppert refinement, which dominates on a large multi-hole face). Fall back
    // to the earcut polygon-with-holes triangulation if the CDT declines.
    let (points, indices) =
        match crate::cdt::triangulate_constrained(&profile.outer, &profile.holes) {
            Some(t) => t,
            None => {
                let mut all: Vec<nalgebra::Point2<f64>> = profile.outer.clone();
                for h in &profile.holes {
                    all.extend_from_slice(h);
                }
                let idx = crate::triangulation::triangulate_polygon_with_holes(
                    &profile.outer,
                    &profile.holes,
                )
                .map_err(|e| Error::InvalidExtrusion(format!("cap triangulation failed: {e}")))?;
                (all, idx)
            }
        };
    let tri = Triangulation { points, indices };

    let mut mesh = Mesh::new();
    create_cap_mesh(&tri, 0.0, Vector3::new(0.0, 0.0, -1.0), &mut mesh);
    create_cap_mesh(&tri, depth, Vector3::new(0.0, 0.0, 1.0), &mut mesh);
    create_side_walls(&profile.outer, depth, &mut mesh);
    for hole in &profile.holes {
        create_side_walls(hole, depth, &mut mesh);
    }
    // The CDT emits cap triangles in arbitrary orientation, so the assembled
    // solid closes as a 2-manifold but with INCONSISTENT winding — harmless for
    // the (undirected) watertight check and for per-vertex-normal rendering, but
    // it breaks the divergence volume that downstream consumers (and the #1297
    // local-frame regression test) compute. Flood-fill a consistent OUTWARD
    // orientation across the closed surface; this only flips triangle winding
    // (per-face vertices are never welded, so creases / flat shading are intact).
    crate::mesh_orient::orient_mesh_outward(&mut mesh);
    if let Some(mat) = transform {
        apply_transform(&mut mesh, &mat);
    }
    Ok(mesh)
}

/// Extrude a 2D profile with void awareness
///
/// This function handles both through-voids and partial-depth voids:
/// - Through voids: Added as holes to the profile before extrusion
/// - Partial-depth voids: Generate internal caps at depth boundaries
///
/// # Arguments
/// * `profile_with_voids` - Profile with classified void information
/// * `depth` - Total extrusion depth
/// * `transform` - Optional transformation matrix
///
/// # Returns
/// The extruded mesh with voids properly handled
#[inline]
pub fn extrude_profile_with_voids(
    profile_with_voids: &Profile2DWithVoids,
    depth: f64,
    transform: Option<Matrix4<f64>>,
) -> Result<Mesh> {
    if depth <= 0.0 {
        return Err(Error::InvalidExtrusion(
            "Depth must be positive".to_string(),
        ));
    }

    // Create profile with through-voids as holes
    let profile_with_holes = profile_with_voids.profile_with_through_holes();

    // Triangulate the combined profile
    let triangulation = profile_with_holes.triangulate()?;

    // Estimate capacity
    let partial_void_count = profile_with_voids.partial_voids().count();

    let vertex_count = triangulation.points.len() * 2;
    let side_vertex_count = profile_with_holes.outer.len() * 2
        + profile_with_holes
            .holes
            .iter()
            .map(|h| h.len() * 2)
            .sum::<usize>();
    let partial_void_vertices = partial_void_count * 100; // Estimate
    let total_vertices = vertex_count + side_vertex_count + partial_void_vertices;

    let mut mesh = Mesh::with_capacity(
        total_vertices,
        triangulation.indices.len() * 2 + profile_with_holes.outer.len() * 6,
    );

    // Create top and bottom caps (with through-void holes included)
    create_cap_mesh(&triangulation, 0.0, Vector3::new(0.0, 0.0, -1.0), &mut mesh);
    create_cap_mesh(
        &triangulation,
        depth,
        Vector3::new(0.0, 0.0, 1.0),
        &mut mesh,
    );

    // Create side walls for outer boundary
    create_side_walls(&profile_with_holes.outer, depth, &mut mesh);

    // Create side walls for holes (including through-voids)
    for hole in &profile_with_holes.holes {
        create_side_walls(hole, depth, &mut mesh);
    }

    // Handle partial-depth voids
    for void in profile_with_voids.partial_voids() {
        create_partial_void_geometry(void, depth, &mut mesh)?;
    }

    // Apply transformation if provided
    if let Some(mat) = transform {
        apply_transform(&mut mesh, &mat);
    }

    Ok(mesh)
}

/// Create geometry for a partial-depth void
///
/// Generates:
/// - Internal cap at void start depth (if not at bottom)
/// - Internal cap at void end depth (if not at top)
/// - Side walls for the void opening
fn create_partial_void_geometry(void: &VoidInfo, total_depth: f64, mesh: &mut Mesh) -> Result<()> {
    if void.contour.len() < 3 {
        return Ok(());
    }

    let epsilon = 0.001;

    // Create triangulation for void contour
    let void_profile = Profile2D::new(void.contour.clone());
    let void_triangulation = match void_profile.triangulate() {
        Ok(t) => t,
        Err(_) => return Ok(()), // Skip if triangulation fails
    };

    // Create internal cap at void start (if not at bottom)
    if void.depth_start > epsilon {
        create_cap_mesh(
            &void_triangulation,
            void.depth_start,
            Vector3::new(0.0, 0.0, -1.0), // Facing down into the void
            mesh,
        );
    }

    // Create internal cap at void end (if not at top)
    if void.depth_end < total_depth - epsilon {
        create_cap_mesh(
            &void_triangulation,
            void.depth_end,
            Vector3::new(0.0, 0.0, 1.0), // Facing up into the void
            mesh,
        );
    }

    // Create side walls for the void (from depth_start to depth_end)
    let void_depth = void.depth_end - void.depth_start;
    if void_depth > epsilon {
        create_void_side_walls(&void.contour, void.depth_start, void.depth_end, mesh);
    }

    Ok(())
}

/// Create side walls for a void opening between two depths
fn create_void_side_walls(contour: &[Point2<f64>], z_start: f64, z_end: f64, mesh: &mut Mesh) {
    let base_index = mesh.vertex_count() as u32;
    let mut quad_count = 0u32;

    for i in 0..contour.len() {
        let j = (i + 1) % contour.len();

        let p0 = &contour[i];
        let p1 = &contour[j];

        // Calculate normal for this edge (pointing inward for voids)
        // Use try_normalize to handle degenerate edges (duplicate consecutive points)
        let edge = Vector3::new(p1.x - p0.x, p1.y - p0.y, 0.0);
        // Reverse normal direction for holes (pointing inward)
        let normal = match Vector3::new(edge.y, -edge.x, 0.0).try_normalize(1e-10) {
            Some(n) => n,
            None => continue, // Skip degenerate edge (duplicate points in contour)
        };

        // Bottom vertices (at z_start)
        let v0_bottom = Point3::new(p0.x, p0.y, z_start);
        let v1_bottom = Point3::new(p1.x, p1.y, z_start);

        // Top vertices (at z_end)
        let v0_top = Point3::new(p0.x, p0.y, z_end);
        let v1_top = Point3::new(p1.x, p1.y, z_end);

        // Add 4 vertices for this quad
        let idx = base_index + (quad_count * 4);
        mesh.add_vertex(v0_bottom, normal);
        mesh.add_vertex(v1_bottom, normal);
        mesh.add_vertex(v1_top, normal);
        mesh.add_vertex(v0_top, normal);

        // Add 2 triangles for the quad (reversed winding for inward-facing)
        mesh.add_triangle(idx, idx + 2, idx + 1);
        mesh.add_triangle(idx, idx + 3, idx + 2);

        quad_count += 1;
    }
}

/// Extrude with a different cross section at the top (lofted/tapered extrusion).
///
/// Used for `IfcExtrudedAreaSolidTapered`. The two profiles must share topology
/// per the IFC WR2 constraint, which we trust to mean **same winding direction
/// and corresponding start vertex** — the side walls are stitched 1:1 by
/// vertex index, so reversed winding or rotated start indices would cross.
/// In practice authoring tools sometimes emit loops with different vertex
/// counts; we resample the shorter loop to the longer one's length (by arc
/// length) so a side wall can always be built. Holes are paired by index; any
/// pair where either side has fewer than 3 vertices is dropped from both caps
/// so the mesh stays manifold.
#[inline]
pub fn extrude_profile_lofted(
    start: &Profile2D,
    end: &Profile2D,
    depth: f64,
    transform: Option<Matrix4<f64>>,
) -> Result<Mesh> {
    if depth <= 0.0 {
        return Err(Error::InvalidExtrusion(
            "Depth must be positive".to_string(),
        ));
    }
    if start.outer.len() < 3 || end.outer.len() < 3 {
        return Err(Error::InvalidProfile(
            "Lofted extrusion requires both profiles to have ≥3 vertices".to_string(),
        ));
    }

    // Match outer-loop vertex counts so we can pair sides 1:1.
    let (outer_start, outer_end) = match_loop_lengths(&start.outer, &end.outer);
    let n = outer_start.len();
    debug_assert_eq!(n, outer_end.len());

    // Pair holes by index, dropping any pair where either side has <3 verts
    // (e.g. one profile has an extra hole). The caps must reflect only the
    // holes we'll actually loft, otherwise the cap shows an opening with no
    // matching side wall and the mesh becomes non-manifold.
    let lofted_hole_pairs: Vec<(Vec<Point2<f64>>, Vec<Point2<f64>>)> = start
        .holes
        .iter()
        .zip(end.holes.iter())
        .filter(|(s, e)| s.len() >= 3 && e.len() >= 3)
        .map(|(s, e)| match_loop_lengths(s, e))
        .collect();

    // Build filtered profiles so cap triangulation only sees the holes we loft.
    let mut start_profile = Profile2D::new(outer_start.clone());
    let mut end_profile = Profile2D::new(outer_end.clone());
    for (sh, eh) in &lofted_hole_pairs {
        start_profile.add_hole(sh.clone());
        end_profile.add_hole(eh.clone());
    }

    // Triangulate each cap independently (silhouettes differ).
    let start_tri = start_profile.triangulate()?;
    let end_tri = end_profile.triangulate()?;
    let cap_vertex_count = start_tri.points.len() + end_tri.points.len();
    let cap_index_count = start_tri.indices.len() + end_tri.indices.len();
    let side_vertex_count =
        n * 4 + lofted_hole_pairs.iter().map(|(s, _)| s.len() * 4).sum::<usize>();
    let mut mesh = Mesh::with_capacity(
        cap_vertex_count + side_vertex_count,
        cap_index_count + n * 6,
    );
    create_cap_mesh(&start_tri, 0.0, Vector3::new(0.0, 0.0, -1.0), &mut mesh);
    create_cap_mesh(&end_tri, depth, Vector3::new(0.0, 0.0, 1.0), &mut mesh);
    create_lofted_side_walls(&outer_start, &outer_end, depth, false, &mut mesh);
    for (sh, eh) in &lofted_hole_pairs {
        create_lofted_side_walls(sh, eh, depth, true, &mut mesh);
    }
    if let Some(mat) = transform {
        apply_transform(&mut mesh, &mat);
    }
    Ok(mesh)
}

/// Resample the shorter loop to the longer one's vertex count via arc-length
/// interpolation, returning owned copies of both loops at equal length.
fn match_loop_lengths(
    a: &[Point2<f64>],
    b: &[Point2<f64>],
) -> (Vec<Point2<f64>>, Vec<Point2<f64>>) {
    if a.len() == b.len() {
        return (a.to_vec(), b.to_vec());
    }
    if a.len() > b.len() {
        (a.to_vec(), resample_loop(b, a.len()))
    } else {
        (resample_loop(a, b.len()), b.to_vec())
    }
}

/// Resample a closed polyline to `target` evenly-spaced points (by arc length).
fn resample_loop(loop_pts: &[Point2<f64>], target: usize) -> Vec<Point2<f64>> {
    let n = loop_pts.len();
    if n == 0 || target == 0 {
        return Vec::new();
    }
    // Cumulative arc length around the closed loop
    let mut cum = Vec::with_capacity(n + 1);
    cum.push(0.0);
    for i in 0..n {
        let p0 = &loop_pts[i];
        let p1 = &loop_pts[(i + 1) % n];
        let d = ((p1.x - p0.x).powi(2) + (p1.y - p0.y).powi(2)).sqrt();
        cum.push(cum[i] + d);
    }
    let total = *cum.last().unwrap();
    if total <= 0.0 {
        return loop_pts.to_vec();
    }
    let mut out = Vec::with_capacity(target);
    for k in 0..target {
        let s = (k as f64 / target as f64) * total;
        // Find segment such that cum[i] <= s < cum[i+1]
        let mut i = 0;
        while i + 1 < cum.len() && cum[i + 1] <= s {
            i += 1;
        }
        if i >= n {
            i = n - 1;
        }
        let seg_len = cum[i + 1] - cum[i];
        let t = if seg_len > 0.0 { (s - cum[i]) / seg_len } else { 0.0 };
        let p0 = &loop_pts[i];
        let p1 = &loop_pts[(i + 1) % n];
        out.push(Point2::new(
            p0.x + (p1.x - p0.x) * t,
            p0.y + (p1.y - p0.y) * t,
        ));
    }
    out
}

/// Side walls between two paired loops at z=0 and z=depth.
/// `is_hole` flips winding so hole walls face inward.
fn create_lofted_side_walls(
    bottom: &[Point2<f64>],
    top: &[Point2<f64>],
    depth: f64,
    is_hole: bool,
    mesh: &mut Mesh,
) {
    let n = bottom.len();
    if n < 2 || top.len() != n {
        return;
    }
    // Orient outward by the bottom loop's winding, matching `create_side_walls`
    // so tapered faces shade the same direction as uniform extrusions in the
    // untapered limit (and outward regardless of authored winding).
    let signed_area2: f64 = (0..n)
        .map(|i| {
            let a = &bottom[i];
            let b = &bottom[(i + 1) % n];
            a.x * b.y - b.x * a.y
        })
        .sum();
    let winding_sign = if signed_area2 < 0.0 { -1.0 } else { 1.0 };
    let base_index = mesh.vertex_count() as u32;
    let mut quad_count = 0u32;
    for i in 0..n {
        let j = (i + 1) % n;
        let p0 = &bottom[i];
        let p1 = &bottom[j];
        let q0 = &top[i];
        let q1 = &top[j];
        let v0 = Point3::new(p0.x, p0.y, 0.0);
        let v1 = Point3::new(p1.x, p1.y, 0.0);
        let v2 = Point3::new(q1.x, q1.y, depth);
        let v3 = Point3::new(q0.x, q0.y, depth);
        // Outward normal from the actual 3D quad. `edge_a × edge_b` is outward
        // for a CCW loop; `winding_sign` corrects CW loops — and per
        // `Profile2D::add_hole`'s contract holes are already authored CW, so
        // this alone already leaves hole walls facing into the solid (away
        // from the loop's own interior, i.e. the void), exactly matching
        // `create_side_walls`' convention (see
        // `extrusion_generic::create_side_walls`, which applies `winding_sign`
        // ONLY, with no separate hole flip). A second `is_hole` flip here
        // used to double-flip the sign back to facing OUT of the solid, into
        // the void — confirmed by `probe_lofted_hole_normal_vs_uniform_hole_normal`,
        // which compares this path against the uniform-extrusion path in the
        // untapered limit (they must agree; they didn't).
        let edge_a = v1 - v0;
        let edge_b = v3 - v0;
        let normal = match edge_a.cross(&edge_b).try_normalize(1e-10) {
            Some(n) => n * winding_sign,
            None => continue,
        };
        let idx = base_index + (quad_count * 4);
        mesh.add_vertex(v0, normal);
        mesh.add_vertex(v1, normal);
        mesh.add_vertex(v2, normal);
        mesh.add_vertex(v3, normal);
        if is_hole {
            mesh.add_triangle(idx, idx + 2, idx + 1);
            mesh.add_triangle(idx, idx + 3, idx + 2);
        } else {
            mesh.add_triangle(idx, idx + 1, idx + 2);
            mesh.add_triangle(idx, idx + 2, idx + 3);
        }
        quad_count += 1;
    }
}


/// Apply transformation matrix to mesh
#[inline]
pub fn apply_transform(mesh: &mut Mesh, transform: &Matrix4<f64>) {
    apply_transform_generic(mesh, transform);
}


// `apply_transform_with_rtc` was deleted here: the C3.2 `pub(crate)` narrowing
// orphaned it (zero callers, production or test), so per the anti-cruft rule it
// goes rather than gain a dead-code allow. The RTC rebase runs in the
// processing orchestrator (see rust/AGENTS.md), not this per-mesh helper.

#[cfg(test)]
#[path = "extrusion_watertight_tests.rs"]
mod watertight_tests;

#[cfg(test)]
#[path = "extrusion_byte_identity_tests.rs"]
mod byte_identity_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extrusion_generic::is_approximately_circular_profile;
    use crate::profile::create_rectangle;

    #[test]
    fn test_extrude_rectangle() {
        let profile = create_rectangle(10.0, 5.0);
        let mesh = extrude_profile(&profile, 20.0, None).unwrap();

        // Should have vertices for top, bottom, and sides
        assert!(mesh.vertex_count() > 0);
        assert!(mesh.triangle_count() > 0);

        // Check bounds
        let (min, max) = mesh.bounds();
        assert!((min.x - -5.0).abs() < 0.01);
        assert!((max.x - 5.0).abs() < 0.01);
        assert!((min.y - -2.5).abs() < 0.01);
        assert!((max.y - 2.5).abs() < 0.01);
        assert!((min.z - 0.0).abs() < 0.01);
        assert!((max.z - 20.0).abs() < 0.01);
    }

    #[test]
    fn test_extrude_with_transform() {
        let profile = create_rectangle(10.0, 5.0);

        // Translation transform
        let transform = Matrix4::new_translation(&Vector3::new(100.0, 200.0, 300.0));

        let mesh = extrude_profile(&profile, 20.0, Some(transform)).unwrap();

        // Check bounds are transformed
        let (min, max) = mesh.bounds();
        assert!((min.x - 95.0).abs() < 0.01); // -5 + 100
        assert!((max.x - 105.0).abs() < 0.01); // 5 + 100
        assert!((min.y - 197.5).abs() < 0.01); // -2.5 + 200
        assert!((max.y - 202.5).abs() < 0.01); // 2.5 + 200
        assert!((min.z - 300.0).abs() < 0.01); // 0 + 300
        assert!((max.z - 320.0).abs() < 0.01); // 20 + 300
    }

    /// Assert every flat (non-cap) side-wall normal points away from the mesh's
    /// XY centroid — i.e. outward, not into the solid.
    fn assert_side_walls_outward(mesh: &Mesh) {
        let vc = mesh.vertex_count();
        let (mut cx, mut cy) = (0.0f32, 0.0f32);
        for i in 0..vc {
            cx += mesh.positions[i * 3];
            cy += mesh.positions[i * 3 + 1];
        }
        cx /= vc as f32;
        cy /= vc as f32;

        let mut checked = 0;
        for i in 0..vc {
            let nz = mesh.normals[i * 3 + 2];
            if nz.abs() >= 0.5 {
                continue; // cap vertex (normal ~ ±Z), not a side wall
            }
            let nx = mesh.normals[i * 3];
            let ny = mesh.normals[i * 3 + 1];
            let rx = mesh.positions[i * 3] - cx;
            let ry = mesh.positions[i * 3 + 1] - cy;
            let dot = nx * rx + ny * ry;
            assert!(
                dot > 0.0,
                "side-wall normal points inward at vertex {i}: n=({nx},{ny}) r=({rx},{ry}) dot={dot}"
            );
            checked += 1;
        }
        assert!(checked > 0, "expected side-wall vertices to check");
    }

    #[test]
    fn test_side_wall_normals_outward_ccw_profile() {
        // create_rectangle is CCW. Before #1006-follow-up these side-wall normals
        // pointed inward (the AC20-FZK-Haus roof slab shaded inside-out).
        let profile = create_rectangle(10.0, 6.0);
        let mesh = extrude_profile(&profile, 4.0, None).unwrap();
        assert_side_walls_outward(&mesh);
    }

    #[test]
    fn test_side_wall_normals_outward_cw_profile() {
        // The same rectangle wound clockwise. This was the previously-correct
        // case; the fix must keep CW outer walls outward (no sign regression).
        let mut pts = create_rectangle(10.0, 6.0).outer;
        pts.reverse();
        let profile = Profile2D::new(pts);
        let mesh = extrude_profile(&profile, 4.0, None).unwrap();
        assert_side_walls_outward(&mesh);
    }

    #[test]
    fn test_extrude_circle() {
        use crate::profile::create_circle;
        use crate::tessellation::TessellationQuality;

        let profile = create_circle(5.0, None, TessellationQuality::Medium);
        let mesh = extrude_profile(&profile, 10.0, None).unwrap();

        assert!(mesh.vertex_count() > 0);
        assert!(mesh.triangle_count() > 0);

        // Check it's roughly cylindrical
        let (min, max) = mesh.bounds();
        assert!((min.x - -5.0).abs() < 0.1);
        assert!((max.x - 5.0).abs() < 0.1);
        assert!((min.y - -5.0).abs() < 0.1);
        assert!((max.y - 5.0).abs() < 0.1);
    }

    #[test]
    fn test_extrude_hollow_circle() {
        use crate::profile::create_circle;
        use crate::tessellation::TessellationQuality;

        let profile = create_circle(10.0, Some(5.0), TessellationQuality::Medium);
        let mesh = extrude_profile(&profile, 15.0, None).unwrap();

        // Hollow circle should have more triangles than solid
        assert!(mesh.triangle_count() > 20);
    }

    #[test]
    fn test_invalid_depth() {
        let profile = create_rectangle(10.0, 5.0);
        let result = extrude_profile(&profile, -1.0, None);
        assert!(result.is_err());
    }

    #[test]
    fn test_circular_profile_detection() {
        use crate::profile::create_circle;
        use crate::tessellation::TessellationQuality;

        // Radius is chosen so `calculate_circle_segments` produces ≥20 points
        // (the threshold raised in #424 to stop 12-point I-beam profiles from
        // being smooth-shaded as circles). At r=10, segments = ceil(√10 * 8) = 26.
        let circle = create_circle(10.0, None, TessellationQuality::Medium);
        assert!(
            circle.outer.len() >= 20,
            "test setup expects ≥20 segments to pass the heuristic threshold; got {}",
            circle.outer.len()
        );
        let mut cx = 0.0;
        let mut cy = 0.0;
        for p in &circle.outer {
            cx += p.x;
            cy += p.y;
        }
        cx /= circle.outer.len() as f64;
        cy /= circle.outer.len() as f64;

        assert!(is_approximately_circular_profile(&circle.outer, cx, cy));
    }

    #[test]
    fn test_rectangular_profile_not_detected_as_circular() {
        let rect = create_rectangle(10.0, 5.0);
        let mut cx = 0.0;
        let mut cy = 0.0;
        for p in &rect.outer {
            cx += p.x;
            cy += p.y;
        }
        cx /= rect.outer.len() as f64;
        cy /= rect.outer.len() as f64;

        assert!(!is_approximately_circular_profile(&rect.outer, cx, cy));
    }

    #[test]
    fn test_lofted_extrusion_rectangle_to_rectangle() {
        // Start: 200x200 (centered at origin), End: 200x600 — matches the IFC
        // sample in issue #628. With Depth=2000 the bounds should be
        // (±100, -100..-100→±300, 0..2000). Caps differ in size so the side
        // walls slope outward in Y.
        let start = create_rectangle(200.0, 200.0);
        let end = create_rectangle(200.0, 600.0);
        let mesh = extrude_profile_lofted(&start, &end, 2000.0, None).unwrap();

        assert!(!mesh.is_empty());
        let (min, max) = mesh.bounds();
        assert!((min.x - -100.0).abs() < 0.01, "min.x = {}", min.x);
        assert!((max.x - 100.0).abs() < 0.01, "max.x = {}", max.x);
        // At the top the rectangle is 600 tall so reaches ±300
        assert!((min.y - -300.0).abs() < 0.01, "min.y = {}", min.y);
        assert!((max.y - 300.0).abs() < 0.01, "max.y = {}", max.y);
        assert!((min.z - 0.0).abs() < 0.01);
        assert!((max.z - 2000.0).abs() < 0.01);
    }

    #[test]
    fn test_lofted_side_walls_not_vertical_when_profiles_differ() {
        // For a tapering quad, side normals must have a non-zero Z component
        // (otherwise the cap and side normals collide and shading goes wrong).
        let start = create_rectangle(200.0, 200.0);
        let end = create_rectangle(200.0, 600.0);
        let mesh = extrude_profile_lofted(&start, &end, 2000.0, None).unwrap();

        // Skip the cap normals (first start_tri + end_tri vertices). At least
        // one side-wall vertex must have |nz| > 0 because the wall is sloped.
        let mut has_sloped_normal = false;
        for chunk in mesh.normals.chunks_exact(3) {
            if chunk[2].abs() > 1e-3 && chunk[2].abs() < 0.9999 {
                has_sloped_normal = true;
                break;
            }
        }
        assert!(
            has_sloped_normal,
            "expected at least one side-wall normal with sloped Z component"
        );
    }

    #[test]
    fn test_lofted_outer_normals_match_uniform_extrusion_convention() {
        // In the untapered limit (start == end), the lofted side-wall normals
        // must match the convention used by the uniform `extrude_profile`:
        // the radial component (in XY) points outward from the profile center.
        // Without this, tapered faces shade inverted vs regular extrusions.
        let rect = create_rectangle(200.0, 200.0);
        let lofted = extrude_profile_lofted(&rect, &rect, 1000.0, None).unwrap();
        let uniform = extrude_profile(&rect, 1000.0, None).unwrap();

        // Sample the bottom-left side-wall vertex (x = -100, y = -100, z = 0)
        // and check the XY normal sign on both meshes.
        fn radial_sign_at(mesh: &Mesh, x: f32, y: f32) -> Option<(f32, f32)> {
            for i in 0..mesh.vertex_count() {
                let px = mesh.positions[i * 3];
                let py = mesh.positions[i * 3 + 1];
                let pz = mesh.positions[i * 3 + 2];
                if (px - x).abs() < 0.5 && (py - y).abs() < 0.5 && pz < 0.5 {
                    let nx = mesh.normals[i * 3];
                    let ny = mesh.normals[i * 3 + 1];
                    if nx.abs() > 0.1 || ny.abs() > 0.1 {
                        return Some((nx, ny));
                    }
                }
            }
            None
        }
        let lofted_n = radial_sign_at(&lofted, -100.0, -100.0)
            .expect("lofted: no side-wall vertex at (-100, -100, 0)");
        let uniform_n = radial_sign_at(&uniform, -100.0, -100.0)
            .expect("uniform: no side-wall vertex at (-100, -100, 0)");
        assert!(
            lofted_n.0.signum() == uniform_n.0.signum()
                || lofted_n.1.signum() == uniform_n.1.signum(),
            "lofted normal {:?} disagrees with uniform normal {:?}",
            lofted_n,
            uniform_n,
        );
    }

    #[test]
    fn test_lofted_extrusion_invalid_depth() {
        let start = create_rectangle(10.0, 10.0);
        let end = create_rectangle(10.0, 20.0);
        assert!(extrude_profile_lofted(&start, &end, 0.0, None).is_err());
        assert!(extrude_profile_lofted(&start, &end, -1.0, None).is_err());
    }

    #[test]
    fn probe_lofted_hole_normal_vs_uniform_hole_normal() {
        // Untapered loft (start == end) with a hole must agree with uniform
        // extrusion's hole side-wall normal direction (into the void).
        let mut outer = create_rectangle(200.0, 200.0);
        let mut hole = vec![
            Point2::new(-50.0, -50.0),
            Point2::new(-50.0, 50.0),
            Point2::new(50.0, 50.0),
            Point2::new(50.0, -50.0),
        ];
        hole.reverse(); // CW per Profile2D::add_hole contract
        outer.add_hole(hole.clone());

        let uniform = extrude_profile(&outer, 1000.0, None).unwrap();
        let lofted = extrude_profile_lofted(&outer, &outer, 1000.0, None).unwrap();

        fn radial_sign_at(mesh: &Mesh, x: f32, y: f32) -> Option<(f32, f32)> {
            for i in 0..mesh.vertex_count() {
                let px = mesh.positions[i * 3];
                let py = mesh.positions[i * 3 + 1];
                let pz = mesh.positions[i * 3 + 2];
                if (px - x).abs() < 0.5 && (py - y).abs() < 0.5 && pz < 0.5 {
                    let nx = mesh.normals[i * 3];
                    let ny = mesh.normals[i * 3 + 1];
                    if nx.abs() > 0.1 || ny.abs() > 0.1 {
                        return Some((nx, ny));
                    }
                }
            }
            None
        }
        let u = radial_sign_at(&uniform, -50.0, -50.0).expect("uniform hole vertex");
        let l = radial_sign_at(&lofted, -50.0, -50.0).expect("lofted hole vertex");
        // Same physical construction (untapered loft == uniform extrusion), so
        // the two independently-computed normals must point the same way: a
        // positive dot product, not merely matching per-component signs (which
        // a harmless +0.0/-0.0 pair can fail spuriously).
        let dot = u.0 * l.0 + u.1 * l.1;
        assert!(
            dot > 0.0,
            "lofted hole normal {:?} disagrees with uniform hole normal {:?} (dot={dot})",
            l, u
        );
    }

    #[test]
    fn test_resample_loop_preserves_total_length() {
        let rect = create_rectangle(10.0, 4.0);
        let resampled = resample_loop(&rect.outer, 16);
        assert_eq!(resampled.len(), 16);
        let total: f64 = (0..resampled.len())
            .map(|i| {
                let p0 = &resampled[i];
                let p1 = &resampled[(i + 1) % resampled.len()];
                ((p1.x - p0.x).powi(2) + (p1.y - p0.y).powi(2)).sqrt()
            })
            .sum();
        // Original perimeter is 28; resampled chord-perimeter is ≤ original
        // (chords cut corners). Allow up to 5% loss.
        assert!(total > 26.5 && total <= 28.0 + 1e-6, "resampled perimeter = {}", total);
    }
}
