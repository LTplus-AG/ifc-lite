// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::transfer_types::TransferFrame;
use nalgebra::{Matrix3, Vector3};

pub(super) type Point = [f64; 3];
pub(super) fn sub(a: Point, b: Point) -> Point {
    std::array::from_fn(|i| a[i] - b[i])
}
pub(super) fn dot(a: Point, b: Point) -> f64 {
    a.iter().zip(b).map(|(a, b)| a * b).sum()
}
pub(super) fn cross(a: Point, b: Point) -> Point {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
pub(super) fn interpolate(points: [Point; 3], w: Point) -> Point {
    // Anchor the interpolation so large coordinates do not get summed three times.
    std::array::from_fn(|i| {
        points[0][i] + w[1] * (points[1][i] - points[0][i]) + w[2] * (points[2][i] - points[0][i])
    })
}
pub(super) fn normal(points: [Point; 3]) -> Result<(Point, f64), String> {
    let a = sub(points[1], points[0]);
    let b = sub(points[2], points[0]);
    let n = cross(a, b);
    let length = dot(n, n).sqrt();
    if !length.is_finite() || length <= dot(a, a).max(dot(b, b)) * 1e-10 || length == 0. {
        return Err(
            "Transfer needs finite nondegenerate, numerically stable source/target triangles"
                .into(),
        );
    }
    Ok((n.map(|v| v / length), length * 0.5))
}
pub(super) fn validate_frame(frame: &TransferFrame) -> Result<(), String> {
    let r = Matrix3::from_fn(|i, j| frame.rotation[i][j]);
    if !frame
        .rotation
        .iter()
        .flatten()
        .chain(&frame.source_anchor)
        .chain(&frame.target_anchor)
        .all(|v| v.is_finite() && v.abs() <= 1e12)
        || (r.transpose() * r - Matrix3::identity()).norm() > 1e-10
        || (r.determinant() - 1.).abs() > 1e-10
    {
        return Err(
            "Transfer requires an explicit finite proper-rigid IFC-world to target frame".into(),
        );
    }
    Ok(())
}
pub(super) fn transform(frame: &TransferFrame, point: Point) -> Point {
    let r = Matrix3::from_fn(|i, j| frame.rotation[i][j]);
    (Vector3::from(frame.target_anchor)
        + r * (Vector3::from(point) - Vector3::from(frame.source_anchor)))
    .into()
}
/// Closest point with source-triangle barycentrics. Cross products avoid the
/// squared Gram determinant that loses skinny-triangle directions.
pub(super) fn closest(points: [Point; 3], point: Point) -> (Point, f64) {
    let [a, b, c] = points;
    let n = cross(sub(b, a), sub(c, a));
    let n2 = dot(n, n);
    let projected = std::array::from_fn(|i| point[i] - n[i] * dot(sub(point, a), n) / n2);
    let w = [
        dot(cross(sub(b, projected), sub(c, projected)), n) / n2,
        dot(cross(sub(c, projected), sub(a, projected)), n) / n2,
        dot(cross(sub(a, projected), sub(b, projected)), n) / n2,
    ];
    if w.iter().all(|v| *v >= 0.) {
        let delta = sub(interpolate(points, w), point);
        return (w, dot(delta, delta));
    }
    let mut best = ([1., 0., 0.], f64::INFINITY);
    for i in 0..3 {
        let j = (i + 1) % 3;
        let edge = sub(points[j], points[i]);
        let t = (dot(sub(point, points[i]), edge) / dot(edge, edge)).clamp(0., 1.);
        let mut weights = [0.; 3];
        weights[i] = 1. - t;
        weights[j] = t;
        let delta = sub(interpolate(points, weights), point);
        let distance = dot(delta, delta);
        if distance < best.1 {
            best = (weights, distance);
        }
    }
    best
}
