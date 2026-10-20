// SPDX-License-Identifier: MPL-2.0
//! Decoded f64 loops and analytic patch parameters, before triangle emission.
use super::super::helpers::push_rebased;
use crate::triangulation::triangulate_planar_face;
use crate::{Error, Point3, Result};
use nalgebra::{Matrix4, Vector3};
#[derive(Debug, Clone)]
pub(super) struct PlanarPlan {
    pub(super) outer: Vec<Point3<f64>>,
    pub(super) hole_points: Vec<Vec<Point3<f64>>>,
    pub(super) rtc: (f64, f64, f64),
}
impl PlanarPlan {
    pub(super) fn evaluate(self) -> Result<(Vec<f32>, Vec<u32>)> {
        let Self {
            outer,
            hole_points,
            rtc,
        } = self;
        let mut positions = Vec::with_capacity(
            (outer.len() + hole_points.iter().map(|h| h.len()).sum::<usize>()) * 3,
        );
        push_rebased(
            &mut positions,
            outer.iter().chain(hole_points.iter().flatten()),
            rtc,
        );

        let indices = triangulate_planar_face(&outer, &hole_points)
            .map_err(|error| Error::geometry(error.to_string()))?;

        Ok((positions, indices))
    }
}
#[derive(Debug, Clone)]
pub(super) struct CylinderPlan {
    pub(super) radius: f64,
    pub(super) axis_transform: Matrix4<f64>,
    pub(super) min_angle: f64,
    pub(super) angle_span: f64,
    pub(super) min_z: f64,
    pub(super) height: f64,
    pub(super) angle_segments: usize,
    pub(super) height_segments: usize,
    pub(super) rtc: (f64, f64, f64),
}
impl CylinderPlan {
    pub(super) fn evaluate(self) -> (Vec<f32>, Vec<u32>) {
        let Self {
            radius,
            axis_transform,
            min_angle,
            angle_span,
            min_z,
            height,
            angle_segments,
            height_segments,
            rtc,
        } = self;
        let mut positions = Vec::new();
        let mut indices = Vec::new();

        // Generate cylinder patch vertices
        for h in 0..=height_segments {
            let z = min_z + (height * h as f64 / height_segments as f64);
            for a in 0..=angle_segments {
                let angle = min_angle + (angle_span * a as f64 / angle_segments as f64);
                let x = radius * angle.cos();
                let y = radius * angle.sin();

                // Transform back to world coordinates
                let local_point = Point3::new(x, y, z);
                let world_point = axis_transform.transform_point(&local_point);

                positions.push((world_point.x - rtc.0) as f32);
                positions.push((world_point.y - rtc.1) as f32);
                positions.push((world_point.z - rtc.2) as f32);
            }
        }

        // Generate indices for quad strip
        let cols = angle_segments + 1;
        for h in 0..height_segments {
            for a in 0..angle_segments {
                let base = (h * cols + a) as u32;
                let next_row = base + cols as u32;

                // Two triangles per quad
                indices.push(base);
                indices.push(base + 1);
                indices.push(next_row + 1);

                indices.push(base);
                indices.push(next_row + 1);
                indices.push(next_row);
            }
        }

        (positions, indices)
    }
}

#[derive(Debug, Clone)]
pub(super) struct RevolutionPlan {
    pub(super) axis_origin: Point3<f64>,
    pub(super) axis_x: Vector3<f64>,
    pub(super) axis_y: Vector3<f64>,
    pub(super) axis_dir: Vector3<f64>,
    pub(super) local_profile: Vec<(f64, f64, f64)>,
    pub(super) n_angle: usize,
    pub(super) a_min: f64,
    pub(super) span: f64,
    pub(super) natural_angle: f64,
    pub(super) rtc: (f64, f64, f64),
}
impl RevolutionPlan {
    pub(super) fn evaluate(self) -> (Vec<f32>, Vec<u32>) {
        let Self {
            axis_origin,
            axis_x,
            axis_y,
            axis_dir,
            local_profile,
            n_angle,
            a_min,
            span,
            natural_angle,
            rtc,
        } = self;
        let n_v = local_profile.len();
        let mut positions = Vec::with_capacity((n_angle + 1) * n_v * 3);
        for i in 0..=n_angle {
            let boundary_angle = a_min + span * (i as f64) / (n_angle as f64);
            let v = boundary_angle - natural_angle;
            let cos_v = v.cos();
            let sin_v = v.sin();
            for &(rx, ry, z) in &local_profile {
                let nrx = rx * cos_v - ry * sin_v;
                let nry = rx * sin_v + ry * cos_v;
                let world = axis_origin + axis_x * nrx + axis_y * nry + axis_dir * z;
                positions.push((world.x - rtc.0) as f32);
                positions.push((world.y - rtc.1) as f32);
                positions.push((world.z - rtc.2) as f32);
            }
        }

        let mut indices = Vec::with_capacity(n_angle * (n_v - 1) * 6);
        for i in 0..n_angle {
            for j in 0..(n_v - 1) {
                let a = (i * n_v + j) as u32;
                let b = a + n_v as u32;
                let c = b + 1;
                let d = a + 1;
                indices.push(a);
                indices.push(b);
                indices.push(c);
                indices.push(a);
                indices.push(c);
                indices.push(d);
            }
        }

        (positions, indices)
    }
}
