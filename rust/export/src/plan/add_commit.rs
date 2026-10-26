// SPDX-License-Identifier: MPL-2.0
//! Where an Add's records go once they are built: the owner history and
//! representation context they name, the records themselves, and the new
//! types later Adds look up. A child of `add`.

use std::collections::HashMap;

use crate::plan::add_types::GlobalId;
use crate::plan::attrs::attribute_index;
use crate::plan::tessellation::{synthesize_context, Emit};
use crate::step_ids::IdAllocator;

use super::assoc::SharedKey;
use super::mapped::MapRef;
use crate::plan::attribution::Settles;

use super::{Added, AddState};

/// The project a synthesized context is listed by, and its
/// `RepresentationContexts` slot.
pub(super) type ContextOwner = (u32, usize);

impl AddState<'_, '_> {
    /// The owner history new records name ([`Histories`]). What it has to
    /// write goes into `out`, which the caller commits only if its Add
    /// builds, so a plan whose Adds are all refused writes nothing.
    pub(super) fn owner_history_for(&self, ids: &mut IdAllocator, out: &mut Vec<(u32, String)>) -> Result<Settles, String> {
        let taken = self.history.take(ids, self.removed).ok_or("id space exhausted")?;
        out.extend(taken.records);
        Ok(taken.settles)
    }

    /// The owner history the built Adds name, if one is settled yet.
    pub(super) fn settled_history(&self) -> Option<u32> {
        self.history.settled(self.removed)
    }

    /// The context new geometry goes into: the plan's, else one synthesized
    /// into `emit`, returned second so the caller can adopt it once its Add
    /// builds.
    pub(super) fn body_context_or_new(&self, emit: &mut Emit) -> Result<(u32, Option<u32>), String> {
        match self.body_context {
            Some(existing) => Ok((existing, None)),
            None => synthesize_context(emit).map(|id| (id, Some(id))),
        }
    }

    /// A synthesized context and where it is listed, refused when the file
    /// has no project to own it.
    pub(super) fn owned_context(&self, context: Option<u32>) -> Result<Option<(u32, ContextOwner)>, String> {
        context.map(|c| self.context_owner().map(|owner| (c, owner))).transpose()
    }

    /// Where a synthesized context is listed: the project and its
    /// `RepresentationContexts` slot.
    fn context_owner(&self) -> Result<ContextOwner, String> {
        match (self.live_project(), attribute_index(self.schema, "IFCPROJECT", "RepresentationContexts")) {
            (Some(project), Some(idx)) => Ok((project, idx)),
            _ => Err("the file has no IfcProject to own a new representation context".into()),
        }
    }

    /// Make a synthesized context the plan's, listed by the project.
    pub(super) fn adopt_context(&mut self, context: u32, (project, idx): ContextOwner) {
        self.body_context = Some(context);
        self.rels.append_to_list(project, idx, context);
    }

    /// The first IfcProject the plan keeps.
    pub(super) fn live_project(&self) -> Option<u32> {
        self.index.projects.iter().copied().find(|id| !self.removed.contains(id))
    }

    /// Keep what an Add built: its records, the owner history they name, and
    /// the shared records later Adds may reuse.
    pub(super) fn commit(&mut self, owner: Settles, out: Vec<(u32, String)>, shared: HashMap<SharedKey, u32>) {
        self.history.commit(owner);
        self.records.extend(out);
        self.shared.extend(shared);
    }

    /// A new type, as later Adds see it: by GlobalId, with no placement,
    /// and with the maps it was written with.
    pub(super) fn register_type(&mut self, id: u32, global_id: GlobalId, class: String, maps: Vec<MapRef>) {
        self.placement_of_added.insert(id, None);
        self.added.insert(global_id.encode(), Added { id, class });
        if !maps.is_empty() {
            self.type_maps.get_mut().insert(id, Ok(maps.into()));
        }
    }
}
