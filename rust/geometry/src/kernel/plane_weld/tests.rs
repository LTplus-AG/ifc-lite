// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::promote_cutter_verts_onto_host_faces;
use crate::kernel::arrangement::Tri;

fn promote_probe(x: f64, origin_y: f64) -> (usize, [f64; 3]) {
    let host: [Tri; 1] = [[[0.0, origin_y, 0.0], [7000.0, origin_y, 0.0], [0.0, origin_y + 1.0, 0.0]]];
    let probe = [x, origin_y, 3.0 / 65_536.0];
    let mut cutter = [[probe, [0.0, origin_y, 2.0], [0.0, origin_y + 1.0, 2.0]]];
    let moved = promote_cutter_verts_onto_host_faces(&mut cutter, &host);
    (moved, cutter[0][0])
}

#[test]
fn issue_7292_reunites_an_existing_corner_with_direction_bounded_tangential_noise_387738() {
    // #387738: normal-band-only rejection tore a previously closed slant
    // cut. The 488 µm lateral correction exceeds the 122 µm normal floor
    // but fits the X-projected f32 band (~1.669 mm at 7000 caller units).
    let (moved, point) = promote_probe(7000.0 - 32.0 / 65_536.0, 0.0);
    assert_eq!(moved, 1, "only the near-plane corner may move");
    assert_eq!(point, [7000.0, 0.0, 0.0], "the exact existing host corner must reunite");
}

#[test]
fn issue_7292_existing_corner_does_not_excuse_excessive_tangential_drift() {
    // Q20 quantization still targets the existing corner, but 1.953 mm
    // exceeds the same 1.669 mm X noise band. Target identity is insufficient.
    let x = 7000.0 - 128.0 / 65_536.0;
    let (moved, point) = promote_probe(x, 0.0);
    assert_eq!(moved, 0, "an excessive jump must be refused even to an existing corner");
    assert_eq!(point, [x, 0.0, 3.0 / 65_536.0]);
}

#[test]
fn issue_7292_tangential_noise_does_not_excuse_a_new_edge_point() {
    // This exact Q20 lift target lies inside an edge, rather than at an
    // existing host vertex. Although the 488 µm drift fits the X noise band,
    // permitting it can tilt the cutter's other coincident sides (#7292).
    let target = 7000.0 * (1.0 - 1.0 / 1024.0);
    let x = target - 32.0 / 65_536.0;
    let (moved, point) = promote_probe(x, 0.0);
    assert_eq!(moved, 0, "only an existing host vertex may receive the corner exception");
    assert_eq!(point, [x, 0.0, 3.0 / 65_536.0]);
}

#[test]
fn issue_7292_an_irrelevant_axis_cannot_widen_the_corner_reunion_band() {
    // Large Y must not enlarge a correction entirely along X. A scalar
    // radius would incorrectly admit this otherwise excessive 1.953 mm jump.
    let x = 7000.0 - 128.0 / 65_536.0;
    let origin_y = 100_000_000.0;
    let (moved, point) = promote_probe(x, origin_y);
    assert_eq!(moved, 0, "unrelated Y magnitude must not widen the X decision band");
    assert_eq!(point, [x, origin_y, 3.0 / 65_536.0]);
}
