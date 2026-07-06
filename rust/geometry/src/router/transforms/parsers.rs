// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Leaf IFC primitive placement parsers: axis placements, points, directions, transformation operators.

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

    /// Parse IfcCartesianTransformationOperator (2D or 3D)
    /// Used for MappedItem MappingTarget transformation
    #[inline]
    pub(crate) fn parse_cartesian_transformation_operator(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Matrix4<f64>> {
        // IfcCartesianTransformationOperator3D has:
        // 0: Axis1 (IfcDirection) - X axis direction (optional)
        // 1: Axis2 (IfcDirection) - Y axis direction (optional)
        // 2: LocalOrigin (IfcCartesianPoint) - translation
        // 3: Scale (IfcReal) - X axis scale (optional, defaults to 1.0)
        // 4: Axis3 (IfcDirection) - Z axis direction (optional, for 3D only)
        // IfcCartesianTransformationOperator3DNonUniform adds:
        // 5: Scale2 (IfcReal) - Y axis scale (defaults to Scale)
        // 6: Scale3 (IfcReal) - Z axis scale (defaults to Scale)
        // Without honoring attrs 5+6, every non-uniform mapped item collapses
        // to its X scale on all three axes — the drywall-panel pieces in the
        // wall-elemented-case fixture (issue #845 follow-up) ended up as
        // tiny cubes instead of tall narrow strips covering the wall area.

        // Get LocalOrigin (attribute 2)
        let origin = if let Some(origin_attr) = entity.get(2) {
            if !origin_attr.is_null() {
                if let Some(origin_entity) = decoder.resolve_ref(origin_attr)? {
                    if origin_entity.ifc_type == IfcType::IfcCartesianPoint {
                        let coords_attr = origin_entity.get(0);
                        if let Some(coords) = coords_attr.and_then(|a| a.as_list()) {
                            Point3::new(
                                coords.first().and_then(|v| v.as_float()).unwrap_or(0.0),
                                coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0),
                                coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0),
                            )
                        } else {
                            Point3::origin()
                        }
                    } else {
                        Point3::origin()
                    }
                } else {
                    Point3::origin()
                }
            } else {
                Point3::origin()
            }
        } else {
            Point3::origin()
        };

        // Get Scale (attribute 3). For IfcCartesianTransformationOperator3DNonUniform
        // this is Scale1 (X axis only); attrs 5+6 supply per-axis Y and Z scales,
        // defaulting to Scale1 when omitted.
        let scale = entity.get_float(3).unwrap_or(1.0);
        let is_non_uniform = matches!(
            entity.ifc_type,
            IfcType::IfcCartesianTransformationOperator2DnonUniform
                | IfcType::IfcCartesianTransformationOperator3DnonUniform
        );
        let scale_y = if is_non_uniform {
            entity.get_float(5).unwrap_or(scale)
        } else {
            scale
        };
        let scale_z = if is_non_uniform {
            entity.get_float(6).unwrap_or(scale)
        } else {
            scale
        };

        // Get Axis1 (raw local X, attribute 0), defaulting to +X when absent/null.
        let x_axis_raw = if let Some(axis1_attr) = entity.get(0) {
            if !axis1_attr.is_null() {
                if let Some(axis1_entity) = decoder.resolve_ref(axis1_attr)? {
                    self.parse_direction(&axis1_entity)?
                } else {
                    Vector3::new(1.0, 0.0, 0.0)
                }
            } else {
                Vector3::new(1.0, 0.0, 0.0)
            }
        } else {
            Vector3::new(1.0, 0.0, 0.0)
        };

        // Get Axis3 (raw local Z, attribute 4 for 3D), defaulting to +Z.
        let z_axis_raw = if let Some(axis3_attr) = entity.get(4) {
            if !axis3_attr.is_null() {
                if let Some(axis3_entity) = decoder.resolve_ref(axis3_attr)? {
                    self.parse_direction(&axis3_entity)?
                } else {
                    Vector3::new(0.0, 0.0, 1.0)
                }
            } else {
                Vector3::new(0.0, 0.0, 1.0)
            }
        } else {
            Vector3::new(0.0, 0.0, 1.0)
        };

        // Orthonormalize (Gram-Schmidt), guarding every normalize so a malformed
        // IfcDirection((0,0,0)) or an Axis1 parallel to Axis3 cannot produce a NaN
        // transform that silently poisons bounds/RTC/instancing/export. A zero
        // Axis3 falls back to +Z; a zero-or-parallel Axis1 keeps the valid Z and
        // takes a deterministic perpendicular X (mirrors build_axis2_matrix). Only
        // the truly degenerate operator reorients, and it always stays finite.
        let z_axis = z_axis_raw
            .try_normalize(1e-9)
            .unwrap_or_else(|| Vector3::new(0.0, 0.0, 1.0));
        let x_norm = x_axis_raw
            .try_normalize(1e-9)
            .unwrap_or_else(|| Vector3::new(1.0, 0.0, 0.0));
        let x_ortho = x_norm - z_axis * x_norm.dot(&z_axis);
        let x_axis = x_ortho.try_normalize(1e-6).unwrap_or_else(|| {
            if z_axis.z.abs() < 0.9 {
                Vector3::new(0.0, 0.0, 1.0).cross(&z_axis).normalize()
            } else {
                Vector3::new(1.0, 0.0, 0.0).cross(&z_axis).normalize()
            }
        });
        let y_axis = z_axis.cross(&x_axis).normalize();

        // Build transformation matrix. Each axis is scaled by its
        // per-axis factor (Scale / Scale2 / Scale3) so non-uniform
        // operators produce the authored anisotropic transform.
        let mut transform = Matrix4::identity();
        transform[(0, 0)] = x_axis.x * scale;
        transform[(1, 0)] = x_axis.y * scale;
        transform[(2, 0)] = x_axis.z * scale;
        transform[(0, 1)] = y_axis.x * scale_y;
        transform[(1, 1)] = y_axis.y * scale_y;
        transform[(2, 1)] = y_axis.z * scale_y;
        transform[(0, 2)] = z_axis.x * scale_z;
        transform[(1, 2)] = z_axis.y * scale_z;
        transform[(2, 2)] = z_axis.z * scale_z;
        transform[(0, 3)] = origin.x;
        transform[(1, 3)] = origin.y;
        transform[(2, 3)] = origin.z;

        Ok(transform)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A zero IfcDirection((0,0,0)) as Axis1 made a bare normalize() emit NaN, and
    // the operator matrix was returned Ok, silently poisoning every mapped vertex.
    // The matrix must now be finite.
    #[test]
    fn cartesian_transformation_operator_zero_axis_stays_finite() {
        let content = "\
#1=IFCDIRECTION((0.,0.,0.));
#3=IFCCARTESIANTRANSFORMATIONOPERATOR3D(#1,$,$,$,$);
";
        let mut decoder = EntityDecoder::new(content);
        let router = GeometryRouter::new();
        let entity = decoder.decode_by_id(3).unwrap();
        let m = router
            .parse_cartesian_transformation_operator(&entity, &mut decoder)
            .expect("operator should still parse");
        assert!(m.iter().all(|v| v.is_finite()), "NaN in transform matrix: {m:?}");
    }
}
