// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `consolidate_coplanar`'s noise filter against real small openings (#4698).

use super::*;
use crate::kernel::arrangement::box_mesh;
use crate::kernel::mesh_bridge::{subtract, tris_to_mesh};

/// Summed area of the triangles whose unit normal is within 1e-3 of `n`.
fn area_facing(mesh: &Mesh, n: Vector3<f64>) -> f64 {
    let p = |i: u32| {
        let i = i as usize * 3;
        Vector3::new(
            mesh.positions[i] as f64,
            mesh.positions[i + 1] as f64,
            mesh.positions[i + 2] as f64,
        )
    };
    mesh.indices
        .chunks_exact(3)
        .map(|t| {
            let c = (p(t[1]) - p(t[0])).cross(&(p(t[2]) - p(t[0])));
            let len = c.norm();
            if len > 0.0 && (c / len - n).norm() < 1e-3 {
                0.5 * len
            } else {
                0.0
            }
        })
        .sum()
}

/// A 10 x 10 cm through-opening cut into a wall, then consolidated, in metres
/// and in millimetres. The front face must lose the opening's area on a 2 x 1 m
/// wall and on a 20 x 10 m wall alike, and in either unit: consolidation runs
/// before the router scales file units to metres, so a millimetre file has to
/// come out the same. Mutation: let the plane share decide alone and the 20 m
/// wall's front face reads its full area, in metres and in millimetres.
#[test]
fn a_small_opening_keeps_its_hole_on_a_large_face_4698() {
    // `unit` is how many mesh units make a metre: 1 for a metre-authored file,
    // 1000 for a millimetre one.
    for unit in [1.0_f64, 1000.0] {
        for (width, height) in [(2.0 * unit, 1.0 * unit), (20.0 * unit, 10.0 * unit)] {
            let (thick, half) = (0.2 * unit, 0.05 * unit);
            let wall = tris_to_mesh(&box_mesh([0.0, 0.0, 0.0], [width, thick, height]));
            let (cx, cz) = (width / 2.0, height / 2.0);
            let opening = tris_to_mesh(&box_mesh(
                [cx - half, -2.5 * thick, cz - half],
                [cx + half, 3.5 * thick, cz + half],
            ));
            let cut = ClippingProcessor::with_unit_scale(1.0 / unit)
                .consolidate(subtract(&wall, &opening));
            let front = area_facing(&cut, Vector3::new(0.0, -1.0, 0.0));
            let expected = width * height - 4.0 * half * half;
            assert!(
                (front - expected).abs() < 1.0e-4 * unit * unit,
                "{width} x {height} wall (1 m = {unit} units): front face reads {front}, \
                 expected {expected}"
            );
        }
    }
}

/// Both gates and the unit invariance of the physical-width one. In metres and
/// millimetres: a wide opening on a large face is kept, a 50 µm sliver is noise,
/// a 1 mm strip is geometry, and a reveal lip that is its whole plane is kept.
/// Mutations: share-only fails the opening; omitting the unit scale keeps the
/// 50 µm sliver in millimetres.
#[test]
fn ring_noise_needs_both_hairline_and_a_small_share_of_the_plane_4698() {
    use nalgebra::Point2;
    let rect = |w: f64, h: f64| {
        vec![Point2::new(0.0, 0.0), Point2::new(w, 0.0), Point2::new(w, h), Point2::new(0.0, h)]
    };
    for unit in [1.0_f64, 1000.0] {
        let facade = 200.0 * unit * unit;
        let u = |m: f64| m * unit;
        assert!(
            !ring_is_noise(&rect(u(0.1), u(0.1)), facade, 1.0 / unit),
            "a 10 cm opening on a 200 m² face is geometry (1 m = {unit} units)"
        );
        assert!(
            ring_is_noise(&rect(u(1.0), u(50.0e-6)), facade, 1.0 / unit),
            "a 50 µm sliver on a 200 m² face is noise (1 m = {unit} units)"
        );
        assert!(
            !ring_is_noise(&rect(u(1.0), u(0.001)), facade, 1.0 / unit),
            "a 1 mm strip is over the physical noise threshold (1 m = {unit} units)"
        );
        let lip = rect(u(2.35), u(1.67e-6));
        assert!(
            !ring_is_noise(&lip, u(2.35) * u(1.67e-6), 1.0 / unit),
            "a reveal lip that is its whole plane is kept (1 m = {unit} units)"
        );
    }
    // The physical-width gate classifies the same compact speck as noise in
    // both unit systems when it is a small share of its plane.
    assert!(
        ring_is_noise(&rect(5.0e-5, 5.0e-5), 200.0, 1.0),
        "a 50 µm speck in metres is noise"
    );
    assert!(ring_is_noise(&rect(5.0e-2, 5.0e-2), 2.0e8, 0.001));

    // The pre-existing absolute-area floor itself remains in caller units. A
    // ring that is its whole plane bypasses the width/share pair, exposing the
    // inherited divergence without changing it in this PR.
    assert!(ring_is_noise(&rect(5.0e-5, 5.0e-5), 2.5e-9, 1.0));
    assert!(!ring_is_noise(&rect(5.0e-2, 5.0e-2), 2.5e-3, 0.001));
}

#[test]
fn raw_singleton_edge_conforms_to_two_non_coplanar_peers_3977() {
    // A valid synthetic closed shell whose target face keeps A-B whole while
    // its two differently-planed neighbours meet that edge at M. Because the
    // peer faces are non-coplanar singletons, M cannot disappear in a planar
    // union; the raw target must become an insertion target for the shell to
    // be topologically closed.
    let (a, b, d, m, c1, c2) = (
        Point3::new(0.0, 0.0, 0.0),
        Point3::new(2.0, 0.0, 0.0),
        Point3::new(0.0, 0.0, 2.0),
        Point3::new(1.0, 0.0, 0.0),
        Point3::new(0.0, 1.0, 0.0),
        Point3::new(2.0, 1.0, 0.5),
    );
    let mut input = Mesh::new();
    for face in [
        [a, b, d],
        [m, a, c1],
        [b, m, c2],
        [d, c1, a],
        [d, m, c1],
        [d, c2, m],
        [d, b, c2],
    ] {
        let normal = (face[1] - face[0])
            .cross(&(face[2] - face[0]))
            .normalize();
        emit_triangle(&mut input, &face, &normal);
    }
    assert!(count_open_boundary_edges_at(&input, 1.0e4) > 0);

    let output = ClippingProcessor::consolidate_coplanar(input);
    assert_eq!(
        count_open_boundary_edges_at(&output, 1.0e7),
        0,
        "the long raw edge must split at the non-coplanar peers' midpoint"
    );
}
