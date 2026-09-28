// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Strict preflight for mapped geometry before the mesh router resolves it.

use std::collections::HashMap;
use std::sync::Arc;
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use ifc_lite_geometry::GeometryRouter;
use nalgebra::Matrix4;

use super::placement::{
    resolve_required, validate_axis2_placement_2d, validate_axis2_placement_3d,
    validate_optional_direction,
};
use super::MAX_VISITED_ITEMS;

pub(super) struct MappedResolution {
    pub items: Arc<[DecodedEntity]>,
    pub transform: Option<[f64; 16]>,
    pub representation_map_id: u32,
}

// Scoped to one IFC extraction: a STEP id is therefore unambiguous across
// schema and unit contexts. Targets and their transforms remain per occurrence.
#[derive(Default)]
pub(super) struct MappedSourceCache {
    entries: HashMap<u32, MappedSource>,
    cached_items: usize,
    #[cfg(test)]
    pub loads: usize,
    #[cfg(test)]
    pub hits: usize,
    #[cfg(test)]
    pub(super) enabled: bool,
}

#[derive(Clone)]
struct MappedSource {
    entity: DecodedEntity,
    items: Arc<[DecodedEntity]>,
    // Outer None means not parsed yet; inner None is an identity origin.
    origin: Option<Option<Matrix4<f64>>>,
}

impl MappedSourceCache {
    pub(super) fn new() -> Self {
        Self {
            #[cfg(test)]
            enabled: true,
            ..Self::default()
        }
    }

    #[inline]
    fn cache_enabled(&self) -> bool {
        #[cfg(test)]
        { self.enabled }
        #[cfg(not(test))]
        { true }
    }

    fn source(
        &mut self, item: &DecodedEntity, decoder: &mut EntityDecoder,
    ) -> Result<MappedSource, String> {
        let id = item.get_ref(0)
            .ok_or_else(|| format!("entity #{} has missing or invalid MappingSource", item.id))?;
        if let Some(cached) = self.entries.get(&id) {
            #[cfg(test)]
            { self.hits += 1; }
            return Ok(cached.clone());
        }
        #[cfg(test)]
        { self.loads += 1; }
        let source = load_source(item, decoder);
        if let Ok(value) = &source {
            let item_count = value.items.len();
            if self.cache_enabled() && self.entries.len() < MAX_VISITED_ITEMS
                && item_count <= MAX_VISITED_ITEMS.saturating_sub(self.cached_items) {
                self.cached_items += item_count;
                self.entries.insert(id, value.clone());
            }
        }
        source
    }

    fn origin(
        &mut self, source: &MappedSource, router: &GeometryRouter,
        decoder: &mut EntityDecoder,
    ) -> ifc_lite_geometry::Result<Option<Matrix4<f64>>> {
        if let Some(origin) = self.entries.get(&source.entity.id).and_then(|entry| entry.origin) {
            return Ok(origin);
        }
        let origin = router.mapping_origin_transform(&source.entity, decoder)?;
        if let Some(entry) = self.entries.get_mut(&source.entity.id) {
            entry.origin = Some(origin);
        }
        Ok(origin)
    }
}

fn load_source(item: &DecodedEntity, decoder: &mut EntityDecoder) -> Result<MappedSource, String> {
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
    Ok(MappedSource { entity: source, items: items.into(), origin: None })
}

pub(super) fn resolve_mapped_item(
    item: &DecodedEntity,
    router: &GeometryRouter,
    decoder: &mut EntityDecoder,
    cache: &mut MappedSourceCache,
) -> Result<MappedResolution, String> {
    let target = resolve_required(item, 1, "MappingTarget", decoder)?;
    validate_target(&target, decoder)?;
    let source = cache.source(item, decoder)?;
    let local = router.resolve_scaled_mapped_item_transform_with_origin_loader(item, decoder,
        |decoder| cache.origin(&source, router, decoder))
        .map_err(|error| format!("mapped transform: {error}"))?;
    Ok(MappedResolution { items: source.items, transform: local, representation_map_id: source.entity.id })
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
