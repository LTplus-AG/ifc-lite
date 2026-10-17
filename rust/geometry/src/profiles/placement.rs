// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::math::tol;
use super::ProfileProcessor;
use crate::profile::Profile2D;
use crate::router::transforms::operator::parse_transformation_operator;
use crate::{Error, Point2, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};

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
                    if len > tol::PLACEMENT_2D_EPS {
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
        if loc_x.abs() < tol::PLACEMENT_2D_EPS
            && loc_y.abs() < tol::PLACEMENT_2D_EPS
            && (dir_x - 1.0).abs() < tol::PLACEMENT_2D_EPS
            && dir_y.abs() < tol::PLACEMENT_2D_EPS
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
    ///
    /// The operator's attribute layout and frame derivation live in ONE place,
    /// [`parse_transformation_operator`] (#7791): this only applies its XY
    /// block to the contours. A second reader used to live here and drifted
    /// (no Axis2 orthogonalisation, no Scale finiteness check).
    pub(super) fn apply_cartesian_transformation_operator_2d(
        &self,
        profile: &mut Profile2D,
        operator: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<()> {
        let m = parse_transformation_operator(operator, decoder)?;
        let (m00, m01, tx) = (m[(0, 0)], m[(0, 1)], m[(0, 3)]);
        let (m10, m11, ty) = (m[(1, 0)], m[(1, 1)], m[(1, 3)]);
        let map = |point: &mut Point2<f64>| {
            let (x, y) = (point.x, point.y);
            point.x = x * m00 + y * m01 + tx;
            point.y = x * m10 + y * m11 + ty;
        };
        profile.outer.iter_mut().for_each(map);
        for hole in &mut profile.holes {
            hole.iter_mut().for_each(map);
        }

        // If the transformation reverses orientation (negative determinant),
        // the winding order of contours is flipped. Reverse them so that
        // extrusion normals point outward correctly.
        if m00 * m11 - m01 * m10 < 0.0 {
            profile.outer.reverse();
            for hole in &mut profile.holes {
                hole.reverse();
            }
        }

        Ok(())
    }

    /// Planar conic center, local-X rotation, and local-Y handedness (#6597).
    pub(super) fn get_placement_2d(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<(Point2<f64>, f64, f64)> {
        let placement_attr = match entity.get(0) {
            Some(attr) if !attr.is_null() => attr,
            _ => return Ok((Point2::new(0.0, 0.0), 0.0, 1.0)),
        };

        let placement = match decoder.resolve_ref(placement_attr)? {
            Some(p) => p,
            None => return Ok((Point2::new(0.0, 0.0), 0.0, 1.0)),
        };

        if placement.ifc_type == IfcType::IfcAxis2Placement3D {
            // Use the canonical orthonormal frame: local Y = Axis cross X.
            // Conics in a horizontal profile plane can have either +Z or -Z
            // normals. RefDirection alone cannot distinguish their travel.
            let frame = crate::transform::parse_axis2_placement_3d(&placement, decoder)?;
            let center = Point2::new(frame[(0, 3)], frame[(1, 3)]);
            let rotation = frame[(1, 0)].atan2(frame[(0, 0)]);
            let determinant = frame[(0, 0)] * frame[(1, 1)]
                - frame[(1, 0)] * frame[(0, 1)];
            return Ok((center, rotation, if determinant < 0.0 { -1.0 } else { 1.0 }));
        }

        let location_attr = placement.get(0);
        let center = if let Some(loc_attr) = location_attr {
            if let Some(loc) = decoder.resolve_ref(loc_attr)? {
                let coords = loc.get(0).and_then(|v| v.as_list());
                if let Some(coords) = coords {
                    let x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0);
                    let y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
                    Point2::new(x, y)
                } else {
                    Point2::new(0.0, 0.0)
                }
            } else {
                Point2::new(0.0, 0.0)
            }
        } else {
            Point2::new(0.0, 0.0)
        };

        let rotation = if let Some(dir_attr) = placement.get(1) {
            if let Some(dir) = decoder.resolve_ref(dir_attr)? {
                let ratios = dir.get(0).and_then(|v| v.as_list());
                if let Some(ratios) = ratios {
                    let x = ratios.first().and_then(|v| v.as_float()).unwrap_or(1.0);
                    let y = ratios.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
                    y.atan2(x)
                } else {
                    0.0
                }
            } else {
                0.0
            }
        } else {
            0.0
        };

        Ok((center, rotation, 1.0))
    }
}
