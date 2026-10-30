// SPDX-License-Identifier: MPL-2.0
//! Authored boundary projection along Position.Z onto the cutting plane.
use crate::{analytic::AnalyticCurveSegment, document::PrismSegment};
use nalgebra::{Matrix4, Point3, Vector3};

pub(super) struct Projection {
    pub(super) frame: Matrix4<f64>, pub(super) scale: f64, pub(super) p: Vector3<f64>, pub(super) r: Vector3<f64>,
    pub(super) z: Vector3<f64>, pub(super) u: Vector3<f64>, pub(super) v: Vector3<f64>, pub(super) dot: f64,
}
impl Projection {
    fn point(&self, source: [f64; 3]) -> [f64; 2] {
        let q = self.frame.transform_point(&Point3::from(Vector3::from(source) * self.scale)).coords;
        let projected = q - self.z * (self.r.dot(&(q - self.p)) / self.dot);
        [self.u.dot(&(projected - self.p)), self.v.dot(&(projected - self.p))]
    }
    pub(super) fn segment(&self, segment: &AnalyticCurveSegment) -> PrismSegment {
        match *segment {
            AnalyticCurveSegment::Line { start, end } => PrismSegment::Line { start: self.point(start), end: self.point(end) },
            AnalyticCurveSegment::Arc { center, normal, x_axis, radius, start_angle, sweep_angle } => {
                let center2 = self.point(center);
                let radius = radius * self.scale;
                if sweep_angle.abs() >= std::f64::consts::TAU - crate::math::tol::RETAINED_ARC_INTERVAL_EPS_RAD {
                    return PrismSegment::Circle { center: center2, radius };
                }
                let x = Vector3::from(x_axis);
                let y = Vector3::from(normal).cross(&x);
                let radial = self.frame.transform_vector(&(x * start_angle.cos() + y * start_angle.sin()));
                let start_angle = self.v.dot(&radial).atan2(self.u.dot(&radial));
                let sense = self.r.dot(&self.frame.transform_vector(&Vector3::from(normal))).signum();
                PrismSegment::Arc { center: center2, radius, start_angle, sweep_angle: sweep_angle * sense }
            }
        }
    }
}
