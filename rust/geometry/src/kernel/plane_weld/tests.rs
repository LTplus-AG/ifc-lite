// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::promote_cutter_verts_onto_host_faces;
use crate::kernel::predicates::orient3d;
use crate::kernel::{DropAxis, ImplicitPoint, Sign};

fn promote_probe(y: f64, plane_y: f64, origin_x: f64) -> (usize, [f64; 3]) {
    // The non-axis plane z=-y/64 keeps Q20's tangential displacement.
    // X contributes to neither the face normal nor the displacement.
    let host = [[[origin_x, 0.0, 0.0], [origin_x + 1.0, 0.0, 0.0],
        [origin_x, 7000.0, -109.375]]];
    let probe = [origin_x, y, -plane_y / 64.0 + 3.0 / 65_536.0];
    let mut cutter = [[probe, [origin_x, 0.0, 2.0], [origin_x + 1.0, 0.0, 2.0]]];
    let moved = promote_cutter_verts_onto_host_faces(&mut cutter, &host);
    (moved, cutter[0][0])
}

#[test]
fn issue_7292_reunites_an_existing_corner_with_direction_bounded_tangential_noise_387738() {
    let (moved, point) = promote_probe(7000.0 - 32.0 / 65_536.0, 7000.0, 0.0);
    assert_eq!(moved, 1, "only the near-plane corner may move");
    assert_eq!(point, [0.0, 7000.0, -109.375]);
}

#[test]
fn issue_7292_existing_corner_does_not_excuse_excessive_tangential_drift() {
    let y = 7000.0 - 128.0 / 65_536.0;
    let (moved, point) = promote_probe(y, 7000.0, 0.0);
    assert_eq!(moved, 0, "0.001953 exceeds the ~0.001669 Y noise band in caller units");
    assert_eq!(point, [0.0, y, -109.375 + 3.0 / 65_536.0]);
}

#[test]
fn issue_7292_tangential_noise_does_not_excuse_a_new_edge_point() {
    let target = 7000.0 * (1.0 - 1.0 / 1024.0);
    let y = target - 32.0 / 65_536.0;
    let (moved, point) = promote_probe(y, target, 0.0);
    assert_eq!(moved, 0, "only an existing host vertex may receive the corner exception");
    assert_eq!(point, [0.0, y, -target / 64.0 + 3.0 / 65_536.0]);
}

#[test]
fn issue_7292_an_irrelevant_axis_cannot_widen_the_corner_reunion_band() {
    // Huge X contributes to neither the tilted face normal nor the Y/Z drift.
    // A scalar noise radius would admit the otherwise excessive correction.
    let y = 7000.0 - 128.0 / 65_536.0;
    let origin_x = 100_000_000.0;
    let (moved, point) = promote_probe(y, 7000.0, origin_x);
    assert_eq!(moved, 0, "irrelevant X must not widen the Y/Z correction band");
    assert_eq!(point, [origin_x, y, -109.375 + 3.0 / 65_536.0]);
}

#[test]
fn issue_7292_axis_plane_feet_preserve_tangential_coordinates_907295() {
    // S_Office entity 907295 lost an exact axis-plane promotion
    // because Q20 moved its in-plane coordinates unnecessarily.
    for axis in [DropAxis::X, DropAxis::Y, DropAxis::Z] {
        let map = |u, v, w| match axis {
            DropAxis::X => [w, u, v],
            DropAxis::Y => [u, w, v],
            DropAxis::Z => [u, v, w],
        };
        let host = [[map(0.0, 0.0, 0.0), map(7000.0, 0.0, 0.0), map(0.0, 1.0, 0.0)]];
        let probe = map(7000.0 - 32.0 / 65_536.0, 0.5, 3.0 / 65_536.0);
        let mut cutter = [[probe, map(0.0, 0.0, 2.0), map(0.0, 1.0, 2.0)]];
        let moved = promote_cutter_verts_onto_host_faces(&mut cutter, &host);
        assert_eq!(moved, 1, "only the near-plane probe should move");
        let expected = map(7000.0 - 32.0 / 65_536.0, 0.5, 0.0);
        assert_eq!(cutter[0][0].map(f64::to_bits), expected.map(f64::to_bits),
            "#7292: exact axis foot must preserve both tangential coordinates for {axis:?}");
        let explicit = ImplicitPoint::Explicit;
        assert_eq!(orient3d(&explicit(cutter[0][0]), &explicit(host[0][0]),
            &explicit(host[0][1]), &explicit(host[0][2])), Sign::Zero);
    }
}

#[test]
fn issue_7292_non_axis_plane_retains_the_original_q20_lift() {
    // z=-y/64 has a perpendicular projection denominator of 4097. This
    // probe's true foot is not on the dyadic grid, so the original Q20
    // edge-basis lift must remain available, including its exact corner.
    let host = [[[0.0, 0.0, 0.0], [7000.0, 0.0, 0.0], [0.0, 64.0, -1.0]]];
    let probe = [7000.0 - 32.0 / 65_536.0, 0.0, 3.0 / 65_536.0];
    let mut cutter = [[probe, [0.0, 0.0, 2.0], [0.0, 1.0, 2.0]]];
    assert_eq!(promote_cutter_verts_onto_host_faces(&mut cutter, &host), 1);
    assert_eq!(cutter[0][0], [7000.0, 0.0, 0.0]);
    let explicit = ImplicitPoint::Explicit;
    assert_eq!(orient3d(&explicit(cutter[0][0]), &explicit(host[0][0]),
        &explicit(host[0][1]), &explicit(host[0][2])), Sign::Zero);
}
