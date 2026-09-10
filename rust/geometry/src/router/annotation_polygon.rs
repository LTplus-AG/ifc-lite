// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Bounded planar polygon validation before the canonical triangulator (#4406).
use super::annotation::invalid;
use crate::{Mesh, Result};
use nalgebra::{Point2, Point3};

type P = Point2<f64>;

pub(super) fn triangulate(rings: &[Vec<Point3<f64>>]) -> Result<Mesh> {
    let outer = &rings[0];
    let origin = outer[0];
    let extent = rings
        .iter()
        .flatten()
        .map(|p| (p - origin).norm())
        .fold(0., f64::max);
    if !extent.is_finite() || extent <= 0. {
        return Err(invalid("degenerate extent"));
    }
    let tolerance = extent * 1e-10;
    let edge = outer[1] - origin;
    if edge.norm() <= tolerance {
        return Err(invalid("duplicate boundary vertex"));
    }
    let u = edge.normalize();
    let normal = outer
        .iter()
        .skip(2)
        .map(|p| u.cross(&(p - origin)))
        .max_by(|a, b| a.norm_squared().total_cmp(&b.norm_squared()))
        .filter(|n| n.norm() > tolerance)
        .ok_or_else(|| invalid("collinear boundary"))?
        .normalize();
    let v = normal.cross(&u);
    let mut projected = Vec::with_capacity(rings.len());
    for ring in rings {
        let mut pts = Vec::with_capacity(ring.len());
        for p in ring {
            let local = p - origin;
            if local.dot(&normal).abs() > tolerance {
                return Err(invalid("nonplanar boundaries"));
            }
            pts.push(P::new(local.dot(&u), local.dot(&v)));
        }
        projected.push(pts);
    }
    validate(&projected)?;
    let indices =
        crate::triangulation::triangulate_polygon_with_holes(&projected[0], &projected[1..])?;
    let mut mesh = Mesh::new();
    // Match the existing processor contract: file-unit local coordinates;
    // canonical router scaling and placement own the world/RTC conversion.
    for ring in rings {
        for p in ring {
            mesh.add_vertex(*p, normal);
        }
    }
    mesh.indices = indices.into_iter().map(|i| i as u32).collect();
    Ok(mesh)
}

fn orient(a: P, b: P, c: P) -> f64 {
    geometry_predicates::orient2d([a.x, a.y], [b.x, b.y], [c.x, c.y])
}
fn on(a: P, b: P, p: P) -> bool {
    orient(a, b, p) == 0.
        && p.x >= a.x.min(b.x)
        && p.x <= a.x.max(b.x)
        && p.y >= a.y.min(b.y)
        && p.y <= a.y.max(b.y)
}
fn intersects(a: P, b: P, c: P, d: P) -> bool {
    let x = orient(a, b, c);
    let y = orient(a, b, d);
    let z = orient(c, d, a);
    let w = orient(c, d, b);
    ((x > 0. && y < 0.) || (x < 0. && y > 0.)) && ((z > 0. && w < 0.) || (z < 0. && w > 0.))
        || on(a, b, c)
        || on(a, b, d)
        || on(c, d, a)
        || on(c, d, b)
}
fn inside(p: P, ring: &[P]) -> bool {
    let mut winding = 0i32;
    for i in 0..ring.len() {
        let a = ring[i];
        let b = ring[(i + 1) % ring.len()];
        if a.y <= p.y && b.y > p.y && orient(a, b, p) > 0. {
            winding += 1;
        }
        if a.y > p.y && b.y <= p.y && orient(a, b, p) < 0. {
            winding -= 1;
        }
    }
    winding != 0
}
fn validate(rings: &[Vec<P>]) -> Result<()> {
    // At most 2048 input vertices => bounded O(n²) exact orientation work.
    for (ri, ring) in rings.iter().enumerate() {
        for i in 0..ring.len() {
            let a = ring[i];
            let b = ring[(i + 1) % ring.len()];
            let next = ring[(i + 2) % ring.len()];
            if orient(a, b, next) == 0. && (next - b).dot(&(a - b)) > 0. {
                return Err(invalid("backtracking adjacent boundary edges"));
            }
            if a == b {
                return Err(invalid("duplicate boundary vertex"));
            }
            for (rj, other) in rings.iter().enumerate().skip(ri) {
                for j in 0..other.len() {
                    if ri == rj && (j <= i || j == i + 1 || (i == 0 && j + 1 == ring.len())) {
                        continue;
                    }
                    if intersects(a, b, other[j], other[(j + 1) % other.len()]) {
                        return Err(invalid("intersecting or touching boundaries"));
                    }
                }
            }
        }
    }
    for (i, hole) in rings.iter().enumerate().skip(1) {
        if !inside(hole[0], &rings[0]) {
            return Err(invalid("hole lies outside outer boundary"));
        }
        for other in rings.iter().skip(i + 1) {
            if inside(hole[0], other) || inside(other[0], hole) {
                return Err(invalid("nested holes"));
            }
        }
    }
    Ok(())
}
