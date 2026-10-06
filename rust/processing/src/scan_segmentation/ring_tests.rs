// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::*;
use std::f64::consts::TAU;

/// Face `k` of a regular `n`-gon about `c` at `apothem`, its normal turned
/// inward (as an unsigned plane normal may come), its span shortened by
/// `crease` at each end (the voxels growth leaves along a crease).
fn polygon_face(c: P2, n: usize, apothem: f64, k: usize, crease: f64) -> Face {
    let a = TAU * k as f64 / n as f64;
    let normal = [-a.cos(), -a.sin()];
    let mid = [c[0] + apothem * a.cos(), c[1] + apothem * a.sin()];
    let half = apothem * (std::f64::consts::PI / n as f64).tan() - crease;
    let t = [-normal[1], normal[0]];
    let at = |s: f64| [mid[0] + s * t[0], mid[1] + s * t[1]];
    Face { plane: k, normal, mid, width: 2. * half, heights: [0., 2.7], ends: [at(-half), at(half)] }
}

const GAP: f64 = 4. * 0.03 + 0.02;

#[test]
fn issue_6893_faces_of_a_regular_polygon_link_and_meet_at_its_axis() {
    let c = [5., -3.];
    let faces: Vec<Face> = (0..12).map(|k| polygon_face(c, 12, 0.6, k, 0.06)).collect();
    for k in 0..12 {
        assert!(linked(&faces[k], &faces[(k + 1) % 12], GAP, 0.02, 2.), "faces {k} and {}", (k + 1) % 12);
    }
    let ring = ring_of(faces, 0.02).expect("a ring");
    assert_eq!(ring.faces.len(), 12);
    assert!((ring.centre[0] - c[0]).abs() < 1e-9 && (ring.centre[1] - c[1]).abs() < 1e-9, "{:?}", ring.centre);
    assert!((ring.apothem - 0.6).abs() < 1e-9);
    // Normals now point away from the axis.
    assert!(ring.faces.iter().all(|f| dot2(sub2(f.mid, c), f.normal) > 0.));
}

#[test]
fn issue_6893_a_wall_corner_is_not_a_link() {
    // Faces of a square turn 90 degrees: a corner, or a rectangular column.
    let faces: Vec<Face> = (0..4).map(|k| polygon_face([0., 0.], 4, 0.3, k, 0.06)).collect();
    assert!(!linked(&faces[0], &faces[1], GAP, 0.02, 2.));
}

#[test]
fn issue_6893_faces_off_their_tangent_points_are_not_a_link() {
    // Neighbouring faces of a hexagon link. Slide both 0.2 m the same way
    // along their own lines (a pinwheel of walls that only happen to meet at
    // that angle): the perpendiculars through their middles still cross
    // behind both, at 0.39 and 0.62 m, which disagree.
    let mut a = polygon_face([0., 0.], 6, 0.5, 0, 0.06);
    let mut b = polygon_face([0., 0.], 6, 0.5, 1, 0.06);
    assert!(linked(&a, &b, GAP, 0.02, 2.));
    for f in [&mut a, &mut b] {
        let t = [-f.normal[1], f.normal[0]];
        let slide = |p: P2| [p[0] - 0.2 * t[0], p[1] - 0.2 * t[1]];
        (f.mid, f.ends) = (slide(f.mid), f.ends.map(slide));
    }
    assert!(!linked(&a, &b, 10., 0.02, 2.));
}

#[test]
fn issue_6893_a_face_at_another_distance_leaves_the_ring() {
    // A 12-gon and one face of a concentric 12-gon 0.3 m further out.
    let c = [0.4, 0.9];
    let mut faces: Vec<Face> = (0..12).map(|k| polygon_face(c, 12, 0.6, k, 0.06)).collect();
    faces.push(Face { plane: 12, ..polygon_face(c, 12, 0.9, 3, 0.06) });
    let ring = ring_of(faces, 0.02).expect("a ring");
    assert_eq!(ring.faces.len(), 12);
    assert!(ring.faces.iter().all(|f| f.plane < 12));
    assert!((ring.apothem - 0.6).abs() < 1e-6, "{}", ring.apothem);
}
