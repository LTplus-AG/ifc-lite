// SPDX-License-Identifier: MPL-2.0
//! Shared facts used to select type geometry and mapped-instance templates.
//!
//! Record admission stays with the caller: native scan-time readers and browser
//! decoder reads feed the same accumulator without changing their refusal policy.
//! The one shared reader is [`type_representation_maps`]: browser discovery, the
//! browser batch and the export data model read `RepresentationMaps` through it,
//! with the same bare-or-list admission as the native scan.
use ifc_lite_core::{slot, AttributeValue, DecodedEntity, IfcType};
use rustc_hash::{FxHashMap, FxHashSet};

use crate::element::{plan_type_geometry, TypeGeometryMode};

/// `IfcTypeProduct.RepresentationMaps` of a decoded type, read as the native
/// scan reads it: every reference member of a list, or the one bare reference
/// the attribute is. A typed wrapper (`IFCPROPERTYSETDEFINITIONSET((#1))`,
/// `IFCX(#1)`) and non-reference members admit nothing, as natively.
pub fn type_representation_maps(entity: &DecodedEntity) -> Vec<u32> {
    match entity.attr(slot::IfcTypeProduct::REPRESENTATION_MAPS) {
        Some(AttributeValue::EntityRef(id)) => vec![*id],
        Some(AttributeValue::List(items)) => items.iter().filter_map(AttributeValue::as_entity_ref).collect(),
        _ => Vec::new(),
    }
}

/// Model-wide type/instance facts. Candidate jobs retain their source order in
/// each scheduler; these sets and counts decide which maps those jobs may draw.
#[derive(Debug, Default)]
pub struct TypeGeometryPlan {
    referenced: FxHashSet<u32>,
    instantiated: FxHashSet<u32>,
    mapped: FxHashMap<u32, (u32, u32)>,
    candidates: Vec<TypeGeometryCandidate>,
}

/// An admitted type-product record and its authored map order.
#[derive(Debug)]
pub(crate) struct TypeGeometryCandidate {
    pub(crate) id: u32,
    pub(crate) start: usize,
    pub(crate) end: usize,
    pub(crate) ifc_type: IfcType,
    pub(crate) maps: Vec<u32>,
}

impl TypeGeometryPlan {
    /// Observe an admitted MappingSource; optionally count its occurrences.
    /// The minimum mapped-item id remains the deterministic native template.
    pub fn observe_mapped(&mut self, item_id: u32, source_id: u32, count_instances: bool) {
        self.referenced.insert(source_id);
        if count_instances {
            self.mapped.entry(source_id).and_modify(|(count, template)| {
                *count += 1;
                *template = (*template).min(item_id);
            }).or_insert((1, item_id));
        }
    }

    /// Observe an admitted IfcRelDefinesByType.RelatingType.
    pub fn observe_instantiated_type(&mut self, type_id: u32) {
        self.instantiated.insert(type_id);
    }

    /// Retain an admitted type record (span, type, authored map order) in scan
    /// order; a type without maps is not a candidate.
    pub fn observe_candidate(&mut self, id: u32, start: usize, end: usize, ifc_type: IfcType, maps: Vec<u32>) {
        if !maps.is_empty() { self.candidates.push(TypeGeometryCandidate { id, start, end, ifc_type, maps }); }
    }

    /// Native scheduling uses one job per selected map of each candidate.
    pub(crate) fn candidates(&self) -> &[TypeGeometryCandidate] { &self.candidates }

    /// Browser scheduling uses one job per type that `plan_type_geometry` would
    /// draw in `EmitTagged` mode, so instantiated types stay for the Types view.
    /// Map-level class assignment remains in the producer.
    pub fn into_browser_jobs(self) -> Vec<(u32, usize, usize, IfcType)> {
        let Self { referenced, instantiated, candidates, .. } = self;
        candidates.into_iter()
            .filter(|candidate| !plan_type_geometry(
                &candidate.maps, &referenced, instantiated.contains(&candidate.id), TypeGeometryMode::EmitTagged,
            ).is_empty())
            .map(|candidate| (candidate.id, candidate.start, candidate.end, candidate.ifc_type))
            .collect()
    }

    /// Mapping sources already drawn through occurrences.
    pub fn referenced(&self) -> &FxHashSet<u32> { &self.referenced }

    /// Instantiated type ids for browser prepass columns.
    pub fn instantiated_types(&self) -> &FxHashSet<u32> { &self.instantiated }

    /// Whether a type has an occurrence, independent of mapped representation use.
    pub(crate) fn is_instantiated(&self, type_id: u32) -> bool { self.instantiated.contains(&type_id) }

    /// Sorted browser wire ids: singleton sources cannot use batch instancing.
    pub fn repeated_sources(&self) -> Vec<u32> {
        let mut ids: Vec<_> = self.mapped.iter()
            .filter(|(_, (count, _))| *count >= 2).map(|(&source, _)| source).collect();
        ids.sort_unstable();
        ids
    }

    /// Transfer the two membership columns into browser caches without cloning.
    pub fn into_membership(self) -> (FxHashSet<u32>, FxHashSet<u32>) {
        (self.referenced, self.instantiated)
    }

    /// Transfer native occurrence counts and template ids without copying maps.
    pub(crate) fn into_mapped_instances(self) -> FxHashMap<u32, (u32, u32)> { self.mapped }
}

#[cfg(test)]
#[path = "plan_tests.rs"]
mod tests;
