// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The extrusion mesher, generic over the scalar (B4.4).
//!
//! `extrusion::extrude_profile` and `extrusion::apply_transform` are the `f64`
//! instantiations of the functions here, and are the only non-test
//! instantiations in the tree. Split out of `extrusion.rs` to keep both files
//! inside the module-size ratchet; the code is otherwise unchanged, and
//! `extrusion_byte_identity_tests` asserts it bit-for-bit against verbatim
//! copies of the pre-generic implementations.

use crate::error::{Error, Result};
use crate::profile::TriangulationOf;
use crate::scalar::{magnitude_squared3, transform_point4, try_normalize3, GeomScalar, MeshSink};
use nalgebra::{Matrix4, Point2, Point3, Vector3};

/// The body of [`extrude_profile`], generic over the scalar and the mesh sink.
///
/// This is the production extrusion mesher; `extrude_profile` is the `f64`
/// instantiation of it and nothing else. The generic form exists so the B4.4
/// kernel-adjoint spike can run the *same* code with a forward-mode dual
/// number and obtain exact derivatives of every emitted vertex coordinate.
/// Every branch is taken on the primal value, so the `f64` monomorphisation is
/// bit-identical to the pre-generic code (asserted in `byte_identity_tests`).
#[inline]
pub(crate) fn extrude_rings_into<S: GeomScalar, M: MeshSink<S>>(
    outer: &[Point2<S>],
    holes: &[Vec<Point2<S>>],
    depth: S,
    transform: Option<Matrix4<S>>,
    mesh: &mut M,
) -> Result<()> {
    if depth.value() <= 0.0 {
        return Err(Error::InvalidExtrusion(
            "Depth must be positive".to_string(),
        ));
    }

    // Check if profile has extreme aspect ratio (very elongated)
    // This detects profiles like railings that span building perimeters
    // and would create stretched triangles when triangulated
    let should_skip_caps = profile_has_extreme_aspect_ratio(outer);

    // Triangulate profile (only if we need caps)
    let triangulation = if should_skip_caps {
        None
    } else {
        Some(crate::profile::triangulate_rings(outer, holes)?)
    };

    // Create mesh
    let cap_vertex_count = triangulation
        .as_ref()
        .map(|t| t.points.len() * 2)
        .unwrap_or(0);
    let side_vertex_count = outer.len() * 2;
    let total_vertices = cap_vertex_count + side_vertex_count;

    let cap_index_count = triangulation
        .as_ref()
        .map(|t| t.indices.len() * 2)
        .unwrap_or(0);
    mesh.reserve(total_vertices, cap_index_count + outer.len() * 6);

    // Create top and bottom caps (skip for extreme aspect ratio profiles)
    if let Some(ref tri) = triangulation {
        create_cap_mesh(
            tri,
            S::from_f64(0.0),
            Vector3::new(S::from_f64(0.0), S::from_f64(0.0), S::from_f64(-1.0)),
            mesh,
        );
        create_cap_mesh(
            tri,
            depth,
            Vector3::new(S::from_f64(0.0), S::from_f64(0.0), S::from_f64(1.0)),
            mesh,
        );
    }

    // Create side walls
    create_side_walls(outer, depth, mesh);

    // Create side walls for holes
    for hole in holes {
        create_side_walls(hole, depth, mesh);
    }

    // Apply transformation if provided
    if let Some(mat) = transform {
        apply_transform_generic(mesh, &mat);
    }

    Ok(())
}

/// Check if a profile has an extreme aspect ratio (very elongated shape)
/// Returns true if the profile is so disproportionate the extrusion caps
/// can't be emitted as a meaningful filled face.
///
/// Originally the threshold was 100:1 — that catches NORMAL residential
/// walls (a 115 mm × 11.8 m wall profile has ratio 103) and drops their
/// top/bottom caps, which then makes the wall a hollow tube and breaks
/// downstream boolean cuts (the opening AABB clip can no longer find
/// triangles to remove on the cap faces — see advanced_model #612315 /
/// calibration class 3). Long thin building elements (curtain-wall
/// mullions, railings, MEP runs) routinely have aspect ratios in the
/// 100–1000 range.
///
/// Raised to 10000:1 so only genuinely pathological profiles (e.g. a
/// 1 mm × 10 m strip that signals an authoring bug, not a real cross-
/// section) trigger cap-skipping. The existing 1 mm absolute-dimension
/// floor below still rejects degenerate input.
#[inline]
pub(crate) fn profile_has_extreme_aspect_ratio<S: GeomScalar>(outer: &[Point2<S>]) -> bool {
    if outer.len() < 3 {
        return false;
    }

    // Calculate bounding box
    let mut min_x = S::from_f64(f64::MAX);
    let mut max_x = S::from_f64(f64::MIN);
    let mut min_y = S::from_f64(f64::MAX);
    let mut max_y = S::from_f64(f64::MIN);

    for p in outer {
        min_x = min_x.min(p.x);
        max_x = max_x.max(p.x);
        min_y = min_y.min(p.y);
        max_y = max_y.max(p.y);
    }

    let width = max_x - min_x;
    let height = max_y - min_y;

    // Skip if dimensions are too small to measure
    if width.value() < 0.001 || height.value() < 0.001 {
        return false;
    }

    let aspect_ratio = (width / height).max(height / width);

    // Skip caps only for truly pathological profiles. Real building
    // elements (walls, slabs, mullions, railings) routinely sit in the
    // 100–1000 range; only profiles 4 orders of magnitude apart in
    // their two dimensions are likely authoring artefacts where the
    // caps wouldn't survive numerical precision anyway.
    aspect_ratio.value() > 10000.0
}

/// Create a cap mesh (top or bottom) from triangulation
#[inline]
pub(crate) fn create_cap_mesh<S: GeomScalar, M: MeshSink<S>>(
    triangulation: &TriangulationOf<S>,
    z: S,
    normal: Vector3<S>,
    mesh: &mut M,
) {
    let base_index = mesh.vertex_count() as u32;

    // Add vertices
    for point in &triangulation.points {
        mesh.add_vertex(Point3::new(point.x, point.y, z), normal);
    }

    // Add triangles
    for i in (0..triangulation.indices.len()).step_by(3) {
        if i + 2 >= triangulation.indices.len() {
            break;
        }
        let i0 = base_index + triangulation.indices[i] as u32;
        let i1 = base_index + triangulation.indices[i + 1] as u32;
        let i2 = base_index + triangulation.indices[i + 2] as u32;

        // Reverse winding for bottom cap
        if z.value() == 0.0 {
            mesh.add_triangle(i0, i2, i1);
        } else {
            mesh.add_triangle(i0, i1, i2);
        }
    }
}

/// Create side walls for a profile boundary
#[inline]
pub(crate) fn create_side_walls<S: GeomScalar, M: MeshSink<S>>(
    boundary: &[nalgebra::Point2<S>],
    depth: S,
    mesh: &mut M,
) {
    let n = boundary.len();
    if n < 2 {
        return;
    }

    // Compute centroid of profile for smooth radial normals
    let mut cx = S::from_f64(0.0);
    let mut cy = S::from_f64(0.0);
    for p in boundary.iter() {
        cx = cx + p.x;
        cy = cy + p.y;
    }
    cx = cx / S::from_f64(n as f64);
    cy = cy / S::from_f64(n as f64);

    // Smooth radial normals are correct for circular-ish profiles, but produce
    // incorrect shading on rectangular/polygonal extrusions.
    let use_smooth_radial_normals = is_approximately_circular_profile(boundary, cx, cy);
    let vertex_normals: Vec<Vector3<S>> = if use_smooth_radial_normals {
        boundary
            .iter()
            .map(|p| {
                try_normalize3(
                    &Vector3::new(p.x - cx, p.y - cy, S::from_f64(0.0)),
                    1e-10,
                )
                .unwrap_or(Vector3::new(
                    S::from_f64(0.0),
                    S::from_f64(0.0),
                    S::from_f64(1.0),
                ))
            })
            .collect()
    } else {
        Vec::new()
    };

    // Orient the flat side-wall normals outward regardless of the profile's
    // authored winding. An edge's cross-section normal is one of its two
    // in-plane perpendiculars; which one points *out* of the solid depends on
    // the loop's winding, so key it off the signed area (CCW > 0). Without
    // this, a CCW-authored outer profile (e.g. the AC20-FZK-Haus roof slab,
    // issue #1006 follow-up) got inward-facing side-wall normals and shaded
    // inside-out under the renderer's normal-based, double-sided lighting.
    // Holes are passed with the opposite (CW) winding, which flips the sign so
    // their walls keep facing into the void — byte-identical to the previous
    // behaviour for negative-area loops.
    let signed_area2: S = (0..n)
        .map(|i| {
            let a = &boundary[i];
            let b = &boundary[(i + 1) % n];
            a.x * b.y - b.x * a.y
        })
        .fold(S::from_f64(0.0), |acc, t| acc + t);
    let winding_sign = S::from_f64(if signed_area2.value() < 0.0 { -1.0 } else { 1.0 });

    let base_index = mesh.vertex_count() as u32;
    let mut quad_count = 0u32;

    for i in 0..n {
        let j = (i + 1) % n;

        let p0 = &boundary[i];
        let p1 = &boundary[j];

        // Skip degenerate edges (duplicate consecutive points)
        let edge = Vector3::new(p1.x - p0.x, p1.y - p0.y, S::from_f64(0.0));
        if magnitude_squared3(&edge).value() < 1e-20 {
            continue;
        }

        // Right-hand perpendicular (edge.y, -edge.x) is outward for a CCW loop;
        // `winding_sign` corrects it for CW loops (and holes).
        let flat_normal = try_normalize3(
            &Vector3::new(edge.y, -edge.x, S::from_f64(0.0)),
            1e-10,
        )
        .map(|v| Vector3::new(v.x * winding_sign, v.y * winding_sign, v.z * winding_sign))
        .unwrap_or(Vector3::new(
            S::from_f64(0.0),
            S::from_f64(0.0),
            S::from_f64(1.0),
        ));
        let n0 = if use_smooth_radial_normals {
            vertex_normals[i]
        } else {
            flat_normal
        };
        let n1 = if use_smooth_radial_normals {
            vertex_normals[j]
        } else {
            flat_normal
        };

        // Bottom vertices
        let v0_bottom = Point3::new(p0.x, p0.y, S::from_f64(0.0));
        let v1_bottom = Point3::new(p1.x, p1.y, S::from_f64(0.0));

        // Top vertices
        let v0_top = Point3::new(p0.x, p0.y, depth);
        let v1_top = Point3::new(p1.x, p1.y, depth);

        // Add 4 vertices with smooth per-vertex normals
        let idx = base_index + (quad_count * 4);
        mesh.add_vertex(v0_bottom, n0);
        mesh.add_vertex(v1_bottom, n1);
        mesh.add_vertex(v1_top, n1);
        mesh.add_vertex(v0_top, n0);

        // Add 2 triangles for the quad, wound CONSISTENTLY with the caps.
        //
        // The caps are emitted assuming a CCW (positive-area) outer loop: the
        // top cap keeps the triangulation winding (+Z outward), the bottom is
        // reversed (−Z outward). The side-wall quad must close that surface with
        // the SAME outward orientation, or the cap↔wall shared edges run the same
        // direction instead of cancelling — a closed but winding-INCONSISTENT
        // solid whose exact-kernel boolean leaves open rim edges (the #1007
        // gable-wall residue: a CW-authored wall profile extruded along +Z).
        // `winding_sign` (CCW>0) selects the matching face order; for a CW loop
        // we mirror the quad so the closed solid is consistently outward,
        // byte-identical to before for the common CCW case.
        if winding_sign.value() > 0.0 {
            mesh.add_triangle(idx, idx + 1, idx + 2);
            mesh.add_triangle(idx, idx + 2, idx + 3);
        } else {
            mesh.add_triangle(idx, idx + 2, idx + 1);
            mesh.add_triangle(idx, idx + 3, idx + 2);
        }

        quad_count += 1;
    }
}


/// Heuristic for detecting circular-ish profiles from boundary points.
///
/// Circular profiles generated from IFC circles typically have many segments with
/// low radial variance relative to the centroid. Rectangles/most polygons do not.
#[inline]
pub(crate) fn is_approximately_circular_profile<S: GeomScalar>(
    boundary: &[Point2<S>],
    cx: S,
    cy: S,
) -> bool {
    if boundary.len() < 20 {
        return false;
    }

    let mut radii: Vec<S> = Vec::with_capacity(boundary.len());
    for p in boundary {
        let dx = p.x - cx;
        let dy = p.y - cy;
        let r = (dx * dx + dy * dy).sqrt();
        if !r.is_finite() || r.value() < 1e-9 {
            return false;
        }
        radii.push(r);
    }

    let mean = radii.iter().fold(S::from_f64(0.0), |acc, r| acc + *r)
        / S::from_f64(radii.len() as f64);
    if mean.value() < 1e-9 {
        return false;
    }

    let variance = radii
        .iter()
        .map(|r| {
            let d = *r - mean;
            d * d
        })
        .fold(S::from_f64(0.0), |acc, t| acc + t)
        / S::from_f64(radii.len() as f64);
    let std_dev = variance.sqrt();
    let coeff_var = std_dev / mean;

    coeff_var.value() < 0.15
}

/// The body of [`apply_transform`], generic over the scalar and the mesh sink.
///
/// Positions go through the shared [`transform_point4`] (bit-identical to
/// nalgebra's `Matrix4::transform_point`, asserted in `scalar::tests`); the
/// normal buffer is the sink's business because it needs a 4x4 inverse and
/// never enters the divergence-theorem volume.
#[inline]
pub(crate) fn apply_transform_generic<S: GeomScalar, M: MeshSink<S>>(
    mesh: &mut M,
    transform: &Matrix4<S>,
) {
    for i in 0..mesh.vertex_count() {
        let p = mesh.position(i);
        mesh.set_position(i, transform_point4(transform, &p));
    }
    mesh.transform_normals(transform);
}
