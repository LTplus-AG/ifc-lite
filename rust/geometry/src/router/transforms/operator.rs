// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `IfcCartesianTransformationOperator` (2D / 3D, uniform + non-uniform): the
//! `IfcMappedItem` MappingTarget operator, parsed into a 4x4.

use super::super::GeometryRouter;
use crate::{Point3, Result, Vector3};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use nalgebra::Matrix4;

impl GeometryRouter {
    /// Parse IfcCartesianTransformationOperator (2D or 3D)
    /// Used for MappedItem MappingTarget transformation
    #[inline]
    pub(crate) fn parse_cartesian_transformation_operator(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Matrix4<f64>> {
        parse_transformation_operator(entity, decoder)
    }
}

/// The router-free form of [`GeometryRouter::parse_cartesian_transformation_operator`].
///
/// This is the SINGLE definition of the operator's attribute layout and frame
/// derivation. `profile_extractor` (2D drawing profiles) calls it too: it used to
/// carry its own copy, which drifted — it missed the non-uniform per-axis scales,
/// the 2D attribute layout, and `Axis2`, so the same `MappingTarget` produced a
/// different transform for a drawing than for the mesh. #1985
pub(crate) fn parse_transformation_operator(
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
    //
    // The 2D subtypes have NO Axis3: `IfcCartesianTransformationOperator2D`
    // stops at Scale (attr 3), and `…2DnonUniform` puts Scale2 at attr 4 —
    // exactly where the 3D form keeps Axis3. Reading the 3D layout on a 2D
    // operator therefore both LOST Scale2 (it was read from attr 5, which
    // does not exist) and fed a REAL to the Axis3 direction parse. #1985
    let is_2d = matches!(
        entity.ifc_type,
        IfcType::IfcCartesianTransformationOperator2D
            | IfcType::IfcCartesianTransformationOperator2DnonUniform
    );

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
    // A non-finite Scale would poison every vertex of the mapped item (the same
    // class the zero-Axis guard below defends against), so it falls back to 1.0.
    // Zero and negative pass through: zero collapses the item, and a negative
    // scale is a reflection that real exporters do write (Scale = -1), which the
    // 3D matrix represents exactly.
    let scale = match entity.get_float(3) {
        Some(v) if v.is_finite() => v,
        _ => 1.0,
    };
    let is_non_uniform = matches!(
        entity.ifc_type,
        IfcType::IfcCartesianTransformationOperator2DnonUniform
            | IfcType::IfcCartesianTransformationOperator3DnonUniform
    );
    // 2DnonUniform: Scale2 at attr 4 (no Axis3, no Scale3).
    // 3DnonUniform: Scale2 at attr 5, Scale3 at attr 6.
    let (scale_y, scale_z) = match (is_non_uniform, is_2d) {
        (false, _) => (scale, scale),
        (true, true) => (finite_scale(entity.get_float(4), scale), scale),
        (true, false) => (
            finite_scale(entity.get_float(5), scale),
            finite_scale(entity.get_float(6), scale),
        ),
    };

    // Get Axis1 (raw local X, attribute 0), defaulting to +X when absent/null.
    let x_axis_raw = if let Some(axis1_attr) = entity.get(0) {
        if !axis1_attr.is_null() {
            if let Some(axis1_entity) = decoder.resolve_ref(axis1_attr)? {
                parse_direction_ratios(&axis1_entity)?
            } else {
                Vector3::new(1.0, 0.0, 0.0)
            }
        } else {
            Vector3::new(1.0, 0.0, 0.0)
        }
    } else {
        Vector3::new(1.0, 0.0, 0.0)
    };

    // Get Axis2 (raw local Y, attribute 1), used below only when it is
    // INCONSISTENT with Axis3 × Axis1 (see the y_axis derivation).
    let y_axis_raw = if let Some(axis2_attr) = entity.get(1) {
        if !axis2_attr.is_null() {
            decoder
                .resolve_ref(axis2_attr)?
                .and_then(|e| parse_direction_ratios(&e).ok())
        } else {
            None
        }
    } else {
        None
    };

    // Get Axis3 (raw local Z, attribute 4 for 3D), defaulting to +Z. The 2D
    // subtypes have no Axis3 attribute (attr 4 is Scale2 there), so the 2D
    // plane normal is always +Z.
    let z_axis_raw = match entity.get(4).filter(|_| !is_2d) {
        Some(axis3_attr) if !axis3_attr.is_null() => {
            if let Some(axis3_entity) = decoder.resolve_ref(axis3_attr)? {
                parse_direction_ratios(&axis3_entity)?
            } else {
                Vector3::new(0.0, 0.0, 1.0)
            }
        }
        _ => Vector3::new(0.0, 0.0, 1.0),
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
    // Y = Z × X (IfcSecondProjAxis' result whenever Axis2 agrees with the
    // right-handed frame, which is every well-formed operator). A supplied
    // Axis2 that DISAGREES — the mirroring/left-handed frames some exporters
    // write — is honoured by projecting it perpendicular to Z and X, matching
    // IfcSecondProjAxis; ignoring it silently un-mirrored those items. The
    // agreeing case keeps the exact cross-product bits, so the frozen output
    // corpus is bit-identical. #1985
    let cross_y = z_axis.cross(&x_axis).normalize();
    let y_axis = match y_axis_raw {
        Some(raw) => {
            let projected = raw - z_axis * raw.dot(&z_axis);
            let projected = projected - x_axis * projected.dot(&x_axis);
            match projected.try_normalize(1e-6) {
                // Consistent with the right-handed frame (dot ≈ 1): keep the
                // cross product verbatim.
                Some(v) if v.dot(&cross_y) < 1.0 - 1e-9 => v,
                _ => cross_y,
            }
        }
        None => cross_y,
    };

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

/// A per-axis scale attribute, falling back to `default` when absent or non-finite.
#[inline]
fn finite_scale(value: Option<f64>, default: f64) -> f64 {
    match value {
        Some(v) if v.is_finite() => v,
        _ => default,
    }
}

/// `IfcDirection.DirectionRatios` as a 3-vector (Z defaults to 0 for the 2D form).
/// Mirrors `GeometryRouter::parse_direction`, minus the router.
pub(super) fn parse_direction_ratios(entity: &DecodedEntity) -> Result<Vector3<f64>> {
    if entity.ifc_type != IfcType::IfcDirection {
        return Err(crate::Error::geometry(format!(
            "Expected IfcDirection, got {}",
            entity.ifc_type
        )));
    }
    let ratios = entity
        .get(0)
        .and_then(|a| a.as_list())
        .ok_or_else(|| crate::Error::geometry("IfcDirection missing ratios".to_string()))?;
    Ok(Vector3::new(
        ratios.first().and_then(|v| v.as_float()).unwrap_or(0.0),
        ratios.get(1).and_then(|v| v.as_float()).unwrap_or(0.0),
        ratios.get(2).and_then(|v| v.as_float()).unwrap_or(0.0),
    ))
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

    // #1985: `IfcCartesianTransformationOperator2DnonUniform` keeps Scale2 at
    // attribute 4 (it has no Axis3). Reading the 3D layout took Scale2 from the
    // nonexistent attribute 5 — so Y silently fell back to the X scale — and fed
    // attribute 4 (a REAL) to the Axis3 direction parse.
    #[test]
    fn operator_2d_non_uniform_reads_scale2_from_attribute_4() {
        let content = "\
#1=IFCCARTESIANPOINT((0.,0.));
#2=IFCCARTESIANTRANSFORMATIONOPERATOR2DNONUNIFORM($,$,#1,2.,5.);
";
        let mut decoder = EntityDecoder::new(content);
        let router = GeometryRouter::new();
        let entity = decoder.decode_by_id(2).unwrap();
        let m = router
            .parse_cartesian_transformation_operator(&entity, &mut decoder)
            .expect("2D non-uniform operator should parse");
        assert!((m[(0, 0)] - 2.0).abs() < 1e-12, "X scale: {m:?}");
        assert!((m[(1, 1)] - 5.0).abs() < 1e-12, "Y scale (Scale2, attr 4): {m:?}");
        // No Scale3 on the 2D form: Z keeps the uniform Scale, and the plane
        // normal stays +Z (attribute 4 must NOT have been read as Axis3).
        assert!((m[(2, 2)] - 2.0).abs() < 1e-12, "Z scale: {m:?}");
        assert!(m[(0, 2)].abs() < 1e-12 && m[(1, 2)].abs() < 1e-12, "Z axis: {m:?}");
    }

    // #1985: Axis2 was never read, so a MIRRORING frame (Axis2 anti-parallel to
    // Axis3 × Axis1) was silently un-mirrored into a right-handed one.
    #[test]
    fn operator_honours_a_mirroring_axis2() {
        let content = "\
#1=IFCDIRECTION((1.,0.,0.));
#2=IFCDIRECTION((0.,-1.,0.));
#3=IFCDIRECTION((0.,0.,1.));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCCARTESIANTRANSFORMATIONOPERATOR3D(#1,#2,#4,$,#3);
";
        let mut decoder = EntityDecoder::new(content);
        let router = GeometryRouter::new();
        let entity = decoder.decode_by_id(5).unwrap();
        let m = router
            .parse_cartesian_transformation_operator(&entity, &mut decoder)
            .expect("mirroring operator should parse");
        assert!(
            (m[(1, 1)] + 1.0).abs() < 1e-12,
            "Y axis must follow the supplied Axis2 (mirror), got {m:?}"
        );
        assert!(
            m.determinant() < 0.0,
            "a mirroring frame must keep its negative determinant: {m:?}"
        );
    }

    // The same frame WITHOUT the mirror (Axis2 agreeing with Axis3 × Axis1) must
    // stay bit-identical to the plain cross product, so the frozen output corpus
    // is unperturbed by the Axis2 support above.
    #[test]
    fn consistent_axis2_keeps_the_cross_product_bits() {
        let with_axis2 = "\
#1=IFCDIRECTION((0.,0.6,0.8));
#2=IFCDIRECTION((0.,-0.8,0.6));
#3=IFCDIRECTION((1.,0.,0.));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCCARTESIANTRANSFORMATIONOPERATOR3D(#1,#2,#4,$,#3);
";
        let without_axis2 = "\
#1=IFCDIRECTION((0.,0.6,0.8));
#3=IFCDIRECTION((1.,0.,0.));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCCARTESIANTRANSFORMATIONOPERATOR3D(#1,$,#4,$,#3);
";
        let router = GeometryRouter::new();
        let parse = |content: &str| {
            let mut decoder = EntityDecoder::new(content);
            let entity = decoder.decode_by_id(5).unwrap();
            router
                .parse_cartesian_transformation_operator(&entity, &mut decoder)
                .expect("operator should parse")
        };
        let a = parse(with_axis2);
        let b = parse(without_axis2);
        assert_eq!(
            a.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
            b.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
            "a consistent Axis2 must not perturb the derived frame"
        );
    }
}
