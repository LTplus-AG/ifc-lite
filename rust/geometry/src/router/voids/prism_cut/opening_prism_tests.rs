// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;
use crate::{extrude_profile, Point2, Point3, Profile2D, Vector3};

#[test]
fn issue_7024_rectangular_analytic_prism_shares_profile_hole_corners() {
    let pt = |x, y| Point2::new(x, y);
    let mut profile = Profile2D::new(vec![pt(0., 0.), pt(8., 0.), pt(8., 8.), pt(0., 8.)]);
    profile.add_hole(vec![pt(1., 1.), pt(1., 2.), pt(2., 2.), pt(2., 1.)]);
    let original_host = extrude_profile(&profile, 0.25, None).expect("closed slab with a hole");
    let g = crate::kernel::mesh_bridge::SNAP_GRID;
    // Cyclic permutations preserve winding and put the opening depth on
    // every coordinate axis, including analytic wall cuts (#7024).
    for axis in 0..3 {
        let rotate = |p: [f64; 3]| {
            let mut out = [0.; 3];
            for k in 0..3 {
                out[(k + axis) % 3] = p[k];
            }
            out
        };
        let mut host = original_host.clone();
        for p in host.positions.chunks_exact_mut(3) {
            let rotated = rotate([p[0] as f64, p[1] as f64, p[2] as f64]);
            for k in 0..3 {
                p[k] = rotated[k] as f32;
            }
        }
        for origin in [[0.; 3], [1000., 2000., 3000.]] {
            host.origin = origin;
            for (dx0, dx1) in [(g, g), (-g, 0.), (0., 0.)] {
                let lo = rotate([1. + dx0, 1., 0.]);
                let hi = rotate([2. + dx1, 2., 0.25]);
                let opening = OpeningType::Rectangular(
                    Point3::from(std::array::from_fn(|k| origin[k] + lo[k])),
                    Point3::from(std::array::from_fn(|k| origin[k] + hi[k])),
                    Some(Vector3::from(rotate([0., 0., 1.]))),
                );
                let prism = prepare_prism(&opening, &host).expect("rectangular prism");
                // A box is a valid prism along any of its three axes. Detection
                // may choose a different axis from the authored extrusion, so
                // compare the reconstructed solid's corners rather than one cap.
                let mut corners: Vec<_> = prism
                    .planes
                    .iter()
                    .flat_map(|&depth| {
                        prism.profiles[0].iter().map(move |p| {
                            add(
                                add(scale(prism.u, p[0]), scale(prism.v, p[1])),
                                scale(prism.d, depth),
                            )
                        })
                    })
                    .collect();
                corners.sort_by(|a, b| a.partial_cmp(b).unwrap());
                let mut expected: Vec<_> = [
                    [1., 1., 0.],
                    [1., 2., 0.],
                    [2., 1., 0.],
                    [2., 2., 0.],
                    [1., 1., 0.25],
                    [1., 2., 0.25],
                    [2., 1., 0.25],
                    [2., 2., 0.25],
                ]
                .into_iter()
                .map(rotate)
                .collect();
                expected.sort_by(|a, b| a.partial_cmp(b).unwrap());
                assert_eq!(
                    corners, expected,
                    "analytic rectangle must reconcile the same corners as exact dispatch"
                );
            }
        }
    }
}
