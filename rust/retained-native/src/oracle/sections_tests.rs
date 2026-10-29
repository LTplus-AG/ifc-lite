// SPDX-License-Identifier: MPL-2.0
use super::*;
use crate::oracle::clipping::Edge;

// #7955, M5 round 3: FZK #67536 profile #67490 and plane #67511 produce
// adjacent f64 topology events by the vertex and three-plane formulas.
#[test]
fn issue_7955_fzk_adjacent_breakpoints_integrate_without_relaxing_accuracy() {
    let points = [[0.3, -0.3], [11.7, -0.3], [12., 0.], [0., 0.]];
    let host = ExtrudedHost {
        loops: vec![(true, (0..4).map(|i| Edge::Line(points[i], points[(i + 1) % 4])).collect())],
        frame: IDENTITY,
        direction: [0., 0., 1.],
        depth: 3.5,
        jacobian: 1.,
    };
    let plane = [0., 0.50000000000019, 0.866025403784329, 0.43301270189216456];
    let breaks = events::breakpoints(&host, &[plane]).unwrap();
    let a = 0.6732050807569754_f64;
    let b = 0.6732050807569755_f64;
    assert_eq!(a.to_bits() + 1, b.to_bits());
    assert!(breaks.windows(2).any(|span| span == [a, b]), "{breaks:?}");
    assert_eq!(a + (b - a) / 2., a);
    // Trapezoid area=3.51, first y moment=-0.522. The kept height is
    // (h-b*y)/q everywhere on this profile; integrate it analytically.
    let expected = (plane[3] * 3.51 + plane[1] * 0.522) / plane[2];
    let volume = section_volume(&host, &[([plane[0], plane[1], plane[2]], plane[3])])
        .expect("adjacent topology events must not reject the FZK section");
    assert!((volume - expected).abs() <= RELATIVE * expected, "{volume} != {expected}");
}
