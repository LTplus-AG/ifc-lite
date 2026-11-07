// SPDX-License-Identifier: MPL-2.0
//! M11-N source normals: planes, ruled arcs and swept disks. No smoothing code,
//! retained recipe or kernel normal enters the expected direction.
use super::math;
use super::math::*;
use ifc_lite_geometry::analytic::{AnalyticCurveSegment, AnalyticExtrusion, AnalyticStatus, ProfileLoopKind};
use ifc_lite_processing::{AnalyticQuantitySources, element::retained_runtime::ShapeOnlyProduct};
#[path = "normals_sources.rs"]
mod sources;
#[path = "normals_types.rs"]
mod types;
#[path = "normals_retrace.rs"]
mod retrace;
#[path = "normals_halfspaces.rs"]
mod halfspaces;
pub use sources::surfaces;

#[path = "normals_check.rs"]
mod check;
pub use check::{Surface, Check, angle, check_mesh};
fn norm(v: [f64; 3]) -> f64 { dot(v,v).sqrt() }
fn scale(v: [f64; 3], s: f64) -> [f64; 3] { v.map(|x| x*s) }
fn add(a: [f64; 3], b: [f64; 3]) -> [f64; 3] { std::array::from_fn(|i| a[i]+b[i]) }

fn extrusion(source: &AnalyticExtrusion, world: &[f64;16]) -> Option<Vec<Surface>> {
    if source.status != AnalyticStatus::Complete {return None;}
    let profile = source.profile.as_ref()?;
    if profile.status != AnalyticStatus::Complete {return None;}
    let solid = multiply(world,source.position_matrix.as_ref().unwrap_or(&IDENTITY));
    let frame = multiply(&solid,profile.profile_position.as_ref().unwrap_or(&IDENTITY));
    let direction = vector(&solid,source.axis_unit_vector?);
    let depth = source.depth?;
    let origin = transform(&frame,[0.;3]);
    let normal = unit(cross(vector(&frame,[1.,0.,0.]),vector(&frame,[0.,1.,0.])))?;
    let sweep_sign = dot(normal,direction).signum();
    if sweep_sign == 0. || !depth.is_finite() || depth <= 0. {return None;}
    let normal = scale(normal,sweep_sign);
    let mut result = vec![Surface::Plane {origin,normal:scale(normal,-1.)},
        Surface::Plane {origin:add(origin,scale(direction,depth)),normal}];
    for boundary in &profile.loops {
        let area = boundary.signed_area;
        if area == 0. || !area.is_finite() { return None; }
        let sign = sweep_sign * area.signum() * if boundary.kind == ProfileLoopKind::Outer {1.} else {-1.};
        for edge in &boundary.segments {
            result.push(match *edge {
                AnalyticCurveSegment::Line {start,end} => Surface::Plane {
                    origin:transform(&frame,start),
                    normal:scale(unit(cross(vector(&frame,sub(end,start)),direction))?,sign),
                },
                AnalyticCurveSegment::Arc {center,normal,x_axis,radius,sweep_angle,..} => Surface::ArcWall {
                    center:transform(&frame,center),u:vector(&frame,scale(x_axis,radius)),
                    v:vector(&frame,scale(cross(normal,x_axis),radius)),d:direction,sign:sign*sweep_angle.signum()},
            });
        }
    }
    Some(result)
}
fn disk(segments: &[AnalyticCurveSegment], radius: f64, inner: Option<f64>) -> Option<Vec<Surface>> {
    let mut result = Vec::new();
    for segment in segments {
        result.push(Surface::Disk { directrix:segment.clone(),radius,sign:1. });
        if let Some(radius) = inner { result.push(Surface::Disk {directrix:segment.clone(),radius,sign:-1.}); }
    }
    for (segment,end) in [(segments.first()?,false),(segments.last()?,true)] {
        let (origin,tangent) = match *segment {
            AnalyticCurveSegment::Line {start,end:b} => (if end {b} else {start},unit(sub(b,start))?),
            AnalyticCurveSegment::Arc {center,normal,x_axis,radius,start_angle,sweep_angle} => {
                let a = start_angle + if end {sweep_angle} else {0.};
                let y = cross(normal,x_axis);
                (add(center,scale(add(scale(x_axis,a.cos()),scale(y,a.sin())),radius)),
                    scale(add(scale(x_axis,-a.sin()),scale(y,a.cos())),sweep_angle.signum()))
            }
        };
        result.push(Surface::Plane {origin,normal:scale(tangent,if end {1.} else {-1.})});
    }
    Some(result)
}

pub fn check(product: &ShapeOnlyProduct, source: &[Surface]) -> Result<Check,String> {
    let mut result = Check::default();
    for part in &product.parts {
        let check = check_mesh(&part.positions,&part.indices,&part.world_from_object,
            part.normals.as_ref().ok_or("missing normals")?,source)?;
        result.corners += check.corners;
        result.planar += check.planar;
        result.curved += check.curved;
        result.smoothed_curved += check.smoothed_curved;
        result.flat += check.flat;
        result.unattributed += check.unattributed;
        result.planar_radians = result.planar_radians.max(check.planar_radians);
        result.curved_radians = result.curved_radians.max(check.curved_radians);
        result.unit_error = result.unit_error.max(check.unit_error);
        result.surface_indices.extend(check.surface_indices);
    }
    Ok(result)
}
