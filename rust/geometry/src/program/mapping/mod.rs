// SPDX-License-Identifier: MPL-2.0
//! Demand-driven mapped-source control. Frames own decoded source and policy;
//! each step borrows live execution owners and installs no retained guard.
mod frames;
mod merged;
mod submeshes;
mod occurrence;
pub(crate) use occurrence::keep_rebase_in_origin;
mod store;
pub(crate) use store::MappingStore;
use crate::{Error, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder, MAX_MAPPED_ITEM_DEPTH, slot};
use crate::GeometryRouter;
use rustc_hash::FxHashSet;

pub(crate) use merged::{MergedWalk, MergedPoll, MergedSource, MergedReady, MergedReply};
pub(crate) use submeshes::{SubmeshWalk, SubmeshPoll, SubmeshSource, SubmeshReady, SubmeshReply, admit_styled_output};

#[derive(Default)]
struct Path { ids: FxHashSet<u32> }
impl Path {
    fn depth(depth: usize, id: u32) -> Result<()> {
        if depth >= MAX_MAPPED_ITEM_DEPTH as usize {
            return Err(Error::geometry(format!(
                "MappedItem nesting exceeded maximum depth of {} at #{}", MAX_MAPPED_ITEM_DEPTH, id)));
        }
        Ok(())
    }
    fn enter(&mut self, id: u32) -> Result<()> {
        if !self.ids.insert(id) {
            return Err(Error::geometry(format!("Detected cyclic IfcMappedItem reference at #{id}")));
        }
        Ok(())
    }
    fn exit(&mut self, id: u32) { self.ids.remove(&id); }
}

fn source(item: &DecodedEntity, decoder: &mut EntityDecoder<'_>) -> Result<DecodedEntity> {
    let attribute = item.get(slot::IfcMappedItem::MAPPING_SOURCE.index())
        .ok_or_else(|| Error::geometry("MappedItem missing MappingSource".to_string()))?;
    decoder.resolve_ref(attribute)?.ok_or_else(|| Error::geometry("Failed to resolve MappingSource".to_string()))
}
pub(in crate::program) fn representation(source: &DecodedEntity, decoder: &mut EntityDecoder<'_>) -> Result<DecodedEntity> {
    let attribute = source.get(slot::IfcRepresentationMap::MAPPED_REPRESENTATION.index())
        .ok_or_else(|| Error::geometry("RepresentationMap missing MappedRepresentation".to_string()))?;
    decoder.resolve_ref(attribute)?.ok_or_else(|| Error::geometry("Failed to resolve MappedRepresentation".to_string()))
}

pub(crate) struct ItemIdentity {
    // Retained for diagnostics; feature-off release builds compile out every read.
    #[cfg_attr(not(any(debug_assertions, feature = "observability")), allow(dead_code))]
    id: u32,
    ifc_type: ifc_lite_core::IfcType,
}
impl From<&DecodedEntity> for ItemIdentity {
    fn from(item: &DecodedEntity) -> Self { Self { id: item.id, ifc_type: item.ifc_type.clone() } }
}

fn skipped(router: &GeometryRouter, item: &ItemIdentity, error: &Error, merged: bool) {
    router.record_unsupported_item(item.ifc_type.clone());
    if merged {
        crate::diag::diag_debug!(
            { item_id = item.id, error = %error, "skipping nested IfcMappedItem" }
            else { #[cfg(debug_assertions)]
                eprintln!("[ifc-lite] Skipping nested IfcMappedItem #{}: {}", item.id, error);
            }
        );
    } else {
        crate::diag::diag_debug!(
            { item_id = item.id, ifc_type = ?item.ifc_type, error = %error,
                "skipping unsupported nested geometry item" }
            else { #[cfg(debug_assertions)]
                eprintln!("[ifc-lite] Skipping unsupported nested geometry #{} ({:?}): {}", item.id, item.ifc_type, error);
            }
        );
    }
    // Feature-off release builds intentionally emit no logging.
    let _ = error;
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod resource_tests;

#[cfg(test)]
#[path = "../../router/processing_shared_cap_tests.rs"]
mod shared_cap_tests;
