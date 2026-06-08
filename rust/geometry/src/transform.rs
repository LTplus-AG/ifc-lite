// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Shared transform utilities for IFC geometry processing
//!
//! Provides unified implementations for parsing IFC placement and direction entities,
//! eliminating code duplication across processors.

use crate::error::{Error, Result};
use crate::mesh::Mesh;
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use nalgebra::{Matrix4, Point3, Vector3};

/// Parse IfcAxis2Placement3D into transformation matrix
///
/// IfcAxis2Placement3D attributes:
/// - 0: Location (IfcCartesianPoint)
/// - 1: Axis (IfcDirection, optional)
/// - 2: RefDirection (IfcDirection, optional)
///
/// Returns a 4x4 transformation matrix that transforms from local coordinates
/// to parent coordinates.
pub fn parse_axis2_placement_3d(
    placement: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Result<Matrix4<f64>> {
    // Get location (attribute 0)
    let location = parse_cartesian_point(placement, decoder, 0)?;

    // Get Z axis (attribute 1) - defaults to (0, 0, 1)
    let z_axis = if let Some(axis_attr) = placement.get(1) {
        if !axis_attr.is_null() {
            if let Some(axis_entity) = decoder.resolve_ref(axis_attr)? {
                parse_direction(&axis_entity)?
            } else {
                Vector3::new(0.0, 0.0, 1.0)
            }
        } else {
            Vector3::new(0.0, 0.0, 1.0)
        }
    } else {
        Vector3::new(0.0, 0.0, 1.0)
    };

    // Get X axis (attribute 2: RefDirection) - defaults to (1, 0, 0)
    let x_axis = if let Some(ref_dir_attr) = placement.get(2) {
        if !ref_dir_attr.is_null() {
            if let Some(ref_dir_entity) = decoder.resolve_ref(ref_dir_attr)? {
                parse_direction(&ref_dir_entity)?
            } else {
                Vector3::new(1.0, 0.0, 0.0)
            }
        } else {
            Vector3::new(1.0, 0.0, 0.0)
        }
    } else {
        Vector3::new(1.0, 0.0, 0.0)
    };

    // Normalize axes
    let z_axis_final = z_axis.normalize();
    let x_axis_normalized = x_axis.normalize();

    // Ensure X is orthogonal to Z (project X onto plane perpendicular to Z)
    let dot_product = x_axis_normalized.dot(&z_axis_final);
    let x_axis_orthogonal = x_axis_normalized - z_axis_final * dot_product;
    let x_axis_final = if x_axis_orthogonal.norm() > 1e-6 {
        x_axis_orthogonal.normalize()
    } else {
        // X and Z are parallel or nearly parallel - use a default perpendicular direction
        if z_axis_final.z.abs() < 0.9 {
            Vector3::new(0.0, 0.0, 1.0).cross(&z_axis_final).normalize()
        } else {
            Vector3::new(1.0, 0.0, 0.0).cross(&z_axis_final).normalize()
        }
    };

    // Y axis is cross product of Z and X (right-hand rule: Y = Z × X)
    let y_axis = z_axis_final.cross(&x_axis_final).normalize();

    // Build transformation matrix
    // Columns represent world-space directions of local axes
    let mut transform = Matrix4::identity();
    transform[(0, 0)] = x_axis_final.x;
    transform[(1, 0)] = x_axis_final.y;
    transform[(2, 0)] = x_axis_final.z;
    transform[(0, 1)] = y_axis.x;
    transform[(1, 1)] = y_axis.y;
    transform[(2, 1)] = y_axis.z;
    transform[(0, 2)] = z_axis_final.x;
    transform[(1, 2)] = z_axis_final.y;
    transform[(2, 2)] = z_axis_final.z;
    transform[(0, 3)] = location.x;
    transform[(1, 3)] = location.y;
    transform[(2, 3)] = location.z;

    Ok(transform)
}

/// Parse IfcCartesianPoint from an entity attribute
///
/// Attempts fast-path extraction first, falls back to full decode if needed.
pub fn parse_cartesian_point(
    parent: &DecodedEntity,
    decoder: &mut EntityDecoder,
    attr_index: usize,
) -> Result<Point3<f64>> {
    let point_attr = parent
        .get(attr_index)
        .ok_or_else(|| Error::geometry("Missing cartesian point".to_string()))?;

    // Try fast path first
    if let Some(point_id) = point_attr.as_entity_ref() {
        if let Some((x, y, z)) = decoder.get_cartesian_point_fast(point_id) {
            return Ok(Point3::new(x, y, z));
        }
    }

    // Fallback to full decode
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

/// Parse IfcCartesianPoint from entity ID (fast-path variant)
///
/// Uses fast-path extraction when available.
pub fn parse_cartesian_point_from_id(
    point_id: u32,
    decoder: &mut EntityDecoder,
) -> Result<Point3<f64>> {
    // Try fast path first
    if let Some((x, y, z)) = decoder.get_cartesian_point_fast(point_id) {
        return Ok(Point3::new(x, y, z));
    }

    // Fallback to full decode
    let point_entity = decoder.decode_by_id(point_id)?;

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

/// Parse IfcDirection from entity ID (fast-path variant)
///
/// Uses fast-path extraction when available.
pub fn parse_direction_from_id(dir_id: u32, decoder: &mut EntityDecoder) -> Result<Vector3<f64>> {
    let dir = decoder.decode_by_id(dir_id)?;
    parse_direction(&dir)
}

/// Parse IfcAxis2Placement3D from entity ID (fast-path variant)
///
/// Uses fast-path extraction when available for location and directions.
pub fn parse_axis2_placement_3d_from_id(
    placement_id: u32,
    decoder: &mut EntityDecoder,
) -> Result<Matrix4<f64>> {
    let placement = decoder.decode_by_id(placement_id)?;

    // Get location using fast path if available
    let location = if let Some(loc_attr) = placement.get(0) {
        if let Some(loc_id) = loc_attr.as_entity_ref() {
            parse_cartesian_point_from_id(loc_id, decoder)?
        } else {
            Point3::new(0.0, 0.0, 0.0)
        }
    } else {
        Point3::new(0.0, 0.0, 0.0)
    };

    // Get Z axis (attribute 1)
    let z_axis = if let Some(axis_attr) = placement.get(1) {
        if !axis_attr.is_null() {
            if let Some(axis_id) = axis_attr.as_entity_ref() {
                parse_direction_from_id(axis_id, decoder)?
            } else {
                Vector3::new(0.0, 0.0, 1.0)
            }
        } else {
            Vector3::new(0.0, 0.0, 1.0)
        }
    } else {
        Vector3::new(0.0, 0.0, 1.0)
    };

    // Get X axis (attribute 2: RefDirection)
    let x_axis = if let Some(ref_dir_attr) = placement.get(2) {
        if !ref_dir_attr.is_null() {
            if let Some(ref_dir_id) = ref_dir_attr.as_entity_ref() {
                parse_direction_from_id(ref_dir_id, decoder)?
            } else {
                Vector3::new(1.0, 0.0, 0.0)
            }
        } else {
            Vector3::new(1.0, 0.0, 0.0)
        }
    } else {
        Vector3::new(1.0, 0.0, 0.0)
    };

    // Normalize axes
    let z_axis_final = z_axis.normalize();
    let x_axis_normalized = x_axis.normalize();

    // Ensure X is orthogonal to Z (project X onto plane perpendicular to Z)
    let dot_product = x_axis_normalized.dot(&z_axis_final);
    let x_axis_orthogonal = x_axis_normalized - z_axis_final * dot_product;
    let x_axis_final = if x_axis_orthogonal.norm() > 1e-6 {
        x_axis_orthogonal.normalize()
    } else {
        // X and Z are parallel or nearly parallel - use a default perpendicular direction
        if z_axis_final.z.abs() < 0.9 {
            Vector3::new(0.0, 0.0, 1.0).cross(&z_axis_final).normalize()
        } else {
            Vector3::new(1.0, 0.0, 0.0).cross(&z_axis_final).normalize()
        }
    };

    // Y axis is cross product of Z and X (right-hand rule: Y = Z × X)
    let y_axis = z_axis_final.cross(&x_axis_final).normalize();

    // Build transformation matrix using Matrix4::new constructor (column-major)
    Ok(Matrix4::new(
        x_axis_final.x,
        y_axis.x,
        z_axis_final.x,
        location.x,
        x_axis_final.y,
        y_axis.y,
        z_axis_final.y,
        location.y,
        x_axis_final.z,
        y_axis.z,
        z_axis_final.z,
        location.z,
        0.0,
        0.0,
        0.0,
        1.0,
    ))
}

/// Parse IfcDirection entity
///
/// Extracts direction ratios from IfcDirection (attribute 0).
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

/// Apply RTC offset to mesh vertices
///
/// Subtracts the RTC offset from all vertex positions to shift coordinates
/// from world space to RTC-shifted space.
pub fn apply_rtc_offset(mesh: &mut Mesh, rtc: (f64, f64, f64)) {
    let (rtc_x, rtc_y, rtc_z) = rtc;
    mesh.positions.chunks_exact_mut(3).for_each(|chunk| {
        chunk[0] = (chunk[0] as f64 - rtc_x) as f32;
        chunk[1] = (chunk[1] as f64 - rtc_y) as f32;
        chunk[2] = (chunk[2] as f64 - rtc_z) as f32;
    });
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
        // This would require a mock decoder, so we'll test integration-style
        // in the processor tests instead
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
