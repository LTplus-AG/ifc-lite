// SPDX-License-Identifier: MPL-2.0
//! Lowering a plan into edits, appended records and removals, without writing
//! anything. Runs against whatever referrers [`super::referrers`] has
//! collected so far; [`super::execute`] re-runs it until it completes without
//! a miss.

use std::collections::{BTreeMap, HashMap, HashSet};

use crate::step_ids::IdAllocator;
use super::index::FileIndex;
use super::add_types::AddItem;
use super::patch::{apply_patch, PatchOutput};
use super::removal::RemovalReason;
use super::types::{Disposition, DroppedRepresentation, ExportPlan, ObjectRef, Refusal, ValidationFinding};
use super::add::AddState;
use super::attribution::{attribute_changes, Histories, Ledger, Rewrites};
use super::identity::Identity;
use super::{attrs, delete, geometry};

pub(crate) struct Resolution {
    pub(crate) appended: Vec<(u32, String)>,
    pub(crate) edits_by_id: HashMap<u32, BTreeMap<usize, String>>,
    pub(crate) removed: HashSet<u32>,
    /// Why the delete cascade removed each id it did, the sweep's deletes
    /// as replaced; an id of `removed` it lacks is one a patch replaced.
    pub(crate) reasons: HashMap<u32, RemovalReason>,
    pub(crate) refusals: Vec<Refusal>,
    pub(crate) patched: usize,
    pub(crate) added: usize,
    /// Every object a patch was applied to: the scope of the duplicate
    /// property-set check, which is the defect a patch can introduce.
    pub(crate) patched_objects: Vec<u32>,
    pub(crate) dropped_representations: Vec<DroppedRepresentation>,
    /// The exporting application the plan was attributed to, if usable.
    pub(crate) identity: Option<Identity>,
    /// What the Adds report beyond refusals (see `AddState::notes`).
    pub(crate) findings: Vec<ValidationFinding>,
}

pub(crate) fn resolve(index: &FileIndex, schema: &str, plan: &ExportPlan) -> Resolution {
    let mut ids = IdAllocator::after(index.max_id);
    let mut appended: Vec<(u32, String)> = Vec::new();
    let mut findings = Vec::new();
    let mut ledger = Ledger::for_plan(plan, &mut findings);
    let mut history = Histories::new(index, schema, ledger.as_mut(), &plan.context);
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

    let (mut protected, feature_keepers) = protected_ids(index, &resolved, &adds, &requested_deletes);

    // The requested deletes' cascade before any patch runs (so no
    // copy-on-write detach is known yet). It gates the "object is also
    // deleted by this plan" refusal, and is the final answer as well when
    // the patches leave its inputs as they are (see the combined pass below).
    let gating = delete::resolve_deletes(index, schema, &requested_deletes, &[], &protected, &feature_keepers);
    // What the requested deletes alone take, to tell what the patches removed.
    let any_patch = resolved.iter().any(|&(_, d)| matches!(d, Disposition::Patch(_)));
    let gating_removed = any_patch.then(|| gating.removed.clone());
    let (gated_requested, gated_protected) = (requested_deletes.clone(), protected.clone());
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
            Disposition::Preserve | Disposition::Delete | Disposition::Add(_) | Disposition::AddType(_) => {}
            Disposition::Patch(patch) => {
                if removed.contains(&id) {
                    let reason = deleted_patch_reason(id, &gating.unhosted, &requested_deletes);
                    refusals.push(Refusal { object: ObjectRef::Id(id), reason: reason.into() });
                    continue;
                }
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
                    history: &mut history,
                    reshaped: &mut reshaped,
                    geometry_cuts: &mut geometry_cuts,
                    body_context: &mut body_context,
                    dropped_representations: &mut dropped_representations,
                };
                // Only a patch that wrote something patched its object.
                if apply_patch(index, schema, id, patch, &mut ids, &mut out) {
                    patched += 1;
                    patched_objects.push(id);
                }
            }
        }
    }

    if let Some(context) = body_context.synthesized {
        attach_context_to_project(index, schema, context, &removed, &mut list_edits);
    }

    let swept = sweep_old_shapes(index, schema, &geometry_cuts, &mut removed, &mut requested_deletes, &mut detach_requests);

    // The one place the top-level deletes' cascade and every patch's
    // copy-on-write detach are resolved together: a relationship either
    // side strips from composes into a single rewrite, and a relationship
    // both sides empty between them still cascades.
    //
    // The cascade reads only its inputs and the referrers collected before
    // this resolution started, so the gating pass is reused exactly when
    // the inputs are the same.
    // Kept from pruning, not as feature keepers: only an Add keeps a hostless feature.
    protected.extend(appended_names(index, &list_edits, &removed, &mut appended));
    let delete_result = if detach_requests.is_empty() && requested_deletes == gated_requested && protected == gated_protected {
        gating
    } else {
        let result = delete::resolve_deletes(index, schema, &requested_deletes, &detach_requests, &protected, &feature_keepers);
        // A gating removal the combined pass no longer makes (a member a
        // copy-on-write clone reuses) comes back out of `removed`.
        removed.retain(|id| !gating.removed.contains(id) || result.removed.contains(id));
        result
    };
    removed.extend(delete_result.removed);
    let reasons = replaced_by_patches(delete_result.reasons, &removed, gating_removed.as_ref(), (swept, &gated_requested));
    refusals.extend(lost_writes(edited, &removed));
    refusals.extend(overridden_preserves(&resolved, &removed, &delete_result.unhosted, &gated_requested));
    for (slot, strip) in delete_result.stripped {
        list_edits.entry(slot).or_default().remove.extend(strip);
    }

    attrs::render_list_edits(index, list_edits, &removed, &mut edits_by_id);

    // Adds run after every delete and patch has settled `removed` and the
    // list edits, so none of them extends a relationship or names a record
    // that is going away, and their list appends start from the rewritten
    // lists.
    findings.extend(super::orphans::unplaced_by_removed_structure(index, schema, &removed, &reasons));
    // The Adds name the history the patches settled on, or take one.
    let adding = AddState::new(index, schema, &removed, &mut history, body_context.chosen());
    let added = adding.build_all(&adds, &mut ids, &mut edits_by_id, &mut appended, &mut refusals, &mut findings);

    // Every rewrite has settled: what the plan modified is read off them.
    let out = Rewrites { ids: &mut ids, appended: &mut appended, edits_by_id: &mut edits_by_id, findings: &mut findings };
    attribute_changes(index, schema, plan, ledger.as_mut(), (&patched_objects, &removed), patched + added > 0, out);

    let identity = ledger.map(|ledger| ledger.identity);
    Resolution { appended, edits_by_id, removed, reasons, refusals, patched, added, patched_objects, dropped_representations, identity, findings }
}

/// The cascade's reasons with what the patches removed themselves marked
/// replaced: everything in `removed` the requested deletes' own cascade
/// (`gating_removed`, `None` when the plan has no patch) did not take (an old
/// placement chain or body, a relationship a copy-on-write left), and the
/// sweep's annotations,
/// which went through the cascade as deletes the plan did not request
/// (`requested` is the plan's own, before the sweep added them).
fn replaced_by_patches(
    mut reasons: HashMap<u32, RemovalReason>,
    removed: &HashSet<u32>,
    gating_removed: Option<&HashSet<u32>>,
    (swept, requested): (HashSet<u32>, &HashSet<u32>),
) -> HashMap<u32, RemovalReason> {
    if let Some(gated) = gating_removed {
        for id in removed.iter().copied().filter(|id| !gated.contains(id)) {
            let reason = reasons.entry(id).or_insert(RemovalReason::Replaced);
            *reason = reason.first(RemovalReason::Replaced);
        }
    }
    for id in swept.into_iter().filter(|id| !requested.contains(id)) {
        reasons.insert(id, RemovalReason::Replaced);
    }
    reasons
}

/// What the old shapes of the geometry patches leave behind: what only they
/// used is pruned, and the annotations they had (a styled item, a layer
/// entry) go through delete, which repairs whatever names them. Returns
/// those annotations, so their removal is reported as replaced.
fn sweep_old_shapes(
    index: &FileIndex,
    schema: &str,
    geometry_cuts: &[(u32, u32)],
    removed: &mut HashSet<u32>,
    requested_deletes: &mut HashSet<u32>,
    detach_requests: &mut Vec<(u32, usize, u32)>,
) -> HashSet<u32> {
    if geometry_cuts.is_empty() {
        return HashSet::new();
    }
    let sweep = geometry::sweep(index, schema, geometry_cuts, removed);
    removed.extend(sweep.pruned);
    detach_requests.extend(sweep.detach);
    let swept: HashSet<u32> = sweep.delete.into_iter().collect();
    requested_deletes.extend(swept.iter().copied());
    swept
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
) -> (Vec<(u32, &'p Disposition)>, Vec<(&'p ObjectRef, AddItem<'p>)>) {
    let mut resolved = Vec::new();
    let mut adds = Vec::new();
    for (obj, disposition) in &plan.dispositions {
        let item = match disposition {
            Disposition::Add(new) => Some(AddItem::Object(new)),
            Disposition::AddType(t) => Some(AddItem::Type(t)),
            _ => None,
        };
        if let Some(item) = item {
            adds.push((obj, item));
            continue;
        }
        match index.resolve(obj) {
            Some(id) => resolved.push((id, disposition)),
            None => refusals.push(Refusal { object: obj.clone(), reason: "object not found in source".into() }),
        }
    }
    (resolved, adds)
}

/// What the delete cascade must keep even when its last referrer goes, and,
/// second, the subset that also keeps an opening or projection whose host
/// goes. A patched object (not also deleted: delete wins) survives pruning by
/// construction, since a copy-on-write patch can give it a relationship the
/// source never had, which the reference count cannot see. So does what an
/// Add names (its container, placement parent, type, host, and the owner
/// history): deleting a type's last occurrence must not take the type an Add
/// in the same plan is typed by. Only what an Add names keeps a hostless
/// feature: a patch cannot make an opening without a host valid IFC, so it
/// is refused instead.
fn protected_ids(
    index: &FileIndex,
    resolved: &[(u32, &Disposition)],
    adds: &[(&ObjectRef, AddItem)],
    requested_deletes: &HashSet<u32>,
) -> (HashSet<u32>, HashSet<u32>) {
    let patched = resolved.iter().filter(|&&(_, d)| matches!(d, Disposition::Patch(_))).map(|&(id, _)| id);
    let named: HashSet<u32> =
        adds.iter().flat_map(|&(_, item)| item.references()).filter_map(|r| index.resolve(r)).filter(|id| !requested_deletes.contains(id)).collect();
    // The Adds name the file's owner history too.
    let history = index.first_owner_history.filter(|_| !adds.is_empty());
    let mut protected: HashSet<u32> = patched.chain(history).filter(|id| !requested_deletes.contains(id)).collect();
    protected.extend(&named);
    (protected, named)
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
/// name them), then return every source record an appended one still
/// names, which the caller keeps from pruning: a member a copy-on-write clone reuses, the owner history. An
/// appended record's own id is above `max_id`, so only what it names in the
/// source is kept.
fn appended_names(
    index: &FileIndex,
    list_edits: &HashMap<(u32, usize), attrs::ListEdit>,
    removed: &HashSet<u32>,
    appended: &mut Vec<(u32, String)>,
) -> Vec<u32> {
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
    named.retain(|&id| id <= index.max_id);
    named
}

/// Why a patch on `id`, which the plan's deletes take, is refused: an
/// opening or projection the plan did not delete itself goes because it
/// lost its host relationship.
fn deleted_patch_reason(id: u32, unhosted: &HashSet<u32>, requested: &HashSet<u32>) -> &'static str {
    if unhosted.contains(&id) && !requested.contains(&id) {
        "opening or projection has no host relationship left after this plan's deletes: IFC ties it to exactly one element, so it goes; delete wins"
    } else {
        "object is also deleted by this plan; delete wins"
    }
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
/// dropped. An opening or projection in `unhosted` that the plan did not
/// itself delete (`requested`) says why it went.
fn overridden_preserves(resolved: &[(u32, &Disposition)], removed: &HashSet<u32>, unhosted: &HashSet<u32>, requested: &HashSet<u32>) -> Vec<Refusal> {
    let mut overridden: Vec<u32> =
        resolved.iter().filter(|&&(id, d)| matches!(d, Disposition::Preserve) && removed.contains(&id)).map(|&(id, _)| id).collect();
    overridden.sort_unstable();
    overridden.dedup();
    overridden
        .into_iter()
        .map(|id| {
            let reason = if unhosted.contains(&id) && !requested.contains(&id) {
                "opening or projection has no host relationship left after this plan's deletes: IFC ties it to exactly one element; it cannot be preserved"
            } else {
                "object is removed by this plan; it cannot be preserved"
            };
            Refusal { object: ObjectRef::Id(id), reason: reason.into() }
        })
        .collect()
}
