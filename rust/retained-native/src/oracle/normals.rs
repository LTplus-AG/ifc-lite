// SPDX-License-Identifier: MPL-2.0
//! M11-N source normals: planes, ruled arcs and swept disks. No smoothing code,
//! retained recipe or kernel normal enters the expected direction.
use super::{clipping::Edge, math::*, sections::ExtrudedHost};
use ifc_lite_geometry::analytic::AnalyticCurveSegment;
use ifc_lite_processing::{AnalyticQuantitySources, element::retained_runtime::ShapeOnlyProduct};
#[path = "normals_sources.rs"]
mod sources;
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

fn extrusion(host: &ExtrudedHost) -> Option<Vec<Surface>> {
    let frame = &host.frame;
    let origin = transform(frame,[0.;3]);
    let normal = unit(cross(vector(frame,[1.,0.,0.]),vector(frame,[0.,1.,0.])))?;
    let sweep_sign = dot(normal,host.direction).signum();
    let normal = scale(normal,sweep_sign);
    let mut result = vec![Surface::Plane {origin,normal:scale(normal,-1.)},
        Surface::Plane {origin:add(origin,scale(host.direction,host.depth)),normal}];
    for (outer,edges) in &host.loops {
        let area: f64 = edges.iter().map(Edge::integral).sum();
        if area == 0. || !area.is_finite() { return None; }
        let sign = sweep_sign * area.signum() * if *outer {1.} else {-1.};
        for edge in edges {
            result.push(match *edge {
                Edge::Line(a,b) => Surface::Plane {
                    origin:transform(frame,[a[0],a[1],0.]),
                    normal:scale(unit(cross(vector(frame,[b[0]-a[0],b[1]-a[1],0.]),host.direction))?,sign),
                },
                Edge::Arc {c,u,v,sweep,..} => Surface::ArcWall {center:transform(frame,[c[0],c[1],0.]),
                    u:vector(frame,[u[0],u[1],0.]), v:vector(frame,[v[0],v[1],0.]), d:host.direction,
                    sign:sign*sweep.signum()},
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
/// Surface selection uses only positions, source incidence and the facet,
/// never the output normal being tested. Empty source sets get flat equality.
pub fn check(product: &ShapeOnlyProduct, source: &[Surface]) -> Result<Check,String> {
    let mut result = Check::default();
    for part in &product.parts {
        let normals = part.normals.as_ref().ok_or("missing normals")?;
        if normals.len() != part.indices.len()*3 { return Err("normal cardinality".into()); }
        for (t,triangle) in part.indices.chunks_exact(3).enumerate() {
            let points: [[f64;3];3] = std::array::from_fn(|i| {
                let v = triangle[i] as usize * 3;
                transform(&part.world_from_object,[part.positions[v],part.positions[v+1],part.positions[v+2]])
            });
            let facet = unit(cross(sub(points[1],points[0]),sub(points[2],points[0]))).ok_or("degenerate triangle")?;
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
