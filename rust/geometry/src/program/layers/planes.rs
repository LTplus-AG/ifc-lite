// SPDX-License-Identifier: MPL-2.0
//! Decoder-free layer planes in the actual host's world-minus-RTC-minus-origin frame.
use super::stack::VisualLayer;
use crate::csg::Plane;
use crate::material_layer_index::LayerAxis;
use crate::math::tol;
use crate::{Point3, Vector3};
use nalgebra::Matrix4;

pub(super) struct LayerFrame {
    pub placement: Matrix4<f64>,
    pub unit_scale: f64,
    pub rtc: (f64, f64, f64),
}
impl LayerFrame {
    pub(super) fn evaluate(self, visual_layers: &[VisualLayer], axis: LayerAxis,
        direction_sense: f64, offset: f64, mesh_origin: [f64; 3]) -> Option<Vec<Plane>> {
        let v = axis.unit_vector();
        let axis_local = Vector3::new(v[0], v[1], v[2]);
        let rotation = self.placement.fixed_view::<3, 3>(0, 0);
        let world_normal = (rotation * axis_local)
            .try_normalize(tol::DIRECTION_MIN_LEN)? * direction_sense;
        let offset_m = offset * self.unit_scale;
        let mut planes = Vec::with_capacity(visual_layers.len().saturating_sub(1));
        let mut cumulative_m = 0.0_f64;
        for (i, layer) in visual_layers.iter().enumerate() {
            cumulative_m += layer.thickness_m;
            if i + 1 == visual_layers.len() { break; }
            let d = offset_m + direction_sense * cumulative_m;
            let local_origin = Point3::new(axis_local.x * d, axis_local.y * d, axis_local.z * d);
            let world_origin = self.placement.transform_point(&local_origin);
            let frame_origin = Point3::new(
                world_origin.x - self.rtc.0 - mesh_origin[0],
                world_origin.y - self.rtc.1 - mesh_origin[1],
                world_origin.z - self.rtc.2 - mesh_origin[2],
            );
            planes.push(Plane::new(frame_origin, world_normal));
        }
        Some(planes)
    }
}
