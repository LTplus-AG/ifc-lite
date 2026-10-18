// SPDX-License-Identifier: MPL-2.0
//! Production cap/side-wall arithmetic for an admitted host-bounded prism.
use crate::{calculate_normals, Error, Mesh, Point2, Point3, Profile2D, Result, Vector3};

/// Build a closed prism mesh given a parameterising 2D polygon (used
/// only for triangulating the caps) and the matching arrays of world-
/// space base and top vertices. `base[i]` and `top[i]` must correspond
/// to `contour_2d[i]`. Caps are tessellated using `Profile2D::triangulate`
/// on `contour_2d`, then each tri is emitted with vertices from `base`
/// (bottom) and `top` (top). Side walls connect successive base/top
/// pairs into quads.
pub(super) fn build_tilted_prism_mesh(
    contour_2d: &[Point2<f64>],
    base_world: &[Point3<f64>],
    top_world: &[Point3<f64>],
) -> Result<Mesh> {
    if base_world.len() != contour_2d.len() || top_world.len() != contour_2d.len() {
        return Err(Error::geometry(
            "Polygonal bounded half-space cap arrays must match contour length"
                .to_string(),
        ));
    }

    let profile = Profile2D::new(contour_2d.to_vec());
    let triangulation = profile.triangulate()?;

    // Map each triangulation vertex back to the corresponding world-space
    // base/top vertex. `triangulation.points` contains the contour
    // vertices in the same order they were supplied (earcutr does not
    // permute the inputs for a simple polygon), so positional indexing
    // works as long as we account for any re-ordering by re-finding the
    // closest contour point if needed.
    //
    // In practice, triangulation.points == contour_2d for our inputs,
    // so we look up each tri-point by index identity into contour_2d.
    let mut tri_to_contour: Vec<usize> = Vec::with_capacity(triangulation.points.len());
    for tp in &triangulation.points {
        // Find the contour vertex whose 2D coordinates match this
        // triangulation vertex (within a small epsilon).
        let mut best = 0usize;
        let mut best_d = f64::INFINITY;
        for (i, cp) in contour_2d.iter().enumerate() {
            let d = (tp.x - cp.x).powi(2) + (tp.y - cp.y).powi(2);
            if d < best_d {
                best_d = d;
                best = i;
            }
        }
        tri_to_contour.push(best);
    }

    let mut mesh = Mesh::with_capacity(
        base_world.len() * 2 + contour_2d.len() * 4,
        triangulation.indices.len() * 2 + contour_2d.len() * 6,
    );
    let zero = Vector3::new(0.0, 0.0, 0.0);

    let push_triangle = |mesh: &mut Mesh, a: Point3<f64>, b: Point3<f64>, c: Point3<f64>| {
        let base_idx = mesh.vertex_count() as u32;
        mesh.add_vertex(a, zero);
        mesh.add_vertex(b, zero);
        mesh.add_vertex(c, zero);
        mesh.indices.extend_from_slice(&[base_idx, base_idx + 1, base_idx + 2]);
    };

    // Earcut NORMALISES its output winding (its linked list re-orients the
    // ring to a fixed orientation), while the side walls below — and the
    // caller's world-normal correction — follow the RAW `contour_2d`
    // order. For a CLOCKWISE contour the caps therefore come out wound
    // against the side walls: BOTH end caps of the prism face INWARD and
    // the boolean sees an open, self-inconsistent cutter (advanced_model
    // PBHS #553001: the 300 mm slot clip leaked +0.018 m³ and left an
    // unpaired quad). Detect the mismatch by comparing the contour's
    // shoelace sign with the orientation of the first non-degenerate
    // output triangle, and flip cap emission so caps and side walls
    // always agree.
    let n = contour_2d.len();
    let shoelace2: f64 = (0..n)
        .map(|i| {
            let p = &contour_2d[i];
            let q = &contour_2d[(i + 1) % n];
            p.x * q.y - q.x * p.y
        })
        .sum();
    let mut flip_caps = false;
    for indices in triangulation.indices.chunks_exact(3) {
        let p0 = &triangulation.points[indices[0]];
        let p1 = &triangulation.points[indices[1]];
        let p2 = &triangulation.points[indices[2]];
        let cross = (p1.x - p0.x) * (p2.y - p0.y) - (p2.x - p0.x) * (p1.y - p0.y);
        if cross != 0.0 {
            flip_caps = (cross > 0.0) != (shoelace2 > 0.0);
            break;
        }
    }

    for indices in triangulation.indices.chunks_exact(3) {
        let (i0, i1, i2) = if flip_caps {
            (
                tri_to_contour[indices[2]],
                tri_to_contour[indices[1]],
                tri_to_contour[indices[0]],
            )
        } else {
            (
                tri_to_contour[indices[0]],
                tri_to_contour[indices[1]],
                tri_to_contour[indices[2]],
            )
        };

        // Base cap faces away from the extruded volume.
        push_triangle(&mut mesh, base_world[i2], base_world[i1], base_world[i0]);
        // Top cap faces in the extrusion direction.
        push_triangle(&mut mesh, top_world[i0], top_world[i1], top_world[i2]);
    }

    for i in 0..base_world.len() {
        let next = (i + 1) % base_world.len();
        let b0 = base_world[i];
        let b1 = base_world[next];
        let t0 = top_world[i];
        let t1 = top_world[next];

        push_triangle(&mut mesh, b0, b1, t1);
        push_triangle(&mut mesh, b0, t1, t0);
    }

    calculate_normals(&mut mesh);
    Ok(mesh)
}

