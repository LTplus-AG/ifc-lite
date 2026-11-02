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
