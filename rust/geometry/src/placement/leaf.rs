// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Point and direction reads for the placement frames, with the router's
//! historical leniency (a missing component is 0). X1 replaces these with the
//! core leaf readers and their refusal rule.

use super::{PlacementError, PlacementResult};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};

fn components(entity: &DecodedEntity) -> PlacementResult<[f64; 3]> {
    let list = entity
        .get(0)
        .and_then(|attr| attr.as_list())
        .ok_or(PlacementError::Missing { at: entity.id, attr: "coordinates" })?;
    let at = |i: usize| list.get(i).and_then(|v| v.as_float()).unwrap_or(0.0);
    Ok([at(0), at(1), at(2)])
}

/// The `IfcCartesianPoint` in attribute `slot` of `parent`.
pub(super) fn point(
    parent: &DecodedEntity,
    decoder: &mut EntityDecoder,
    slot: usize,
) -> PlacementResult<[f64; 3]> {
    let attr = parent
        .get(slot)
        .ok_or(PlacementError::Missing { at: parent.id, attr: "Location" })?;
    if let Some((x, y, z)) = attr.as_entity_ref().and_then(|id| decoder.get_cartesian_point_fast(id)) {
        return Ok([x, y, z]);
    }
    let point = decoder
        .resolve_ref(attr)?
        .ok_or(PlacementError::Missing { at: parent.id, attr: "Location" })?;
    if point.ifc_type != IfcType::IfcCartesianPoint {
        return Err(PlacementError::Unsupported { at: point.id, found: point.ifc_type });
    }
    components(&point)
}

/// The `IfcDirection` in attribute `slot` of `parent`; `$` or absent is `None`.
pub(super) fn optional_direction(
    parent: &DecodedEntity,
    decoder: &mut EntityDecoder,
    slot: usize,
) -> PlacementResult<Option<[f64; 3]>> {
    let Some(attr) = parent.get(slot).filter(|attr| !attr.is_null()) else {
        return Ok(None);
    };
    let Some(direction) = decoder.resolve_ref(attr)? else {
        return Ok(None);
    };
    if direction.ifc_type != IfcType::IfcDirection {
        return Err(PlacementError::Unsupported { at: direction.id, found: direction.ifc_type });
    }
    components(&direction).map(Some)
}
