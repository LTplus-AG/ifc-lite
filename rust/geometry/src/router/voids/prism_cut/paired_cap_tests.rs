// SPDX-License-Identifier: MPL-2.0

use super::*;

#[test]
fn exact_jamb_preserves_a_floor_wider_than_the_finish() {
    // The finish covers half of the aperture and meets the wider core at
    // depth zero. The exact route should retain the authored cap (#10528).
    let axes = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    for end in [0, 1] {
        let core_side_depth = if end == 0 { -0.2 } else { 0.2 };
        let mut host = Mesh {
            positions: vec![
                0.0, 0.0, 0.0, 4.0, 0.0, 0.0, 4.0, 3.0, 0.0, 0.0, 3.0, 0.0,
                0.0, 0.0, 0.0, 1.5, 0.0, 0.0, 1.5, 3.0, 0.0, 0.0, 3.0, 0.0,
                4.0, 0.0, core_side_depth,
            ],
            indices: vec![0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 1, 2, 8],
            ..Mesh::default()
        };
        if end == 1 {
            for triangle in host.indices.chunks_exact_mut(3) {
                triangle.swap(1, 2);
            }
        }
        let depths = if end == 0 { [0.0, 0.012] } else { [-0.012, 0.0] };
        let jamb = [end == 0, end == 1];
        let lo = [1.0, 1.0, depths[0]];
        let hi = [2.0, 2.0, depths[1]];
        assert_eq!(paired_exact_jambs(&host, axes, lo, hi, jamb), jamb);
    }
}

#[test]
fn exact_jamb_does_not_choose_a_wider_finish_as_the_floor_11276() {
    // The wide face is the bottom of the finish. Its exclusive corner
    // continues into the opening (+Z), while the narrower core lies below.
    let mut host = Mesh {
        positions: vec![
            0.0, 0.0, 0.0, 4.0, 0.0, 0.0, 4.0, 3.0, 0.0, 0.0, 3.0, 0.0,
            0.0, 0.0, 0.0, 1.5, 0.0, 0.0, 1.5, 3.0, 0.0, 0.0, 3.0, 0.0,
            4.0, 0.0, 0.012, 1.5, 0.0, -0.2,
        ],
        indices: vec![0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 1, 2, 8, 4, 9, 5],
        ..Mesh::default()
    };
    let axes = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    for inward in [false, true] {
        if inward {
            for triangle in host.indices.chunks_exact_mut(3) {
                triangle.swap(1, 2);
            }
        }
        let paired = paired_exact_jambs(
            &host, axes, [1.0, 1.0, 0.0], [2.0, 2.0, 0.012], [true, false],
        );
        assert_eq!(paired, [false, false], "inward={inward}");
    }
}
