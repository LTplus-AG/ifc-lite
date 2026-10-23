// SPDX-License-Identifier: MPL-2.0
//! A single lazy scan for missing type-geometry membership columns.
use super::IfcAPI;
use ifc_lite_core::{slot, EntityDecoder, EntityScanner};
use ifc_lite_processing::plan::TypeGeometryPlan;
use rustc_hash::FxHashSet;
use std::sync::{Arc, Mutex};

type Membership = Arc<FxHashSet<u32>>;
type Slot = Mutex<Option<Membership>>;

fn installed(slot: &Slot) -> Option<Membership> {
    slot.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone()
}

fn install_missing(slot: &Slot, values: FxHashSet<u32>) -> Membership {
    let mut slot = slot.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    Arc::clone(slot.get_or_insert_with(|| Arc::new(values)))
}

impl IfcAPI {
    /// Return installed columns or discover only the missing ones in one scan.
    /// Do not synthesize the optional don't-bake plan: absence still means flat.
    pub(crate) fn get_or_build_type_membership(
        &self,
        content: &[u8],
        decoder: &mut EntityDecoder,
    ) -> (Membership, Membership) {
        let referenced = installed(&self.cached_referenced_repmaps);
        let instantiated = installed(&self.cached_instantiated_type_ids);
        if let (Some(referenced), Some(instantiated)) = (&referenced, &instantiated) {
            return (Arc::clone(referenced), Arc::clone(instantiated));
        }
        let mut mapped_spans = Vec::new();
        let mut type_spans = Vec::new();
        let mut scanner = EntityScanner::new(content);
        while let Some((id, kind, start, end)) = scanner.next_entity() {
            if referenced.is_none() && ifc_lite_core::keyword_eq(kind, "IFCMAPPEDITEM") {
                mapped_spans.push((id, start, end));
            } else if instantiated.is_none() && ifc_lite_core::keyword_eq(kind, "IFCRELDEFINESBYTYPE") {
                type_spans.push((id, start, end));
            }
        }
        let mut plan = TypeGeometryPlan::default();
        // Preserve the former two getters' decode order, including refusals.
        for (id, start, end) in mapped_spans {
            if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                if let Some(source) = entity.ref_at(slot::IfcMappedItem::MAPPING_SOURCE) {
                    plan.observe_mapped(id, source, false);
                }
            }
        }
        for (id, start, end) in type_spans {
            if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                if let Some(type_id) = entity.ref_at(slot::IfcRelDefinesByType::RELATING_TYPE) {
                    plan.observe_instantiated_type(type_id);
                }
            }
        }
        let (new_referenced, new_instantiated) = plan.into_membership();
        (
            referenced.unwrap_or_else(|| install_missing(&self.cached_referenced_repmaps, new_referenced)),
            instantiated.unwrap_or_else(|| install_missing(&self.cached_instantiated_type_ids, new_instantiated)),
        )
    }
}

#[cfg(test)]
#[path = "type_geometry_cache_tests.rs"]
mod tests;
