// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Leaf IFC primitive placement parsers: axis placements, points, directions.
//! The `IfcCartesianTransformationOperator` lives in `operator.rs` and the
//! `IfcMappedItem` target/origin composition in `mapped.rs`.

use super::super::GeometryRouter;
use crate::{Error, Point3, Result, Vector3};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use nalgebra::Matrix4;

impl GeometryRouter {
    /// Parse IfcAxis2Placement3D into transformation matrix
    pub(crate) fn parse_axis2_placement_3d(
        &self,
        placement: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Matrix4<f64>> {
        // IfcAxis2Placement3D: Location, Axis, RefDirection
        let location = self.parse_cartesian_point(placement, decoder, 0)?;

        // Default axes if not specified
        let z_axis = if let Some(axis_attr) = placement.get(1) {
            if !axis_attr.is_null() {
                if let Some(axis_entity) = decoder.resolve_ref(axis_attr)? {
                    self.parse_direction(&axis_entity)?
                } else {
                    Vector3::new(0.0, 0.0, 1.0)
                }
            } else {
                Vector3::new(0.0, 0.0, 1.0)
            }
        } else {
            Vector3::new(0.0, 0.0, 1.0)
        };

        let x_axis = if let Some(ref_dir_attr) = placement.get(2) {
            if !ref_dir_attr.is_null() {
                if let Some(ref_dir_entity) = decoder.resolve_ref(ref_dir_attr)? {
                    self.parse_direction(&ref_dir_entity)?
                } else {
                    Vector3::new(1.0, 0.0, 0.0)
                }
            } else {
                Vector3::new(1.0, 0.0, 0.0)
            }
        } else {
            Vector3::new(1.0, 0.0, 0.0)
        };

        // Orthonormalize + assemble via the shared builder so the
        // degenerate-axis (RefDirection ∥ Axis) fallback is applied here too,
        // instead of normalizing a zero cross-product into a NaN matrix.
        Ok(crate::transform::build_axis2_matrix(location, z_axis, x_axis))
    }

    /// Parse IfcCartesianPoint
    #[inline]
    pub(crate) fn parse_cartesian_point(
        &self,
        parent: &DecodedEntity,
        decoder: &mut EntityDecoder,
        attr_index: usize,
    ) -> Result<Point3<f64>> {
        let point_attr = parent
            .get(attr_index)
            .ok_or_else(|| Error::geometry("Missing cartesian point".to_string()))?;

        let point_entity = decoder
            .resolve_ref(point_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve cartesian point".to_string()))?;

        if point_entity.ifc_type != IfcType::IfcCartesianPoint {
            return Err(Error::geometry(format!(
                "Expected IfcCartesianPoint, got {}",
                point_entity.ifc_type
            )));
        }

        // Get coordinates list (attribute 0)
        let coords_attr = point_entity
            .get(0)
            .ok_or_else(|| Error::geometry("IfcCartesianPoint missing coordinates".to_string()))?;

        let coords = coords_attr
            .as_list()
            .ok_or_else(|| Error::geometry("Expected coordinate list".to_string()))?;

        let x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0);
        let y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
        let z = coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0);

        Ok(Point3::new(x, y, z))
    }

    /// Parse IfcDirection
    #[inline]
    pub(crate) fn parse_direction(&self, direction_entity: &DecodedEntity) -> Result<Vector3<f64>> {
        if direction_entity.ifc_type != IfcType::IfcDirection {
            return Err(Error::geometry(format!(
                "Expected IfcDirection, got {}",
                direction_entity.ifc_type
            )));
        }

        // Get direction ratios (attribute 0)
        let ratios_attr = direction_entity
            .get(0)
            .ok_or_else(|| Error::geometry("IfcDirection missing ratios".to_string()))?;

        let ratios = ratios_attr
            .as_list()
            .ok_or_else(|| Error::geometry("Expected ratio list".to_string()))?;

        let x = ratios.first().and_then(|v| v.as_float()).unwrap_or(0.0);
        let y = ratios.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
        let z = ratios.get(2).and_then(|v| v.as_float()).unwrap_or(0.0);

        Ok(Vector3::new(x, y, z))
    }
}
