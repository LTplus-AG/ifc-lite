// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;
use crate::kernel::plane_weld::{lift::exact_on_plane_weld, promote_cutter_verts_onto_host_faces};

const HOST: Tri = [[0.0, -20.0, 0.0], [0.0, -110.0, 0.0], [0.0, -110.0, 3900.0]];

fn z_face(v: [f64; 3]) -> Tri {
    [v, [v[0] + 1.0, v[1], v[2]], [v[0], v[1] + 1.0, v[2]]]
}

#[test]
fn issue_7292_actual_480054_admitted_lift_preserves_original_healthy_axis_faces() {
    // Actual saved job000 source faces4/31 and selected host10. These are
    // original caller-mm coordinates, not synthesized after promotion.
    let v = [-0.0000152587890625, -125.0, 2715.0];
    let mut source = [
        [[7049.99951171875, -125.0, 3900.0], [0.0, -125.0, 3900.0], v],
        [
            [-0.0000152587890625, -109.99993896484375, 2715.0],
            [1724.9996337890625, -125.0, 2715.0],
            v,
        ],
    ];
    let old = exact_on_plane_weld(v, HOST).expect("actual Q20 lift");
    assert_ne!(old[1], v[1]);
    assert_ne!(old[2], v[2]);
    assert!(promote_cutter_verts_onto_host_faces(&mut source, &[HOST]) > 0);
    for t in &source {
        assert_eq!(t[2], [0.0, -125.0, 2715.0]);
        let e = ImplicitPoint::Explicit;
        assert_eq!(
            orient3d(&e(t[2]), &e(HOST[0]), &e(HOST[1]), &e(HOST[2])),
            Sign::Zero
        );
    }
    assert_eq!(vertex_bits(&source[0][2]), vertex_bits(&source[1][2]));
}

#[test]
fn issue_7292_absent_original_axis_feature_keeps_q20() {
    let v = [-0.0000152587890625, -125.0, 2715.0];
    let source = [[v, [7049.0, -124.0, 2716.0], [2.0, -123.0, 2717.0]]];
    let old = exact_on_plane_weld(v, HOST).unwrap();
    assert!(SourceAxes::new(&source)
        .candidate(v, old, HOST, &HashSet::new())
        .is_none());
    let mut actual = source;
    promote_cutter_verts_onto_host_faces(&mut actual, &[HOST]);
    assert_eq!(actual[0][0], old);
}

#[test]
fn issue_7292_existing_host_corner_keeps_its_q20_identity() {
    let v = [-0.0000152587890625, -125.0, 2715.0];
    let old = exact_on_plane_weld(v, HOST).unwrap();
    let corners = HashSet::from([vertex_bits(&old)]);
    assert!(SourceAxes::new(&[z_face(v)])
        .candidate(v, old, HOST, &corners)
        .is_none());
}

#[test]
fn issue_7292_tilted_host_cannot_restore_a_dependent_coordinate() {
    let v = [0.0, 0.0, 1.0];
    // Exact nonzero nZ, even though it is tiny compared to nX.
    let tilted = [
        [0.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [2.0_f64.powi(-40), 0.0, 1.0],
    ];
    let primary = [0.0, 0.0, 0.0];
    assert!(SourceAxes::new(&[z_face(v)])
        .candidate(v, primary, tilted, &HashSet::new())
        .is_none());
}

#[test]
fn issue_7292_off_existing_grid_original_coordinate_cannot_be_restored() {
    let v = [0.0, 0.0, 1.0 / 3.0];
    let primary = [0.0, 0.0, 1.0];
    assert!(SourceAxes::new(&[z_face(v)])
        .candidate(v, primary, HOST, &HashSet::new())
        .is_none());
}

#[test]
fn issue_7292_filtered_original_plate_does_not_supply_axis_features() {
    // Existing #4698 policy: the64m by5mm plate's two triangles are needles.
    let source = [[[0.0, 0.0, 1.0], [64.0, 0.0, 1.0], [64.0, 0.005, 1.0]]];
    let v = source[0][0];
    assert!(crate::csg::tri_is_needle(&source[0].map(Point3::from)));
    assert!(SourceAxes::new(&source)
        .candidate(v, [0.0, 0.0, 2.0], HOST, &HashSet::new())
        .is_none());
}

#[test]
fn issue_7292_same_source_face_must_survive_actual_f32_narrowing() {
    let source = [[
        [100_000_000.0, 0.0, 1.0],
        [100_000_001.0, 0.0, 1.0],
        [100_000_000.0, 1.0, 1.0],
    ]];
    assert!(projection_axis(&source[0]).is_some());
    assert!(!crate::csg::tri_is_needle(&source[0].map(Point3::from)));
    let narrowed = source[0].map(|p| p.map(|x| x as f32 as f64));
    assert!(projection_axis(&narrowed).is_none());
    assert!(SourceAxes::new(&source)
        .candidate(source[0][0], [0.0, 0.0, 2.0], HOST, &HashSet::new())
        .is_none());
}

#[test]
fn issue_7292_coordinate_preservation_cannot_lose_a_finite_host_contact() {
    // Closed source tetra + closed host triangular prism. Original v lies on
    // X+Y=64; its accepted raw Q20 lies at the cap/hypotenuse intersection.
    // Restoring only the source X-face coordinate would leave both contacts.
    let host: [Tri; 8] = [
        [[0.0, 0.0, 0.0], [0.0, 64.0, 0.0], [64.0, 0.0, 0.0]],
        [[0.0, 0.0, 2.0], [64.0, 0.0, 2.0], [0.0, 64.0, 2.0]],
        [[0.0, 0.0, 0.0], [64.0, 0.0, 0.0], [64.0, 0.0, 2.0]],
        [[0.0, 0.0, 0.0], [64.0, 0.0, 2.0], [0.0, 0.0, 2.0]],
        [[64.0, 0.0, 0.0], [0.0, 64.0, 0.0], [0.0, 64.0, 2.0]],
        [[64.0, 0.0, 0.0], [0.0, 64.0, 2.0], [64.0, 0.0, 2.0]],
        [[0.0, 64.0, 0.0], [0.0, 0.0, 0.0], [0.0, 0.0, 2.0]],
        [[0.0, 64.0, 0.0], [0.0, 0.0, 2.0], [0.0, 64.0, 2.0]],
    ];
    let mut source: [Tri; 4] = [
        [
            [32.00001525878906, 31.999984741210938, 1.52587890625e-05],
            [32.00001525878906, 30.999984741210938, 0.2500152587890625],
            [32.00001525878906, 31.499984741210938, 1.0000152587890625],
        ],
        [
            [32.00001525878906, 31.999984741210938, 1.52587890625e-05],
            [33.00001525878906, 29.999984741210938, 0.5000152587890625],
            [32.00001525878906, 30.999984741210938, 0.2500152587890625],
        ],
        [
            [32.00001525878906, 31.999984741210938, 1.52587890625e-05],
            [32.00001525878906, 31.499984741210938, 1.0000152587890625],
            [33.00001525878906, 29.999984741210938, 0.5000152587890625],
        ],
        [
            [32.00001525878906, 30.999984741210938, 0.2500152587890625],
            [33.00001525878906, 29.999984741210938, 0.5000152587890625],
            [32.00001525878906, 31.499984741210938, 1.0000152587890625],
        ],
    ];
    let primary = [32.0, 32.0, 0.0];
    let original = source[0][0];
    let e = ImplicitPoint::Explicit;
    assert_eq!(
        orient3d(&e(original), &e(host[4][0]), &e(host[4][1]), &e(host[4][2])),
        Sign::Zero
    );
    let old = exact_on_plane_weld(original, host[0]).expect("original Q20 gates");
    assert_eq!(old, primary);
    let corners = crate::kernel::near_band::exact_vertex_set(&host);
    assert!(!corners.contains(&vertex_bits(&primary)));
    let correction = SourceAxes::new(&source)
        .candidate(original, primary, host[0], &corners)
        .expect("healthy same-face F64/F32 feature and independent host axis");
    assert_eq!(correction, [32.0 + 1.0 / 65536.0, 32.0, 0.0]);
    assert!(crate::kernel::coplanar::contains_projected_point(
        &host[0], primary
    ));
    assert!(!crate::kernel::coplanar::contains_projected_point(
        &host[0], correction
    ));
    assert_closed_fixture(&host);
    assert_closed_fixture(&source);
    assert!(promote_cutter_verts_onto_host_faces(&mut source, &host) > 0);
    for triangle in &source[..3] {
        assert_eq!(
            triangle[0], primary,
            "production must preserve accepted cap/hypotenuse contact"
        );
    }
}

fn assert_closed_fixture(triangles: &[Tri]) {
    // Independent exact directed-edge count establishes this fixture's premise.
    let mut edges = std::collections::BTreeMap::new();
    for triangle in triangles {
        for k in 0..3 {
            let a = vertex_bits(&triangle[k]);
            let b = vertex_bits(&triangle[(k + 1) % 3]);
            assert_ne!(a, b);
            let (edge, direction) = if a < b { ((a, b), 0) } else { ((b, a), 1) };
            let counts = edges.entry(edge).or_insert([0_u32; 2]);
            counts[direction] += 1;
        }
    }
    assert!(edges.values().all(|counts| *counts == [1, 1]));
}

#[test]
fn issue_7292_numeric_equal_axis_coordinate_keeps_primary_signed_zero() {
    let original = [-0.0, 0.25, 1.0 / 65536.0];
    let mut source = [[original, [-0.0, 0.5, 1.0], [-0.0, 0.25, 1.0]]];
    let host = [[[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]]];
    let primary = exact_on_plane_weld(original, host[0]).unwrap();
    assert_eq!(primary, [0.0, 0.25, 0.0]);
    assert_eq!(primary[0].to_bits(), 0.0_f64.to_bits());
    let corners = crate::kernel::near_band::exact_vertex_set(&host);
    assert!(!corners.contains(&vertex_bits(&primary)));
    assert!(SourceAxes::new(&source)
        .candidate(original, primary, host[0], &corners)
        .is_none());
    assert_eq!(promote_cutter_verts_onto_host_faces(&mut source, &host), 1);
    assert_eq!(vertex_bits(&source[0][0]), vertex_bits(&primary));
}

#[path = "source_axes_admission_tests.rs"]
mod admission_tests;

#[path = "source_axes_finite_anchor_tests.rs"]
mod finite_anchor_tests;
