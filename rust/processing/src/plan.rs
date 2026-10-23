// SPDX-License-Identifier: MPL-2.0
//! Shared facts used to select type geometry and mapped-instance templates.
//!
//! Record admission stays with the caller: native scan-time readers and browser
//! decoder reads feed the same accumulator without changing their refusal policy.
use ifc_lite_core::IfcType;
use rustc_hash::{FxHashMap, FxHashSet};

/// Model-wide type/instance facts. Candidate jobs retain their source order in
/// each scheduler; these sets and counts decide which maps those jobs may draw.
#[derive(Default)]
pub struct TypeGeometryPlan {
    referenced: FxHashSet<u32>,
    instantiated: FxHashSet<u32>,
    mapped: FxHashMap<u32, (u32, u32)>,
    candidates: Vec<TypeGeometryCandidate>,
}

/// An admitted type-product record and its authored map order.
pub struct TypeGeometryCandidate {
    pub id: u32,
    pub start: usize,
    pub end: usize,
    pub ifc_type: IfcType,
    pub maps: Vec<u32>,
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

    /// Retain a nonempty type candidate in scan order.
    pub fn observe_candidate(&mut self, candidate: TypeGeometryCandidate) {
        if !candidate.maps.is_empty() { self.candidates.push(candidate); }
    }

    /// Native scheduling uses one job per selected map of each candidate.
    pub fn candidates(&self) -> &[TypeGeometryCandidate] { &self.candidates }

    /// Browser scheduling uses one job per type, retaining instantiated types
    /// for the Types view. Map-level class assignment remains in the producer.
    pub fn into_browser_jobs(self) -> Vec<(u32, usize, usize, IfcType)> {
        self.candidates.into_iter()
            .filter(|candidate| candidate.maps.iter().any(|map| !self.referenced.contains(map)))
            .map(|candidate| (candidate.id, candidate.start, candidate.end, candidate.ifc_type))
            .collect()
    }

    /// Mapping sources already drawn through occurrences.
    pub fn referenced(&self) -> &FxHashSet<u32> { &self.referenced }

    /// Instantiated type ids for browser prepass columns.
    pub fn instantiated_types(&self) -> &FxHashSet<u32> { &self.instantiated }

    /// Whether a type has an occurrence, independent of mapped representation use.
    pub fn is_instantiated(&self, type_id: u32) -> bool { self.instantiated.contains(&type_id) }

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
    pub fn into_mapped_instances(self) -> FxHashMap<u32, (u32, u32)> { self.mapped }
}

#[cfg(test)]
#[path = "plan_tests.rs"]
mod tests;
