// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Per-owner length units for material layers in federated, multi-project IFC.

use super::types::{EntityMetadata, Relationship};
use ifc_lite_core::{EntityDecoder, ProjectUnits};
use std::collections::{HashMap, HashSet};

pub(super) struct MaterialUnitContext {
    default_scale: f64,
    project_scales: HashMap<u32, f64>,
    containment: HashMap<u32, u32>,
    aggregation: HashMap<u32, u32>,
    type_objects: HashMap<u32, Vec<u32>>,
    mixed_type_scales: HashSet<u32>,
}

impl MaterialUnitContext {
    pub(super) fn new(
        entities: &[EntityMetadata],
        relationships: &[Relationship],
        decoder: &mut EntityDecoder,
        default_scale: f64,
    ) -> Self {
        let project_ids: Vec<u32> = entities
            .iter()
            .filter(|e| e.type_name.eq_ignore_ascii_case("IFCPROJECT"))
            .map(|e| e.entity_id)
            .collect();
        let mut context = Self {
            default_scale,
            project_scales: HashMap::new(),
            containment: HashMap::new(),
            aggregation: HashMap::new(),
            type_objects: HashMap::new(),
            mixed_type_scales: HashSet::new(),
        };
        // The ordinary single-project file uses the caller's scale directly.
        if project_ids.len() <= 1 {
            return context;
        }

        for &project_id in &project_ids {
            let scale = if project_id == project_ids[0] {
                default_scale
            } else {
                ProjectUnits::resolve(decoder, project_id)
                    .resolved_for_unit_type("LENGTHUNIT")
                    .map_or(default_scale, |unit| unit.si_scale)
            };
            context.project_scales.insert(project_id, scale);
        }
        for rel in relationships {
            let kind = rel.rel_type.as_str();
            if kind.eq_ignore_ascii_case("IFCRELCONTAINEDINSPATIALSTRUCTURE") {
                context
                    .containment
                    .entry(rel.related_id)
                    .or_insert(rel.relating_id);
            } else if kind.eq_ignore_ascii_case("IFCRELAGGREGATES") {
                context
                    .aggregation
                    .entry(rel.related_id)
                    .or_insert(rel.relating_id);
            } else if kind.eq_ignore_ascii_case("IFCRELDEFINESBYTYPE") {
                context
                    .type_objects
                    .entry(rel.relating_id)
                    .or_default()
                    .push(rel.related_id);
            }
        }
        // A type used by occurrences in different unit contexts has no
        // single valid layer thickness. Keep its association unresolved until
        // the wire can carry per-occurrence resolved material definitions.
        context.mixed_type_scales = context
            .type_objects
            .iter()
            .filter_map(|(&type_id, objects)| {
                let mut scales = objects.iter().map(|&id| context.scale_for(id).to_bits());
                let first = scales.next()?;
                scales.any(|scale| scale != first).then_some(type_id)
            })
            .collect();
        context
    }

    pub(super) fn has_mixed_type_scales(&self, entity_id: u32) -> bool {
        self.mixed_type_scales.contains(&entity_id)
    }

    pub(super) fn scale_for(&self, entity_id: u32) -> f64 {
        if self.project_scales.is_empty() {
            return self.default_scale;
        }
        let mut visited = HashSet::new();
        let mut current = entity_id;
        loop {
            if let Some(&scale) = self.project_scales.get(&current) {
                return scale;
            }
            if !visited.insert(current) {
                return self.default_scale;
            }
            // Match the raw parser's ownership walk: containment first, then
            // aggregation, then a type's first defined occurrence (#3554).
            let next = self
                .containment
                .get(&current)
                .or_else(|| self.aggregation.get(&current))
                .or_else(|| {
                    self.type_objects
                        .get(&current)
                        .and_then(|objects| objects.first())
                });
            let Some(&next_id) = next else {
                return self.default_scale;
            };
            current = next_id;
        }
    }
}
