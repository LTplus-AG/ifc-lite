// SPDX-License-Identifier: MPL-2.0
//! One material band of a concentric sector host, source only (#7955). The host's two end
//! lines need not be radial: dental_clinic #1674's inner arc spans 77.4 degrees and its outer
//! 75.1. A band's arcs therefore end where those lines cross the band's own radii, not at
//! the angles of the host arc each is scaled from.
use super::{clipping::Edge, prism::Prism};

/// Where the line from `a` to `b` crosses the circle about `c` of `radius`, between them.
fn crossing(a: [f64; 2], b: [f64; 2], c: [f64; 2], radius: f64) -> Option<[f64; 2]> {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let (fx, fy) = (a[0] - c[0], a[1] - c[1]);
    let (qa, qb, qc) = (dx * dx + dy * dy, 2. * (fx * dx + fy * dy), fx * fx + fy * fy - radius * radius);
    let root = (qb * qb - 4. * qa * qc).max(0.).sqrt();
    let t = [(-qb + root) / (2. * qa), (-qb - root) / (2. * qa)].into_iter()
        .find(|t| (-1e-9..=1. + 1e-9).contains(t))?;
    Some([a[0] + t * dx, a[1] + t * dy])
}

/// The host's radial slice inner..outer, its arcs trimmed to its own end lines.
pub(super) fn radial_band(host: &Prism, inner: f64, outer: f64) -> Option<Prism> {
    let edges = &host.loops[0].1;
    let [start, end] = [0, 1].map(|i| edges.iter().enumerate().filter(|(_, e)| matches!(e, Edge::Arc { .. })).nth(i));
    let ((first_at, first), (second_at, second)) = (start?, end?);
    let radius = |e: &Edge| match e { Edge::Arc { u, .. } => u[0].hypot(u[1]), _ => 0. };
    let minimum = radius(first).min(radius(second));
    let line = |at: usize| match edges[at % edges.len()] { Edge::Line(a, b) => Some((a, b)), _ => None };
    let trimmed = |at: usize, edge: &Edge| -> Option<Edge> {
        let Edge::Arc { c, u, v, sweep, .. } = *edge else { return None };
        let r = radius(edge);
        // `angle` inverts the arc's parametrisation only on a circle: |u| = |v| and u . v = 0.
        if (v[0].hypot(v[1]) - r).abs() > 1e-9 * r || (u[0] * v[0] + u[1] * v[1]).abs() > 1e-9 * r * r { return None; }
        let target = if r == minimum { inner } else { outer };
        let scale = target / r;
        let (u, v) = (u.map(|x| x * scale), v.map(|x| x * scale));
        let angle = |p: [f64; 2]| {
            let d = [p[0] - c[0], p[1] - c[1]];
            (d[0] * v[0] + d[1] * v[1]).atan2(d[0] * u[0] + d[1] * u[1])
        };
        let (before, after) = (line(at + edges.len() - 1)?, line(at + 1)?);
        let from = angle(crossing(before.0, before.1, c, target)?);
        let to = angle(crossing(after.0, after.1, c, target)?);
        // Same turning sense as the host arc, whatever branch atan2 lands on.
        let tau = std::f64::consts::TAU;
        let turn = if sweep > 0. { (to - from).rem_euclid(tau) } else { -(from - to).rem_euclid(tau) };
        Some(Edge::Arc { c, u, v, a: from, sweep: turn })
    };
    let (first, second) = (trimmed(first_at, first)?, trimmed(second_at, second)?);
    let e1 = Edge::Line(first.point(1.), second.point(0.));
    let e2 = Edge::Line(second.point(1.), first.point(0.));
    Some(Prism { loops: vec![(true, vec![first, e1, second, e2])], low: host.low, high: host.high, start: host.start })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::FRAC_PI_2;

    /// The quarter annulus 1 <= r <= 2 in the first quadrant; `v` is the inner arc's second axis.
    fn quarter(v: [f64; 2]) -> Prism {
        let inner = Edge::Arc { c: [0., 0.], u: [1., 0.], v, a: 0., sweep: FRAC_PI_2 };
        let outer = Edge::Arc { c: [0., 0.], u: [2., 0.], v: [0., 2.], a: FRAC_PI_2, sweep: -FRAC_PI_2 };
        let edges = vec![inner, Edge::Line([0., 1.], [0., 2.]), outer, Edge::Line([2., 0.], [1., 0.])];
        Prism { loops: vec![(true, edges)], low: 0., high: 1., start: 0. }
    }

    #[test]
    fn a_band_of_a_circular_sector_is_its_annulus_slice() {
        let band = radial_band(&quarter([0., 1.]), 1.2, 1.8).expect("a circular sector");
        let area = band.loops[0].1.iter().map(Edge::integral).sum::<f64>().abs();
        let hand = FRAC_PI_2 / 2. * (1.8f64.powi(2) - 1.2f64.powi(2));
        assert!((area - hand).abs() < 1e-12, "{area} vs {hand}");
    }

    /// Equal lengths but not perpendicular: an ellipse, whose parameter `atan2` does not invert.
    #[test]
    fn a_sheared_arc_basis_is_refused() {
        let (s, c) = 1.2f64.sin_cos();
        assert!(radial_band(&quarter([c, s]), 1.2, 1.8).is_none());
    }
}
