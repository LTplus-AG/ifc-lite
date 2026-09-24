// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Validate placement references before the mesh router's tolerant resolver.

use std::collections::HashSet;

use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType, MAX_PLACEMENT_DEPTH};

pub(super) fn validate_placement_chain(
    element: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Result<(), String> {
    let Some(attr) = element.get(5).filter(|attr| !attr.is_null()) else {
        return Ok(());
    };
    let mut current = attr.as_entity_ref().ok_or("ObjectPlacement is not an entity reference")?;
    let mut seen = HashSet::new();
    loop {
        if seen.len() > MAX_PLACEMENT_DEPTH {
            return Err("placement chain exceeded maximum depth".into());
        }
        if !seen.insert(current) {
            return Err(format!("placement chain has a cycle at #{current}"));
        }
        let node = decoder.decode_by_id(current)
            .map_err(|error| format!("ObjectPlacement #{current}: {error}"))?;
        match node.ifc_type {
            IfcType::IfcLocalPlacement => {
                let relative = resolve_required(&node, 1, "RelativePlacement", decoder)?;
                if !matches!(relative.ifc_type, IfcType::IfcAxis2Placement2D | IfcType::IfcAxis2Placement3D) {
                    return Err(format!("IfcLocalPlacement #{current} has invalid RelativePlacement #{}", relative.id));
                }
            }
            IfcType::IfcGridPlacement => {
                let location = resolve_required(&node, 1, "PlacementLocation", decoder)?;
                if location.ifc_type != IfcType::IfcVirtualGridIntersection {
                    return Err(format!("IfcGridPlacement #{current} has invalid PlacementLocation #{}", location.id));
                }
            }
            IfcType::IfcLinearPlacement => {
                let relative = node.get(1).filter(|attr| !attr.is_null());
                let cartesian = node.get(2).filter(|attr| !attr.is_null());
                if relative.is_none() && cartesian.is_none() {
                    return Err(format!("IfcLinearPlacement #{current} has no RelativePlacement or CartesianPosition"));
                }
                if relative.is_some() {
                    let value = resolve_required(&node, 1, "RelativePlacement", decoder)?;
                    if value.ifc_type != IfcType::IfcAxis2PlacementLinear {
                        return Err(format!("IfcLinearPlacement #{current} has invalid RelativePlacement #{}", value.id));
                    }
                }
                if cartesian.is_some() {
                    let value = resolve_required(&node, 2, "CartesianPosition", decoder)?;
                    if value.ifc_type != IfcType::IfcAxis2Placement3D {
                        return Err(format!("IfcLinearPlacement #{current} has invalid CartesianPosition #{}", value.id));
                    }
                }
            }
            _ => return Err(format!("ObjectPlacement #{current} has invalid type {}", node.ifc_type.name())),
        }
        let Some(parent) = node.get(0).filter(|attr| !attr.is_null()) else { return Ok(()) };
        current = parent.as_entity_ref()
            .ok_or_else(|| format!("placement #{current} has invalid PlacementRelTo"))?;
    }
}

fn resolve_required(
    node: &DecodedEntity,
    index: usize,
    name: &str,
    decoder: &mut EntityDecoder,
) -> Result<DecodedEntity, String> {
    let id = node.get_ref(index)
        .ok_or_else(|| format!("placement #{} has missing or invalid {name}", node.id))?;
    decoder.decode_by_id(id)
        .map_err(|error| format!("placement #{} {name} #{id}: {error}", node.id))
}
