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

/// A 23° wall frame with a core face over u in [0, 4] and a finish face over
/// u in [`finish.0`, `finish.1`], both at the cap depth `w` and both 3 m tall.
/// `wider_ccw` is the projected winding of the core face; the finish face
/// always has the opposite winding, as two touching closed shells do. The
/// aperture spans u in [1, `aperture_hi`] and v in [1, 2].
fn oblique_pair(
    end: usize,
    finish: (f64, f64),
    aperture_hi: f64,
    wider_ccw: bool,
) -> (PrismFrame, Vec<PTri>) {
    let (s, c) = 23.0_f64.to_radians().sin_cos();
    let w = 2.411;
    let planes = if end == 0 { vec![w, w + 0.012] } else { vec![w - 0.012, w] };
    let (lo, hi) = ([1.0, 1.0], [aperture_hi, 2.0]);
    let pf = PrismFrame {
        u: [-s, c, 0.0],
        v: [0.0, 0.0, 1.0],
        d: [c, s, 0.0],
        planes,
        profiles: vec![vec![lo, [hi[0], lo[1]], hi, [lo[0], hi[1]]]],
        slab_area: vec![1.0],
        slab_interior: vec![[1.5, 1.5]],
        bb: (lo, hi),
    };
    let mut positions = Vec::new();
    for [uu, vv] in [[0.0, 0.0], [4.0, 0.0], [4.0, 3.0], [0.0, 3.0]]
        .into_iter()
        .chain([[finish.0, 0.0], [finish.1, 0.0], [finish.1, 3.0], [finish.0, 3.0]])
    {
        positions.extend(pf.lift(uu, vv, w).map(|x| x as f32));
    }
    let ccw = |q: u32| [q, q + 1, q + 2, q, q + 2, q + 3];
    let cw = |q: u32| [q, q + 2, q + 1, q, q + 3, q + 2];
    let (wider, finish) = if wider_ccw { (ccw(0), cw(4)) } else { (cw(0), ccw(4)) };
    let host = Mesh {
        positions,
        indices: wider.into_iter().chain(finish).collect(),
        ..Mesh::default()
    };
    let tris = ptris_from_mesh(&host).expect("finite host");
    (pf, tris)
}

#[test]
fn oblique_paired_cap_defers_for_either_source_winding_11351() {
    // The finish shares the core's u = 0 corners and covers part of the
    // aperture. Reversing both shells swaps the signed-area groups but not
    // which face contains the other, so the deferral must not change.
    for end in [0, 1] {
        for wider_ccw in [false, true] {
            let (pf, tris) = oblique_pair(end, (0.0, 1.5), 2.0, wider_ccw);
            assert!(
                has_oblique_paired_cap(&pf, &tris),
                "end={end} wider_ccw={wider_ccw}",
            );
        }
    }
}

#[test]
fn oblique_paired_cap_still_needs_shared_corners_11351() {
    // A near-coplanar quad that touches no core corner is a separate face,
    // whichever signed-area group either face falls in.
    for end in [0, 1] {
        for wider_ccw in [false, true] {
            let (pf, tris) = oblique_pair(end, (0.2, 1.7), 2.0, wider_ccw);
            assert!(
                !has_oblique_paired_cap(&pf, &tris),
                "end={end} wider_ccw={wider_ccw}",
            );
        }
    }
}

#[test]
fn oblique_paired_cap_tries_both_mutually_contained_faces_11351() {
    // The finish stops half a band short of the core's u = 4 edge, so each
    // face contains the other within the band. The aperture reaches 3/4 of a
    // band past u = 4: only the core covers it. Whichever signed-area group
    // the core falls in, it counts as the outer face and the cut defers.
    let band = flush_band_at(oblique_pair(0, (0.0, 4.0), 4.0, true).0.corner_mag());
    for end in [0, 1] {
        for wider_ccw in [false, true] {
            let finish = (0.0, 4.0 - 0.5 * band);
            let (pf, tris) = oblique_pair(end, finish, 4.0 + 0.75 * band, wider_ccw);
            assert_eq!(flush_band_at(pf.corner_mag()), band);
            assert!(
                has_oblique_paired_cap(&pf, &tris),
                "end={end} wider_ccw={wider_ccw}",
            );
        }
    }
}
