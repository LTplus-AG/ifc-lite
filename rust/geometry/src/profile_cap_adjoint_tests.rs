// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::Dual;
use crate::Point2;

#[test]
fn issue_7631_recovered_cap_area_retains_authored_vertex_derivatives() {
    let profile = crate::profile_generic::tests::bridge_profile();
    let lift = |ring: &[Point2<f64>]| -> Vec<Point2<Dual<1>>> {
        ring.iter().map(|p| Point2::new(Dual::constant(p.x), Dual::constant(p.y))).collect()
    };
    let outer = lift(&profile.outer);
    let mut holes: Vec<_> = profile.holes.iter().map(|r| lift(r)).collect();
    // Move one authored hole corner in x, including its repeated closing
    // endpoint. The analytic cap-area derivative is half the next-minus-
    // previous y coordinate, because this hole has clockwise winding.
    let last = holes[0].len() - 1;
    let x = Dual::variable(profile.holes[0][0].x, 0);
    holes[0][0].x = x;
    holes[0][last].x = x;
    let expected = 0.5 * (profile.holes[0][1].y - profile.holes[0][last - 1].y);
    assert!(expected > 0.0);

    let mut data = Vec::new();
    let mut offsets = Vec::new();
    for (i, ring) in std::iter::once(&profile.outer).chain(profile.holes.iter()).enumerate() {
        if i > 0 { offsets.push(data.len() / 2); }
        for p in ring { data.extend([p.x, p.y]); }
    }
    let established = crate::triangulation::safe_earcut(&data, &offsets, 2).unwrap();
    let cap = crate::profile_generic::triangulate_rings(&outer, &holes).unwrap();
    assert!(cap.indices.len() > established.len(), "the missing-boundary retry must actually run");
    let area = cap.indices.chunks_exact(3).fold(Dual::constant(0.0), |sum, t| {
        let (a, b, c) = (cap.points[t[0]], cap.points[t[1]], cap.points[t[2]]);
        sum + ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) * Dual::constant(0.5)
    });
    assert!((area.d[0] - expected).abs() < 1e-9,
        "recovered cap area must carry the analytic derivative: {} vs {expected}", area.d[0]);
}
