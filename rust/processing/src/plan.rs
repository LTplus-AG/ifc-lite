// SPDX-License-Identifier: MPL-2.0
//! Shared facts used to select type geometry and mapped-instance templates.
//!
//! Record admission stays with the caller: native scan-time readers and browser
//! decoder reads feed the same accumulator without changing their refusal policy.
use rustc_hash::{FxHashMap, FxHashSet};

/// Model-wide type/instance facts. Candidate jobs retain their source order in
/// each scheduler; these sets and counts decide which maps those jobs may draw.
#[derive(Default)]
pub struct TypeGeometryPlan {
    referenced: FxHashSet<u32>,
    instantiated: FxHashSet<u32>,
    mapped: FxHashMap<u32, (u32, u32)>,
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

    /// Transfer native occurrence counts and template ids without copying maps.
    pub fn into_mapped_instances(self) -> FxHashMap<u32, (u32, u32)> { self.mapped }
}

#[cfg(test)]
#[path = "plan_tests.rs"]
mod tests;
