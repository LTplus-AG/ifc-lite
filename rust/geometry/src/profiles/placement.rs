// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::math::tol;
use crate::placement::Axis2Placement;
use super::ProfileProcessor;
use crate::profile::Profile2D;
use crate::router::transforms::operator::parse_transformation_operator;
use crate::{Point2, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder};

impl ProfileProcessor {
    /// Apply IfcAxis2Placement2D transform to profile points
    /// IfcAxis2Placement2D: Location, RefDirection
    pub(super) fn apply_profile_position(
        &self,
        profile: &mut Profile2D,
        placement: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<()> {
        // The one reader: Location is mandatory, RefDirection optional (+X),
        // both under the leaf rule. This used to be hand-rolled: a missing
        // Location or an unreadable coordinate was the origin and a missing x
        // ratio was 1.0 (PROC-1, GEOM-2).
        let frame = Axis2Placement::read(placement, decoder)?.matrix();
        let (loc_x, loc_y) = (frame[(0, 3)], frame[(1, 3)]);
        let (dir_x, dir_y) = (frame[(0, 0)], frame[(1, 0)]);

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
        let y_axis = (frame[(0, 1)], frame[(1, 1)]);

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

        // 2D and 3D alike through the one reader. The 3D frame's local Y is
        // Axis x X: conics in a horizontal profile plane can have either +Z
        // or -Z normals, and RefDirection alone cannot distinguish their
        // travel. A 2D placement is always right-handed.
        let read = Axis2Placement::read(&placement, decoder)?;
        let frame = read.matrix();
        let center = Point2::new(frame[(0, 3)], frame[(1, 3)]);
        // Preserve raw atan2 bits only for planar ratios that survive the
        // canonical repair. Other cases take the repaired frame's heading,
        // matching parameterized profiles (#7779 / #7880).
        let rotation = match read.ref_direction.filter(|r| {
            let norm = crate::Vector3::from(*r).norm();
            read.planar && r[2] == 0.0 && norm.is_finite() && norm > tol::AXIS_MIN_LEN
        }) {
            Some(r) => r[1].atan2(r[0]),
            None => frame[(1, 0)].atan2(frame[(0, 0)]),
        };
        let determinant = frame[(0, 0)] * frame[(1, 1)] - frame[(1, 0)] * frame[(0, 1)];
        Ok((center, rotation, if determinant < 0.0 { -1.0 } else { 1.0 }))
    }
}
