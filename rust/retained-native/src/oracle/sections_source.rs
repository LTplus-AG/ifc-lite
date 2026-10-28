// SPDX-License-Identifier: MPL-2.0
//! Independent analytic extrusion frame for the shared section oracle.
use super::{clipping::Edge, math::*, prism::profile_frame};
use ifc_lite_geometry::analytic::{AnalyticCurveSegment, AnalyticStatus, ProfileLoopKind};
use ifc_lite_processing::{AnalyticQuantitySources, ExtrusionInstance};

pub struct ExtrudedHost {
    pub(super) loops: Vec<(bool, Vec<Edge>)>,
    pub(super) frame: [f64; 16],
    pub(super) direction: [f64; 3],
    pub(super) depth: f64,
    pub(super) jacobian: f64,
}
impl ExtrudedHost {
    /// A single definition occurrence, read independently of retained cutters.
    /// The caller selects the original host definition for a modified product.
    pub fn from_sources(sources: &AnalyticQuantitySources, instance: &ExtrusionInstance) -> Option<Self> {
        if instance.status != AnalyticStatus::Complete { return None; }
        let source = &sources.extrusion_definitions.sources.iter().find(|s| s.key == instance.source)?.source;
        if source.status != AnalyticStatus::Complete { return None; }
        let profile = source.profile.as_ref()?;
        let frame = profile_frame(sources, instance)?;
        let solid = multiply(&instance.world_from_source?, source.position_matrix.as_ref().unwrap_or(&IDENTITY));
        let direction = vector(&solid, source.axis_unit_vector?);
        let jacobian = dot(cross(vector(&frame, [1., 0., 0.]), vector(&frame, [0., 1., 0.])), direction).abs();
        let depth = source.depth?;
        if frame.iter().chain(direction.iter()).any(|x| !x.is_finite()) || !depth.is_finite() || depth <= 0.
            || !jacobian.is_finite() || jacobian <= 0. { return None; }
        let mut loops = Vec::new();
        let mut count = 0;
        for boundary in &profile.loops {
            let mut edges = Vec::new();
            for segment in &boundary.segments {
                count += 1; if count > 4096 { return None; }
                edges.push(match *segment {
                    AnalyticCurveSegment::Line { start, end } => {
                        if start[2] != 0. || end[2] != 0. || start.iter().chain(end.iter()).any(|v| !v.is_finite()) { return None; }
                        Edge::Line([start[0], start[1]], [end[0], end[1]])
                    }
                    AnalyticCurveSegment::Arc { center, normal, x_axis, radius, start_angle, sweep_angle } => {
                        if center.iter().chain(normal.iter()).chain(x_axis.iter()).chain([&radius, &start_angle, &sweep_angle]).any(|v| !v.is_finite())
                            || center[2] != 0. || normal[0] != 0. || normal[1] != 0. || normal[2].abs() != 1.
                            || x_axis[2] != 0. || (dot(x_axis, x_axis) - 1.).abs() > 1e-12
                            || radius <= 0. || sweep_angle == 0. || sweep_angle.abs() > std::f64::consts::TAU + 1e-12 { return None; }
                        let y = cross(normal, x_axis);
                        Edge::Arc { c: [center[0], center[1]], u: [radius * x_axis[0], radius * x_axis[1]],
                            v: [radius * y[0], radius * y[1]], a: start_angle, sweep: sweep_angle }
                    }
                });
            }
            if edges.is_empty() { return None; }
            loops.push((boundary.kind == ProfileLoopKind::Outer, edges));
        }
        if loops.is_empty() || loops.len() > 128 || !loops[0].0 || loops[1..].iter().any(|x| x.0) { return None; }
        Some(Self { loops, frame, direction, depth, jacobian })
    }
}
