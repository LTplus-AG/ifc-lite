// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::ProfileProcessor;
use crate::profile::Profile2D;
use crate::{Error, Result};
use ifc_lite_core::{AttributeValue, DecodedEntity, EntityDecoder, IfcType};

impl ProfileProcessor {
    /// Apply IfcAxis2Placement2D transform to profile points
    /// IfcAxis2Placement2D: Location, RefDirection
    pub(super) fn apply_profile_position(
        &self,
        profile: &mut Profile2D,
        placement: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<()> {
        // Get Location (attribute 0) - IfcCartesianPoint
        let (loc_x, loc_y) = if let Some(loc_attr) = placement.get(0) {
            if !loc_attr.is_null() {
                if let Some(loc_entity) = decoder.resolve_ref(loc_attr)? {
                    let coords = loc_entity
                        .get(0)
                        .and_then(|v| v.as_list())
                        .ok_or_else(|| Error::geometry("Missing point coordinates".to_string()))?;
                    let x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0);
                    let y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
                    (x, y)
                } else {
                    (0.0, 0.0)
                }
            } else {
                (0.0, 0.0)
            }
        } else {
            (0.0, 0.0)
        };

        // Get RefDirection (attribute 1) - IfcDirection (optional, default is (1,0))
        let (dir_x, dir_y) = if let Some(dir_attr) = placement.get(1) {
            if !dir_attr.is_null() {
                if let Some(dir_entity) = decoder.resolve_ref(dir_attr)? {
                    let ratios = dir_entity
                        .get(0)
                        .and_then(|v| v.as_list())
                        .ok_or_else(|| Error::geometry("Missing direction ratios".to_string()))?;
                    let x = ratios.first().and_then(|v| v.as_float()).unwrap_or(1.0);
                    let y = ratios.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
                    // Normalize
                    let len = (x * x + y * y).sqrt();
                    if len > 1e-10 {
                        (x / len, y / len)
                    } else {
                        (1.0, 0.0)
                    }
                } else {
                    (1.0, 0.0)
                }
            } else {
                (1.0, 0.0)
            }
        } else {
            (1.0, 0.0)
        };

        // Skip transform if it's identity (location at origin, direction is (1,0))
        if loc_x.abs() < 1e-10
            && loc_y.abs() < 1e-10
            && (dir_x - 1.0).abs() < 1e-10
            && dir_y.abs() < 1e-10
        {
            return Ok(());
        }

        // RefDirection is the local X axis direction
        // Local Y axis is perpendicular: (-dir_y, dir_x)
        let x_axis = (dir_x, dir_y);
        let y_axis = (-dir_y, dir_x);

        // Transform all outer points
        for point in &mut profile.outer {
            let old_x = point.x;
            let old_y = point.y;
            // Rotation then translation: p' = R * p + t
            point.x = old_x * x_axis.0 + old_y * y_axis.0 + loc_x;
            point.y = old_x * x_axis.1 + old_y * y_axis.1 + loc_y;
        }

        // Transform all hole points
        for hole in &mut profile.holes {
            for point in hole {
                let old_x = point.x;
                let old_y = point.y;
                point.x = old_x * x_axis.0 + old_y * y_axis.0 + loc_x;
                point.y = old_x * x_axis.1 + old_y * y_axis.1 + loc_y;
            }
        }

        Ok(())
    }

    /// Apply IfcCartesianTransformationOperator2D to all profile contours.
    pub(super) fn apply_cartesian_transformation_operator_2d(
        &self,
        profile: &mut Profile2D,
        operator: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<()> {
        let (origin_x, origin_y) = if let Some(origin_attr) = operator.get(2) {
            if let Some(origin_entity) = decoder.resolve_ref(origin_attr)? {
                let coords = origin_entity
                    .get(0)
                    .and_then(|v| v.as_list())
                    .ok_or_else(|| {
                        Error::geometry("Missing operator origin coordinates".to_string())
                    })?;
                (
                    coords.first().and_then(|v| v.as_float()).unwrap_or(0.0),
                    coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0),
                )
            } else {
                (0.0, 0.0)
            }
        } else {
            (0.0, 0.0)
        };

        let scale_x = operator.get_float(3).unwrap_or(1.0);
        let scale_y = match operator.ifc_type {
            IfcType::IfcCartesianTransformationOperator2DnonUniform => {
                operator.get_float(4).unwrap_or(scale_x)
            }
            _ => scale_x,
        };

        let axis1 = self.parse_operator_axis_2d(operator.get(0), decoder, (1.0, 0.0))?;
        let axis2 = self.parse_operator_axis_2d(operator.get(1), decoder, (0.0, 1.0))?;

        let (x_axis, y_axis) = match (axis1, axis2) {
            (Some(x_axis), Some(y_axis)) => (x_axis, y_axis),
            (Some(x_axis), None) => (x_axis, (-x_axis.1, x_axis.0)),
            (None, Some(y_axis)) => ((y_axis.1, -y_axis.0), y_axis),
            (None, None) => ((1.0, 0.0), (0.0, 1.0)),
        };

        for point in &mut profile.outer {
            let old_x = point.x;
            let old_y = point.y;
            point.x = old_x * x_axis.0 * scale_x + old_y * y_axis.0 * scale_y + origin_x;
            point.y = old_x * x_axis.1 * scale_x + old_y * y_axis.1 * scale_y + origin_y;
        }

        for hole in &mut profile.holes {
            for point in hole {
                let old_x = point.x;
                let old_y = point.y;
                point.x = old_x * x_axis.0 * scale_x + old_y * y_axis.0 * scale_y + origin_x;
                point.y = old_x * x_axis.1 * scale_x + old_y * y_axis.1 * scale_y + origin_y;
            }
        }

        // If the transformation reverses orientation (negative determinant),
        // the winding order of contours is flipped. Reverse them so that
        // extrusion normals point outward correctly.
        let det = scale_x * scale_y * (x_axis.0 * y_axis.1 - y_axis.0 * x_axis.1);
        if det < 0.0 {
            profile.outer.reverse();
            for hole in &mut profile.holes {
                hole.reverse();
            }
        }

        Ok(())
    }

    fn parse_operator_axis_2d(
        &self,
        axis_attr: Option<&AttributeValue>,
        decoder: &mut EntityDecoder,
        default: (f64, f64),
    ) -> Result<Option<(f64, f64)>> {
        let Some(axis_attr) = axis_attr else {
            return Ok(None);
        };
        if axis_attr.is_null() {
            return Ok(None);
        }

        let Some(axis_entity) = decoder.resolve_ref(axis_attr)? else {
            return Ok(None);
        };
        let ratios = axis_entity
            .get(0)
            .and_then(|v| v.as_list())
            .ok_or_else(|| Error::geometry("Missing operator axis ratios".to_string()))?;
        let x = ratios
            .first()
            .and_then(|v| v.as_float())
            .unwrap_or(default.0);
        let y = ratios
            .get(1)
            .and_then(|v| v.as_float())
            .unwrap_or(default.1);
        let len = (x * x + y * y).sqrt();
        if len <= 1e-10 {
            return Ok(Some(default));
        }

        Ok(Some((x / len, y / len)))
    }
}
