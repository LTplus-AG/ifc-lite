// SPDX-License-Identifier: MPL-2.0
//! One patch applied to one object: its rename, property and quantity
//! writes, placement move and (with a geometry patch) new body, collected
//! into the outputs [`super::resolve`] settles once every patch has run.

use std::collections::{BTreeMap, HashMap, HashSet};

use crate::step_ids::IdAllocator;
use crate::step_text::escape;

use super::index::FileIndex;
use super::types::{DroppedRepresentation, ObjectRef, Patch, PropWrite, Refusal};
use super::{attrs, geometry, placement, props, props_target};

pub(super) struct PatchOutput<'a> {
    pub(super) edits_by_id: &'a mut HashMap<u32, BTreeMap<usize, String>>,
    pub(super) appended: &'a mut Vec<(u32, String)>,
    pub(super) refusals: &'a mut Vec<Refusal>,
    pub(super) removed: &'a mut HashSet<u32>,
    pub(super) detach_requests: &'a mut Vec<(u32, usize, u32)>,
    pub(super) list_edits: &'a mut HashMap<(u32, usize), attrs::ListEdit>,
    /// Objects a patch has already moved. Patches of one object compose, but
    /// only one may move it: a second placement would repoint past the first
    /// one's new records and leave them unreferenced.
    pub(super) moved: &'a mut HashSet<u32>,
    /// `(edited record, patched object)` for every in-place edit and set
    /// member change, checked once the deletes settle.
    pub(super) edited: &'a mut HashSet<(u32, u32)>,
    pub(super) object: u32,
    /// Objects a patch has already given a new body, for the same reason:
    /// a second body would leave the first one's records unreferenced.
    pub(super) reshaped: &'a mut HashSet<u32>,
    pub(super) geometry_cuts: &'a mut Vec<(u32, u32)>,
    pub(super) body_context: &'a mut geometry::BodyContext,
    pub(super) dropped_representations: &'a mut Vec<DroppedRepresentation>,
}

impl PatchOutput<'_> {
    fn edit(&mut self, edits: Vec<(u32, usize, String)>) {
        for (id, idx, value) in edits {
            self.edits_by_id.entry(id).or_default().insert(idx, value);
            self.edited.insert((id, self.object));
        }
    }

    /// The member-list change on `set`'s attribute `idx`, recorded as a
    /// write of the patched object.
    fn list_edit(&mut self, set: u32, idx: usize) -> &mut attrs::ListEdit {
        self.edited.insert((set, self.object));
        self.list_edits.entry((set, idx)).or_default()
    }
}

pub(super) fn apply_patch(
    index: &FileIndex,
    schema: &str,
    object_id: u32,
    patch: &Patch,
    ids: &mut IdAllocator,
    owner_history: Option<u32>,
    out: &mut PatchOutput<'_>,
) {
    if let Some(name) = &patch.name {
        let entity_type = index.type_of(object_id).unwrap_or_default();
        match attrs::attribute_index(schema, &entity_type, "Name") {
            Some(idx) => out.edit(vec![(object_id, idx, format!("'{}'", escape(name)))]),
            None => out.refusals.push(Refusal {
                object: ObjectRef::Id(object_id),
                reason: format!("{entity_type} has no Name attribute in {schema}"),
            }),
        }
    }

    // Writes to one set are resolved together, in the order the set is
    // first named. A write is grouped by the set it lands on, so two sets of
    // one name stay apart and a targeted and an untargeted write to one set
    // meet.
    let mut writes: Vec<(PropWrite, Option<u32>)> = Vec::new();
    for w in &patch.psets {
        match props_target::resolve_write(index, schema, object_id, w) {
            Ok(resolved) => writes.push(resolved),
            Err(reason) => out.refusals.push(Refusal { object: ObjectRef::Id(object_id), reason: format!("{}.{}: {reason}", w.pset, w.prop) }),
        }
    }
    let mut groups: Vec<(Option<u32>, Vec<&PropWrite>)> = Vec::new();
    for (write, holder) in &writes {
        let same_set = |(h, g): &&mut (Option<u32>, Vec<&PropWrite>)| {
            h == holder && g.first().is_some_and(|w| w.pset == write.pset && w.kind == write.kind && w.scope == write.scope)
        };
        match groups.iter_mut().find(same_set) {
            Some((_, group)) => group.push(write),
            None => groups.push((*holder, vec![write])),
        }
    }
    for (_, group) in &groups {
        let result = props::resolve_set_writes(index, schema, object_id, group, ids, owner_history);
        for outcome in result.outcomes {
            match outcome {
                props::PropOutcome::InPlace(edits) => out.edit(edits),
                props::PropOutcome::Append { new_records } => out.appended.extend(new_records),
                props::PropOutcome::Fold { new_records, append: (set, idx, value) } => {
                    out.appended.extend(new_records);
                    out.list_edit(set, idx).append.push(value);
                }
                props::PropOutcome::CopyOnWrite { new_records, detach } => {
                    out.appended.extend(new_records);
                    out.detach_requests.push(detach);
                }
                props::PropOutcome::LeafCopyOnWrite { new_records, replace: (set, idx, old, new) } => {
                    out.appended.extend(new_records);
                    // A later patch repointing the same leaf replaces the
                    // earlier copy, which then names nothing.
                    if let Some(earlier) = out.list_edit(set, idx).substitute.insert(old, new) {
                        out.appended.retain(|(id, _)| *id != earlier);
                    }
                }
            }
        }
        for (write, reason) in result.refused {
            out.refusals.push(Refusal { object: ObjectRef::Id(object_id), reason: format!("{}.{}: {reason}", write.pset, write.prop) });
        }
    }

    if let Some(placement_patch) = &patch.placement {
        let result = if out.moved.contains(&object_id) {
            Err("object is already moved by another patch in this plan; the first placement wins".to_string())
        } else {
            placement::resolve_placement(index, schema, object_id, placement_patch, ids)
        };
        match result {
            Ok(placement::PlacementWrite { new_records, repoint, orphaned }) => {
                out.appended.extend(new_records);
                out.edit(vec![repoint]);
                out.removed.extend(orphaned);
                out.moved.insert(object_id);
            }
            Err(reason) => out.refusals.push(Refusal { object: ObjectRef::Id(object_id), reason }),
        }
    }

    if let Some(geometry_patch) = &patch.geometry {
        let result = if out.reshaped.contains(&object_id) {
            Err("object already gets a new body from another patch in this plan; the first wins".to_string())
        } else {
            geometry::resolve_geometry(index, schema, object_id, geometry_patch, ids, out.removed, out.body_context)
        };
        match result {
            Ok(geometry::GeometryWrite { new_records, repoint, old_shape, dropped }) => {
                out.reshaped.insert(object_id);
                out.appended.extend(new_records);
                out.edit(vec![repoint]);
                out.geometry_cuts.extend(old_shape.map(|shape| (object_id, shape)));
                out.dropped_representations.extend(dropped.into_iter().map(|(representation, identifier)| {
                    DroppedRepresentation { object: ObjectRef::Id(object_id), representation, identifier }
                }));
            }
            Err(reason) => out.refusals.push(Refusal { object: ObjectRef::Id(object_id), reason: format!("geometry: {reason}") }),
        }
    }
}
