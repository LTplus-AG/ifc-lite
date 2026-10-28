// SPDX-License-Identifier: MPL-2.0
//! Independent finite regions, all expressed relative to the same opened host.
use super::{cutter, layer_family::*, LogicalRetainedValue};
use crate::document::{PrismLoop, PrismRole, PrismSegment, RetainedPrism};
use nalgebra::{Matrix4, Point3, Vector3};

pub(super) fn regions(host: &LogicalRetainedValue, spec: &LayerSpec) -> crate::Result<Vec<RetainedPrism>> {
    let bounds = host.bounds.ok_or_else(|| crate::Error::geometry("layer host bounds"))?;
    let g = crate::document::retained_frames::relative(*host.object_frame(), spec.world_from_object)
        .map_err(crate::Error::geometry)?;
    let inverse = crate::document::retained_frames::relative(spec.world_from_object, *host.object_frame())
        .map_err(crate::Error::geometry)?;
    let inverse = Matrix4::from_column_slice(&inverse);
    let corners = bounds.corners().map(|p| inverse.transform_point(&Point3::from(p)));
    let margin = cutter::MARGIN_MIN_M.max(cutter::MARGIN_DIAGONAL * Vector3::new(
        bounds.0[3] - bounds.0[0], bounds.0[4] - bounds.0[1], bounds.0[5] - bounds.0[2]).norm());
    let interfaces = spec.cumulative();
    let mut output = Vec::new();
    crate::resource::reserve_headers(&mut output, spec.layers.len())?.retain();
    match spec.family {
        LayerFamily::Planar { axis } => {
            let a = Vector3::from(axis);
            let n = a * spec.sense;
            let lo = corners.iter().map(|p| n.dot(&p.coords)).fold(f64::INFINITY, f64::min) - margin;
            let hi = corners.iter().map(|p| n.dot(&p.coords)).fold(f64::NEG_INFINITY, f64::max) + margin;
            let g = Matrix4::from_column_slice(&g);
            let normal = g.transform_vector(&n);
            let origin = g.transform_point(&Point3::from(n * lo));
            let base = cutter::halfspace_prism(host, spec.source_id, origin.into(), normal.into())
                .map_err(|e| match e { cutter::CutterError::Control(e) => e,
                    cutter::CutterError::Recipe(e) => crate::Error::geometry(e.to_string()) })?
                .ok_or_else(|| crate::Error::geometry("layer bounding prism"))?;
            for k in 0..spec.layers.len() {
                let lower = if k == 0 { lo.min(spec.sense * spec.offset_m + interfaces[0] - margin) }
                    else { spec.sense * spec.offset_m + interfaces[k - 1] };
                let upper = if k == interfaces.len() { hi.max(lower + margin) }
                    else { spec.sense * spec.offset_m + interfaces[k] };
                let mut prism = base.clone();
                prism.role = PrismRole::LayerRegion;
                for j in 0..3 { prism.frame[12 + j] += normal[j] * (lower - lo); }
                prism.depth = upper - lower;
                output.push(prism);
            }
        }
        LayerFamily::Cylindrical { center, sigma, .. } => {
            let min_z = corners.iter().map(|p| p.z).fold(f64::INFINITY, f64::min) - margin;
            let max_z = corners.iter().map(|p| p.z).fold(f64::NEG_INFINITY, f64::max) + margin;
            let max_r = corners.iter().map(|p| (p.x - center[0]).hypot(p.y - center[1]))
                .fold(0., f64::max) + margin;
            let mut local = Matrix4::identity();
            local[(0, 3)] = center[0]; local[(1, 3)] = center[1]; local[(2, 3)] = min_z;
            let frame = crate::document::retained_frames::multiply(g, crate::math::mat4::col_major_array(&local));
            for k in 0..spec.layers.len() {
                // q=sigma*(R-rho). w=sense*(q-offset), dw/drho=-sigma*sense.
                // Outside-first stacks therefore swap the unbounded end regions.
                let previous = if k == 0 { None } else { spec.radius_at(interfaces[k - 1]) };
                let next = interfaces.get(k).and_then(|&c| spec.radius_at(c));
                let (inner, outer) = if sigma * spec.sense > 0. {
                    (next.unwrap_or(0.), previous.unwrap_or(max_r.max(next.unwrap_or(0.) + margin)))
                } else {
                    (previous.unwrap_or(0.), next.unwrap_or(max_r.max(previous.unwrap_or(0.) + margin)))
                };
                let circle = |outer, radius| PrismLoop { outer, segments: vec![PrismSegment::Circle { center: [0.; 2], radius }] };
                let mut loops = vec![circle(true, outer)];
                if inner > 0. { loops.push(circle(false, inner)); }
                output.push(RetainedPrism { source_id: spec.source_id, role: PrismRole::LayerRegion,
                    frame, loops, direction: [0., 0., 1.], depth: max_z - min_z });
            }
        }
    }
    Ok(output)
}
