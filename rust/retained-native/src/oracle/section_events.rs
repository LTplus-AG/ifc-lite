// SPDX-License-Identifier: MPL-2.0
//! Section topology events: profile vertices, tangencies and moving K vertices.
use super::super::{clipping::Edge, math::*};
use super::ExtrudedHost;
pub(super) fn breakpoints(host: &ExtrudedHost, planes: &[[f64; 4]]) -> Option<Vec<f64>> {
    let mut times = vec![0., host.depth];
    let mut add = |t: f64| { if t.is_finite() && t > 0. && t < host.depth { times.push(t); } };
    let mut constraints = planes.to_vec();
    let mut work = 1_000_000usize;
    for (_, edges) in &host.loops { for edge in edges {
        for &[a, b, q, h] in planes {
            work = work.checked_sub(1)?;
            for p in [edge.point(0.), edge.point(1.)] { if q != 0. { add((h - a * p[0] - b * p[1]) / q); } }
            if let Edge::Arc { c, u, v, .. } = edge {
                // K-line tangent to the full supporting circle/ellipse.
                let extent = (a * u[0] + b * u[1]).hypot(a * v[0] + b * v[1]);
                if q != 0. { for sign in [-1., 1.] { add((h - a * c[0] - b * c[1] + sign * extent) / q); } }
            }
        }
        if let Edge::Line(a, b) = edge {
            let n = [b[1] - a[1], a[0] - b[0]];
            constraints.push([n[0], n[1], 0., n[0] * a[0] + n[1] * a[1]]);
        }
    } }
    // Include every moving K-vertex crossing a stationary profile line or
    // another K-line. Extra events from nonconvex supporting lines are harmless.
    for i in 0..planes.len() { for j in i + 1..constraints.len() {
        let p = constraints[i]; let q = constraints[j];
        for r in &constraints[j + 1..] {
            work = work.checked_sub(1)?;
            let a = [p[0], p[1], p[2]]; let b = [q[0], q[1], q[2]]; let c = [r[0], r[1], r[2]];
            let det = dot(a, cross(b, c));
            if det != 0. { add((p[3] * cross(b, c)[2] + q[3] * cross(c, a)[2] + r[3] * cross(a, b)[2]) / det); }
        }
        let det = p[0] * q[1] - p[1] * q[0];
        if det == 0. { continue; }
        let start = [(p[3] * q[1] - p[1] * q[3]) / det, (p[0] * q[3] - p[3] * q[0]) / det];
        let speed = [(-p[2] * q[1] + p[1] * q[2]) / det, (-p[0] * q[2] + p[2] * q[0]) / det];
        for (_, edges) in &host.loops { for e in edges {
            work = work.checked_sub(1)?;
            if let Edge::Arc { c, u, v, .. } = e {
                let det = u[0] * v[1] - u[1] * v[0];
                if det == 0. { return None; }
                let local = |p: [f64; 2]| [(p[0] * v[1] - p[1] * v[0]) / det, (u[0] * p[1] - u[1] * p[0]) / det];
                let a = local([start[0] - c[0], start[1] - c[1]]); let b = local(speed);
                let aa = b[0] * b[0] + b[1] * b[1]; let bb = 2. * (a[0] * b[0] + a[1] * b[1]);
                let cc = a[0] * a[0] + a[1] * a[1] - 1.;
                let disc = bb * bb - 4. * aa * cc;
                if aa > 0. && disc >= 0. { for sign in [-1., 1.] { add((-bb + sign * disc.sqrt()) / (2. * aa)); } }
            }
        } }
    } }
    times.sort_by(f64::total_cmp); times.dedup();
    (times.len() <= 16384).then_some(times)
}
