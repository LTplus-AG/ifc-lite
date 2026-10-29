// SPDX-License-Identifier: MPL-2.0
//! Derived cutters, not captured IFC recipes. CUT-0's frozen interface is
//! Line | Arc | Circle: the Round 2 orchestrator ruling (2026-10-27, #7955)
//! extends M5 §4.0.1 for M6's IfcArcIndex without changing wire format 1.
use super::retained_sweep::{f64_bytes, region, MAX_LOCAL_M, MAX_LOOPS, MAX_SEGMENTS};
use super::{EvaluationBounds, RegionQualification, RetainedRefusal, SweepPayload};
use crate::analytic::AnalyticCurveSegment;
use crate::math::tol;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrismRole { HalfSpace, BoundedHalfSpace, LayerRegion }
#[derive(Debug, Clone, PartialEq)]
pub struct PrismLoop { pub outer: bool, pub segments: Vec<PrismSegment> }
#[derive(Debug, Clone, PartialEq)]
pub enum PrismSegment {
    Line { start: [f64; 2], end: [f64; 2] },
    /// Wire kind 3: centre, +Z normal, +X basis, radius, start and signed sweep.
    Arc { center: [f64; 2], radius: f64, start_angle: f64, sweep_angle: f64 },
    Circle { center: [f64; 2], radius: f64 },
}
#[derive(Debug, Clone, PartialEq)]
pub struct RetainedPrism {
    pub source_id: u32,
    pub role: PrismRole,
    /// Column-major, proper rigid cutter evaluation -> host evaluation (metres).
    pub frame: [f64; 16],
    pub loops: Vec<PrismLoop>,
    pub direction: [f64; 3],
    pub depth: f64,
}
impl PrismSegment {
    fn curve(&self) -> Result<region::Curve, RetainedRefusal> {
        let xyz = |p: [f64; 2]| [p[0], p[1], 0.];
        let segment = match *self {
            Self::Line { start, end } => AnalyticCurveSegment::Line { start: xyz(start), end: xyz(end) },
            Self::Arc { center, radius, start_angle, sweep_angle } => {
                // An Arc is partial; a full turn must use Circle explicitly.
                if sweep_angle.abs() >= std::f64::consts::TAU - tol::RETAINED_ARC_INTERVAL_EPS_RAD {
                    return invalid("prism arc must be partial");
                }
                AnalyticCurveSegment::Arc { center: xyz(center), normal: [0., 0., 1.],
                    x_axis: [1., 0., 0.], radius, start_angle, sweep_angle }
            }
            Self::Circle { center, radius } => AnalyticCurveSegment::Arc { center: xyz(center),
                normal: [0., 0., 1.], x_axis: [1., 0., 0.], radius,
                start_angle: 0., sweep_angle: std::f64::consts::TAU },
        };
        region::curve(&segment, [0.; 3], 1.)
    }
}
impl RetainedPrism {
    pub fn lower(&self) -> Result<SweepPayload, RetainedRefusal> {
        super::retained_frames::rigid(self.frame).map_err(RetainedRefusal::InvalidSource)?;
        let d = nalgebra::Vector3::from(self.direction);
        let length = d.norm();
        if !length.is_finite() || length <= 0. || d.z <= 0. || !self.depth.is_finite()
            || self.depth <= 0. || self.depth > MAX_LOCAL_M
            || self.depth * d.z / length <= tol::RETAINED_MIN_LENGTH_M {
            return invalid("invalid prism sweep extent");
        }
        if self.loops.is_empty() || self.loops.len() > MAX_LOOPS { return invalid("invalid prism loop count"); }
        let mut curves = Vec::with_capacity(self.loops.len());
        let mut count = 0;
        let mut net_area = 0.;
        for (index, boundary) in self.loops.iter().enumerate() {
            if boundary.outer != (index == 0) || boundary.segments.is_empty()
                || boundary.segments.len() > MAX_SEGMENTS - count { return invalid("invalid prism boundary"); }
            count += boundary.segments.len();
            let mut items = boundary.segments.iter().map(PrismSegment::curve).collect::<Result<Vec<_>, _>>()?;
            let mut twice_area = 0.;
            for (i, item) in items.iter().enumerate() {
                let (_, end) = item.endpoints();
                let (next, _) = items[(i + 1) % items.len()].endpoints();
                if (end[0] - next[0]).hypot(end[1] - next[1]) > tol::RETAINED_BOUNDARY_JOIN_EPS_M
                    || (item.kind == 2 && items.len() != 1) { return invalid("disconnected prism boundary"); }
                twice_area += item.twice_area();
            }
            if !twice_area.is_finite() || twice_area.abs() <= tol::RETAINED_TWICE_AREA_EPS_M2 {
                return invalid("degenerate prism boundary");
            }
            if (twice_area > 0.) != boundary.outer { items = items.into_iter().rev().map(region::Curve::reversed).collect(); }
            net_area += if boundary.outer { twice_area.abs() } else { -twice_area.abs() };
            curves.push(items);
        }
        if !net_area.is_finite() || net_area <= tol::RETAINED_TWICE_AREA_EPS_M2 { return invalid("nonpositive prism region"); }
        let direction = self.direction.map(|v| v / length);
        let evaluation_bounds = EvaluationBounds::region(curves.iter().flatten().map(|c| (c.kind, c.values)), direction, self.depth);
        if evaluation_bounds.is_none() { return invalid("nonfinite prism bounds"); }
        let mut bytes = Vec::with_capacity(48 + curves.len() * 8 + count * 104);
        for value in [1u32, curves.len() as u32, count as u32, 0] { bytes.extend(value.to_le_bytes()); }
        for value in direction.into_iter().chain([self.depth]) { f64_bytes(&mut bytes, value)?; }
        for (index, boundary) in curves.iter().enumerate() {
            bytes.extend(u32::from(index != 0).to_le_bytes());
            bytes.extend((boundary.len() as u32).to_le_bytes());
            for curve in boundary {
                bytes.extend(curve.kind.to_le_bytes());
                bytes.extend(0u32.to_le_bytes());
                for value in curve.values { f64_bytes(&mut bytes, value)?; }
            }
        }
        let identity = crate::math::mat4::col_major_array(&nalgebra::Matrix4::identity());
        Ok(SweepPayload { format: 1, bytes, segments: count as u32, loops: curves.len() as u32,
            qualification: RegionQualification::OrderedRegion, source_from_evaluation: identity,
            evaluation_from_source: identity, evaluation_bounds })
    }
}
fn invalid<T>(reason: &'static str) -> Result<T, RetainedRefusal> { Err(RetainedRefusal::InvalidSource(reason)) }
