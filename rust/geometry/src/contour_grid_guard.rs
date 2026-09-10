// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Conservative fixed-grid topology qualification, before integer overlay.
use crate::contour_bool2d::Ring2D;
use i_overlay::i_float::adapter::FloatPointAdapter;
use std::collections::BTreeMap;
fn orient(a: [f64; 2], b: [f64; 2], c: [f64; 2]) -> i8 {
    let d = geometry_predicates::orient2d(a, b, c);
    if d > 0. {
        1
    } else if d < 0. {
        -1
    } else {
        0
    }
}
fn integer_orient(a: [i64; 2], b: [i64; 2], c: [i64; 2]) -> i8 {
    let x = i128::from(b[0]) - i128::from(a[0]);
    let y = i128::from(b[1]) - i128::from(a[1]);
    let d = x * (i128::from(c[1]) - i128::from(a[1])) - y * (i128::from(c[0]) - i128::from(a[0]));
    d.signum() as i8
}
fn distance(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
    let d = [b[0] - a[0], b[1] - a[1]];
    let q = [p[0] - a[0], p[1] - a[1]];
    let n = d[0] * d[0] + d[1] * d[1];
    let t = if n == 0. {
        0.
    } else {
        ((q[0] * d[0] + q[1] * d[1]) / n).clamp(0., 1.)
    };
    (q[0] - t * d[0]).hypot(q[1] - t * d[1])
}
/// Inputs already have a bounded total edge count. These checks are quadratic;
/// the caller charges them along with overlay work. Uncertain cases refuse,
/// rather than claiming arbitrary path topology survives quantization.
pub(crate) fn validate_with_adapter(
    subject: &[Ring2D], clip: &[Ring2D], grid: f64,
    adapter: &FloatPointAdapter<[f64;2], i64>,
) -> Result<(), String> {
    let rings: Vec<_> = subject.iter().chain(clip).collect();
    let mut seen = BTreeMap::new();
    let mut edges = Vec::new();
    let mut magnitude = 1_f64;
    for ring in &rings {
        for p in ring.iter() {
            magnitude = magnitude.max(p[0].abs()).max(p[1].abs());
            let q = adapter.float_to_int(p);
            let q = [q.x, q.y];
            if seen.insert(q, *p).is_some_and(|old| old != *p) {
                return Err("Fixed-grid quantization collapses distinct PDF fill endpoints; choose a finer tolerance".into());
            }
        }
        for i in 0..ring.len() {
            let a = ring[i];
            let b = ring[(i + 1) % ring.len()];
            if a == b {
                continue;
            }
            let qa = adapter.float_to_int(&a);
            let qb = adapter.float_to_int(&b);
            edges.push((a, b, [qa.x, qa.y], [qb.x, qb.y]));
        }
    }
    // Room for endpoint and intersection rounding, plus conservative floating
    // coordinate subtraction error in the proximity diagnostics below.
    let margin = 8. * grid + 64. * f64::EPSILON * magnitude;
    let mut crossings = vec![0; edges.len()];
    let mut intersections: Vec<([f64; 2], usize, usize)> = vec![];
    for i in 0..edges.len() {
        for j in i + 1..edges.len() {
            let (a, b, qa, qb) = edges[i];
            let (c, d, qc, qd) = edges[j];
            // A side change relative to an infinite line is not a finite-edge
            // topology change when an axis still separates both endpoint boxes
            // before AND after quantization, beyond the existing error margin.
            let separated = (0..2).any(|axis| {
                let gap = a[axis].min(b[axis]).max(c[axis].min(d[axis]))
                    - a[axis].max(b[axis]).min(c[axis].max(d[axis]));
                let qgap = i128::from(qa[axis].min(qb[axis]).max(qc[axis].min(qd[axis])))
                    - i128::from(qa[axis].max(qb[axis]).min(qc[axis].max(qd[axis])));
                gap > margin && qgap as f64 * grid > margin
            });
            if separated { continue; }
            let original = [
                orient(a, b, c),
                orient(a, b, d),
                orient(c, d, a),
                orient(c, d, b),
            ];
            let snapped = [
                integer_orient(qa, qb, qc),
                integer_orient(qa, qb, qd),
                integer_orient(qc, qd, qa),
                integer_orient(qc, qd, qb),
            ];
            if original != snapped {
                return Err("Fixed-grid quantization changes fill boundary topology; choose a finer tolerance".into());
            }
            for (p, u, v, sign) in [
                (c, a, b, original[0]),
                (d, a, b, original[1]),
                (a, c, d, original[2]),
                (b, c, d, original[3]),
            ] {
                if sign != 0 && distance(p, u, v) <= margin {
                    return Err(
                        "PDF fill boundaries are too close to certify fixed-grid topology".into(),
                    );
                }
            }
            if original[0] * original[1] < 0 && original[2] * original[3] < 0 {
                crossings[i] += 1;
                crossings[j] += 1;
                if crossings[i] > 1 || crossings[j] > 1 {
                    return Err("PDF fill boundary has multiple crossings on one edge; topology qualification is not yet supported".into());
                }
                let u = [b[0] - a[0], b[1] - a[1]];
                let v = [d[0] - c[0], d[1] - c[1]];
                let w = [c[0] - a[0], c[1] - a[1]];
                let denominator = u[0] * v[1] - u[1] * v[0];
                if denominator.abs()
                    <= 64. * f64::EPSILON * (u[0] * v[1]).abs().max((u[1] * v[0]).abs())
                {
                    return Err("PDF fill intersection is too ill-conditioned to qualify".into());
                }
                let t = (w[0] * v[1] - w[1] * v[0]) / denominator;
                let p = [a[0] + t * u[0], a[1] + t * u[1]];
                if !t.is_finite() || p.iter().any(|v| !v.is_finite()) {
                    return Err("PDF fill intersection exceeds numeric range".into());
                }
                intersections.push((p, i, j));
            }
        }
    }
    for (k, (p, i, j)) in intersections.iter().enumerate() {
        for (l, (a, b, _, _)) in edges.iter().enumerate() {
            if l == *i || l == *j {
                if (p[0] - a[0]).hypot(p[1] - a[1]) <= margin
                    || (p[0] - b[0]).hypot(p[1] - b[1]) <= margin
                {
                    return Err("PDF fill intersection may collapse onto an endpoint".into());
                }
            } else if distance(*p, *a, *b) <= margin {
                return Err("PDF fill intersection may merge another boundary".into());
            }
        }
        if intersections[..k]
            .iter()
            .any(|(q, _, _)| (p[0] - q[0]).hypot(p[1] - q[1]) <= margin)
        {
            return Err("PDF fill intersections may collapse together on the fixed grid".into());
        }
    }
    Ok(())
}
