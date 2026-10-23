// SPDX-License-Identifier: MPL-2.0
//! Lowering a plan into edits, appended records and removals, without writing
//! anything. Runs against whatever referrers [`super::referrers`] has
//! collected so far; [`super::execute`] re-runs it until it completes without
//! a miss.

use std::collections::{BTreeMap, HashMap, HashSet};

use crate::step_ids::IdAllocator;
use super::index::FileIndex;
use super::add_types::NewObject;
use super::patch::{apply_patch, PatchOutput};
use super::types::{Disposition, DroppedRepresentation, ExportPlan, ObjectRef, Refusal};
use super::{add, attrs, delete, geometry, owner_history};

pub(crate) struct Resolution {
    pub(crate) appended: Vec<(u32, String)>,
    pub(crate) edits_by_id: HashMap<u32, BTreeMap<usize, String>>,
    pub(crate) removed: HashSet<u32>,
    pub(crate) refusals: Vec<Refusal>,
    pub(crate) patched: usize,
    pub(crate) added: usize,
    /// Every object a patch was applied to: the scope of the duplicate
    /// property-set check, which is the defect a patch can introduce.
    pub(crate) patched_objects: Vec<u32>,
    pub(crate) dropped_representations: Vec<DroppedRepresentation>,
}

pub(crate) fn resolve(index: &FileIndex, schema: &str, plan: &ExportPlan) -> Resolution {
    let mut ids = IdAllocator::after(index.max_id);

    let mut appended: Vec<(u32, String)> = Vec::new();
    let owner_history_ref = patch_owner_history(index, schema, plan, &mut ids, &mut appended);

    let mut refusals: Vec<Refusal> = Vec::new();
    let mut edits_by_id: HashMap<u32, BTreeMap<usize, String>> = HashMap::new();
    let mut requested_deletes: HashSet<u32> = HashSet::new();
    let mut patched = 0usize;
    let mut patched_objects = Vec::new();

    // Resolve every disposition against the file before doing anything that
    // depends on another one's outcome (delete's reverse-reference repair
    // needs the full deleted set up front).
    let (resolved, adds) = split_dispositions(index, plan, &mut refusals);
    for &(id, disposition) in &resolved {
        if matches!(disposition, Disposition::Delete) {
            requested_deletes.insert(id);
        }
    }

    let mut protected = protected_ids(index, &resolved, &adds, &requested_deletes);

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
    // Every geometry patch's cut `(product, old shape)`, swept together once
    // every patch has resolved.
    let mut geometry_cuts: Vec<(u32, u32)> = Vec::new();
    let mut body_context = geometry::BodyContext::default();
    let mut dropped_representations = Vec::new();

    let mut moved: HashSet<u32> = HashSet::new();
    let mut edited: HashSet<(u32, u32)> = HashSet::new();
    let mut reshaped: HashSet<u32> = HashSet::new();
    for &(id, disposition) in &resolved {
        match disposition {
            Disposition::Preserve | Disposition::Delete | Disposition::Add(_) => {}
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
                    reshaped: &mut reshaped,
                    geometry_cuts: &mut geometry_cuts,
                    body_context: &mut body_context,
                    dropped_representations: &mut dropped_representations,
                };
                apply_patch(index, schema, id, patch, &mut ids, owner_history_ref, &mut out);
            }
        }
    }

    if let Some(context) = body_context.synthesized {
        attach_context_to_project(index, schema, context, &removed, &mut list_edits);
    }

    // What the old shapes leave behind. The annotations the sweep finds (a
    // styled item, a layer entry) go through delete below, which repairs
    // whatever names them.
    if !geometry_cuts.is_empty() {
        let sweep = geometry::sweep(index, schema, &geometry_cuts, &removed);
        removed.extend(sweep.pruned);
        requested_deletes.extend(sweep.delete);
        detach_requests.extend(sweep.detach);
    }

    // The one place the top-level deletes' cascade and every patch's
    // copy-on-write detach are resolved together: a relationship either
    // side strips from composes into a single rewrite, and a relationship
    // both sides empty between them still cascades.
    let gated = (requested_deletes.len(), protected.len());
    protect_what_appended_names(index, &list_edits, &removed, &mut appended, &mut protected);
    // Both sets only grow, so unchanged sizes and no detach mean the gating
    // pass already is this answer.
    let delete_result = if detach_requests.is_empty() && gated == (requested_deletes.len(), protected.len()) {
        gating
    } else {
        let result = delete::resolve_deletes(index, schema, &requested_deletes, &detach_requests, &protected);
        // This pass decides what the deletes take: a gating removal it no
        // longer makes (a member a copy-on-write clone reuses) comes back.
        removed.retain(|id| !gating.removed.contains(id) || result.removed.contains(id));
        result
    };
    removed.extend(delete_result.removed);
    refusals.extend(lost_writes(edited, &removed));
    refusals.extend(overridden_preserves(&resolved, &removed));
    for (slot, strip) in delete_result.stripped {
        list_edits.entry(slot).or_default().remove.extend(strip);
    }

    attrs::render_list_edits(index, list_edits, &removed, &mut edits_by_id);

    // Adds run after every delete and patch has settled `removed` and the
    // list edits, so none of them extends a relationship or names a record
    // that is going away, and their list appends start from the rewritten
    // lists.
    let added = if adds.is_empty() {
        0
    } else {
        // An owner history the plan deletes is not one an Add can name.
        let owner_history = owner_history_ref.filter(|id| !removed.contains(id));
        let state = add::AddState::new(index, schema, &removed, &plan.context, owner_history, body_context.chosen());
        state.build_all(&adds, &mut ids, &mut edits_by_id, &mut appended, &mut refusals)
    };

    Resolution { appended, edits_by_id, removed, refusals, patched, added, patched_objects, dropped_representations }
}

/// The owner history a patch's new records name: the file's first, else one
/// synthesized into `appended`. Synthesized only when a patch actually needs
/// to point a NEW record's OwnerHistory somewhere: a plan that never writes a
/// property/quantity set must not grow the file by five records it has no use
/// for. Adds synthesize their own on first success (see `add::AddState::new`).
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

/// Every disposition but an Add resolved to its id in the file (refused when
/// it is not there), and the Adds apart: an Add names an object that does not
/// exist yet, so it is not resolved against the file; `add` checks its key
/// itself.
#[allow(clippy::type_complexity)]
fn split_dispositions<'p>(
    index: &FileIndex,
    plan: &'p ExportPlan,
    refusals: &mut Vec<Refusal>,
) -> (Vec<(u32, &'p Disposition)>, Vec<(&'p ObjectRef, &'p NewObject)>) {
    let mut resolved = Vec::new();
    let mut adds = Vec::new();
    for (obj, disposition) in &plan.dispositions {
        if let Disposition::Add(new) = disposition {
            adds.push((obj, &**new));
            continue;
        }
        match index.resolve(obj) {
            Some(id) => resolved.push((id, disposition)),
            None => refusals.push(Refusal { object: obj.clone(), reason: "object not found in source".into() }),
        }
    }
    (resolved, adds)
}

/// What the delete cascade must keep even when its last referrer goes. A
/// patched object (not also deleted: delete wins) survives by construction,
/// since a copy-on-write patch can give it a relationship the source never
/// had, which the reference count cannot see. So does what an Add names (its
/// container, placement parent, type, host, and the owner history): deleting
/// a type's last occurrence must not take the type an Add in the same plan is
/// typed by.
fn protected_ids(
    index: &FileIndex,
    resolved: &[(u32, &Disposition)],
    adds: &[(&ObjectRef, &NewObject)],
    requested_deletes: &HashSet<u32>,
) -> HashSet<u32> {
    let patched = resolved.iter().filter(|&&(_, d)| matches!(d, Disposition::Patch(_))).map(|&(id, _)| id);
    let named = adds.iter().flat_map(|(_, new)| new.references()).filter_map(|r| index.resolve(r));
    // The Adds name the file's owner history too.
    let history = index.first_owner_history.filter(|_| !adds.is_empty());
    patched.chain(named).chain(history).filter(|id| !requested_deletes.contains(id)).collect()
}

/// Append a synthesized representation context to the project's
/// `RepresentationContexts`, through the same list accumulator a delete
/// stripping a context from that list uses.
fn attach_context_to_project(
    index: &FileIndex,
    schema: &str,
    context: u32,
    removed: &HashSet<u32>,
    list_edits: &mut HashMap<(u32, usize), attrs::ListEdit>,
) {
    let Some(project) = index.projects.iter().copied().find(|id| !removed.contains(id)) else { return };
    let Some(idx) = attrs::attribute_index(schema, "IFCPROJECT", "RepresentationContexts") else { return };
    list_edits.entry((project, idx)).or_default().append.push(context);
}

/// Drop the members a write adds to a set the deletes take (nothing would
/// name them), then keep alive every source record an appended one still
/// names: a member a copy-on-write clone reuses, the owner history. An
/// appended record's own id is above `max_id`, so only what it names in the
/// source is kept.
fn protect_what_appended_names(
    index: &FileIndex,
    list_edits: &HashMap<(u32, usize), attrs::ListEdit>,
    removed: &HashSet<u32>,
    appended: &mut Vec<(u32, String)>,
    protected: &mut HashSet<u32>,
) {
    let orphans: HashSet<u32> = list_edits
        .iter()
        .filter(|((set, _), _)| removed.contains(set))
        .flat_map(|(_, edit)| edit.append.iter().chain(edit.substitute.values()).copied())
        .collect();
    appended.retain(|(id, _)| !orphans.contains(id));
    let mut named = Vec::new();
    for (_, text) in appended.iter() {
        crate::step_text::refs_in_line(text.as_bytes(), &mut named);
    }
    protected.extend(named.into_iter().filter(|&id| id <= index.max_id));
}

/// A refusal for each surviving object's write into a record the plan
/// deletes: the write would vanish.
fn lost_writes(edited: HashSet<(u32, u32)>, removed: &HashSet<u32>) -> Vec<Refusal> {
    let mut lost: Vec<(u32, u32)> = edited.into_iter().filter(|(record, object)| removed.contains(record) && !removed.contains(object)).collect();
    lost.sort_unstable();
    lost.into_iter()
        .map(|(record, object)| Refusal { object: ObjectRef::Id(object), reason: format!("a write to #{record} is lost: this plan deletes that record") })
        .collect()
}

/// A refusal for each Preserve the plan's removals override: reported, not
/// dropped.
fn overridden_preserves(resolved: &[(u32, &Disposition)], removed: &HashSet<u32>) -> Vec<Refusal> {
    let mut overridden: Vec<u32> =
        resolved.iter().filter(|&&(id, d)| matches!(d, Disposition::Preserve) && removed.contains(&id)).map(|&(id, _)| id).collect();
    overridden.sort_unstable();
    overridden.dedup();
    overridden
        .into_iter()
        .map(|id| Refusal { object: ObjectRef::Id(id), reason: "object is removed by this plan; it cannot be preserved".into() })
        .collect()
}
