// SPDX-License-Identifier: MPL-2.0
//! A building's footprint: the outline of the vertical projection of its
//! element meshes.
//!
//! Each element is outlined by `ifc_lite_geometry::projection_outline::
//! mesh_outline_2d` (the winding-independent i_overlay union of its projected
//! triangles, the plan-drawing projection path), and the element outlines are
//! unioned with the same engine. The result is the exact maximal horizontal
//! extent of the building's walls, slabs, roofs and installations: where an
//! upper storey or a roof overhangs, the outline follows the overhang. No
//! generalisation is applied beyond dropping vertices within half a grid
//! step of a straight line.
//!
//! An element with more than `MAX_OVERLAY_TRIANGLES` projected triangles is
//! not outlined exactly (the helper refuses it to bound union time); its
//! convex hull is used instead and counted in [`Footprint::approximated`] so
//! the caller can say so.

use i_overlay::core::fill_rule::FillRule;
use i_overlay::core::overlay_rule::OverlayRule;
use i_overlay::float::single::SingleFloatOverlay;
use ifc_lite_geometry::projection_outline::{mesh_outline_2d, NoOutline, ProjectionAxis};
use ifc_lite_processing::MeshData;

/// One polygon of a footprint: the exterior ring (counter-clockwise seen
/// from above) followed by its holes (clockwise), in IFC world XY metres.
pub(super) type Shape = Vec<Vec<[f64; 2]>>;

pub(super) struct Footprint {
    pub shapes: Vec<Shape>,
    /// Lowest and highest world Z over the outlined meshes, metres.
    pub z_min: f64,
    pub z_max: f64,
    /// Elements outlined by their convex hull instead of exactly.
    pub approximated: usize,
}

/// The footprint of `meshes`, or `None` when none of them projects to an area.
/// `world` maps a baked mesh point (`origin + position`) to IFC world metres;
/// `tolerance` is the collinearity tolerance in metres.
pub(super) fn footprint(meshes: &[&MeshData], world: impl Fn([f64; 3]) -> [f64; 3], tolerance: f64) -> Option<Footprint> {
    let anchor = meshes.iter().find_map(|m| m.positions.get(..3).map(|p| world(point(m, p))))?;
    let mut z_min = f64::INFINITY;
    let mut z_max = f64::NEG_INFINITY;
    let mut approximated = 0;
    let mut outlines: Vec<Vec<Vec<[f64; 2]>>> = Vec::new();
    let mut local: Vec<f32> = Vec::new();
    for m in meshes {
        local.clear();
        for p in m.positions.chunks_exact(3) {
            let w = world(point(m, p));
            z_min = z_min.min(w[2]);
            z_max = z_max.max(w[2]);
            local.extend([(w[0] - anchor[0]) as f32, (w[1] - anchor[1]) as f32, (w[2] - anchor[2]) as f32]);
        }
        match mesh_outline_2d(&local, &m.indices, ProjectionAxis::Z, false) {
            Ok(outline) => outlines.push(
                outline.contours.iter().map(|ring| ring.iter().map(|q| [q[0] as f64, q[1] as f64]).collect()).collect(),
            ),
            Err(NoOutline::OverBudget { .. }) => {
                let pts: Vec<[f64; 2]> = local.chunks_exact(3).map(|p| [p[0] as f64, p[1] as f64]).collect();
                if let Some(hull) = convex_hull(pts) {
                    outlines.push(vec![hull]);
                    approximated += 1;
                }
            }
            Err(NoOutline::Empty) => {}
        }
    }
    let mut outlines = outlines.into_iter().filter(|o| !o.is_empty());
    let subject: Vec<Vec<[f64; 2]>> = outlines.next()?;
    let mut clip: Vec<Vec<[f64; 2]>> = outlines.flatten().collect();
    if clip.is_empty() {
        // i_overlay needs a clip to union; a shape unioned with itself is
        // the shape, regrouped into exterior rings and their holes.
        clip = subject.clone();
    }
    let unioned = subject.overlay(&clip, OverlayRule::Union, FillRule::NonZero);
    let shapes: Vec<Shape> = unioned
        .into_iter()
        .filter_map(|shape| {
            let mut rings = shape.into_iter().filter_map(|ring| simplify(ring, tolerance));
            let mut outer = rings.next()?;
            orient(&mut outer, true);
            let mut out = vec![outer];
            for mut hole in rings {
                orient(&mut hole, false);
                out.push(hole);
            }
            Some(out.into_iter().map(|ring| ring.into_iter().map(|q| [q[0] + anchor[0], q[1] + anchor[1]]).collect()).collect())
        })
        .collect();
    (!shapes.is_empty()).then_some(Footprint { shapes, z_min, z_max, approximated })
}

#[inline]
fn point(m: &MeshData, p: &[f32]) -> [f64; 3] {
    [m.origin[0] + p[0] as f64, m.origin[1] + p[1] as f64, m.origin[2] + p[2] as f64]
}

/// Twice the signed area (positive counter-clockwise), relative to the
/// first vertex: products of large absolute coordinates (map-scale IFC
/// world positions) would cancel a small ring's area away.
pub(super) fn signed_area2(ring: &[[f64; 2]]) -> f64 {
    let n = ring.len();
    let Some(&o) = ring.first() else { return 0.0 };
    (0..n).map(|i| {
        let (a, b) = (ring[i], ring[(i + 1) % n]);
        let (a, b) = ([a[0] - o[0], a[1] - o[1]], [b[0] - o[0], b[1] - o[1]]);
        a[0] * b[1] - b[0] * a[1]
    }).sum()
}

fn orient(ring: &mut [[f64; 2]], ccw: bool) {
    if (signed_area2(ring) > 0.0) != ccw {
        ring.reverse();
    }
}

/// Drop vertices closer than `tolerance` to the line through their
/// neighbours, repeatedly, and the ring itself when it encloses no area.
fn simplify(mut ring: Vec<[f64; 2]>, tolerance: f64) -> Option<Vec<[f64; 2]>> {
    let mut changed = true;
    while changed && ring.len() >= 3 {
        changed = false;
        let mut i = 0;
        while i < ring.len() && ring.len() >= 3 {
            let n = ring.len();
            let (a, p, b) = (ring[(i + n - 1) % n], ring[i], ring[(i + 1) % n]);
            let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
            let len = dx.hypot(dy);
            let off = if len > 0.0 {
                ((p[0] - a[0]) * dy - (p[1] - a[1]) * dx).abs() / len
            } else {
                (p[0] - a[0]).hypot(p[1] - a[1])
            };
            if off < tolerance {
                ring.remove(i);
                changed = true;
            } else {
                i += 1;
            }
        }
    }
    (ring.len() >= 3 && signed_area2(&ring).abs() > tolerance * tolerance).then_some(ring)
}

/// Andrew's monotone chain, counter-clockwise; `None` under three hull points.
fn convex_hull(mut pts: Vec<[f64; 2]>) -> Option<Vec<[f64; 2]>> {
    pts.retain(|p| p[0].is_finite() && p[1].is_finite());
    pts.sort_by(|a, b| a[0].total_cmp(&b[0]).then(a[1].total_cmp(&b[1])));
    pts.dedup();
    if pts.len() < 3 {
        return None;
    }
    let cross = |o: [f64; 2], a: [f64; 2], b: [f64; 2]| (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    let mut hull: Vec<[f64; 2]> = Vec::with_capacity(pts.len() * 2);
    for pass in 0..2 {
        let start = hull.len();
        let iter: Box<dyn Iterator<Item = &[f64; 2]>> = if pass == 0 { Box::new(pts.iter()) } else { Box::new(pts.iter().rev()) };
        for &p in iter {
            while hull.len() >= start + 2 && cross(hull[hull.len() - 2], hull[hull.len() - 1], p) <= 0.0 {
                hull.pop();
            }
            hull.push(p);
        }
        hull.pop();
    }
    (hull.len() >= 3).then_some(hull)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hull_of_a_square_with_an_interior_point() {
        let hull = convex_hull(vec![[0.0, 0.0], [2.0, 0.0], [1.0, 1.0], [2.0, 2.0], [0.0, 2.0]]).unwrap();
        assert_eq!(hull.len(), 4);
        assert!(signed_area2(&hull) > 0.0);
        assert!((signed_area2(&hull) - 8.0).abs() < 1e-12);
    }

    #[test]
    fn simplify_drops_collinear_vertices_only() {
        let ring = vec![[0.0, 0.0], [1.0, 0.0], [2.0, 0.0], [2.0, 2.0], [0.0, 2.0]];
        assert_eq!(simplify(ring, 1e-4).unwrap(), vec![[0.0, 0.0], [2.0, 0.0], [2.0, 2.0], [0.0, 2.0]]);
    }
}
