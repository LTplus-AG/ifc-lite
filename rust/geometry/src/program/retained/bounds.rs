// SPDX-License-Identifier: MPL-2.0
//! Conservative boxes in each value's runtime evaluation frame. Never inferred
//! from a tessellation: curves use full-circle boxes, rational disks their hull.
use super::LogicalRetainedValue;
use nalgebra::{Matrix4, Point3};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EvaluationBounds(pub [f64; 6]);
impl EvaluationBounds {
    pub(crate) fn points(points: impl IntoIterator<Item = [f64; 3]>) -> Option<Self> {
        let mut b = [f64::INFINITY, f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
        for p in points {
            if p.iter().any(|v| !v.is_finite()) { return None; }
            for i in 0..3 { b[i] = b[i].min(p[i]); b[i + 3] = b[i + 3].max(p[i]); }
        }
        Self(b).valid().then_some(Self(b))
    }
    pub fn valid(&self) -> bool { (0..3).all(|i| self.0[i].is_finite() && self.0[i + 3].is_finite() && self.0[i] <= self.0[i + 3]) }
    pub fn corners(self) -> [[f64; 3]; 8] {
        std::array::from_fn(|j| std::array::from_fn(|i| self.0[i + if j & (1 << i) == 0 { 0 } else { 3 }]))
    }
    pub(crate) fn transformed(self, frame: &Matrix4<f64>) -> Option<Self> {
        if !self.valid() { return None; }
        Self::points(self.corners().map(|p| frame.transform_point(&Point3::from(p)).into()))
    }
    pub(crate) fn expanded(self, radius: f64) -> Option<Self> {
        let b = Self(std::array::from_fn(|i| self.0[i] + if i < 3 { -radius } else { radius }));
        b.valid().then_some(b)
    }
    pub(crate) fn region(curves: impl IntoIterator<Item = (u32, [f64; 12])>, direction: [f64; 3], depth: f64) -> Option<Self> {
        let mut points = Vec::new();
        for (kind, v) in curves {
            if kind == 1 { points.extend([[v[0], v[1], v[2]], [v[3], v[4], v[5]]]); }
            else {
                // Full circle is conservative even for a trimmed arc.
                let extent: [f64; 3] = std::array::from_fn(|i| v[9] * (1. - v[i + 3] * v[i + 3]).max(0.).sqrt());
                points.extend([std::array::from_fn(|i| v[i] - extent[i]), std::array::from_fn(|i| v[i] + extent[i])]);
            }
        }
        let base = Self::points(points)?;
        Self::points(base.corners().into_iter().flat_map(|p| [p, std::array::from_fn(|i| p[i] + direction[i] * depth)]))
    }
}
pub(super) fn boolean_bounds(inputs: &[LogicalRetainedValue; 2], operation: crate::BoolOp) -> Option<EvaluationBounds> {
    match operation {
        crate::BoolOp::Difference => inputs[0].bounds,
        crate::BoolOp::Intersection => inputs[0].bounds,
        crate::BoolOp::Union => {
            let (left, right) = (inputs[0].bounds?, inputs[1].bounds?);
            let relative = crate::document::retained_frames::relative(inputs[0].object_frame, inputs[1].object_frame).ok()?;
            let mapped = right.transformed(&Matrix4::from_column_slice(&relative))?;
            EvaluationBounds::points(left.corners().into_iter().chain(mapped.corners()))
        }
        _ => None,
    }
}
