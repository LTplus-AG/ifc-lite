// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Shared helper functions for geometry processors.
//!
//! These functions are used by multiple processor implementations to parse
//! common IFC entities (IfcAxis2Placement3D, IfcCartesianPoint, IfcDirection, etc.).

use crate::{Error, Point3, Result, Vector3};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use nalgebra::Matrix4;

/// Face data extracted from IFC for parallel triangulation
pub(super) struct FaceData {
    pub(super) outer_points: Vec<Point3<f64>>,
    pub(super) hole_points: Vec<Vec<Point3<f64>>>,
}

/// Triangulated face result
pub(super) struct FaceResult {
    pub(super) positions: Vec<f32>,
    pub(super) indices: Vec<u32>,
}

/// Parse IfcAxis2Placement3D into transformation matrix
///
/// Handles Location, Axis (Z direction), and RefDirection (X direction).
/// Ensures orthogonal axes via Gram-Schmidt-like process.
#[inline]
pub(super) fn parse_axis2_placement_3d(
    placement: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Result<Matrix4<f64>> {
    // IfcAxis2Placement3D: Location, Axis, RefDirection
    // Location can be null ($) - default to origin (0,0,0)
    let location = if let Some(loc_attr) = placement.get(0) {
        if !loc_attr.is_null() {
            parse_cartesian_point(placement, decoder, 0)?
        } else {
            Point3::new(0.0, 0.0, 0.0)
        }
    } else {
        Point3::new(0.0, 0.0, 0.0)
    };

    // Default axes if not specified
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

    // Orthonormalize + assemble via the shared builder (canonical Gram–Schmidt
    // with the degenerate-axis fallback baked in).
    Ok(crate::transform::build_axis2_matrix(location, z_axis, x_axis))
}

/// Parse IfcCartesianPoint from a parent entity at the given attribute index
#[inline]
pub(super) fn parse_cartesian_point(
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

/// Parse IfcDirection entity into a direction vector
#[inline]
pub(super) fn parse_direction(direction_entity: &DecodedEntity) -> Result<Vector3<f64>> {
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

/// Extract points from a PolyLoop entity by entity ID.
///
/// Uses fast-path coordinate extraction. Shared by FaceBasedSurfaceModelProcessor
/// and ShellBasedSurfaceModelProcessor.
pub(super) fn extract_loop_points_by_id(
    loop_id: u32,
    decoder: &mut EntityDecoder,
) -> Option<Vec<Point3<f64>>> {
    let point_ids = decoder.get_polyloop_point_ids_fast(loop_id)?;

    let mut points = Vec::with_capacity(point_ids.len());
    for point_id in point_ids {
        let (x, y, z) = decoder.get_cartesian_point_fast(point_id)?;
        points.push(Point3::new(x, y, z));
    }

    if points.len() >= 3 {
        Some(points)
    } else {
        None
    }
}

/// Get transform from IfcAxis2Placement3D by entity ID.
///
/// Uses fast-path cartesian point extraction. Shared by SurfaceOfLinearExtrusionProcessor
/// and AdvancedBrepProcessor.
pub(super) fn get_axis2_placement_transform_by_id(
    placement_id: u32,
    decoder: &mut EntityDecoder,
) -> Result<Matrix4<f64>> {
    let placement = decoder.decode_by_id(placement_id)?;

    // Get location
    let location = placement
        .get(0)
        .and_then(|a| a.as_entity_ref())
        .and_then(|id| decoder.get_cartesian_point_fast(id))
        .unwrap_or((0.0, 0.0, 0.0));

    // Get axis (Z direction)
    let z_axis = placement
        .get(1)
        .and_then(|a| a.as_entity_ref())
        .and_then(|id| get_direction_by_id(id, decoder))
        .unwrap_or(Vector3::new(0.0, 0.0, 1.0));

    // Get ref direction (X direction)
    let x_axis = placement
        .get(2)
        .and_then(|a| a.as_entity_ref())
        .and_then(|id| get_direction_by_id(id, decoder))
        .unwrap_or(Vector3::new(1.0, 0.0, 0.0));

    // Orthonormalize + assemble via the shared builder so the degenerate-axis
    // (RefDirection ∥ Axis) fallback is applied here too, instead of normalizing
    // a zero cross-product into a NaN matrix.
    Ok(crate::transform::build_axis2_matrix(
        Point3::new(location.0, location.1, location.2),
        z_axis,
        x_axis,
    ))
}

/// Get direction vector from an IfcDirection entity by ID.
///
/// Returns None if the entity cannot be decoded or parsed.
/// Shared by SurfaceOfLinearExtrusionProcessor and AdvancedBrepProcessor.
pub(super) fn get_direction_by_id(
    dir_id: u32,
    decoder: &mut EntityDecoder,
) -> Option<Vector3<f64>> {
    let dir = decoder.decode_by_id(dir_id).ok()?;
    // IfcDirection has a single attribute: DirectionRatios (list of floats)
    let ratios = dir.get(0)?.as_list()?;
    let x = ratios.first()?.as_float().unwrap_or(0.0);
    let y = ratios.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
    let z = ratios.get(2).and_then(|v| v.as_float()).unwrap_or(0.0);
    Some(Vector3::new(x, y, z))
}
