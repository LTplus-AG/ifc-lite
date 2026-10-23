// SPDX-License-Identifier: MPL-2.0
//! Lowering a plan into edits, appended records and removals, without writing
//! anything. Runs against whatever referrers [`super::referrers`] has
//! collected so far; [`super::execute`] re-runs it until it completes without
//! a miss.

use std::collections::{BTreeMap, HashMap, HashSet};

use crate::step_text::escape;

use crate::step_ids::IdAllocator;
use super::index::FileIndex;
use super::types::{Disposition, ExportPlan, ObjectRef, Patch, PropWrite, Refusal};
use super::{attrs, delete, owner_history, placement, props};

pub(crate) struct Resolution {
    pub(crate) appended: Vec<(u32, String)>,
    pub(crate) edits_by_id: HashMap<u32, BTreeMap<usize, String>>,
    pub(crate) removed: HashSet<u32>,
    pub(crate) refusals: Vec<Refusal>,
    pub(crate) patched: usize,
    pub(crate) added_unsupported: usize,
    /// Every object a patch was applied to: the scope of the duplicate
    /// property-set check, which is the defect a patch can introduce.
    pub(crate) patched_objects: Vec<u32>,
}

pub(crate) fn resolve(index: &FileIndex, schema: &str, plan: &ExportPlan) -> Resolution {
    let mut ids = IdAllocator::after(index.max_id);

    let mut appended: Vec<(u32, String)> = Vec::new();
    let owner_history_ref = patch_owner_history(index, schema, plan, &mut ids, &mut appended);

    let mut refusals: Vec<Refusal> = Vec::new();
    let mut edits_by_id: HashMap<u32, BTreeMap<usize, String>> = HashMap::new();
    let mut requested_deletes: HashSet<u32> = HashSet::new();
    let mut patched = 0usize;
    let mut added_unsupported = 0usize;
    let mut patched_objects = Vec::new();

    // Resolve every disposition against the file before doing anything that
    // depends on another one's outcome (delete's reverse-reference repair
    // needs the full deleted set up front).
    let resolved = resolve_dispositions(index, plan, &mut refusals);
    for &(id, disposition) in &resolved {
        if matches!(disposition, Disposition::Delete) {
            requested_deletes.insert(id);
        }
    }

    // A patched (and not also deleted — delete wins, checked below) object
    // survives by construction: the plan named it, and a copy-on-write patch
    // can give it a relationship the source file never had, which the
    // reference-counting cascade below has no way to see. Passed to every
    // call of `resolve_deletes` so its "last referrer gone" cascade never
    // prunes an object the plan is patching out from under the patch.
    let mut protected: HashSet<u32> = resolved
        .iter()
        .filter(|&&(id, d)| matches!(d, Disposition::Patch(_)) && !requested_deletes.contains(&id))
        .map(|&(id, _)| id)
        .collect();

    // A gating-only pass: whether the requested deletes alone (no patch has
    // run yet, so no copy-on-write detach is known) already remove an
    // object a patch also targets. This is deliberately not the final
    // answer for list edits — see the combined call below — only for the
    // "object is also deleted by this plan" refusal, which only ever cares
    // about the requested deletes' own cascade.
    let gating = delete::resolve_deletes(index, schema, &requested_deletes, &[], &protected);
    // Grows beyond `gating.removed`: a patch's placement rewrite (an old,
    // now-unreferenced axis placement chain) can orphan more records, found
    // and pruned as that patch is resolved. A patch's copy-on-write detach
    // does NOT grow this here — it is named, not applied, until the combined
    // call below.
    let mut removed: HashSet<u32> = gating.removed.clone();
    // Every copy-on-write's request to strip itself from an old
    // relationship's member list: `(relationship, attribute index, this
    // object)`. Collected across every patch so relationship touched by more
    // than one detach (or by both a detach and the top-level delete cascade)
    // gets one combined rewrite instead of two competing ones.
    let mut detach_requests: Vec<(u32, usize, u32)> = Vec::new();
    // Every change a write makes to an existing set's member list: a leaf
    // copy-on-write's repoint and a folded new member. Collected like
    // `detach_requests` and rendered once below, together with whatever the
    // delete pass strips from the same list.
    let mut list_edits: HashMap<(u32, usize), attrs::ListEdit> = HashMap::new();

    let mut moved: HashSet<u32> = HashSet::new();
    let mut edited: HashSet<(u32, u32)> = HashSet::new();
    for &(id, disposition) in &resolved {
        match disposition {
            Disposition::Preserve | Disposition::Delete => {}
            Disposition::Add => added_unsupported += 1,
            Disposition::Patch(patch) => {
                if removed.contains(&id) {
                    refusals.push(Refusal {
                        object: ObjectRef::Id(id),
                        reason: "object is also deleted by this plan; delete wins".into(),
                    });
                    continue;
                }
                patched += 1;
                patched_objects.push(id);
                // The duplicate-set check reads these after the write; asked
                // for here so they are collected before resolution settles.
                index.referrers(id);
                let mut out = PatchOutput {
                    edits_by_id: &mut edits_by_id,
                    appended: &mut appended,
                    refusals: &mut refusals,
                    removed: &mut removed,
                    detach_requests: &mut detach_requests,
                    list_edits: &mut list_edits,
                    moved: &mut moved,
                    edited: &mut edited,
                    object: id,
                };
                apply_patch(index, schema, id, patch, &mut ids, owner_history_ref, &mut out);
            }
        }
    }

    // The one place the top-level deletes' cascade and every patch's
    // copy-on-write detach are resolved together: a relationship either
    // side strips from composes into a single rewrite, and a relationship
    // both sides empty between them still cascades.
    //
    // A source record an appended one names (a member a copy-on-write clone
    // reuses, the owner history) must outlive the cascade even when every
    // source referrer it had is going away.
    // An appended record's own id is above `max_id`, so only what it names
    // in the source survives the filter.
    // A member a write adds to a set the deletes take has nothing left to
    // name it, so it is not written and protects nothing.
    let orphans: HashSet<u32> = list_edits
        .iter()
        .filter(|((set, _), _)| removed.contains(set))
        .flat_map(|(_, edit)| edit.append.iter().chain(edit.substitute.values()).copied())
        .collect();
    appended.retain(|(id, _)| !orphans.contains(id));
    let mut named = Vec::new();
    for (_, text) in &appended {
        crate::step_text::refs_in_line(text.as_bytes(), &mut named);
    }
    protected.extend(named.into_iter().filter(|&id| id <= index.max_id));
    let delete_result = delete::resolve_deletes(index, schema, &requested_deletes, &detach_requests, &protected);
    // This pass decides what the deletes take: a gating removal it no longer
    // makes (a member a copy-on-write clone reuses) comes back.
    removed.retain(|id| !gating.removed.contains(id) || delete_result.removed.contains(id));
    removed.extend(delete_result.removed);
    // A surviving object's write into a record the plan deletes would vanish.
    let mut lost: Vec<(u32, u32)> = edited.into_iter().filter(|(record, object)| removed.contains(record) && !removed.contains(object)).collect();
    lost.sort_unstable();
    refusals.extend(lost.into_iter().map(|(record, object)| Refusal {
        object: ObjectRef::Id(object),
        reason: format!("a write to #{record} is lost: this plan deletes that record"),
    }));
    // A Preserve the plan's removals override is reported, not dropped.
    let mut overridden: Vec<u32> =
        resolved.iter().filter(|&&(id, d)| matches!(d, Disposition::Preserve) && removed.contains(&id)).map(|&(id, _)| id).collect();
    overridden.sort_unstable();
    overridden.dedup();
    refusals.extend(overridden.into_iter().map(|id| Refusal {
        object: ObjectRef::Id(id),
        reason: "object is removed by this plan; it cannot be preserved".into(),
    }));
    for (slot, strip) in delete_result.stripped {
        list_edits.entry(slot).or_default().remove.extend(strip);
    }

    render_list_edits(index, list_edits, &removed, &mut edits_by_id);

    Resolution { appended, edits_by_id, removed, refusals, patched, added_unsupported, patched_objects }
}

/// The owner history a patch's new records name: the file's first, else one
/// synthesized into `appended`. Synthesized only when a patch actually needs
/// to point a NEW record's OwnerHistory somewhere: a plan that never writes a
/// property/quantity set must not grow the file by five records it has no use
/// for.
fn patch_owner_history(
    index: &FileIndex,
    schema: &str,
    plan: &ExportPlan,
    ids: &mut IdAllocator,
    appended: &mut Vec<(u32, String)>,
) -> Option<u32> {
    let needs_owner_history = index.first_owner_history.is_none()
        && plan
            .dispositions
            .iter()
            .any(|(_, d)| matches!(d, Disposition::Patch(p) if !p.psets.is_empty()));
    if !needs_owner_history {
        return index.first_owner_history;
    }
    owner_history::synthesize(schema, ids, &plan.context).map(|(records, id)| {
        appended.extend(records);
        id
    })
}

/// Every disposition resolved to its id in the file, refused when it is not
/// there.
fn resolve_dispositions<'p>(
    index: &FileIndex,
    plan: &'p ExportPlan,
    refusals: &mut Vec<Refusal>,
) -> Vec<(u32, &'p Disposition)> {
    let mut resolved = Vec::new();
    for (obj, disposition) in &plan.dispositions {
        match index.resolve(obj) {
            Some(id) => resolved.push((id, disposition)),
            None => refusals.push(Refusal { object: obj.clone(), reason: "object not found in source".into() }),
        }
    }
    resolved
}

/// Every list change on one (record, attribute) slot, rendered once against
/// the source list, so no change discards another's.
fn render_list_edits(
    index: &FileIndex,
    list_edits: HashMap<(u32, usize), attrs::ListEdit>,
    removed: &HashSet<u32>,
    edits_by_id: &mut HashMap<u32, BTreeMap<usize, String>>,
) {
    for ((id, idx), edit) in list_edits {
        if removed.contains(&id) {
            continue;
        }
        let Some(slot) = index.raw_line(id).and_then(|line| crate::step_text::attribute_of(&line, idx)) else { continue };
        if let Some(entries) = attrs::ListEntry::parse_list(&slot) {
            edits_by_id.entry(id).or_default().insert(idx, edit.render(&entries));
        }
    }
}

struct PatchOutput<'a> {
    edits_by_id: &'a mut HashMap<u32, BTreeMap<usize, String>>,
    appended: &'a mut Vec<(u32, String)>,
    refusals: &'a mut Vec<Refusal>,
    removed: &'a mut HashSet<u32>,
    detach_requests: &'a mut Vec<(u32, usize, u32)>,
    list_edits: &'a mut HashMap<(u32, usize), attrs::ListEdit>,
    /// Objects a patch has already moved. Patches of one object compose, but
    /// only one may move it: a second placement would repoint past the first
    /// one's new records and leave them unreferenced.
    moved: &'a mut HashSet<u32>,
    /// `(edited record, patched object)` for every in-place edit and set
    /// member change, checked once the deletes settle.
    edited: &'a mut HashSet<(u32, u32)>,
    object: u32,
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

fn apply_patch(
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
    // first named.
    let mut groups: Vec<Vec<&PropWrite>> = Vec::new();
    for write in &patch.psets {
        let same_set = |w: &&PropWrite| w.pset == write.pset && w.kind == write.kind && w.scope == write.scope;
        match groups.iter_mut().find(|g| g.first().is_some_and(same_set)) {
            Some(group) => group.push(write),
            None => groups.push(vec![write]),
        }
    }
    for group in &groups {
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
}
