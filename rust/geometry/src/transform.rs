// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Shared transform utilities for IFC geometry processing
//!
//! Provides unified implementations for parsing IFC placement and direction entities,
//! eliminating code duplication across processors.

use crate::error::{Error, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use crate::placement::Axis2Placement;
use nalgebra::{Matrix4, Point3, Vector3};

mod placement_2d;
pub(crate) use crate::placement::build_axis2_matrix;
pub(crate) use placement_2d::parse_axis2_placement_2d;

/// Parse IfcAxis2Placement3D into transformation matrix
///
/// IfcAxis2Placement3D attributes:
/// - 0: Location (IfcCartesianPoint)
/// - 1: Axis (IfcDirection, optional)
/// - 2: RefDirection (IfcDirection, optional)
///
/// Returns a 4x4 transformation matrix that transforms from local coordinates
/// to parent coordinates. The reader is [`crate::placement::Axis2Placement`].
pub fn parse_axis2_placement_3d(
    placement: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Result<Matrix4<f64>> {
    Ok(Axis2Placement::read_3d(placement, decoder)?.matrix())
}

/// Parse IfcCartesianPoint from an entity attribute.
///
/// Read under the one leaf rule ([`EntityDecoder::point3`]): the right IFC
/// type holding 2 or 3 finite numbers (2D promotes to z = 0). Anything else
/// is a counted [`ifc_lite_core::Error::MalformedRecord`], never a 0.
pub fn parse_cartesian_point(
    parent: &DecodedEntity,
    decoder: &mut EntityDecoder,
    attr_index: usize,
) -> Result<Point3<f64>> {
    decoder
        .point3_at(parent, attr_index)?
        .map(Point3::from)
        .ok_or_else(|| Error::geometry("Missing cartesian point".to_string()))
}

/// Parse IfcCartesianPoint from entity ID (fast-path variant), under the same
/// leaf rule as [`parse_cartesian_point`].
pub fn parse_cartesian_point_from_id(
    point_id: u32,
    decoder: &mut EntityDecoder,
) -> Result<Point3<f64>> {
    Ok(Point3::from(decoder.point3(point_id)?))
}

/// Parse IfcDirection from entity ID, under the leaf rule
/// ([`EntityDecoder::direction3`]): raw ratios, not normalised, zero allowed.
pub fn parse_direction_from_id(dir_id: u32, decoder: &mut EntityDecoder) -> Result<Vector3<f64>> {
    Ok(Vector3::from(decoder.direction3(dir_id)?))
}

/// Parse IfcAxis2Placement3D from entity ID (fast-path variant)
///
/// Values are read under the leaf rule. A `$` Location is still the origin
/// here (D-§3.4: X3a makes it a refusal with the other `helpers` forks).
pub fn parse_axis2_placement_3d_from_id(
    placement_id: u32,
    decoder: &mut EntityDecoder,
) -> Result<Matrix4<f64>> {
    let placement = decoder.decode_by_id(placement_id)?;
    Ok(Axis2Placement {
        location: decoder.point3_at(&placement, 0)?.unwrap_or([0.0; 3]),
        axis: decoder.direction3_at(&placement, 1)?,
        ref_direction: decoder.direction3_at(&placement, 2)?,
        planar: false,
    }
    .matrix())
}

/// Parse IfcDirection entity
///
/// Extracts direction ratios from IfcDirection (attribute 0). This one takes
/// no decoder, so it can neither count a refusal nor use the byte fast path:
/// it keeps reading a missing component as 0 until its callers in
/// `processors/helpers.rs` move to `EntityDecoder::direction3` (X3a) and R2a
/// deletes it.
pub fn parse_direction(direction_entity: &DecodedEntity) -> Result<Vector3<f64>> {
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

/// The building/site rotation about the world vertical (Z) axis, derived from a
/// resolved **column-major** 4×4 placement matrix (as returned by
/// [`crate::GeometryRouter::resolve_scaled_placement`]). The local X-axis (the
/// placement's RefDirection, composed through the full parent chain and
/// normalized) is column 0 — elements `[0]`, `[1]`, `[2]` — so its angle in the
/// world XY plane is `atan2(m[1], m[0])`.
///
/// This is the single source of truth for site rotation: the processor consumes
/// the full matrix (baking the inverse rotation into vertices for the
/// `site_local` frame) while the viewer takes this angle for its render-frame
/// rotation — both off the *same* resolved matrix, so they cannot drift on
/// nested, scaled, or tilted-axis placements (where `atan2` of the raw
/// top-level RefDirection is incomplete). Returns `None` for a degenerate
/// (zero-length) projected X-axis.
pub fn rotation_angle_about_z(matrix: &[f64; 16]) -> Option<f64> {
    let x = matrix[0];
    let y = matrix[1];
    if x * x + y * y < 1e-10 {
        return None;
    }
    Some(y.atan2(x))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_direction() {
        // parse_direction reads the ratio list from attribute 0.
        let content = "#1=IFCDIRECTION((0.5,0.25,0.75));";
        let mut decoder = EntityDecoder::new(content);
        let dir = decoder.decode_by_id(1).unwrap();

        let v = parse_direction(&dir).unwrap();

        assert!((v.x - 0.5).abs() < 1e-12);
        assert!((v.y - 0.25).abs() < 1e-12);
        assert!((v.z - 0.75).abs() < 1e-12);
    }

    #[test]
    fn parse_cartesian_point_reads_coordinates_from_attribute_0() {
        // parse_cartesian_point(parent, decoder, 0) resolves the ref stored
        // at attribute 0 and reads its coordinate list.
        let content = "\
#1=IFCCARTESIANPOINT((1.0,2.0,3.0));
#2=IFCAXIS2PLACEMENT3D(#1,$,$);";
        let mut decoder = EntityDecoder::new(content);
        let placement = decoder.decode_by_id(2).unwrap();

        let p = parse_cartesian_point(&placement, &mut decoder, 0).unwrap();

        assert!((p.x - 1.0).abs() < 1e-12);
        assert!((p.y - 2.0).abs() < 1e-12);
        assert!((p.z - 3.0).abs() < 1e-12);
    }

    #[test]
    fn parse_axis2_placement_3d_defaults_missing_axis_and_ref_direction() {
        // IfcAxis2Placement3D attributes 1 (Axis) and 2 (RefDirection) are
        // entirely absent (not even `$`), so `placement.get(1)`/`get(2)`
        // return `None` and the default world Z/X axes must be used with no
        // orthogonalization needed (they're already perpendicular).
        let content = "\
#1=IFCCARTESIANPOINT((10.0,20.0,30.0));
#2=IFCAXIS2PLACEMENT3D(#1);";
        let mut decoder = EntityDecoder::new(content);
        let placement = decoder.decode_by_id(2).unwrap();
        assert_eq!(placement.attributes.len(), 1, "test fixture sanity check");

        let m = parse_axis2_placement_3d(&placement, &mut decoder).unwrap();

        // Translation column carries the location through unchanged.
        assert!((m[(0, 3)] - 10.0).abs() < 1e-9);
        assert!((m[(1, 3)] - 20.0).abs() < 1e-9);
        assert!((m[(2, 3)] - 30.0).abs() < 1e-9);
        // Default Z axis (0,0,1) -> column 2.
        assert!((m[(0, 2)] - 0.0).abs() < 1e-9);
        assert!((m[(1, 2)] - 0.0).abs() < 1e-9);
        assert!((m[(2, 2)] - 1.0).abs() < 1e-9);
        // Default X axis (1,0,0) -> column 0.
        assert!((m[(0, 0)] - 1.0).abs() < 1e-9);
        assert!((m[(1, 0)] - 0.0).abs() < 1e-9);
        assert!((m[(2, 0)] - 0.0).abs() < 1e-9);
    }

    // An Axis-only placement (RefDirection `$`, or the attribute missing) on
    // each world axis: the frame the renderer draws. #5922: the viewer's
    // compare reader (`apps/viewer/src/lib/compare/worldPlacement.test.ts`)
    // pins the SAME table, so a change to this fill must move both.
    #[test]
    fn parse_axis2_placement_3d_axis_only_frames_on_world_axes() {
        type V = [f64; 3];
        let cases: [(V, V, V); 6] = [
            // (Axis, local X, local Y = Z x X)
            ([1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]),
            ([-1.0, 0.0, 0.0], [0.0, -1.0, 0.0], [0.0, 0.0, 1.0]),
            ([0.0, 1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, -1.0]),
            ([0.0, -1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]),
            ([0.0, 0.0, 1.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]),
            ([0.0, 0.0, -1.0], [1.0, 0.0, 0.0], [0.0, -1.0, 0.0]),
        ];
        for ((axis, x, y), tail) in cases.iter().flat_map(|c| [(c, ",$"), (c, "")]) {
            let content = format!(
                "#1=IFCCARTESIANPOINT((0.0,0.0,0.0));\n#2=IFCDIRECTION(({:?},{:?},{:?}));\n#3=IFCAXIS2PLACEMENT3D(#1,#2{tail});",
                axis[0], axis[1], axis[2]
            );
            let mut decoder = EntityDecoder::new(&content);
            let placement = decoder.decode_by_id(3).unwrap();
            let m = parse_axis2_placement_3d(&placement, &mut decoder).unwrap();
            for i in 0..3 {
                assert!((m[(i, 0)] - x[i]).abs() < 1e-9, "Axis {axis:?}{tail}: X = {:?}", m.column(0));
                assert!((m[(i, 1)] - y[i]).abs() < 1e-9, "Axis {axis:?}{tail}: Y = {:?}", m.column(1));
            }
        }
    }

    #[test]
    fn parse_axis2_placement_3d_orthogonalizes_parallel_ref_direction_low_z() {
        // RefDirection parallel to Axis forces the fallback branch. With
        // Axis = (1,0,0), |z.z| = 0 < 0.9, so the fallback is
        // world-Z x Axis = (0,0,1) x (1,0,0) = (0,1,0).
        let content = "\
#1=IFCCARTESIANPOINT((0.0,0.0,0.0));
#2=IFCDIRECTION((1.0,0.0,0.0));
#3=IFCDIRECTION((1.0,0.0,0.0));
#4=IFCAXIS2PLACEMENT3D(#1,#2,#3);";
        let mut decoder = EntityDecoder::new(content);
        let placement = decoder.decode_by_id(4).unwrap();

        let m = parse_axis2_placement_3d(&placement, &mut decoder).unwrap();

        // X axis (column 0) is the fallback perpendicular (0,1,0), not the
        // degenerate parallel RefDirection.
        assert!((m[(0, 0)] - 0.0).abs() < 1e-9);
        assert!((m[(1, 0)] - 1.0).abs() < 1e-9);
        assert!((m[(2, 0)] - 0.0).abs() < 1e-9);
        // Y = Z x X = (1,0,0) x (0,1,0) = (0,0,1) -> column 1.
        assert!((m[(0, 1)] - 0.0).abs() < 1e-9);
        assert!((m[(1, 1)] - 0.0).abs() < 1e-9);
        assert!((m[(2, 1)] - 1.0).abs() < 1e-9);
    }

    #[test]
    fn parse_axis2_placement_3d_orthogonalizes_parallel_ref_direction_high_z() {
        // RefDirection parallel to Axis forces the fallback branch. With
        // Axis = (0,0,1), |z.z| = 1 >= 0.9, so the fallback is
        // world-X x Axis = (1,0,0) x (0,0,1) = (0,-1,0).
        let content = "\
#1=IFCCARTESIANPOINT((0.0,0.0,0.0));
#2=IFCDIRECTION((0.0,0.0,1.0));
#3=IFCDIRECTION((0.0,0.0,1.0));
#4=IFCAXIS2PLACEMENT3D(#1,#2,#3);";
        let mut decoder = EntityDecoder::new(content);
        let placement = decoder.decode_by_id(4).unwrap();

        let m = parse_axis2_placement_3d(&placement, &mut decoder).unwrap();

        // X axis (column 0) is the fallback perpendicular (0,-1,0).
        assert!((m[(0, 0)] - 0.0).abs() < 1e-9);
        assert!((m[(1, 0)] - (-1.0)).abs() < 1e-9);
        assert!((m[(2, 0)] - 0.0).abs() < 1e-9);
        // Y = Z x X = (0,0,1) x (0,-1,0) = (1,0,0) -> column 1.
        assert!((m[(0, 1)] - 1.0).abs() < 1e-9);
        assert!((m[(1, 1)] - 0.0).abs() < 1e-9);
        assert!((m[(2, 1)] - 0.0).abs() < 1e-9);
    }

    #[test]
    fn rotation_angle_about_z_handles_identity_rotation_and_scale() {
        // Identity → 0 rad.
        let mut m = [0.0f64; 16];
        m[0] = 1.0;
        m[5] = 1.0;
        m[10] = 1.0;
        m[15] = 1.0;
        assert!(rotation_angle_about_z(&m).unwrap().abs() < 1e-12);

        // 45° about Z: column-0 X-axis = (cos45, sin45, 0). Matches the legacy
        // atan2(RefDirection.y, RefDirection.x) for an axis-aligned placement.
        let a = std::f64::consts::FRAC_PI_4;
        let mut r = [0.0f64; 16];
        r[0] = a.cos();
        r[1] = a.sin();
        r[4] = -a.sin();
        r[5] = a.cos();
        r[10] = 1.0;
        r[15] = 1.0;
        assert!((rotation_angle_about_z(&r).unwrap() - a).abs() < 1e-12);

        // Uniform scale is angle-invariant (resolve_scaled_placement may carry scale).
        let mut s = r;
        for v in s.iter_mut().take(3) {
            *v *= 3.0;
        }
        assert!((rotation_angle_about_z(&s).unwrap() - a).abs() < 1e-9);

        // Degenerate (zero-length) projected X-axis → None.
        assert!(rotation_angle_about_z(&[0.0f64; 16]).is_none());
    }
}
