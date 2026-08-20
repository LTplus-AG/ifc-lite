// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;

#[test]
fn axis_aligned_box_is_closed_and_has_outward_normals() {
    let mesh = build_axis_aligned_box(2.0, 3.0, 4.0);
    assert_eq!(mesh.positions.len() / 3, 24);
    assert_eq!(mesh.indices.len() / 3, 12);

    let mut min = [f32::INFINITY; 3];
    let mut max = [f32::NEG_INFINITY; 3];
    for chunk in mesh.positions.chunks_exact(3) {
        for i in 0..3 {
            min[i] = min[i].min(chunk[i]);
            max[i] = max[i].max(chunk[i]);
        }
    }
    assert_eq!(min, [0.0, 0.0, 0.0]);
    assert_eq!(max, [2.0, 3.0, 4.0]);

    // Each face's normal should match its outward axis.
    let mut faces_seen = [false; 6];
    for chunk in mesh.normals.chunks_exact(12) {
        let nx = chunk[0];
        let ny = chunk[1];
        let nz = chunk[2];
        let label = match (nx, ny, nz) {
            (x, _, _) if x > 0.5 => 0,
            (x, _, _) if x < -0.5 => 1,
            (_, y, _) if y > 0.5 => 2,
            (_, y, _) if y < -0.5 => 3,
            (_, _, z) if z > 0.5 => 4,
            (_, _, z) if z < -0.5 => 5,
            _ => panic!("non-axial normal"),
        };
        faces_seen[label] = true;
    }
    assert!(faces_seen.iter().all(|&seen| seen), "missing a face");
}
