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
    let mut host = extrude_profile(&profile, 0.25, None).expect("closed slab with a hole");
    let g = crate::kernel::mesh_bridge::SNAP_GRID;
    for origin in [[0.; 3], [1000., 2000., 3000.]] {
        host.origin = origin;
        for (dx0, dx1) in [(g, g), (-g, 0.), (0., 0.)] {
            let opening = OpeningType::Rectangular(
                Point3::new(origin[0] + 1. + dx0, origin[1] + 1., origin[2]),
                Point3::new(origin[0] + 2. + dx1, origin[1] + 2., origin[2] + 0.25),
                Some(Vector3::new(0., 0., 1.)),
            );
            let prism = prepare_prism(&opening, &host).expect("rectangular prism");
            let mut corners: Vec<_> = prism.profiles[0].iter().map(|p| {
                let v = add(scale(prism.u, p[0]), scale(prism.v, p[1]));
                [v[0], v[1]]
            }).collect();
            corners.sort_by(|a, b| a.partial_cmp(b).unwrap());
            assert_eq!(corners, vec![[1., 1.], [1., 2.], [2., 1.], [2., 2.]],
                "analytic rectangle must reconcile the same corners as exact dispatch");
        }
    }
}
