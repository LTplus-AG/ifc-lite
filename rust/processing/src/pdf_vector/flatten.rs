// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Iterative Bezier subdivision in the calibrated model plane.
//! This bounds geometric approximation; it does not certify path topology.
type Point = [f64; 2];

pub(super) fn charge(remaining: &mut u64, work: u64) -> Result<(), String> {
    *remaining = remaining
        .checked_sub(work)
        .ok_or("PDF curve flattening exceeds shared work budget")?;
    Ok(())
}
pub(super) fn distance(p: Point, a: Point, b: Point) -> f64 {
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
fn midpoint(a: Point, b: Point) -> Point {
    [a[0] * 0.5 + b[0] * 0.5, a[1] * 0.5 + b[1] * 0.5]
}
/// Append endpoints, excluding the original start. Controls are already in the
/// model plane: affine transformation commutes with Bezier evaluation, so the
/// error bound includes nonuniform scale and shear without a guessed scale.
pub(super) fn bezier<const N: usize>(
    controls: [Point; N],
    tolerance: f64,
    remaining: &mut u64,
    output: &mut Vec<Point>,
) -> Result<(), String> {
    if !(N == 3 || N == 4)
        || !tolerance.is_finite()
        || tolerance <= 0.
        || controls
            .iter()
            .flatten()
            .any(|x| !x.is_finite() || x.abs() > 1e8)
    {
        return Err("PDF curve requires finite quadratic/cubic controls and tolerance".into());
    }
    let mut stack = vec![(controls, 0_u8)];
    while let Some((points, depth)) = stack.pop() {
        charge(remaining, (N * N) as u64)?;
        let a = points[0];
        let b = points[N - 1];
        let magnitude = points.iter().flatten().fold(1_f64, |m, x| m.max(x.abs()));
        let roundoff = 128. * f64::EPSILON * magnitude;
        if roundoff >= tolerance {
            return Err("PDF curve tolerance is below model-coordinate numerical precision".into());
        }
        // A Bezier lies in its control hull. Distance to the finite chord is
        // convex, so this bounds every curve point; an infinite-line test would
        // incorrectly collapse collinear backtracking curves.
        let flat = points[1..N - 1]
            .iter()
            .all(|p| distance(*p, a, b) + roundoff <= tolerance);
        if flat && a != b {
            if output.len() >= 1024 {
                return Err("PDF curve exceeds flattened vertex budget".into());
            }
            output.push(b);
            continue;
        }
        if points.iter().all(|p| *p == a) {
            return Err("PDF curve collapses to one model-plane point".into());
        }
        if depth >= 32 {
            return Err("PDF curve subdivision depth exhausted; no partial geometry".into());
        }
        let mut layer = points;
        let mut left = points;
        let mut right = points;
        for level in 1..N {
            for i in 0..N - level {
                layer[i] = midpoint(layer[i], layer[i + 1]);
            }
            left[level] = layer[0];
            right[N - 1 - level] = layer[N - 1 - level];
        }
        if left == points || right == points {
            return Err(
                "PDF curve subdivision cannot advance at model-coordinate precision".into(),
            );
        }
        stack.push((right, depth + 1));
        stack.push((left, depth + 1));
    }
    Ok(())
}

#[cfg(test)]
#[path = "flatten_tests.rs"]
mod tests;
