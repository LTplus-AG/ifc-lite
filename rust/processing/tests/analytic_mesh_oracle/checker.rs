// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #5781: compare authored swept-disk surfaces with independently produced meshes.
//! The source description and element mesh use their public processing paths.

use std::collections::HashSet;

use ifc_lite_geometry::{
    analytic::{AnalyticCurveSegment, AnalyticStatus},
    TessellationQuality,
};
use ifc_lite_processing::{
    build_geometry_data_export, extract_swept_disk_descriptions,
    process_geometry_filtered_with_quality_and_ids, ExportedElement, MeshCoordinateSpace,
    OpeningFilterMode, SweptDiskOccurrence,
};

type Point = [f64; 3];

fn add(a: Point, b: Point) -> Point {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
fn sub(a: Point, b: Point) -> Point {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn scale(a: Point, k: f64) -> Point {
    [a[0] * k, a[1] * k, a[2] * k]
}
fn dot(a: Point, b: Point) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn cross(a: Point, b: Point) -> Point {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
fn norm(a: Point) -> f64 {
    dot(a, a).sqrt()
}
fn unit(a: Point) -> Point {
    scale(a, 1.0 / norm(a))
}

fn curve_frame(segment: &AnalyticCurveSegment, t: f64) -> (Point, Point) {
    match *segment {
        AnalyticCurveSegment::Line { start, end } => {
            (add(start, scale(sub(end, start), t)), unit(sub(end, start)))
        }
        AnalyticCurveSegment::Arc {
            center,
            normal,
            x_axis,
            radius,
            start_angle,
            sweep_angle,
        } => {
            let y_axis = cross(normal, x_axis);
            let angle = start_angle + sweep_angle * t;
            let radial = add(scale(x_axis, angle.cos()), scale(y_axis, angle.sin()));
            let travel = add(scale(x_axis, -angle.sin()), scale(y_axis, angle.cos()));
            (
                add(center, scale(radial, radius)),
                scale(unit(travel), sweep_angle.signum()),
            )
        }
    }
}

fn ring(center: Point, tangent: Point, radius: f64, angle: f64) -> Point {
    let reference = if tangent[2].abs() < 0.9 {
        [0.0, 0.0, 1.0]
    } else {
        [1.0, 0.0, 0.0]
    };
    let u = unit(cross(tangent, reference));
    let v = cross(tangent, u);
    add(
        center,
        scale(add(scale(u, angle.cos()), scale(v, angle.sin())), radius),
    )
}

/// Squared point/triangle distance (Ericson's closest-point regions). The
/// mesh path may split or weld vertices; only its actual triangles matter.
fn triangle_distance_squared(p: Point, a: Point, b: Point, c: Point) -> f64 {
    let ab = sub(b, a);
    let ac = sub(c, a);
    let ap = sub(p, a);
    let d1 = dot(ab, ap);
    let d2 = dot(ac, ap);
    if d1 <= 0.0 && d2 <= 0.0 {
        return dot(ap, ap);
    }
    let bp = sub(p, b);
    let d3 = dot(ab, bp);
    let d4 = dot(ac, bp);
    if d3 >= 0.0 && d4 <= d3 {
        return dot(bp, bp);
    }
    let vc = d1 * d4 - d3 * d2;
    if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
        let q = add(a, scale(ab, d1 / (d1 - d3)));
        return dot(sub(p, q), sub(p, q));
    }
    let cp = sub(p, c);
    let d5 = dot(ab, cp);
    let d6 = dot(ac, cp);
    if d6 >= 0.0 && d5 <= d6 {
        return dot(cp, cp);
    }
    let vb = d5 * d2 - d1 * d6;
    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
        let q = add(a, scale(ac, d2 / (d2 - d6)));
        return dot(sub(p, q), sub(p, q));
    }
    let va = d3 * d6 - d5 * d4;
    if va <= 0.0 && d4 - d3 >= 0.0 && d5 - d6 >= 0.0 {
        let bc = sub(c, b);
        let q = add(b, scale(bc, (d4 - d3) / ((d4 - d3) + (d5 - d6))));
        return dot(sub(p, q), sub(p, q));
    }
    let denominator = 1.0 / (va + vb + vc);
    let q = add(
        a,
        add(scale(ab, vb * denominator), scale(ac, vc * denominator)),
    );
    dot(sub(p, q), sub(p, q))
}

fn nearest_mesh_distance(point: Point, mesh: &ExportedElement) -> f64 {
    mesh.faces
        .iter()
        .map(|face| {
            triangle_distance_squared(
                point,
                mesh.vertices[face[0] as usize],
                mesh.vertices[face[1] as usize],
                mesh.vertices[face[2] as usize],
            )
        })
        .fold(f64::INFINITY, f64::min)
        .sqrt()
}

fn bounds(points: impl Iterator<Item = Point>) -> (Point, Point) {
    let mut low = [f64::INFINITY; 3];
    let mut high = [f64::NEG_INFINITY; 3];
    for point in points {
        for axis in 0..3 {
            low[axis] = low[axis].min(point[axis]);
            high[axis] = high[axis].max(point[axis]);
        }
    }
    (low, high)
}

fn surface_samples(disk: &SweptDiskOccurrence, include_endpoints: bool) -> Vec<Point> {
    let mut samples = Vec::new();
    for segment in &disk.directrix {
        let fractions: &[f64] = if include_endpoints {
            &[0.0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1.0]
        } else {
            // End rings can be mitred at segment joins or capped at the ends.
            &[0.25, 0.5, 0.75]
        };
        for &t in fractions {
            let (center, tangent) = curve_frame(segment, t);
            for radius in [Some(disk.radius), disk.inner_radius].into_iter().flatten() {
                for step in 0..16 {
                    samples.push(ring(
                        center,
                        tangent,
                        radius,
                        step as f64 * std::f64::consts::TAU / 16.0,
                    ));
                }
            }
        }
    }
    samples
}

/// The surface residual covers even an eight-sided disk's chord sagitta
/// (1 - cos(pi/8) = 7.61% of radius), 1 µm export welding, and f32 local
/// coordinates. The bound limit covers a 90-degree miter's 0.414-radius
/// extension at segment joins. Both limits
/// are in world metres and are independent of a large absolute RTC origin.
pub(super) fn compare_surface(
    product_id: u32,
    disk: &SweptDiskOccurrence,
    mesh: &ExportedElement,
) -> Result<(), String> {
    let identity = format!(
        "product #{product_id}, solid #{}, directrix #{}",
        disk.solid_id, disk.directrix_id
    );
    if mesh.faces.is_empty() || mesh.vertices.is_empty() {
        return Err(format!("{identity}: mesh has no triangles"));
    }
    let surface_tolerance = 0.08 * disk.radius + 0.000_05;
    for (sample_index, point) in surface_samples(disk, false).into_iter().enumerate() {
        let residual = nearest_mesh_distance(point, mesh);
        if !residual.is_finite() || residual > surface_tolerance {
            return Err(format!("{identity}: surface sample {sample_index} residual {residual:.9} m exceeds tolerance {surface_tolerance:.9} m"));
        }
    }
    let (expected_low, expected_high) = bounds(surface_samples(disk, true).into_iter());
    let (actual_low, actual_high) = bounds(mesh.vertices.iter().copied());
    let bound_tolerance = 0.5 * disk.radius + 0.000_05;
    for axis in 0..3 {
        for (name, expected, actual) in [
            ("minimum", expected_low[axis], actual_low[axis]),
            ("maximum", expected_high[axis], actual_high[axis]),
        ] {
            let residual = (actual - expected).abs();
            if !residual.is_finite() || residual > bound_tolerance {
                return Err(format!("{identity}: axis {axis} {name} bound expected {expected:.9} m, mesh {actual:.9} m, residual {residual:.9} m exceeds tolerance {bound_tolerance:.9} m"));
            }
        }
    }
    Ok(())
}

pub(super) fn eligibility(
    disks: &[SweptDiskOccurrence],
) -> Result<&SweptDiskOccurrence, &'static str> {
    if disks.len() != 1 {
        return Err("multiple source solids cannot be compared to one merged mesh");
    }
    let disk = &disks[0];
    if disk.source_modified {
        return Err("CSG operand is not the final visible mesh");
    }
    if !matches!(disk.status, AnalyticStatus::Complete) {
        return Err("unsupported analytic directrix");
    }
    if disk.directrix.is_empty() || disk.directrix_metrics().is_none() {
        return Err("incomplete directrix metrics");
    }
    Ok(disk)
}

pub(super) fn compare_model(
    source: &[u8],
    expected_id: u32,
) -> Result<(SweptDiskOccurrence, ExportedElement), String> {
    let ids = HashSet::from([expected_id]);
    let descriptions = extract_swept_disk_descriptions(source, Some(&ids));
    if !descriptions.diagnostics.is_empty() {
        return Err(format!(
            "product #{expected_id}: analytic diagnostics: {:?}",
            descriptions.diagnostics
        ));
    }
    let disks = descriptions
        .elements
        .get(&expected_id)
        .ok_or_else(|| format!("product #{expected_id}: no analytic swept disk"))?;
    let disk = eligibility(disks)
        .map_err(|reason| format!("product #{expected_id}: skipped: {reason}"))?;
    let result = process_geometry_filtered_with_quality_and_ids(
        &source,
        OpeningFilterMode::Default,
        TessellationQuality::High,
        Some(&ids),
    );
    let site_rotation = if result.mesh_coordinate_space == MeshCoordinateSpace::SiteLocal {
        result.site_transform.as_deref()
    } else {
        None
    };
    let exported = build_geometry_data_export(
        &result.meshes,
        result.metadata.coordinate_info.origin_shift,
        site_rotation,
    );
    let mesh = exported
        .elements
        .get(&expected_id)
        .ok_or_else(|| format!("product #{expected_id}: mesh path produced no occurrence"))?;
    compare_surface(expected_id, disk, mesh)?;
    Ok((disk.clone(), mesh.clone()))
}
