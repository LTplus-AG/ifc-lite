// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #6443: compare exact authored extrusion boundaries with canonical meshes.

use std::collections::HashSet;

use ifc_lite_geometry::analytic::{AnalyticCurveSegment, AnalyticExtrusion, AnalyticStatus};
use ifc_lite_processing::{
    extract_extrusion_definitions, ExportedElement, ExtrusionDefinition, ExtrusionInstance,
};
use nalgebra::{Matrix4, Vector4};

use super::checker::{
    add, bounds, check_closed_oriented_edges, mesh_for_product, nearest_mesh_distance, scale,
};

type Point = [f64; 3];

fn transform(matrix: &Matrix4<f64>, point: Point) -> Point {
    let result = matrix * Vector4::new(point[0], point[1], point[2], 1.0);
    [result.x, result.y, result.z]
}

fn transform_vector(matrix: &Matrix4<f64>, vector: Point) -> Point {
    let result = matrix * Vector4::new(vector[0], vector[1], vector[2], 0.0);
    [result.x, result.y, result.z]
}

fn samples(segment: &AnalyticCurveSegment) -> Vec<Point> {
    match *segment {
        AnalyticCurveSegment::Line { start, end } => (0..=8)
            .map(|step| {
                add(
                    scale(start, 1.0 - step as f64 / 8.0),
                    scale(end, step as f64 / 8.0),
                )
            })
            .collect(),
        AnalyticCurveSegment::Arc {
            center,
            normal,
            x_axis,
            radius,
            start_angle,
            sweep_angle,
        } => {
            let y_axis = [
                normal[1] * x_axis[2] - normal[2] * x_axis[1],
                normal[2] * x_axis[0] - normal[0] * x_axis[2],
                normal[0] * x_axis[1] - normal[1] * x_axis[0],
            ];
            // At least 64 stations per circle: the sampled bound misses the
            // exact circular extremum by at most 0.12% of its radius.
            let steps = (sweep_angle.abs() * 64.0 / std::f64::consts::TAU)
                .ceil()
                .max(8.0) as usize;
            (0..=steps)
                .map(|step| {
                    let angle = start_angle + sweep_angle * step as f64 / steps as f64;
                    add(
                        center,
                        add(
                            scale(x_axis, radius * angle.cos()),
                            scale(y_axis, radius * angle.sin()),
                        ),
                    )
                })
                .collect()
        }
    }
}

pub(super) fn eligibility<'a>(
    definitions: &'a [ExtrusionDefinition],
    instances: &'a [ExtrusionInstance],
) -> Result<(&'a AnalyticExtrusion, &'a ExtrusionInstance), &'static str> {
    if instances.len() != 1 {
        return Err("multiple source solids cannot be compared to one merged mesh");
    }
    let instance = &instances[0];
    if instance.source_modified {
        return Err("CSG operand is not the final visible mesh");
    }
    let definition = definitions
        .iter()
        .find(|source| source.key == instance.source)
        .ok_or("source definition is missing")?;
    if !matches!(instance.status, AnalyticStatus::Complete)
        || !matches!(definition.source.status, AnalyticStatus::Complete)
        || definition.source.profile.as_ref().is_none_or(|profile| {
            !matches!(profile.status, AnalyticStatus::Complete) || profile.loops.is_empty()
        })
        || instance.world_from_source.is_none()
    {
        return Err("unsupported or tapered extrusion/profile/occurrence");
    }
    Ok((&definition.source, instance))
}

pub(super) fn compare_surface(
    product_id: u32,
    source: &AnalyticExtrusion,
    instance: &ExtrusionInstance,
    mesh: &ExportedElement,
) -> Result<(), String> {
    let profile = source.profile.as_ref().ok_or("missing profile")?;
    let identity = format!(
        "product #{product_id}, solid #{}, profile #{}",
        source.solid_id, profile.profile_id
    );
    if mesh.faces.is_empty() || mesh.vertices.is_empty() {
        return Err(format!("{identity}: mesh has no triangles"));
    }
    check_closed_oriented_edges(&identity, mesh)?;
    let occurrence = Matrix4::from_column_slice(
        &instance
            .world_from_source
            .ok_or("missing occurrence transform")?,
    );
    let solid = source
        .position_matrix
        .map_or_else(Matrix4::identity, |matrix| {
            Matrix4::from_column_slice(&matrix)
        });
    let profile_frame = profile
        .profile_position
        .map_or_else(Matrix4::identity, |matrix| {
            Matrix4::from_column_slice(&matrix)
        });
    let sweep_frame = occurrence * solid;
    let world_from_profile = sweep_frame * profile_frame;
    let direction = source.axis_unit_vector.ok_or("missing ExtrudedDirection")?;
    let depth = source.depth.ok_or("missing Depth")?;
    // ExtrudedDirection is solid-local. Profile Position places only the
    // cross-section, and must not rotate the sweep vector.
    let offset = transform_vector(&sweep_frame, scale(direction, depth));
    let mut boundary = Vec::new();
    let mut profile_boundary = Vec::new();
    for boundary_loop in &profile.loops {
        for segment in &boundary_loop.segments {
            for point in samples(segment) {
                let base = transform(&world_from_profile, point);
                profile_boundary.push(base);
                for fraction in [0.0, 0.5, 1.0] {
                    boundary.push(add(base, scale(offset, fraction)));
                }
            }
        }
    }
    let (expected_low, expected_high) = bounds(boundary.iter().copied());
    let (actual_low, actual_high) = bounds(mesh.vertices.iter().copied());
    let (profile_low, profile_high) = bounds(profile_boundary.into_iter());
    let profile_extent = (0..3)
        .map(|axis| profile_high[axis] - profile_low[axis])
        .fold(0.0_f64, f64::max);
    // High-quality circular tessellation has sub-percent sagitta at these
    // stations. Permit 1% of the placed profile width (never the depth, which
    // could hide a thin-profile error) plus 0.1 mm for local f32 vertices,
    // export welding and RTC reconstruction. The 5 km test origin is exactly
    // representable in f32; the 1% term also covers its sub-mm vertex ULP.
    let tolerance = 0.01 * profile_extent + 0.000_1;
    for (index, point) in boundary.into_iter().enumerate() {
        let residual = nearest_mesh_distance(point, mesh);
        if !residual.is_finite() || residual > tolerance {
            return Err(format!("{identity}: surface sample {index} residual {residual:.9} m exceeds tolerance {tolerance:.9} m"));
        }
    }
    for axis in 0..3 {
        for (name, expected, actual) in [
            ("minimum", expected_low[axis], actual_low[axis]),
            ("maximum", expected_high[axis], actual_high[axis]),
        ] {
            let residual = (actual - expected).abs();
            if !residual.is_finite() || residual > tolerance {
                return Err(format!("{identity}: axis {axis} {name} bound residual {residual:.9} m exceeds tolerance {tolerance:.9} m (source {expected:.9}, mesh {actual:.9})"));
            }
        }
    }
    Ok(())
}

pub(super) fn compare_model(
    source: &[u8],
    product_id: u32,
) -> Result<(AnalyticExtrusion, ExtrusionInstance, ExportedElement), String> {
    let ids = HashSet::from([product_id]);
    let descriptions = extract_extrusion_definitions(source, Some(&ids));
    if !descriptions.diagnostics.is_empty() {
        return Err(format!(
            "product #{product_id}: analytic diagnostics: {:?}",
            descriptions.diagnostics
        ));
    }
    let instances = descriptions
        .instances
        .get(&product_id)
        .ok_or_else(|| format!("product #{product_id}: no analytic extrusion"))?;
    let (extrusion, instance) = eligibility(&descriptions.sources, instances)
        .map_err(|reason| format!("product #{product_id}: skipped: {reason}"))?;
    let mesh = mesh_for_product(source, product_id)?;
    compare_surface(product_id, extrusion, instance, &mesh)?;
    Ok((extrusion.clone(), instance.clone(), mesh))
}
