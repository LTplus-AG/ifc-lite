// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Cross-section interpolation and mesh emission for
//! `IfcSectionedSolidHorizontal` (see `sectioned.rs`).
//!
//! A cross-section is a list of regions (one per area of a composite
//! profile, #7685), each an outer ring plus its holes. Every ring of every
//! region is placed, stitched and capped: hollow sections (box girders,
//! pipes) were lofted from the outer ring alone and rendered solid
//! (PROC-AL-5). Walls follow the shared extrusion rule
//! (`outward_is_right_hand`), so they face out of the solid for either
//! authored winding and either frame handedness.

use nalgebra::{Point2, Point3, Vector3};

use crate::{
    alignment::AlignmentFrame,
    extrusion_generic::{outward_is_right_hand, Ring},
    triangulation::triangulate_polygon_with_holes,
    Mesh, Profile2D, Result,
};

/// One station's cross-section: its regions, each with its holes.
pub(super) type Section = Vec<Profile2D>;

/// `region` with the rings that cannot bound an area (< 3 points) dropped,
/// so ring slots, walls and the cap triangulation agree on the ring list.
pub(super) fn clean_region(mut region: Profile2D) -> Option<Profile2D> {
    if region.outer.len() < 3 {
        return None;
    }
    region.holes.retain(|h| h.len() >= 3);
    Some(region)
}

/// The rings of `region` in triangulation order: outer, then every hole.
fn rings(region: &Profile2D) -> impl Iterator<Item = (&[Point2<f64>], Ring)> {
    std::iter::once((region.outer.as_slice(), Ring::Outer))
        .chain(region.holes.iter().map(|h| (h.as_slice(), Ring::Hole)))
}

/// `true` when `a` and `b` have the same regions with the same ring sizes,
/// so their vertices correspond one to one.
pub(super) fn same_topology(a: &[Profile2D], b: &[Profile2D]) -> bool {
    a.len() == b.len()
        && a.iter().zip(b).all(|(ra, rb)| {
            ra.holes.len() == rb.holes.len()
                && rings(ra).zip(rings(rb)).all(|((x, _), (y, _))| x.len() == y.len())
        })
}

/// Linear blend of two sections by `t ∈ [0, 1]`, vertex by vertex. Sections
/// of different topology fall back to the nearer endpoint, so consecutive
/// samples either correspond or are an authored topology change.
pub(super) fn interpolate_section(a: &[Profile2D], b: &[Profile2D], t: f64) -> Section {
    if !same_topology(a, b) {
        return if t < 0.5 { a.to_vec() } else { b.to_vec() };
    }
    let lerp = |x: &[Point2<f64>], y: &[Point2<f64>]| -> Vec<Point2<f64>> {
        x.iter()
            .zip(y)
            .map(|(p, q)| Point2::new(p.x * (1.0 - t) + q.x * t, p.y * (1.0 - t) + q.y * t))
            .collect()
    };
    a.iter()
        .zip(b)
        .map(|(ra, rb)| Profile2D {
            outer: lerp(&ra.outer, &rb.outer),
            holes: ra.holes.iter().zip(&rb.holes).map(|(x, y)| lerp(x, y)).collect(),
        })
        .collect()
}

/// Every ring of every region of `section`, placed in 3D by `frame`:
/// `[region][ring][vertex]`, rings in triangulation order.
pub(super) fn place_section(section: &[Profile2D], frame: &AlignmentFrame) -> Vec<Vec<Vec<Point3<f64>>>> {
    section
        .iter()
        .map(|region| {
            rings(region)
                .map(|(ring, _)| {
                    ring.iter()
                        .map(|p| frame.origin + frame.right * p.x + frame.up * p.y)
                        .collect()
                })
                .collect()
        })
        .collect()
}

/// Cap every region of `section`: the outer ring with its holes, triangulated
/// once, each triangle wound counter-clockwise in the profile plane (the
/// fast-path and earcut orders differ) and then kept (`forward`, front face
/// along the frame's `right × up`) or flipped. `normal` is the shading normal.
pub(super) fn emit_caps(
    mesh: &mut Mesh,
    section: &[Profile2D],
    placed: &[Vec<Vec<Point3<f64>>>],
    normal: Vector3<f64>,
    forward: bool,
) -> Result<()> {
    for (region, placed_rings) in section.iter().zip(placed) {
        let indices = triangulate_polygon_with_holes(&region.outer, &region.holes)?;
        let points: Vec<Point2<f64>> = rings(region).flat_map(|(r, _)| r.iter().copied()).collect();
        let base = (mesh.positions.len() / 3) as u32;
        for p in placed_rings.iter().flatten() {
            mesh.add_vertex(*p, normal);
        }
        for tri in indices.chunks_exact(3) {
            let (a, b, c) = (tri[0], tri[1], tri[2]);
            let ccw = (points[b] - points[a]).perp(&(points[c] - points[a])) >= 0.0;
            let (a, b, c) = (base + a as u32, base + b as u32, base + c as u32);
            if ccw == forward {
                mesh.add_triangle(a, b, c);
            } else {
                mesh.add_triangle(a, c, b);
            }
        }
    }
    Ok(())
}

/// Stitch two placements of the same-topology `section` with one quad per
/// ring edge. `flip` is set for a mirrored frame (`right × up` against the
/// tangent), which reverses what "outward" means for the planar rule.
pub(super) fn emit_side_walls(
    mesh: &mut Mesh,
    section: &[Profile2D],
    prev: &[Vec<Vec<Point3<f64>>>],
    this: &[Vec<Vec<Point3<f64>>>],
    flip: bool,
) {
    for ((region, prev_rings), this_rings) in section.iter().zip(prev).zip(this) {
        for (((ring, kind), prev_ring), this_ring) in rings(region).zip(prev_rings).zip(this_rings) {
            let reverse = !outward_is_right_hand(ring, kind);
            stitch_ring(mesh, ring, prev_ring, this_ring, flip, reverse);
        }
    }
}

/// One ring's wall quads. `flip` picks the quad's corner order, and with it
/// the diagonal that splits a twisted (non-planar) quad, by frame handedness
/// alone; that order faces out for a right-hand ring. `reverse` then flips
/// the winding of both triangles, never the diagonal, so the surface (and the
/// volume) does not depend on the authored winding.
fn stitch_ring(
    mesh: &mut Mesh,
    ring: &[Point2<f64>],
    prev_ring: &[Point3<f64>],
    this_ring: &[Point3<f64>],
    flip: bool,
    reverse: bool,
) {
    let n = prev_ring.len();
    if n < 2 || this_ring.len() != n {
        return;
    }
    for j in 0..n {
        let j1 = (j + 1) % n;
        // A repeated vertex (the closing point many exporters write) is a
        // zero-length edge whose zero-area "quad" would run both ways along
        // the seam. Skip it, as `create_side_walls` does.
        if (ring[j1] - ring[j]).norm_squared() < 1e-20 {
            continue;
        }
        let (p0, p1, p2, p3) = if flip {
            (prev_ring[j1], prev_ring[j], this_ring[j], this_ring[j1])
        } else {
            (prev_ring[j], prev_ring[j1], this_ring[j1], this_ring[j])
        };
        let n_face = compute_face_normal(&p0, &p1, &p2);
        let n_face = if reverse { -n_face } else { n_face };
        let v_base = (mesh.positions.len() / 3) as u32;
        mesh.add_vertex(p0, n_face);
        mesh.add_vertex(p1, n_face);
        mesh.add_vertex(p2, n_face);
        mesh.add_vertex(p3, n_face);
        if reverse {
            mesh.add_triangle(v_base, v_base + 2, v_base + 1);
            mesh.add_triangle(v_base, v_base + 3, v_base + 2);
        } else {
            mesh.add_triangle(v_base, v_base + 1, v_base + 2);
            mesh.add_triangle(v_base, v_base + 2, v_base + 3);
        }
    }
}

fn compute_face_normal(a: &Point3<f64>, b: &Point3<f64>, c: &Point3<f64>) -> Vector3<f64> {
    let ab = b - a;
    let ac = c - a;
    let n = ab.cross(&ac);
    let len = n.norm();
    if len > 1e-12 {
        n / len
    } else {
        Vector3::new(0.0, 0.0, 1.0)
    }
}
