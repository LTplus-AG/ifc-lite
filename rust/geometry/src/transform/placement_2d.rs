// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Canonical router-free `IfcAxis2Placement2D` transform.

use super::{parse_decoded_cartesian_point, parse_direction};
use crate::{Error, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use nalgebra::{Matrix4, Vector3};

/// Parse Location and optional RefDirection in the XY plane, preserving the
/// existing fallback for a missing or degenerate direction.
pub(crate) fn parse_axis2_placement_2d(
    placement: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Result<Matrix4<f64>> {
    // The generic point parser uses a type-agnostic raw fast path. Mapping
    // origins historically reject a Location that is not IfcCartesianPoint,
    // so resolve once and check the decoded entity before reading coordinates.
    let location_attr = placement
        .get(0)
        .ok_or_else(|| Error::geometry("Missing cartesian point".to_string()))?;
    let location_entity = decoder
        .resolve_ref(location_attr)?
        .ok_or_else(|| Error::geometry("Failed to resolve cartesian point".to_string()))?;
    let location = parse_decoded_cartesian_point(&location_entity)?;
    let ref_dir = match placement.get(1) {
        Some(attr) if !attr.is_null() => match decoder.resolve_ref(attr)? {
            Some(direction) => parse_direction(&direction)?
                .try_normalize(1e-9)
                .unwrap_or_else(|| Vector3::new(1.0, 0.0, 0.0)),
            None => Vector3::new(1.0, 0.0, 0.0),
        },
        _ => Vector3::new(1.0, 0.0, 0.0),
    };
    let mut matrix = Matrix4::identity();
    matrix[(0, 0)] = ref_dir.x;
    matrix[(1, 0)] = ref_dir.y;
    matrix[(0, 1)] = -ref_dir.y;
    matrix[(1, 1)] = ref_dir.x;
    matrix[(0, 3)] = location.x;
    matrix[(1, 3)] = location.y;
    matrix[(2, 3)] = location.z;
    Ok(matrix)
}
