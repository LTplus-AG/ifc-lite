// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The half-space cap's section weld: the cap chains the cut section on a
//! weld grid, and a closed cap moves the cut wall's section vertices onto
//! that weld so wall and cap meet.

use crate::{Mesh, Point3, Vector3};

/// Whether `p` lies on the plane through `plane_point` with unit normal `n`
/// to the rounding of an f32 point: a few f32 steps of its coordinates along
/// `n`, so a coordinate tangent to the plane, however large, adds nothing.
/// The clipper leaves every copy of a section vertex on the plane this way.
fn lies_on_plane(p: Point3<f64>, plane_point: Point3<f64>, n: Vector3<f64>) -> bool {
    let along = n.x.abs() * (p.x.abs() + plane_point.x.abs())
        + n.y.abs() * (p.y.abs() + plane_point.y.abs())
        + n.z.abs() * (p.z.abs() + plane_point.z.abs());
    (p - plane_point).dot(&n).abs() <= 8.0 * f64::from(f32::EPSILON) * along + f64::MIN_POSITIVE
}

fn point(c: &[f32; 3]) -> Point3<f64> {
    Point3::new(c[0] as f64, c[1] as f64, c[2] as f64)
}

/// Weld the mesh's vertices on a grid of `weld_eps`, as (position, on the cut
/// plane, per mesh vertex id). The first vertex in a cell stands for it,
/// unless it is off the plane ([`lies_on_plane`]) and a later one in the cell
/// is on it: then that one does, so neither the cap nor the welded section
/// is built at a corner that only lies near the plane.
pub(super) fn weld_section(
    mesh: &Mesh,
    plane_point: Point3<f64>,
    n: Vector3<f64>,
    weld_eps: f64,
) -> (Vec<Point3<f64>>, Vec<bool>, Vec<u32>) {
    use std::collections::HashMap;
    let vcount = mesh.positions.len() / 3;
    let quant = |c: f32| -> i64 { (c as f64 / weld_eps).round() as i64 };
    let mut weld: HashMap<(i64, i64, i64), u32> = HashMap::new();
    let mut pos: Vec<Point3<f64>> = Vec::new();
    let mut on_plane: Vec<bool> = Vec::new();
    let mut exact: Vec<bool> = Vec::new();
    let mut welded: Vec<u32> = Vec::with_capacity(vcount);
    for c in mesh.positions.as_chunks::<3>().0 {
        let key = (quant(c[0]), quant(c[1]), quant(c[2]));
        let p = point(c);
        let id = match weld.get(&key) {
            Some(&id) => {
                let cell = (exact.get_mut(id as usize), on_plane.get_mut(id as usize), pos.get_mut(id as usize));
                if let (Some(exact), Some(on), Some(at)) = cell {
                    if !*exact && lies_on_plane(p, plane_point, n) {
                        (*exact, *on, *at) = (true, true, p);
                    }
                }
                id
            }
            None => {
                let id = pos.len() as u32;
                on_plane.push((p - plane_point).dot(&n).abs() <= weld_eps);
                exact.push(lies_on_plane(p, plane_point, n));
                pos.push(p);
                weld.insert(key, id);
                id
            }
        };
        welded.push(id);
    }
    (pos, on_plane, welded)
}

/// Move every mesh vertex that lies on the cut plane ([`lies_on_plane`]) in
/// an on-plane weld cell onto its weld position.
///
/// The cap is triangulated over the welded section. Left where they were,
/// two section vertices in one cell stay two vertices of the cut wall and one
/// of the cap: a T-junction along the section, or a hole the width of the
/// cell where the two are not in line. A plane 1.6 mm above the base of a
/// finely faceted arc wall leaves such pairs 0.11 mm apart, one where each
/// quad's diagonal crosses the plane (ISSUE_129 #61300, 0.17 mm cells). A
/// vertex that only shares a cell with the section, such as a corner of a
/// thin part just above the plane, stays where it is.
pub(super) fn snap_to_section(
    mesh: &mut Mesh,
    plane_point: Point3<f64>,
    n: Vector3<f64>,
    (pos, on_plane, welded): (&[Point3<f64>], &[bool], &[u32]),
) {
    for (c, &id) in mesh.positions.as_chunks_mut::<3>().0.iter_mut().zip(welded) {
        let (Some(true), Some(p)) = (on_plane.get(id as usize), pos.get(id as usize)) else { continue };
        if lies_on_plane(point(c), plane_point, n) {
            *c = [p.x as f32, p.y as f32, p.z as f32];
        }
    }
}
