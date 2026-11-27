// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The global instance plan: GPU instancing decided ONCE per model.
//!
//! The per-batch decision (`batch_partition.rs`) instances a geometry only
//! when eight copies land in ONE batch call, so what instances, and how many
//! templates a model ends up with, depends on batch size and worker count.
//! The global plan decides from model-wide facts the pre-pass already has:
//!
//! - **Mapped sources**: an `IfcRepresentationMap` whose model-wide
//!   `IfcMappedItem` count reaches [`GLOBAL_INSTANCE_GATE`]
//!   (`setGlobalInstancePlan`).
//! - **Content keys**: elements whose geometry items are structurally
//!   identical, planned by the pre-pass when key planning is on
//!   (`setGlobalKeyPlanning`, `global_key_plan.rs`) and shipped per job
//!   (`addGlobalKeyPlan`).
//!
//! Installing a plan changes ONLY the partitioned batch output
//! (`processGeometryBatchPartitioned*`): meshing runs exactly as with no plan
//! installed, so every flat mesh and every geometry fingerprint is unchanged.
//! Without an installed plan nothing here runs.

use crate::api::IfcAPI;
use rustc_hash::{FxHashMap, FxHashSet};
use std::sync::{Arc, Mutex, PoisonError};
use wasm_bindgen::prelude::*;

/// Model-wide occurrences a geometry needs before it instances: the same
/// value the per-batch decision applies per batch.
pub(crate) const GLOBAL_INSTANCE_GATE: u32 = super::batch_partition::INSTANCE_MIN_OCCURRENCES;

/// A worker's installed plan, cleared with the rest of the content caches.
#[derive(Default, Debug)]
pub(crate) struct GlobalPlan {
    /// Whether `setGlobalInstancePlan` armed this load.
    pub(super) armed: bool,
    /// Mapped sources at or above the gate.
    pub(super) mapped: FxHashSet<u32>,
    /// The items of each planned source's mapped representation, to its
    /// source. A source whose item carries its own style is baked per
    /// occurrence and keyed by the item's content, not by the source id; its
    /// meshes name the item (`geometry_item_id`). Resolved once per load.
    pub(super) mapped_items: FxHashMap<u32, u32>,
    mapped_items_resolved: bool,
    /// Content-key plan index per planned job id.
    pub(super) keyed_jobs: FxHashMap<u32, u32>,
}

pub(crate) type SharedGlobalPlan = Arc<Mutex<GlobalPlan>>;

impl GlobalPlan {
    /// The planned source a mesh belongs to: its `rep_identity` when that is a
    /// planned source id, else the planned source naming its item.
    pub(super) fn mapped_source(&self, rep: u128, item: Option<u32>) -> Option<u32> {
        u32::try_from(rep)
            .ok()
            .filter(|id| self.mapped.contains(id))
            .or_else(|| item.and_then(|item| self.mapped_items.get(&item).copied()))
    }
}

/// Resolve [`GlobalPlan::mapped_items`] once per load: each planned
/// `IfcRepresentationMap`'s mapped representation items. A source that does
/// not decode contributes nothing (its occurrences can still match by id).
pub(super) fn resolve_mapped_items(plan: &SharedGlobalPlan, decoder: &mut ifc_lite_core::EntityDecoder) {
    let mut plan = plan.lock().unwrap_or_else(PoisonError::into_inner);
    if plan.mapped_items_resolved {
        return;
    }
    plan.mapped_items_resolved = true;
    let mut sources: Vec<u32> = plan.mapped.iter().copied().collect();
    sources.sort_unstable();
    for source in sources {
        let Ok(map) = decoder.decode_by_id(source) else { continue };
        let Some(rep_id) = map.get_ref(ifc_lite_core::slot::IfcRepresentationMap::MAPPED_REPRESENTATION.index()) else {
            continue;
        };
        let Ok(rep) = decoder.decode_by_id(rep_id) else { continue };
        for item in ifc_lite_geometry::representation::rep_item_ids(&rep) {
            plan.mapped_items.entry(item).or_insert(source);
        }
    }
}

impl IfcAPI {
    fn global_plan_state(&self) -> SharedGlobalPlan {
        self.content.cached_global_plan.get_or_init(Default::default)
    }

    /// The installed plan, when `setGlobalInstancePlan` armed one.
    pub(crate) fn global_plan(&self) -> Option<SharedGlobalPlan> {
        let slot = self.content.cached_global_plan.lock().unwrap_or_else(PoisonError::into_inner);
        slot.as_ref()
            .filter(|plan| plan.lock().unwrap_or_else(PoisonError::into_inner).armed)
            .cloned()
    }

    /// The plan that governs a batch: installed, and the batch partitions
    /// (instancing armed) an unshifted model. One predicate for the batch setup
    /// (which then disarms placeholders) and the partition (which then keys).
    pub(super) fn governing_global_plan(&self, arm_instancing: bool, needs_shift: bool) -> Option<SharedGlobalPlan> {
        if arm_instancing && !needs_shift { self.global_plan() } else { None }
    }

    /// Whether this instance's streaming pre-pass plans content keys.
    pub(crate) fn global_key_planning(&self) -> bool {
        self.global_key_planning.load(std::sync::atomic::Ordering::Relaxed)
    }
}

#[wasm_bindgen]
impl IfcAPI {
    /// Arm the global instance plan for this load. `source_ids` and `counts`
    /// are the pre-pass columns' `mappedInstancePlan` and
    /// `mappedInstanceCounts` (model-wide `IfcMappedItem` count per source);
    /// only sources at or above the instancing gate are kept. Mismatched
    /// lengths disarm the plan, which leaves the per-batch decision in charge.
    /// Installed after `setEntityIndex`, which clears it on a content swap.
    /// Arming starts the plan over, key plan included: call `addGlobalKeyPlan` after it.
    #[wasm_bindgen(js_name = setGlobalInstancePlan)]
    pub fn set_global_instance_plan(&self, source_ids: &[u32], counts: &[u32]) {
        let state = self.global_plan_state();
        let mut plan = state.lock().unwrap_or_else(PoisonError::into_inner);
        // Arming (or a refused arm) starts the load's plan over: key-plan chunks follow it.
        plan.keyed_jobs.clear();
        plan.mapped.clear();
        plan.mapped_items.clear();
        plan.mapped_items_resolved = false;
        plan.armed = source_ids.len() == counts.len();
        if !plan.armed {
            return;
        }
        plan.mapped = source_ids
            .iter()
            .zip(counts)
            .filter(|&(&id, &count)| count >= GLOBAL_INSTANCE_GATE && super::global_key_plan::is_mapped_key_id(id))
            .map(|(&id, _)| id)
            .collect();
    }

    /// Record the content-key plan index of planned jobs (`planIndex` of the
    /// pre-pass `jobs` events; unplanned entries are skipped). Effective only
    /// once `setGlobalInstancePlan` armed the load. Mismatched lengths record nothing.
    #[wasm_bindgen(js_name = addGlobalKeyPlan)]
    pub fn add_global_key_plan(&self, job_ids: &[u32], plan_index: &[u32]) {
        if job_ids.len() != plan_index.len() {
            return;
        }
        let state = self.global_plan_state();
        let mut plan = state.lock().unwrap_or_else(PoisonError::into_inner);
        for (&id, &index) in job_ids.iter().zip(plan_index) {
            if index != super::global_key_plan::KEY_PLAN_NONE {
                plan.keyed_jobs.insert(id, index);
            }
        }
    }

    /// Plan content keys in the streaming pre-pass of THIS instance: hash every
    /// job's geometry items before the first dispatch, emit a
    /// `global-key-plan` event and each job's `planIndex` with its chunk.
    /// Off by default; off leaves the pre-pass events unchanged.
    #[wasm_bindgen(js_name = setGlobalKeyPlanning)]
    pub fn set_global_key_planning(&self, on: bool) {
        self.global_key_planning.store(on, std::sync::atomic::Ordering::Relaxed);
    }
}
