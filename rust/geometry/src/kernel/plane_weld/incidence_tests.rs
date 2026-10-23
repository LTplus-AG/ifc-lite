// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;
use crate::kernel::plane_weld::promote_cutter_verts_onto_host_faces;

fn map_triangle(t: Tri, axis: usize, reverse: bool) -> Tri {
    let mut t = t.map(|p| [p[axis % 3], p[(axis + 1) % 3], p[(axis + 2) % 3]]);
    if reverse { t.swap(0, 1); }
    t
}

#[test]
fn issue_7292_exact_overlap_requires_positive_area_in_every_projection_and_winding() {
    let a = [[0.0, 0.0, 0.0], [4.0, 0.0, 0.0], [0.0, 4.0, 0.0]];
    // Analytic intersections: identical area 8, contained area 1/2,
    // crossing area 2; edge/point/disjoint intersections have area zero.
    let cases = [
        (a, true),
        ([[1.0, 1.0, 0.0], [2.0, 1.0, 0.0], [1.0, 2.0, 0.0]], true),
        ([[2.0, 0.0, 0.0], [6.0, 0.0, 0.0], [2.0, 4.0, 0.0]], true),
        ([[0.0, 0.0, 0.0], [4.0, 0.0, 0.0], [0.0, -4.0, 0.0]], false),
        ([[4.0, 0.0, 0.0], [5.0, 0.0, 0.0], [4.0, 1.0, 0.0]], false),
        ([[5.0, 0.0, 0.0], [6.0, 0.0, 0.0], [5.0, 1.0, 0.0]], false),
    ];
    for axis in 0..3 {
        for reverse_a in [false, true] {
            for reverse_b in [false, true] {
                let a = map_triangle(a, axis, reverse_a);
                for (b, expected) in cases {
                    let b = map_triangle(b, axis, reverse_b);
                    assert_eq!(positive_overlap(&a, &b), expected);
                    assert_eq!(positive_overlap(&b, &a), expected);
                }
            }
        }
    }
}

#[test]
fn issue_7292_only_exact_nondegenerate_overlapping_faces_constrain_motion() {
    let host = [[[0.0, 0.0, 0.0], [4.0, 0.0, 0.0], [0.0, 4.0, 0.0]]];
    let source = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]];
    let target = [0.0, 0.0, 1.0];
    assert!(!ExactFaceIncidences::new(&[source], &host).admits(source[0], target, &host));
    // One off-plane corner destroys face coplanarity, even though the tested
    // corner itself remains exactly on the host's infinite supporting plane.
    let mut tilted = source;
    tilted[2][2] = 1.0 / 65_536.0;
    assert!(ExactFaceIncidences::new(&[tilted], &host).admits(tilted[0], target, &host));
    let line = [source[0], source[1], [2.0, 0.0, 0.0]];
    assert!(!positive_overlap(&host[0], &line));
    assert!(!positive_overlap(&line, &host[0]));
    assert!(ExactFaceIncidences::new(&[line], &host).admits(line[0], target, &host));
    let remote = source.map(|p| [p[0] + 8.0, p[1], p[2]]);
    assert!(ExactFaceIncidences::new(&[remote], &host).admits(remote[0], target, &host));
}

#[test]
fn issue_7292_duplicate_positions_and_signed_zero_preserve_all_incident_faces() {
    let host = [
        [[0.0, 0.0, 0.0], [4.0, 0.0, 0.0], [0.0, 4.0, 0.0]],
        [[0.0, 0.0, 0.0], [4.0, 0.0, 0.0], [0.0, 0.0, 4.0]],
    ];
    let source = [
        [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
        [[-0.0, -0.0, -0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]],
        [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
    ];
    for faces in [source, [source[2], source[1], source[0]]] {
        let incidence = ExactFaceIncidences::new(&faces, &host);
        for original in [[0.0; 3], [-0.0; 3]] {
            assert!(!incidence.admits(original, [1.0, 1.0, 0.0], &host),
                "remaining on Z=0 must not break the incident Y=0 face");
            assert!(!incidence.admits(original, [1.0, 0.0, 1.0], &host),
                "remaining on Y=0 must not break the incident Z=0 face");
            assert!(incidence.admits(original, [1.0, 0.0, 0.0], &host),
                "motion along the shared supporting-plane intersection is legal");
        }
    }
}

#[test]
fn issue_7292_retained_constraints_are_bounded_by_source_faces_not_host_tessellation() {
    for side in [1, 4, 16, 32] {
        let mut host = Vec::new();
        for x in 0..side {
            for y in 0..side {
                let (x, y) = (x as f64, y as f64);
                host.push([[x, y, 0.0], [x + 1.0, y, 0.0], [x, y + 1.0, 0.0]]);
                host.push([[x + 1.0, y, 0.0], [x + 1.0, y + 1.0, 0.0], [x, y + 1.0, 0.0]]);
            }
        }
        let edge = side as f64;
        let source = [[[0.0, 0.0, 0.0], [edge, 0.0, 0.0], [0.0, edge, 0.0]]];
        let incidence = ExactFaceIncidences::new(&source, &host);
        assert!(!incidence.admits(source[0][0], [0.0, 0.0, 1.0], &host));
        let registrations: usize = incidence.planes.values().map(Vec::len).sum();
        assert!(registrations <= 3 * source.len(),
            "refining a shared host surface must not multiply retained plane constraints");
    }
}

#[test]
fn issue_7292_minibim_exact_overlapping_reveal_survives_competing_q20_promotion() {
    // MiniBIM 137627, alternate first CSG group: C1 source face 6 is
    // exactly coplanar with host 118 over positive area, despite both source
    // corner heights lying outside the host face. Host 186 competes with it.
    let source = [
        [9.089569091796875, 22.521331787109375, 6.5749969482421875],
        [6.4639434814453125, 21.703643798828125, 6.5749969482421875],
        [6.4639434814453125, 21.703643798828125, 6.975006103515625],
    ];
    let support = [
        [6.4639434814453125, 21.703643798828125, 6.649993896484375],
        [9.089569091796875, 22.521331787109375, 6.649993896484375],
        [9.089569091796875, 22.521331787109375, 6.899993896484375],
    ];
    let competing = [
        [6.40447998046875, 21.89459228515625, 6.649993896484375],
        [6.315277099609375, 22.1810302734375, 6.649993896484375],
        [6.315277099609375, 22.1810302734375, 6.899993896484375],
    ];
    let expected_q20 = [6.4639451932453085, 21.703644461988006, source[2][2]];
    let mut isolated = [source];
    assert!(promote_cutter_verts_onto_host_faces(&mut isolated, &[competing]) > 0);
    assert_eq!(isolated[0][2], expected_q20,
        "the real competing plane must exercise an admitted Q20 move");
    assert!(!on_plane(expected_q20, &support));
    assert!(on_plane(expected_q20, &competing));
    assert!(source.iter().all(|&p| on_plane(p, &support)));
    assert!(positive_overlap(&support, &source));
    for host in [[competing, support], [support, competing]] {
        let mut cutter = [source, source];
        promote_cutter_verts_onto_host_faces(&mut cutter, &host);
        for face in cutter {
            assert_eq!(face[2], source[2], "preserve the original exact reveal seam");
            assert!(face.iter().all(|&p| on_plane(p, &support)),
                "every occurrence of the overlapping face stays on its original plane");
        }
    }
}

// #7292: preserve the pre-deferred promotion's bit write without inflating moved telemetry.
#[test]
fn issue_7292_deferred_promotion_keeps_a_numeric_noop_signed_zero_write() {
    use crate::kernel::{arrangement::Tri, near_band, predicates::orient3d, ImplicitPoint, Sign};
    use crate::kernel::plane_weld::{lift::exact_on_plane_weld, selection::{Face, select}, promote_cutter_verts_onto_host_faces};
    let host: [Tri; 1] = [[
        [60.132110595703125, 102.38771057128906, -41.9317626953125],
        [7.43914794921875, 46.67027282714844, 76.77105712890625],
        [-7.43914794921875, -113.66767883300781, -87.21969604492188],
    ]];
    // Exact S16 midpoint of host[1] and host[2], distinct from all host corners.
    let original = [-0.0, -33.49870300292969, -5.2243194580078125];
    let mut source = [[original, host[0][0], host[0][1]]];
    let e = ImplicitPoint::Explicit;
    assert_eq!(orient3d(&e(original), &e(host[0][0]), &e(host[0][1]), &e(host[0][2])), Sign::Zero);
    let mut band = near_band::NearBand::default();
    band.observe_tris(&host);
    band.observe_tris(&source);
    let faces = [Face::new(host[0], &band).expect("nondegenerate host face")];
    let corners = near_band::exact_vertex_set(&host);
    assert!(!corners.contains(&near_band::vertex_bits(&original)));
    // Actual selection must reach the lift: exact coplanarity does not imply
    // the rounded floating distance is zero for this nonaxis host plane.
    let (distance, _) = select(original, &faces, &band, &corners).expect("rounded nonzero face distance reaches Q20");
    assert_ne!(distance, 0.0);
    let target = exact_on_plane_weld(original, host[0]).expect("original Q20 gates pass");
    assert_eq!(target, original, "this fixture is a numeric no-op");
    assert_ne!(near_band::vertex_bits(&target), near_band::vertex_bits(&original));
    assert_eq!(target[0].to_bits(), 0.0f64.to_bits());
    let moved = promote_cutter_verts_onto_host_faces(&mut source, &host);
    assert_eq!(moved, 0, "pre-deferred telemetry counts numeric movement only");
    assert_eq!(near_band::vertex_bits(&source[0][0]), near_band::vertex_bits(&target),
        "pre-deferred code still wrote the signed-zero-normalized exact target");
}

#[test]
fn issue_7292_axis_foot_rescues_979333_without_breaking_exact_shared_side_faces() {
    // S_Office entity 979333 job 001: Q20 on X=3750 scatters Y off
    // an exact overlapping side face. The exact X foot preserves that face.
    let axis_host = [
        [3750.0, 20.0, 0.0], [3750.0, 110.0, 0.0],
        [3750.0, 109.99888610839844, 2714.999267578125],
    ];
    for (y, source, support) in [
        (20.0,
            [[3749.999755859375, 20.0, 80.0], [0.0, 20.0, 80.0], [0.0, 20.0, 0.0]],
            [[0.0, 20.0, 0.0], [3750.0, 20.0, 0.0], [3750.0, 20.0, 3250.0]]),
        (110.0,
            [[3749.999755859375, 110.0, 80.0], [3750.0, 110.0, 0.0], [0.0, 110.0, 80.0]],
            [[0.0, 110.0, 3250.0], [3750.0, 110.0, 3250.0], [3750.0, 110.0, 0.0]]),
    ] {
        // This control demonstrates the raw Q20 primitive's scatter. Full
        // promotion may also preserve healthy original axis-face coordinates.
        let q20 = super::super::lift::exact_on_plane_weld(source[0], axis_host)
            .expect("original Q20 gates pass");
        assert_ne!(q20, [3750.0, y, 80.0], "control must exercise Q20 tangential scatter");
        assert!(on_plane(q20, &axis_host));
        assert!(!on_plane(q20, &support));
        for host in [[axis_host, support], [support, axis_host]] {
            let mut cutter = [source];
            assert!(promote_cutter_verts_onto_host_faces(&mut cutter, &host) > 0);
            assert_eq!(cutter[0][0], [3750.0, y, 80.0],
                "support-preserving exact foot must complete the X reconciliation");
            assert!(cutter[0].iter().all(|&p| on_plane(p, &support)));
            assert!(on_plane(cutter[0][0], &axis_host));
        }
    }
}

#[test]
fn issue_7292_axis_foot_cannot_break_an_existing_rotated_shared_face() {
    let delta = 1.0 / 65_536.0;
    // Source lies on X+Y=0. Neither Q20 nor the exact X=0 foot can
    // reconcile this corner without destroying the shared rotated face.
    let source = [[delta, -delta, 1.0], [1.0, -1.0, 1.0], [delta, -delta, 2.0]];
    let support = [[0.0, 0.0, 0.0], [2.0, -2.0, 0.0], [0.0, 0.0, 4.0]];
    let axis_host = [[0.0, 0.0, 0.0], [0.0, 3.0, 0.0], [0.0, 0.0, 3.0]];
    let foot = [0.0, -delta, 1.0];
    assert!(positive_overlap(&support, &source));
    assert!(on_plane(foot, &axis_host));
    assert!(!on_plane(foot, &support));
    let mut isolated = [source];
    promote_cutter_verts_onto_host_faces(&mut isolated, &[axis_host]);
    assert_ne!(isolated[0][0], source[0], "control must reach an admitted proposal");
    for host in [[axis_host, support], [support, axis_host]] {
        let mut cutter = [source];
        promote_cutter_verts_onto_host_faces(&mut cutter, &host);
        assert_eq!(cutter[0][0], source[0], "unsafe axis foot must also be refused");
        assert!(cutter[0].iter().all(|&p| on_plane(p, &support)));
    }
}
