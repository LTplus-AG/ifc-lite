// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;

const STEP: f64 = 1.0 / 65_536.0;

fn setup(tris: &[Tri], point: [f64; 3]) -> (NearBand, Vec<Face>, HashSet<[u64; 3]>) {
    let mut band = NearBand::default();
    band.observe_tris(tris);
    band.observe_point(&point);
    let faces = tris.iter().map(|&t| Face::new(t, &band).unwrap()).collect();
    let vertices = tris.iter().flatten().map(vertex_bits).collect();
    (band, faces, vertices)
}

fn assert_selected(point: [f64; 3], tris: &[Tri], expected: usize) -> [f64; 3] {
    let (band, faces, vertices) = setup(tris, point);
    let (d, face) = select(point, &faces, &band, &vertices).unwrap();
    assert!(
        std::ptr::eq(face, &faces[expected]),
        "unexpected reconciliation surface"
    );
    let target = exact_on_plane_weld(point, face.t).unwrap();
    assert!(face.admits(point, target, d, &band, &vertices));
    let explicit = ImplicitPoint::Explicit;
    assert_eq!(
        orient3d(
            &explicit(target),
            &explicit(face.t[0]),
            &explicit(face.t[1]),
            &explicit(face.t[2])
        ),
        Sign::Zero
    );
    target
}

fn remote_plane(z: f64) -> Tri {
    [[0.0, 0.0, z], [1.0, 0.0, z], [0.0, 1.0, z]]
}

fn covering_plane(z: f64, edge: f64) -> Tri {
    [[0.0, 0.0, z], [edge, 0.0, z], [0.0, edge, z]]
}

#[test]
fn issue_7292_covering_surface_reconciles_both_9094_corners_under_axis_symmetry() {
    // Actual ISSUE_129 entity 9094 host triangles 37 and 35. The old nearest
    // infinite plane misses the corner's footprint; the covering wall must
    // supply a shared, exactly planar endpoint before coplanar clipping.
    let old = [
        [-0.63336181640625, -0.7086944580078125, 7.5500030517578125],
        [-0.63336181640625, -0.7086944580078125, 7.75],
        [-10.4207763671875, 3.4520263671875, 8.75],
    ];
    let covering = [
        [10.749313354492188, -5.5475921630859375, 9.699996948242188],
        [-11.45361328125, 3.8910980224609375, 9.699996948242188],
        [-0.4492950439453125, -0.7869415283203125, 7.75],
    ];
    for z in [8.080001831054688, 8.279998779296875] {
        let original = [0.6458587646484375, -1.25250244140625, z];
        // Cyclic rotations and every coordinate sign reflection cover all
        // dominant projection axes and both projected winding orientations.
        for rotation in 0..3 {
            for signs in 0..8 {
                let map = |p: [f64; 3]| {
                    [0, 1, 2].map(|k| {
                        let sign = if signs & (1 << k) == 0 { 1.0 } else { -1.0 };
                        sign * p[(k + rotation) % 3]
                    })
                };
                let point = map(original);
                let tris = [old.map(map), covering.map(map)];
                assert!(!contains_projected_point(&tris[0], point));
                assert!(contains_projected_point(&tris[1], point));
                assert!(!same_plane(&tris[0], &tris[1]));
                let (band, faces, _) = setup(&tris, point);
                assert!(faces[0].distance(point).0 < faces[1].distance(point).0);
                assert!(faces[1].distance(point).0 <= faces[1].band2);
                let legacy = exact_on_plane_weld(point, tris[0]).unwrap();
                let actual = assert_selected(point, &tris, 1);
                assert_ne!(actual, legacy, "the witness must expose the former seam");
                assert!(contains_projected_point(&tris[1], actual));
                assert!(faces[1].admits(
                    point,
                    actual,
                    faces[1].distance(point).1,
                    &band,
                    &HashSet::new()
                ));
            }
        }
    }
}

#[test]
fn issue_7292_containing_same_plane_sibling_preserves_the_legacy_basis() {
    let point = [2.0, 2.0, STEP];
    let old = [[0.0, 0.0, 0.0], [3.0, 0.0, 0.0], [0.0, 1.0, 0.0]];
    let sibling = covering_plane(0.0, 10.0);
    let distinct = covering_plane(3.0 * STEP, 8.0);
    assert!(!contains_projected_point(&old, point));
    assert!(contains_projected_point(&sibling, point));
    assert!(same_plane(&old, &sibling));
    let legacy = exact_on_plane_weld(point, old).unwrap();
    assert_ne!(
        legacy,
        exact_on_plane_weld(point, sibling).unwrap(),
        "same support plane with another basis can create a different Q20 seam"
    );
    assert_eq!(assert_selected(point, &[old, distinct, sibling], 0), legacy);
}

#[test]
fn issue_7292_no_covering_face_retains_infinite_support_plane_semantics() {
    let point = [2.0, 2.0, STEP];
    let old = remote_plane(0.0);
    let other = remote_plane(3.0 * STEP);
    assert!(!contains_projected_point(&old, point));
    assert!(!contains_projected_point(&other, point));
    assert_eq!(assert_selected(point, &[old, other], 0), [2.0, 2.0, 0.0]);
}

#[test]
fn issue_7292_preferred_lift_or_drift_failure_retains_the_original_seam() {
    let point = [2.0, 2.0, STEP];
    let old = remote_plane(0.0);
    // Off the host S16 grid: a covering plane does not bypass exact lift gates.
    let off_grid = covering_plane(3.1 * STEP, 8.0);
    assert!(contains_projected_point(&off_grid, point));
    assert!(exact_on_plane_weld(point, off_grid).is_none());
    assert_eq!(assert_selected(point, &[old, off_grid], 0), [2.0, 2.0, 0.0]);
    // A long covering basis quantizes the foot beyond its unchanged Z-normal
    // drift band. Its valid exact-plane point must nevertheless be refused.
    let long = covering_plane(3.0 * STEP, 10_000.0);
    let (band, faces, vertices) = setup(&[old, long], point);
    let q = exact_on_plane_weld(point, long).unwrap();
    assert!(contains_projected_point(&long, point));
    assert!(!faces[1].admits(point, q, faces[1].distance(point).1, &band, &vertices));
    assert_eq!(assert_selected(point, &[old, long], 0), [2.0, 2.0, 0.0]);
}

#[test]
fn issue_7292_covering_face_outside_its_normal_band_preserves_original_seam() {
    let point = [2.0, 2.0, STEP];
    let old = remote_plane(0.0);
    let far = covering_plane(16.0 * STEP, 8.0);
    let (_, faces, _) = setup(&[old, far], point);
    assert!(contains_projected_point(&far, point));
    assert!(faces[1].distance(point).0 > faces[1].band2);
    assert_eq!(assert_selected(point, &[old, far], 0), [2.0, 2.0, 0.0]);
}

#[test]
fn issue_7292_original_range_gate_cannot_be_bypassed_by_a_covering_face() {
    let point = [20.0, 20.0, STEP];
    let tris = [remote_plane(0.0), covering_plane(3.0 * STEP, 40.0)];
    assert!(
        exact_on_plane_weld(point, tris[0]).is_none(),
        "alpha=beta=20 exceed the Q20 range"
    );
    assert!(exact_on_plane_weld(point, tris[1]).is_some());
    assert!(contains_projected_point(&tris[1], point));
    let (band, faces, vertices) = setup(&tris, point);
    let (_, face) = select(point, &faces, &band, &vertices).unwrap();
    assert!(
        std::ptr::eq(face, &faces[0]),
        "retain the original refused lift"
    );
}

#[test]
fn issue_7292_admitted_global_host_corner_precedes_a_distinct_covering_plane() {
    // The original Q20 target is an existing host corner even though the
    // slightly noisy original point falls outside that corner's triangle.
    let old = covering_plane(0.0, 7000.0);
    let point = [7000.0 - 32.0 * STEP, -3.0 * STEP, STEP];
    let covering = [
        [0.0, -1.0, 3.0 * STEP],
        [10_000.0, -1.0, 3.0 * STEP],
        [0.0, 10_000.0, 3.0 * STEP],
    ];
    assert!(!contains_projected_point(&old, point));
    assert!(contains_projected_point(&covering, point));
    assert!(!same_plane(&old, &covering));
    let target = [7000.0, 0.0, 0.0];
    assert_eq!(exact_on_plane_weld(point, old), Some(target));
    let (band, faces, vertices) = setup(&[old, covering], point);
    let d = faces[0].distance(point).1;
    assert!(vertices.contains(&vertex_bits(&target)));
    assert!(faces[0].admits(point, target, d, &band, &vertices));
    assert!(
        !faces[0].admits(point, target, d, &band, &HashSet::new()),
        "this witness specifically needs the direction-bounded existing-corner exception"
    );
    assert_eq!(assert_selected(point, &[old, covering], 0), target);
}

#[test]
fn issue_7292_refused_stacked_cap_lift_is_not_replaced_by_an_admitted_covering_lift() {
    // Actual first 2% stacked-slice job: original cap plane 0 is nearest but
    // outside the point's footprint. Its Q20 tangent shift is refused. Plane 5
    // offers an admitted lift; using it introduced a thin cap in the real chain.
    // Local preference must preserve the original refused reconciliation.
    let point = [1500.0, 800.0, 64.0];
    let old = [
        [100.0, 1099.780029296875, 69.99560546875],
        [-3025.0, 0.0, 48.0],
        [-3025.0, 1099.780029296875, 69.99560546875],
    ];
    let covering = [
        [7000.0, 799.8400268554688, 63.996795654296875],
        [1500.0, 799.8400268554688, 63.996795654296875],
        [1500.0, 859.8280639648438, 65.19656372070312],
    ];
    let (band, faces, vertices) = setup(&[old, covering], point);
    assert!(!contains_projected_point(&old, point));
    assert!(contains_projected_point(&covering, point));
    assert!(!same_plane(&old, &covering));
    assert!(faces[0].distance(point).0 < faces[1].distance(point).0);
    let original_q20 = exact_on_plane_weld(point, old).unwrap();
    let preferred_q20 = exact_on_plane_weld(point, covering).unwrap();
    assert!(!faces[0].admits(
        point,
        original_q20,
        faces[0].distance(point).1,
        &band,
        &vertices
    ));
    assert!(faces[1].admits(
        point,
        preferred_q20,
        faces[1].distance(point).1,
        &band,
        &vertices
    ));
    let (_, selected) = select(point, &faces, &band, &vertices).unwrap();
    assert!(std::ptr::eq(selected, &faces[0]));
    // Neither supporting plane is axis-aligned: the existing lazy rescue is
    // unavailable, so the caller must retain the original coordinate.
    assert!(super::super::lift::exact_axis_plane_foot(point, old).is_none());
    let mut cutter = [[point, [0.0, 0.0, 1000.0], [1.0, 0.0, 1000.0]]];
    assert_eq!(
        super::super::promote_cutter_verts_onto_host_faces(&mut cutter, &[old, covering]),
        0
    );
    assert_eq!(cutter[0][0], point);
}

#[test]
fn issue_7292_refused_axis_q20_keeps_the_existing_exact_foot_rescue() {
    // A long nearest axis-plane basis refuses a new in-plane Q20 shift.
    // A distinct covering plane offers an admitted Q20 point. Selection must
    // leave that decision to the established axis rescue, which preserves XY.
    let point = [7000.0 - 32.0 * STEP, 0.5, 3.0 * STEP];
    let old = [[0.0, 0.0, 0.0], [7000.0, 0.0, 0.0], [0.0, 1.0, 0.0]];
    let covering = [
        [6998.0, 0.0, 6.0 * STEP],
        [7002.0, 0.0, 6.0 * STEP],
        [6998.0, 4.0, 6.0 * STEP],
    ];
    let (band, faces, vertices) = setup(&[old, covering], point);
    assert!(!contains_projected_point(&old, point));
    assert!(contains_projected_point(&covering, point));
    let original_q20 = exact_on_plane_weld(point, old).unwrap();
    let preferred_q20 = exact_on_plane_weld(point, covering).unwrap();
    assert!(!faces[0].admits(
        point,
        original_q20,
        faces[0].distance(point).1,
        &band,
        &vertices
    ));
    assert!(faces[1].admits(
        point,
        preferred_q20,
        faces[1].distance(point).1,
        &band,
        &vertices
    ));
    let (_, selected) = select(point, &faces, &band, &vertices).unwrap();
    assert!(std::ptr::eq(selected, &faces[0]));
    let mut cutter = [[point, [0.0, 0.0, 1000.0], [1.0, 0.0, 1000.0]]];
    assert_eq!(
        super::super::promote_cutter_verts_onto_host_faces(&mut cutter, &[old, covering]),
        1
    );
    assert_eq!(
        cutter[0][0],
        [point[0], point[1], 0.0],
        "retain the original exact foot instead of the competing covering plane"
    );
}
