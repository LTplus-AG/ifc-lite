// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Sufficient, deliberately conservative original-curve simplicity certificate.
use super::flatten::charge;
use ifc_lite_geometry::{
    kernel::{predicates::orient2d, DropAxis, ImplicitPoint, Sign},
    Ring2D,
};
pub(super) fn sign(a: [f64; 2], b: [f64; 2], c: [f64; 2]) -> Sign {
    let explicit = |p: [f64; 2]| ImplicitPoint::Explicit([p[0], p[1], 0.]);
    orient2d(&explicit(a), &explicit(b), &explicit(c), DropAxis::Z)
}
pub(super) fn convex(controls: &[[f64; 2]], remaining: &mut u64) -> Result<(), String> {
    charge(remaining, (controls.len() as u64).pow(2))?;
    let mut winding = Sign::Zero;
    for i in 0..controls.len() {
        let a = controls[i];
        let b = controls[(i + 1) % controls.len()];
        if a == b {
            continue;
        }
        for &p in controls {
            let s = sign(a, b, p);
            if s == Sign::Zero {
                continue;
            }
            if winding != Sign::Zero && winding != s {
                return Err("PDF Bezier piece requires a convex control polygon".into());
            }
            winding = s;
        }
    }
    if winding == Sign::Zero {
        let a = controls[0];
        let b = controls[controls.len() - 1];
        let axis = usize::from((b[1] - a[1]).abs() > (b[0] - a[0]).abs());
        let ordered = a != b
            && controls.windows(2).all(|p| {
                if b[axis] > a[axis] {
                    p[0][axis] <= p[1][axis]
                } else {
                    p[0][axis] >= p[1][axis]
                }
            });
        if !ordered {
            return Err("PDF Bezier control polygon is collapsed or backtracks on a line".into());
        }
    }
    Ok(())
}
fn strictly_separated(a: &Ring2D, b: &Ring2D) -> bool {
    for hull in [a, b] {
        for i in 0..hull.len() {
            for j in i + 1..hull.len() {
                let p = hull[i];
                let q = hull[j];
                if p == q {
                    continue;
                }
                let aa: Vec<_> = a.iter().map(|x| sign(p, q, *x)).collect();
                let bb: Vec<_> = b.iter().map(|x| sign(p, q, *x)).collect();
                for (near, far) in [(&aa, &bb), (&bb, &aa)] {
                    if (near.iter().all(|s| *s != Sign::Negative)
                        && far.iter().all(|s| *s == Sign::Negative))
                        || (near.iter().all(|s| *s != Sign::Positive)
                            && far.iter().all(|s| *s == Sign::Positive))
                    {
                        return true;
                    }
                }
            }
        }
    }
    false
}
fn shared_endpoint_only(a: &Ring2D, b: &Ring2D, p: [f64; 2]) -> bool {
    let aa: Vec<_> = a.iter().copied().filter(|q| *q != p).collect();
    let bb: Vec<_> = b.iter().copied().filter(|q| *q != p).collect();
    if aa.is_empty() || bb.is_empty() {
        return false;
    }
    let separates = |d: [f64; 2]| {
        let q = [p[0] + d[0], p[1] + d[1]];
        if p == q || q.iter().any(|v| !v.is_finite()) {
            return false;
        }
        let sa: Vec<_> = aa.iter().map(|x| sign(p, q, *x)).collect();
        let sb: Vec<_> = bb.iter().map(|x| sign(p, q, *x)).collect();
        (sa.iter().all(|s| *s == Sign::Positive) && sb.iter().all(|s| *s == Sign::Negative))
            || (sa.iter().all(|s| *s == Sign::Negative) && sb.iter().all(|s| *s == Sign::Positive))
    };
    for q in aa.iter().chain(&bb) {
        if separates([p[1] - q[1], q[0] - p[0]]) {
            return true;
        }
    }
    for x in &aa {
        for y in &bb {
            let u = [x[0] - p[0], x[1] - p[1]];
            let v = [y[0] - p[0], y[1] - p[1]];
            let un = u[0].hypot(u[1]);
            let vn = v[0].hypot(v[1]);
            if separates([u[0] / un + v[0] / vn, u[1] / un + v[1] / vn]) {
                return true;
            }
        }
    }
    false
}
// Two pieces may bound a lens (or a curve and its closing chord). Bernstein
// weights are positive inside (0,1): one strictly sided control and no control
// across the chord proves the curve interior cannot touch that chord.
fn shared_chord(a: &Ring2D, b: &Ring2D) -> bool {
    if a.first() != b.last() || a.last() != b.first() || a.first() == a.last() {
        return false;
    }
    let p = a[0];
    let q = *a.last().unwrap();
    let side = |h: &Ring2D| {
        let mut result = Sign::Zero;
        for x in &h[1..h.len() - 1] {
            let s = sign(p, q, *x);
            if s == Sign::Zero {
                continue;
            }
            if result != Sign::Zero && result != s {
                return None;
            }
            result = s;
        }
        Some(result)
    };
    match (side(a), side(b)) {
        (Some(x), Some(y)) => x != y,
        _ => false,
    }
}
/// Each curve is inside its convex control hull. Strict separation therefore
/// proves different original pieces cannot meet, except at a declared adjacent
/// endpoint. Candidate lines may miss a possible separator; that only refuses.
pub(super) fn qualify(pieces: &[Ring2D], remaining: &mut u64) -> Result<(), String> {
    charge(remaining, (pieces.len() as u64).pow(2) * 256)?;
    for i in 0..pieces.len() {
        for j in i + 1..pieces.len() {
            let a = &pieces[i];
            let b = &pieces[j];
            let adjacent = if j == i + 1 && a.last() == b.first() {
                a.last().copied()
            } else if i == 0 && j + 1 == pieces.len() && b.last() == a.first() {
                a.first().copied()
            } else {
                None
            };
            let valid = (pieces.len() == 2 && shared_chord(a, b))
                || adjacent.map_or_else(
                    || strictly_separated(a, b),
                    |p| shared_endpoint_only(a, b, p),
                );
            if !valid {
                return Err("PDF curved control hulls have unresolved contact or overlap; no partial geometry".into());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "curve_hulls_tests.rs"]
mod tests;
