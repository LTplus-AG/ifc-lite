// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! World-coordinate transform for authored swept-disk curves.

use ifc_lite_geometry::AnalyticCurveSegment;
use nalgebra::{Matrix4, Vector3, Vector4};

pub(super) fn transform_disk(
    segments: &mut [AnalyticCurveSegment],
    radius: f64,
    inner_radius: Option<f64>,
    transform: &Matrix4<f64>,
    unit_scale: f64,
) -> Result<(f64, Option<f64>), String> {
    if transform.iter().any(|value| !value.is_finite()) {
        return Err("occurrence transform has non-finite coordinates".into());
    }
    let basis = [0, 1, 2].map(|i| Vector3::new(transform[(0, i)], transform[(1, i)], transform[(2, i)]));
    let scales = basis.map(|v| v.norm());
    let scale = scales[0];
    if !scale.is_finite() || scale <= 0.0 || !unit_scale.is_finite() || unit_scale <= 0.0
        || scales.iter().any(|s| !s.is_finite() || (s - scale).abs() > scale * 1e-8)
        || basis[0].dot(&basis[1]).abs() > scale * scale * 1e-8
        || basis[0].dot(&basis[2]).abs() > scale * scale * 1e-8
        || basis[1].dot(&basis[2]).abs() > scale * scale * 1e-8
    {
        return Err("nonuniform, degenerate, or invalid occurrence transform".into());
    }
    let orient = if basis[0].cross(&basis[1]).dot(&basis[2]) < 0.0 { -1.0 } else { 1.0 };
    let point = |p: [f64; 3]| {
        let q = transform * Vector4::new(p[0] * unit_scale, p[1] * unit_scale, p[2] * unit_scale, 1.0);
        [q.x, q.y, q.z]
    };
    let direction = |p: [f64; 3], handedness: f64| {
        let v = transform * Vector4::new(p[0], p[1], p[2], 0.0);
        [v.x * handedness / scale, v.y * handedness / scale, v.z * handedness / scale]
    };
    for segment in segments {
        match segment {
            AnalyticCurveSegment::Line { start, end } => {
                *start = point(*start);
                *end = point(*end);
            }
            AnalyticCurveSegment::Arc { center, normal, x_axis, radius, .. } => {
                *center = point(*center);
                *normal = direction(*normal, orient);
                *x_axis = direction(*x_axis, 1.0);
                *radius *= unit_scale * scale;
            }
        }
        let finite = match segment {
            AnalyticCurveSegment::Line { start, end } => start.iter().chain(end.iter()).all(|v| v.is_finite()),
            AnalyticCurveSegment::Arc { center, normal, x_axis, radius, start_angle, sweep_angle } =>
                center.iter().chain(normal.iter()).chain(x_axis.iter()).all(|v| v.is_finite())
                    && radius.is_finite() && start_angle.is_finite() && sweep_angle.is_finite(),
        };
        if !finite { return Err("transformed directrix has non-finite coordinates".into()); }
    }
    let world_radius = radius * unit_scale * scale;
    let world_inner = inner_radius.map(|r| r * unit_scale * scale);
    if !world_radius.is_finite() || world_inner.is_some_and(|r| !r.is_finite()) {
        return Err("transformed disk radius is non-finite".into());
    }
    Ok((world_radius, world_inner))
}
