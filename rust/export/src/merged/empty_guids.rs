// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The GlobalId half of the drop plan's claim pass (#5937); see [`PlannerGuids`].

use std::collections::{HashMap, HashSet};

use super::super::guid::{extract_global_id_fast, is_relationship_type};
use super::super::plan::ModelIndex;
use super::super::units::units_compatible;
use super::is_container_type;

/// Where the emit loop will have recorded a GlobalId: final id, unit scale, and
/// whether the writer is a container. `None`: not knowable before emission.
type Record = Option<(u32, f64, bool)>;

/// One model as [`PlannerGuids::plan`] sees it, in merge order.
pub(super) struct GuidModel<'a> {
    pub(super) index: &'a ModelIndex<'a>,
    pub(super) included: &'a HashSet<u32>,
    /// Left out before GlobalId reconciliation: the spatial remap's keys.
    pub(super) remap: &'a HashMap<u32, u32>,
    pub(super) first: bool,
    pub(super) compatible: bool,
    pub(super) base: u32,
    pub(super) scale: f64,
    /// Exported across schemas: a placeholder may replace the source GlobalId.
    pub(super) converting: bool,
}

/// The emit loop's GlobalId reconciliation (`plan::reconcile_global_ids`),
/// replayed from what the drop plan can know before anything is written: the
/// twin of `PlannerGuids` in `merged-planner-guids.ts`.
///
/// It must never unify two entities the emit loop keeps apart, or the claim
/// pass would withhold an edge the emit loop writes and could drop the parent
/// of a full storey (WR41). So a GlobalId whose emit verdict the plan cannot
/// see is recorded as unknown and resolves nothing afterwards: one a model
/// exports across schemas, a relationship's, and one a model repeats (the emit
/// loop re-stamps all but the first, and registers the source id through a
/// re-stamped copy when the first is hidden). A container unifies only onto a
/// container, and anything else only onto a non-container: the drop plan's own
/// container canonicalisation already puts both copies on one node, so a
/// container this pass treats as written but the plan drops takes the copies
/// unified with it along. Missing a unification only keeps a container.
pub(super) struct PlannerGuids {
    primary_scale: f64,
    records: HashMap<String, Record>,
}

impl PlannerGuids {
    pub(super) fn new(primary_scale: f64) -> Self {
        Self { primary_scale, records: HashMap::new() }
    }

    /// Local id → final id for the entities the emit loop is sure to unify by
    /// GlobalId, then record what this model writes. Call once per model.
    pub(super) fn plan(&mut self, m: &GuidModel) -> HashMap<u32, u32> {
        let skipped = |id: &u32| m.remap.contains_key(id) || (!m.first && m.compatible && m.index.projects.contains(id));
        let guids: Vec<(u32, &str, String)> = m.index.order.iter().filter(|id| !skipped(id)).filter_map(|&id| {
            let ty = m.index.type_of.get(&id)?;
            extract_global_id_fast(ty, m.index.line_bytes(id)?).map(|g| (id, ty.as_str(), g))
        }).collect();
        let mut seen: HashMap<&str, usize> = HashMap::new();
        for (_, _, g) in &guids {
            *seen.entry(g.as_str()).or_default() += 1;
        }
        let mut unified = HashMap::new();
        let mut written: Vec<(String, Record)> = Vec::new();
        for (id, ty, g) in &guids {
            let repeated = seen[g.as_str()] > 1;
            match self.records.get(g) {
                Some(prior) => {
                    let known = prior.filter(|&(_, scale, container)| {
                        !repeated && m.compatible && units_compatible(scale, self.primary_scale)
                            && !is_relationship_type(ty) && container == is_container_type(ty)
                    });
                    if let Some((final_id, _, _)) = known {
                        unified.insert(*id, final_id);
                    }
                }
                None if repeated => written.push((g.clone(), None)),
                None if m.included.contains(id) => {
                    let known = !m.converting && !is_relationship_type(ty);
                    written.push((g.clone(), known.then(|| (id.saturating_add(m.base), m.scale, is_container_type(ty)))));
                }
                None => {}
            }
        }
        for (g, record) in written {
            self.records.insert(g, record);
        }
        unified
    }
}

#[cfg(test)]
#[path = "empty_guids_tests.rs"]
mod tests;
