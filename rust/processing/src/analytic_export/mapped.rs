// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Strict preflight for mapped geometry before the mesh router resolves it.

use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use ifc_lite_geometry::GeometryRouter;

use super::placement::{
    resolve_required, validate_axis2_placement_2d, validate_axis2_placement_3d,
    validate_optional_direction,
};
use super::MAX_VISITED_ITEMS;

pub(super) struct MappedResolution {
    pub items: Vec<DecodedEntity>,
    pub transform: Option<[f64; 16]>,
    pub representation_map_id: u32,
}

pub(super) fn resolve_mapped_item(
    item: &DecodedEntity,
    router: &GeometryRouter,
    decoder: &mut EntityDecoder,
) -> Result<MappedResolution, String> {
    let target = resolve_required(item, 1, "MappingTarget", decoder)?;
    validate_target(&target, decoder)?;

    let source = resolve_required(item, 0, "MappingSource", decoder)?;
    if source.ifc_type != IfcType::IfcRepresentationMap {
        return Err(format!("MappingSource #{} is not IfcRepresentationMap", source.id));
    }
    validate_origin(&source, decoder)?;

    let rep = resolve_required(&source, 1, "MappedRepresentation", decoder)?;
    if !rep.ifc_type.is_subtype_of(IfcType::IfcRepresentation) {
        return Err(format!("MappedRepresentation #{} has wrong type {}", rep.id, rep.ifc_type.name()));
    }
    let items_attr = rep.get(3)
        .ok_or_else(|| format!("MappedRepresentation #{} has missing Items", rep.id))?;
    let refs = items_attr.as_list()
        .ok_or_else(|| format!("MappedRepresentation #{} has missing or malformed Items", rep.id))?;
    if refs.is_empty() || refs.len() > MAX_VISITED_ITEMS
        || refs.iter().any(|reference| reference.as_entity_ref().is_none())
    {
        return Err(format!("MappedRepresentation #{} has malformed or oversized Items", rep.id));
    }
    let items = decoder.resolve_ref_list(items_attr)
        .map_err(|error| format!("MappedRepresentation #{} Items: {error}", rep.id))?;
    let local = router.resolve_scaled_mapped_item_transform(item, &source, decoder)
        .map_err(|error| format!("mapped transform: {error}"))?;
    Ok(MappedResolution { items, transform: local, representation_map_id: source.id })
}

fn validate_target(target: &DecodedEntity, decoder: &mut EntityDecoder) -> Result<(), String> {
    let is_3d = target.ifc_type.is_subtype_of(IfcType::IfcCartesianTransformationOperator3D);
    let is_2d = target.ifc_type.is_subtype_of(IfcType::IfcCartesianTransformationOperator2D);
    if !is_3d && !is_2d {
        return Err(format!("MappingTarget #{} has wrong type {}", target.id, target.ifc_type.name()));
    }
    let origin = resolve_required(target, 2, "LocalOrigin", decoder)?;
    if origin.ifc_type != IfcType::IfcCartesianPoint {
        return Err(format!("MappingTarget #{} LocalOrigin #{} is not IfcCartesianPoint", target.id, origin.id));
    }
    validate_optional_direction(target, 0, "Axis1", decoder)?;
    validate_optional_direction(target, 1, "Axis2", decoder)?;
    if is_3d {
        validate_optional_direction(target, 4, "Axis3", decoder)?;
    }
    Ok(())
}

fn validate_origin(source: &DecodedEntity, decoder: &mut EntityDecoder) -> Result<(), String> {
    let origin = resolve_required(source, 0, "MappingOrigin", decoder)?;
    match origin.ifc_type {
        IfcType::IfcAxis2Placement3D => validate_axis2_placement_3d(&origin, decoder),
        IfcType::IfcAxis2Placement2D => validate_axis2_placement_2d(&origin, decoder),
        _ => Err(format!("MappingOrigin #{} has wrong type {}", origin.id, origin.ifc_type.name())),
    }
}
