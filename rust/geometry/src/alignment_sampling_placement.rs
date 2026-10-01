// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Schema validation before the canonical (renderer-tolerant) placement resolver.
//! No transform is computed here. Unsupported placement families fail explicitly.
use crate::{Error, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType, MAX_PLACEMENT_DEPTH};
use std::collections::HashSet;

pub(super) fn validate_placement(
    entity: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Result<()> {
    let Some(attr) = entity.get(5).filter(|a| !a.is_null()) else {
        return Ok(());
    };
    let mut current = attr
        .as_entity_ref()
        .ok_or_else(|| Error::geometry("ObjectPlacement must be a reference"))?;
    let mut visited = HashSet::new();
    loop {
        if !visited.insert(current) || visited.len() > MAX_PLACEMENT_DEPTH {
            return Err(Error::geometry(
                "Cyclic or over-budget alignment placement chain",
            ));
        }
        let placement = decoder.decode_by_id(current)?;
        if placement.ifc_type != IfcType::IfcLocalPlacement {
            return Err(Error::geometry(format!(
                "Unsupported alignment placement #{}: {}",
                current, placement.ifc_type
            )));
        }
        let rel_id = placement
            .get_ref(1)
            .ok_or_else(|| Error::geometry("LocalPlacement missing RelativePlacement"))?;
        let rel = decoder.decode_by_id(rel_id)?;
        if rel.ifc_type != IfcType::IfcAxis2Placement3D {
            return Err(Error::geometry(
                "RelativePlacement must be IfcAxis2Placement3D",
            ));
        }
        let loc = decoder.decode_by_id(
            rel.get_ref(0)
                .ok_or_else(|| Error::geometry("Axis2Placement3D missing Location"))?,
        )?;
        validate_vector(&loc, IfcType::IfcCartesianPoint)?;
        let mut directions = [[0., 0., 1.], [1., 0., 0.]];
        for (index, direction) in directions.iter_mut().enumerate() {
            if let Some(attr) = rel.get(index + 1).filter(|a| !a.is_null()) {
                let id = attr
                    .as_entity_ref()
                    .ok_or_else(|| Error::geometry("Placement direction must be a reference"))?;
                *direction = validate_vector(&decoder.decode_by_id(id)?, IfcType::IfcDirection)?;
            }
        }
        let [z, x] = directions;
        let cross = [
            z[1] * x[2] - z[2] * x[1],
            z[2] * x[0] - z[0] * x[2],
            z[0] * x[1] - z[1] * x[0],
        ];
        if !cross.iter().any(|v| v.abs() > 1e-12) {
            return Err(Error::geometry(
                "Placement Axis and RefDirection are parallel or degenerate",
            ));
        }
        let Some(parent) = placement.get(0).filter(|a| !a.is_null()) else {
            return Ok(());
        };
        current = parent
            .as_entity_ref()
            .ok_or_else(|| Error::geometry("PlacementRelTo must be a reference"))?;
    }
}

fn validate_vector(entity: &DecodedEntity, expected: IfcType) -> Result<[f64; 3]> {
    if entity.ifc_type != expected {
        return Err(Error::geometry(format!(
            "Expected {expected}, got {}",
            entity.ifc_type
        )));
    }
    let coords = entity
        .get_list(0)
        .ok_or_else(|| Error::geometry("Missing placement coordinates/ratios"))?;
    if coords.len() != 3 {
        return Err(Error::geometry(
            "3D placement requires three coordinates/ratios",
        ));
    }
    let mut values = [0.; 3];
    for (out, attr) in values.iter_mut().zip(coords) {
        *out = attr
            .as_float()
            .filter(|v| v.is_finite())
            .ok_or_else(|| Error::geometry("Nonfinite or nonnumeric placement coordinate/ratio"))?;
    }
    if expected == IfcType::IfcDirection {
        let norm = values.iter().map(|v| v * v).sum::<f64>().sqrt();
        if !norm.is_finite() || norm <= 0. {
            return Err(Error::geometry("Degenerate placement direction"));
        }
        values.iter_mut().for_each(|v| *v /= norm);
    }
    Ok(values)
}
