// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;
use crate::kernel::{arrangement::box_mesh, mesh_bridge::tris_to_mesh};

fn represented(positions: &[[f32; 3]], triangles: &[[u32; 3]]) -> Mesh {
    let mut mesh = Mesh::new();
    mesh.positions = positions.iter().flatten().copied().collect();
    mesh.normals = vec![0.0; mesh.positions.len()];
    mesh.indices = triangles.iter().flatten().copied().collect();
    mesh
}

#[test]
fn issue_7292_public_boundary_certificate_rejects_empty_malformed_and_collapsed() {
    assert!(!public_weld_closed(&Mesh::new()));
    let mut mesh = represented(&[[0., 0., 0.], [0.00001, 0., 0.], [0., 0.00001, 0.]], &[[0, 1, 2]]);
    assert!(!mesh.is_empty());
    assert!(mesh.welded_by_position(1e-4).indices.is_empty());
    assert!(!public_weld_closed(&mesh), "all-collapsed output is no boundary certificate");
    mesh.indices = vec![0, 1, 99];
    assert!(!public_weld_closed(&mesh));
    mesh.indices.clear();
    assert!(!public_weld_closed(&mesh));
}

#[test]
fn issue_7802_public_boundary_rejects_nonfinite_on_otherwise_closed_box() {
    let healthy = tris_to_mesh(&box_mesh([0., 0., 0.], [1., 1., 1.]));
    assert!(public_weld_closed(&healthy), "positive control must certify a closed boundary");
    assert_eq!(healthy.positions[0], 0.0);
    let mut nonfinite = healthy.clone();
    nonfinite.positions[0] = f32::NAN;
    // #7802: NaN and zero both cast to the same integer weld key. Keep the
    // indexed topology closed so only the finite-coordinate guard rejects it.
    assert_eq!(nonfinite.welded_by_position(1e-4).indices, healthy.welded_by_position(1e-4).indices,
        "NaN at zero must preserve the quantized boundary for this regression");
    assert!(!public_weld_closed(&nonfinite), "nonfinite coordinates are not a boundary certificate");
}

#[test]
fn issue_7292_public_boundary_requires_one_forward_and_one_reverse() {
    let box_mesh = tris_to_mesh(&box_mesh([0., 0., 0.], [1., 1., 1.]));
    assert!(public_weld_closed(&box_mesh));
    let mut doubled = box_mesh.clone();
    doubled.indices.extend_from_slice(&box_mesh.indices);
    assert!(!public_weld_closed(&doubled), "2f/2r is balanced but nonmanifold");
    let mut open = box_mesh;
    open.indices.truncate(open.indices.len() - 3);
    assert!(!public_weld_closed(&open));
}

#[test]
fn issue_7292_public_boundary_does_not_add_an_area_predicate() {
    let indexed_line = represented(&[[0., 0., 0.], [1., 0., 0.], [2., 0., 0.]], &[[0, 1, 2], [0, 2, 1]]);
    assert!(public_weld_closed(&indexed_line), "this indexed boundary bar alone does not certify valid area or a solid");
    assert!(!crate::exact_topology::strict_closed_mesh(&indexed_line));
}

// Actual committed #3913 +SG/BAC, bx=.65/by=.20. Positions/indices are from
// source-pinned A33 and rimV4 production captures. Normals do not enter the bar.
#[test]
fn issue_7292_public_f32_weld_preserves_actual_nary_caller_contract() {
    let baseline = represented(&[
        [0.0, 0.0, 1.0],
        [0.0, 0.11331450194120407, 1.0],
        [0.0, 0.11331473290920258, 0.8416146636009216],
        [0.0, 0.11331472545862198, 0.0],
        [0.0, 0.0, 0.0],
        [-0.7908630967140198, 0.40116962790489197, 3.219646771412954e-15],
        [-0.7908634543418884, 0.4011683166027069, 1.0],
        [-0.44883692264556885, 1.3408511877059937, 1.0],
        [-0.4488374888896942, 1.3408499956130981, 3.219646771412954e-15],
        [0.6696116924285889, 1.0, 1.0],
        [1.3330078125, 1.3830108642578125, 1.0],
        [1.3330078125, 1.3830108642578125, 0.0],
        [0.6696116924285889, 1.0, 0.0],
        [1.6710853811829907e-09, 0.11331473290920258, 0.8416146636009216],
        [-2.4526004645838918e-29, 0.11331450194120407, 1.0],
        [-0.7908634543418884, 0.4011683166027069, 1.0],
        [-0.7908630967140198, 0.40116962790489197, 3.1086244689504383e-15],
        [1.315236808352438e-10, 0.11331472545862198, 0.8416146636009216],
        [-0.7908630967140198, 0.40116962790489197, 3.219646771412954e-15],
        [1.1102230246251565e-16, 0.11331472545862198, 0.0],
        [0.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [1.0, 0.0, 1.0],
        [0.0, 0.0, 1.0],
        [0.6696116924285889, 1.0, 0.0],
        [1.3330078125, 1.3830108642578125, 0.0],
        [1.8330078125, 0.5169830322265625, 0.0],
        [1.0, 0.03604709729552269, 0.0],
        [1.0, 0.0, 0.0],
        [0.0, 0.0, 0.0],
        [0.0, 0.11331472545862198, 0.0],
        [-0.7908630967140198, 0.40116962790489197, 0.0],
        [-0.4488374888896942, 1.3408499956130981, -0.0],
        [0.48767393827438354, 1.0, -0.0],
        [0.0, 0.0, 1.0],
        [1.0, 0.0, 1.0],
        [1.0, 0.03604709729552269, 1.0],
        [1.8330078125, 0.5169830322265625, 1.0],
        [1.3330078125, 1.3830108642578125, 1.0],
        [0.6696116924285889, 1.0, 1.0],
        [0.48767393827438354, 1.0, 1.0],
        [-0.44883692264556885, 1.3408511877059937, 1.0],
        [-0.7908634543418884, 0.4011683166027069, 1.0],
        [0.0, 0.11331450194120407, 1.0],
        [0.48767393827438354, 1.0, 1.0],
        [0.6696116924285889, 1.0, 1.0],
        [0.6696116924285889, 1.0, -0.0],
        [0.48767393827438354, 1.0, 0.0],
        [-0.4488374888896942, 1.3408499956130981, 3.2441438112804956e-15],
        [-0.44883692264556885, 1.3408511877059937, 1.0],
        [0.48767441511154175, 1.000001311302185, 1.0],
        [0.48767393827438354, 1.0, -5.293955920339377e-23],
        [1.8330078125, 0.5169830322265625, 0.0],
        [1.8330078125, 0.5169830322265625, 1.0],
        [1.0, 0.03604709729552269, 1.0],
        [1.0, 0.03604709729552269, 0.0],
        [1.3330078125, 1.3830108642578125, 0.0],
        [1.3330078125, 1.3830108642578125, 1.0],
        [1.8330078125, 0.5169830322265625, 1.0],
        [1.8330078125, 0.5169830322265625, 0.0],
        [1.0, 0.0, 0.0],
        [1.0, 0.03604709729552269, 0.0],
        [1.0, 0.03604709729552269, 1.0],
        [1.0, 0.0, 1.0],
    ], &[
        [0, 1, 2],
        [0, 2, 4],
        [2, 3, 4],
        [5, 6, 7],
        [5, 7, 8],
        [9, 10, 11],
        [9, 11, 12],
        [13, 14, 15],
        [13, 15, 16],
        [17, 18, 19],
        [20, 21, 22],
        [20, 22, 23],
        [24, 25, 26],
        [24, 26, 27],
        [27, 28, 29],
        [27, 29, 30],
        [30, 31, 32],
        [24, 27, 33],
        [27, 30, 33],
        [30, 32, 33],
        [34, 35, 36],
        [36, 37, 39],
        [37, 38, 39],
        [36, 39, 40],
        [34, 36, 43],
        [36, 40, 43],
        [40, 41, 43],
        [41, 42, 43],
        [44, 45, 46],
        [44, 46, 47],
        [48, 49, 51],
        [49, 50, 51],
        [52, 53, 54],
        [52, 54, 55],
        [56, 57, 58],
        [56, 58, 59],
        [60, 61, 62],
        [60, 62, 63],
    ]);
    let rim = represented(&[
        [0.0, 0.0, 1.0],
        [-0.0, 0.11331450194120407, 1.0],
        [0.0, 0.11331473290920258, 0.8416146636009216],
        [-0.0, 0.11331472545862198, -0.0],
        [0.0, 0.0, 0.0],
        [-0.7908630967140198, 0.40116962790489197, 0.0],
        [-0.7908634543418884, 0.4011683166027069, 1.0],
        [-0.44883692264556885, 1.3408511877059937, 1.0],
        [-0.4488372802734375, 1.3408498764038086, 0.0],
        [0.6696116924285889, 1.0, 1.0],
        [1.3330078125, 1.3830108642578125, 1.0],
        [1.3330078125, 1.3830108642578125, 0.0],
        [0.6696116924285889, 1.0, -0.0],
        [1.6710853811829907e-09, 0.11331473290920258, 0.8416146636009216],
        [-2.4526004645838918e-29, 0.11331450194120407, 1.0],
        [-0.7908634543418884, 0.4011683166027069, 1.0],
        [-0.7908630967140198, 0.40116962790489197, 3.1086244689504383e-15],
        [1.315236808352438e-10, 0.11331472545862198, 0.8416146636009216],
        [-0.7908630967140198, 0.40116962790489197, 3.219646771412954e-15],
        [1.1102230246251565e-16, 0.11331472545862198, 0.0],
        [0.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [1.0, 0.0, 1.0],
        [0.0, 0.0, 1.0],
        [0.6696116924285889, 1.0, -0.0],
        [1.3330078125, 1.3830108642578125, 0.0],
        [1.8330078125, 0.5169830322265625, 0.0],
        [1.0, 0.03604709729552269, 0.0],
        [1.0, 0.0, 0.0],
        [0.0, 0.0, 0.0],
        [-0.0, 0.11331472545862198, -0.0],
        [-0.7908630967140198, 0.40116962790489197, 0.0],
        [-0.4488374888896942, 1.3408499956130981, -0.0],
        [0.48767393827438354, 1.0, -0.0],
        [0.0, 0.0, 1.0],
        [1.0, 0.0, 1.0],
        [1.0, 0.03604709729552269, 1.0],
        [1.8330078125, 0.5169830322265625, 1.0],
        [1.3330078125, 1.3830108642578125, 1.0],
        [0.6696116924285889, 1.0, 1.0],
        [0.48767393827438354, 1.0, 1.0],
        [-0.44883692264556885, 1.3408511877059937, 1.0],
        [-0.7908634543418884, 0.4011683166027069, 1.0],
        [-0.0, 0.11331450194120407, 1.0],
        [0.48767393827438354, 1.0, 1.0],
        [0.6696116924285889, 1.0, 1.0],
        [0.6696116924285889, 1.0, -0.0],
        [0.48767393827438354, 1.0, -0.0],
        [-0.4488374888896942, 1.3408499956130981, 3.2441438112804956e-15],
        [-0.44883692264556885, 1.3408511877059937, 1.0],
        [0.48767393827438354, 1.0, 1.0],
        [0.48767393827438354, 1.0, -5.293955920339377e-23],
        [1.8330078125, 0.5169830322265625, 0.0],
        [1.8330078125, 0.5169830322265625, 1.0],
        [1.0, 0.03604709729552269, 1.0],
        [1.0, 0.03604709729552269, 0.0],
        [1.3330078125, 1.3830108642578125, 0.0],
        [1.3330078125, 1.3830108642578125, 1.0],
        [1.8330078125, 0.5169830322265625, 1.0],
        [1.8330078125, 0.5169830322265625, 0.0],
        [1.0, 0.0, 0.0],
        [1.0, 0.03604709729552269, 0.0],
        [1.0, 0.03604709729552269, 1.0],
        [1.0, 0.0, 1.0],
    ], &[
        [0, 1, 2],
        [0, 2, 4],
        [2, 3, 4],
        [5, 6, 7],
        [5, 7, 8],
        [9, 10, 11],
        [9, 11, 12],
        [13, 14, 15],
        [13, 15, 16],
        [17, 18, 19],
        [20, 21, 22],
        [20, 22, 23],
        [24, 25, 26],
        [24, 26, 27],
        [27, 28, 29],
        [27, 29, 30],
        [30, 31, 32],
        [24, 27, 33],
        [27, 30, 33],
        [30, 32, 33],
        [34, 35, 36],
        [36, 37, 39],
        [37, 38, 39],
        [36, 39, 40],
        [34, 36, 43],
        [36, 40, 43],
        [40, 41, 43],
        [41, 42, 43],
        [44, 45, 46],
        [44, 46, 47],
        [48, 49, 51],
        [49, 50, 51],
        [52, 53, 54],
        [52, 54, 55],
        [56, 57, 58],
        [56, 58, 59],
        [60, 61, 62],
        [60, 62, 63],
    ]);
    assert!(public_weld_closed(&baseline));
    assert!(!public_weld_closed(&rim));
    assert!(!crate::exact_topology::strict_closed_mesh(&baseline), "the caller bar is not exact closure");
}

fn fold_fixture() -> (Mesh, super::super::buckets::Buckets, super::super::supported_cells::Supported) {
    use super::super::plane_merge::PlaneTri;
    use nalgebra::{Point3, Vector3};
    let mut closed = tris_to_mesh(&box_mesh([0.; 3], [1.; 3]));
    let first: Vec<u32> = closed.indices[..3].to_vec();
    // Drop one triangle: its three edges open, and only those.
    let open = {
        let mut m = closed.clone();
        m.indices.drain(..3);
        m
    };
    let corner = |i: u32| {
        let b = i as usize * 3;
        Point3::new(closed.positions[b] as f64, closed.positions[b + 1] as f64, closed.positions[b + 2] as f64)
    };
    let key = (0, 0, 0, 0);
    let mut buckets = super::super::buckets::Buckets::new();
    buckets.insert(
        key,
        vec![PlaneTri { v: [corner(first[0]), corner(first[1]), corner(first[2])], normal: Vector3::z(), tag: None }],
    );
    let mut supported = super::super::supported_cells::Supported::default();
    supported.folded_buckets.push(key);
    closed.indices.clear();
    (open, buckets, supported)
}

#[test]
fn issue_7949_open_edges_on_the_fold_are_not_a_tear_beyond_it() {
    let (open, buckets, supported) = fold_fixture();
    assert!(!tears_beyond_folds(&open, &buckets, &supported), "the hole sits on the fold's own vertices");
}

#[test]
fn issue_7949_open_edges_off_the_fold_are_a_tear_beyond_it() {
    let (open, buckets, _) = fold_fixture();
    let no_fold = super::super::supported_cells::Supported::default();
    assert!(tears_beyond_folds(&open, &buckets, &no_fold), "with no fold to explain it the hole is a tear");
    let closed = tris_to_mesh(&box_mesh([0.; 3], [1.; 3]));
    assert!(!tears_beyond_folds(&closed, &buckets, &no_fold), "a closed host tears nothing");
}

#[test]
fn issue_7949_an_open_sub_edge_split_along_a_fold_edge_is_not_a_tear_beyond_it() {
    use super::super::{buckets::Buckets, plane_merge::PlaneTri, supported_cells::Supported};
    use nalgebra::{Point3, Vector3};
    // One retained fold triangle. A peer seam splits its bottom edge at (1,0): a
    // vertex the fold never owned, but which lies on it.
    let key = (0, 0, 0, 0);
    let (a, b, c) = (Point3::new(0., 0., 0.), Point3::new(2., 0., 0.), Point3::new(0., 2., 0.));
    let mut buckets = Buckets::new();
    buckets.insert(key, vec![PlaneTri { v: [a, b, c], normal: Vector3::z(), tag: None }]);
    let mut supported = Supported::default();
    supported.folded_buckets.push(key);

    // The fold re-cut at (1,0): every open edge runs along the fold's boundary
    // (the shared a-split diagonal is paired, so it is not open).
    let split = represented(
        &[[0., 0., 0.], [1., 0., 0.], [2., 0., 0.], [0., 2., 0.]],
        &[[0, 1, 3], [1, 2, 3]],
    );
    assert!(!tears_beyond_folds(&split, &buckets, &supported));
    // A chord through the fold's interior, both endpoints on its boundary, is
    // not the fold's boundary.
    let chord = represented(&[[1., 0., 0.], [0., 2., 0.], [0., 1., 0.]], &[[0, 1, 2]]);
    assert!(tears_beyond_folds(&chord, &buckets, &supported));
    // One corner outside the fold altogether.
    let off_fold = represented(&[[1., 0., 0.], [0., 2., 0.], [3., 3., 0.]], &[[0, 1, 2]]);
    assert!(tears_beyond_folds(&off_fold, &buckets, &supported));
}

#[test]
fn issue_7949_an_open_edge_joining_two_separate_fold_regions_is_a_tear_beyond_them() {
    use super::super::{buckets::Buckets, plane_merge::PlaneTri, supported_cells::Supported};
    use nalgebra::{Point3, Vector3};
    // Two fold triangles five units apart. The edge between a corner of each
    // has both endpoints on a fold and runs through neither.
    let tri = |x: f64| PlaneTri {
        v: [Point3::new(x, 0., 0.), Point3::new(x + 1., 0., 0.), Point3::new(x, 1., 0.)],
        normal: Vector3::z(),
        tag: None,
    };
    let mut buckets = Buckets::new();
    buckets.insert((0, 0, 0, 0), vec![tri(0.)]);
    buckets.insert((1, 0, 0, 0), vec![tri(5.)]);
    let mut supported = Supported::default();
    supported.folded_buckets.extend([(0, 0, 0, 0), (1, 0, 0, 0)]);

    let bridge = represented(&[[0., 0., 0.], [5., 0., 0.], [0., 1., 0.]], &[[0, 1, 2]]);
    assert!(tears_beyond_folds(&bridge, &buckets, &supported));
}
