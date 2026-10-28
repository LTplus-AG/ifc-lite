// SPDX-License-Identifier: MPL-2.0
//! M11-N source normals: planes, ruled arcs and swept disks. No smoothing code,
//! retained recipe or kernel normal enters the expected direction.
use super::math::*;
use ifc_lite_geometry::analytic::{AnalyticCurveSegment, AnalyticExtrusion, AnalyticStatus, ProfileLoopKind};
use ifc_lite_processing::{AnalyticQuantitySources, element::retained_runtime::ShapeOnlyProduct};
#[path = "normals_sources.rs"]
mod sources;
#[path = "normals_types.rs"]
mod types;
#[path = "normals_retrace.rs"]
mod retrace;
pub use sources::surfaces;

#[derive(Clone, Debug)]
pub enum Surface {
    Plane { origin: [f64; 3], normal: [f64; 3] },
    /// Unit circle in the u/v basis, swept along d; supports oblique prisms.
    ArcWall { center: [f64; 3], u: [f64; 3], v: [f64; 3], d: [f64; 3], sign: f64 },
    Disk { directrix: AnalyticCurveSegment, radius: f64, sign: f64 },
}
impl Surface {
    /// Signed source direction and distance to its analytic supporting surface.
    pub fn sample(&self, p: [f64; 3]) -> Option<([f64; 3], f64)> {
        match self {
            Self::Plane { origin, normal } => Some((*normal, dot(sub(p,*origin),*normal).abs())),
            Self::ArcWall { center,u,v,d,sign } => {
                let q = sub(p,*center);
                let det = dot(*u,cross(*v,*d));
                let x = dot(q,cross(*v,*d))/det;
                let y = dot(q,cross(*d,*u))/det;
                let radius = x.hypot(y);
                let radial = add(scale(*u,x),scale(*v,y));
                let normal = unit(cross(add(scale(*u,-y),scale(*v,x)),*d))?;
                Some((scale(normal,*sign), (radius-1.).abs()*norm(radial)/radius))
            }
            Self::Disk { directrix,radius,sign } => {
                let center = match *directrix {
                    AnalyticCurveSegment::Line { start,end } => {
                        let d = unit(sub(end,start))?;
                        add(start,scale(d,dot(sub(p,start),d)))
                    }
                    AnalyticCurveSegment::Arc { center,normal,radius,.. } => {
                        let q = sub(p,center);
                        let radial = unit(sub(q,scale(normal,dot(q,normal))))?;
                        add(center,scale(radial,radius))
                    }
                };
                let radial = sub(p,center);
                Some((scale(unit(radial)?,*sign), (norm(radial)-radius).abs()))
            }
        }
    }
    pub fn curved(&self) -> bool { !matches!(self, Self::Plane { .. }) }
    fn reversed(mut self, sign: f64) -> Self {
        match &mut self {
            Self::Plane { normal,.. } => *normal = scale(*normal,sign),
            Self::ArcWall { sign:s,.. } | Self::Disk { sign:s,.. } => *s *= sign,
        }
        self
    }
}
fn norm(v: [f64; 3]) -> f64 { dot(v,v).sqrt() }
fn scale(v: [f64; 3], s: f64) -> [f64; 3] { v.map(|x| x*s) }
fn add(a: [f64; 3], b: [f64; 3]) -> [f64; 3] { std::array::from_fn(|i| a[i]+b[i]) }
pub fn angle(a: [f64; 3], b: [f64; 3]) -> f64 { norm(cross(a,b)).atan2(dot(a,b)) }

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

#[derive(Debug, Default)]
pub struct Check {
    pub corners: usize,
    pub planar: usize,
    pub curved: usize,
    pub smoothed_curved: usize,
    pub flat: usize,
    pub unattributed: usize,
    pub planar_radians: f64,
    pub curved_radians: f64,
    pub unit_error: f64,
}
fn facet(local: [[f64;3];3], frame: &[f64;16]) -> Option<[f64;3]> {
    // Translation cancels analytically. Subtracting absolute world points
    // loses small edges on georeferenced models and corrupts oracle incidence.
    unit(cross(vector(frame,sub(local[1],local[0])), vector(frame,sub(local[2],local[0]))))
}
/// Surface selection uses only positions, source incidence and the facet,
/// never the output normal being tested. Empty source sets get flat equality.
pub fn check(product: &ShapeOnlyProduct, source: &[Surface]) -> Result<Check,String> {
    let mut result = Check::default();
    for part in &product.parts {
        let normals = part.normals.as_ref().ok_or("missing normals")?;
        if normals.len() != part.indices.len()*3 { return Err("normal cardinality".into()); }
        for (t,triangle) in part.indices.chunks_exact(3).enumerate() {
            let local: [[f64;3];3] = std::array::from_fn(|i| {
                let v = triangle[i] as usize * 3;
                [part.positions[v],part.positions[v+1],part.positions[v+2]]
            });
            let points = local.map(|p| transform(&part.world_from_object,p));
            let facet = facet(local,&part.world_from_object).ok_or("degenerate triangle")?;
            let centroid = add(points[0],scale(add(sub(points[1],points[0]),sub(points[2],points[0])),1./3.));
            let surface = source.iter().find(|s| {
                let incidence = if s.curved() {0.001001} else {1e-6};
                points.iter().chain([&centroid]).all(|&p| s.sample(p).is_some_and(|(_,d)| d.is_finite() && d <= incidence))
                    && s.sample(centroid).is_some_and(|(n,_)| angle(n,facet) <= if s.curved() {0.0873} else {1e-9})
            });
            if surface.is_none() && !source.is_empty() { result.unattributed += 3; }
            for (c,&point) in points.iter().enumerate() {
                let offset = (t*3+c)*3;
                let normal = [normals[offset],normals[offset+1],normals[offset+2]];
                if normal.iter().any(|v| !v.is_finite()) { return Err("nonfinite normal".into()); }
                result.unit_error = result.unit_error.max((norm(normal)-1.).abs());
                result.corners += 1;
                let expected = surface.and_then(|s| s.sample(point)).map_or(facet,|(n,_)| n);
                let error = angle(expected,normal);
                if surface.is_some_and(Surface::curved) {
                    result.smoothed_curved += usize::from(angle(facet,normal) > 1e-9);
                    result.curved += 1; result.curved_radians = result.curved_radians.max(error);
                } else {
                    if source.is_empty() {result.flat += 1;} else {result.planar += 1;}
                    result.planar_radians = result.planar_radians.max(error);
                }
            }
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn m11_n_7955_source_facet_direction_is_translation_invariant() {
        let triangle = [[0.,0.,0.],[0.02,0.,2.41],[0.,0.,2.41]];
        let mut frame = [0.8,0.6,0.,0., -0.6,0.8,0.,0., 0.,0.,1.,0., 0.,0.,0.,1.];
        for translation in [0.,5_000_000.,1e20] {
            frame[12] = translation; frame[13] = -translation; frame[14] = translation;
            assert!(angle(facet(triangle,&frame).unwrap(),[0.6,-0.8,0.]) < 1e-15);
        }
    }
}
