// SPDX-License-Identifier: MPL-2.0
//! One patch applied to one object: its rename, property and quantity
//! writes, placement move and (with a geometry patch) new body, collected
//! into the outputs [`super::resolve`] settles once every patch has run.

use std::collections::{BTreeMap, HashMap, HashSet};

use crate::step_ids::IdAllocator;
use crate::step_text::quoted;

use super::attribution::Histories;
use super::index::FileIndex;
use super::types::{DroppedRepresentation, ObjectRef, Patch, Refusal};
use super::{attrs, geometry, placement, props, props_target};

pub(super) struct PatchOutput<'a, 'h> {
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
    /// Where the owner history of a record a patch adds comes from.
    pub(super) history: &'a mut Histories<'h>,
    /// Objects a patch has already given a new body, for the same reason:
    /// a second body would leave the first one's records unreferenced.
    pub(super) reshaped: &'a mut HashSet<u32>,
    pub(super) geometry_cuts: &'a mut Vec<(u32, u32)>,
    pub(super) body_context: &'a mut geometry::BodyContext,
    pub(super) dropped_representations: &'a mut Vec<DroppedRepresentation>,
}

impl PatchOutput<'_, '_> {
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

/// Apply `patch` to `object_id`, returning whether it wrote anything: a
/// patch whose every part is refused leaves the object unmodified, and one
/// that asks for nothing is refused as such rather than dropped silently.
pub(super) fn apply_patch(
    index: &FileIndex,
    schema: &str,
    object_id: u32,
    patch: &Patch,
    ids: &mut IdAllocator,
    out: &mut PatchOutput<'_, '_>,
) -> bool {
    let refused_before = out.refusals.len();
    let wrote = write_patch(index, schema, object_id, patch, ids, out);
    if !wrote && out.refusals.len() == refused_before {
        out.refusals.push(Refusal { object: ObjectRef::Id(object_id), reason: "patch changes nothing".into() });
    }
    wrote
}

fn write_patch(
    index: &FileIndex,
    schema: &str,
    object_id: u32,
    patch: &Patch,
    ids: &mut IdAllocator,
    out: &mut PatchOutput<'_, '_>,
) -> bool {
    let mut wrote = false;
    if let Some(name) = &patch.name {
        let entity_type = index.type_of(object_id).unwrap_or_default();
        match attrs::attribute_index(schema, &entity_type, "Name") {
            Some(idx) => {
                out.edit(vec![(object_id, idx, quoted(name))]);
                wrote = true;
            }
            None => out.refusals.push(Refusal {
                object: ObjectRef::Id(object_id),
                reason: format!("{entity_type} has no Name attribute in {schema}"),
            }),
        }
    }

    // Writes to one set are resolved together, in the order the set is
    // first named. A write is grouped by the set it lands on, so two sets of
    // one name stay apart and a targeted and an untargeted write to one set
    // meet; writes that land on no set yet group by the set they will start.
    if !patch.psets.is_empty() {
        let target = props_target::WriteTarget::read(index, schema, object_id);
        let mut groups: Vec<Vec<props_target::ResolvedWrite<'_>>> = Vec::new();
        for w in &patch.psets {
            let resolved = match props_target::resolve_write(&target, w) {
                Ok(resolved) => resolved,
                Err(reason) => {
                    out.refusals.push(Refusal { object: ObjectRef::Id(object_id), reason: format!("{}.{}: {reason}", w.pset, w.prop) });
                    continue;
                }
            };
            let same_set = |g: &&mut Vec<props_target::ResolvedWrite<'_>>| {
                g.first().is_some_and(|f| match (f.set, resolved.set) {
                    // One set can be both the object's and its type's: an
                    // occurrence and a type-scoped write to it stay apart.
                    (Some(a), Some(b)) => a == b && f.write.scope == w.scope,
                    (None, None) => f.write.pset == w.pset && f.write.kind == w.kind && f.write.scope == w.scope,
                    _ => false,
                })
            };
            match groups.iter_mut().find(same_set) {
                Some(group) => group.push(resolved),
                None => groups.push(vec![resolved]),
            }
        }
        for group in &groups {
            wrote |= apply_set_writes(&target, group, ids, out);
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
                wrote = true;
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
                wrote = true;
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
    wrote
}

/// The outcomes of resolving one set's writes, recorded on `out`; whether
/// any write produced one.
fn apply_set_writes(
    target: &props_target::WriteTarget<'_>,
    group: &[props_target::ResolvedWrite<'_>],
    ids: &mut IdAllocator,
    out: &mut PatchOutput<'_, '_>,
) -> bool {
    let (history, removed) = (&*out.history, &*out.removed);
    let result = props::resolve_set_writes(target, group, ids, &|ids: &mut IdAllocator| history.take(ids, removed));
    if let Some(settles) = result.history {
        out.history.commit(settles);
    }
    let wrote = !result.outcomes.is_empty();
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
        out.refusals.push(Refusal { object: ObjectRef::Id(target.object_id), reason: format!("{}.{}: {reason}", write.pset, write.prop) });
    }
    wrote
}
