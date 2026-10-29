// SPDX-License-Identifier: MPL-2.0
//! Place analytic source curves in a common, host-relative f64 plane.
use super::{clipping::Edge, math::*};
use ifc_lite_geometry::analytic::{AnalyticCurveSegment, AnalyticStatus, ProfileLoopKind};
use ifc_lite_processing::{AnalyticQuantitySources, ExtrusionInstance};

pub(super) struct Basis {
    origin: [f64; 3],
    x: [f64; 3],
    y: [f64; 3],
    z: [f64; 3],
}
impl Basis {
    pub fn new(frame: &[f64; 16]) -> Option<Self> {
        let x = unit(vector(frame, [1., 0., 0.]))?;
        let z = unit(cross(x, vector(frame, [0., 1., 0.])))?;
        Some(Self {
            origin: transform(frame, [0.; 3]),
            x,
            y: cross(z, x),
            z,
        })
    }
    pub(super) fn vector(&self, p: [f64; 3]) -> [f64; 3] {
        [dot(p, self.x), dot(p, self.y), dot(p, self.z)]
    }
    /// Convert a host-relative halfspace n·p <= c to world coordinates.
    pub(super) fn world_plane(&self, n: [f64; 3], c: f64) -> ([f64; 3], f64) {
        let world = std::array::from_fn(|i| n[0]*self.x[i]+n[1]*self.y[i]+n[2]*self.z[i]);
        (world, c+dot(world,self.origin))
    }
    pub(super) fn point(&self, p: [f64; 3]) -> [f64; 3] {
        self.vector(sub(p, self.origin))
    }
}
#[derive(Clone)]
pub(super) struct Prism {
    pub loops: Vec<(bool, Vec<Edge>)>,
    pub low: f64,
    pub high: f64,
    /// Height of the profile plane (`cap(start)`); `cap(end)` is the other bound.
    pub start: f64,
}
pub(super) fn profile_frame(
    sources: &AnalyticQuantitySources,
    i: &ExtrusionInstance,
) -> Option<[f64; 16]> {
    let s = &sources
        .extrusion_definitions
        .sources
        .iter()
        .find(|s| s.key == i.source)?
        .source;
    let p = s.profile.as_ref()?;
    Some(multiply(
        &multiply(
            &i.world_from_source?,
            s.position_matrix.as_ref().unwrap_or(&IDENTITY),
        ),
        p.profile_position.as_ref().unwrap_or(&IDENTITY),
    ))
}
pub(super) fn prisms(
    sources: &AnalyticQuantitySources,
    id: u32,
    basis: &Basis,
) -> Option<Vec<Prism>> {
    let instances = sources.extrusion_definitions.instances.get(&id)?;
    if instances.is_empty() {
        return None;
    }
    instances.iter().map(|i| prism(sources, i, basis)).collect()
}
fn prism(sources: &AnalyticQuantitySources, i: &ExtrusionInstance, basis: &Basis) -> Option<Prism> {
    if i.source_modified || i.status != AnalyticStatus::Complete {
        return None;
    }
    let source = &sources
        .extrusion_definitions
        .sources
        .iter()
        .find(|s| s.key == i.source)?
        .source;
    let profile = source.profile.as_ref()?;
    let frame = profile_frame(sources, i)?;
    let solid = multiply(
        &i.world_from_source?,
        source.position_matrix.as_ref().unwrap_or(&IDENTITY),
    );
    let d = basis.vector(vector(
        &solid,
        source
            .axis_unit_vector?
            .map(|a| a * source.depth.unwrap_or(0.)),
    ));
    if !d.iter().all(|x| x.is_finite())
        || d[2] == 0.
        || d[0].abs().max(d[1].abs()) > d[2].abs() * 1e-10
    {
        return None;
    }
    let z = basis.point(transform(&frame, [0.; 3]))[2];
    let mut loops = Vec::new();
    for boundary in &profile.loops {
        let mut edges = Vec::new();
        for segment in &boundary.segments {
            let edge = match *segment {
                AnalyticCurveSegment::Line { start, end } => {
                    let a = basis.point(transform(&frame, start));
                    let b = basis.point(transform(&frame, end));
                    if (a[2] - z).abs().max((b[2] - z).abs()) > 1e-8 {
                        return None;
                    }
                    Edge::Line([a[0], a[1]], [b[0], b[1]])
                }
                AnalyticCurveSegment::Arc {
                    center,
                    normal,
                    x_axis,
                    radius,
                    start_angle,
                    sweep_angle,
                } => {
                    if !start_angle.is_finite()
                        || !sweep_angle.is_finite()
                        || sweep_angle.abs() > std::f64::consts::TAU + 1e-12
                    {
                        return None;
                    }
                    let c = basis.point(transform(&frame, center));
                    let u = basis.vector(vector(&frame, x_axis.map(|v| v * radius)));
                    let v = basis.vector(vector(&frame, cross(normal, x_axis).map(|v| v * radius)));
                    if (c[2] - z).abs().max(u[2].abs()).max(v[2].abs()) > 1e-8 {
                        return None;
                    }
                    Edge::Arc {
                        c: [c[0], c[1]],
                        u: [u[0], u[1]],
                        v: [v[0], v[1]],
                        a: start_angle,
                        sweep: sweep_angle,
                    }
                }
            };
            edges.push(edge);
        }
        if edges.is_empty() || edges.len() > 4096 {
            return None;
        }
        loops.push((boundary.kind == ProfileLoopKind::Outer, edges));
    }
    Some(Prism {
        loops,
        low: z.min(z + d[2]),
        high: z.max(z + d[2]),
        start: z,
    })
}
