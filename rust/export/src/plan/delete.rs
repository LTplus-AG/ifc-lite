// SPDX-License-Identifier: MPL-2.0
//! Delete with reverse-reference repair.
//!
//! Driven by the file's own references, not a hand list of relationship
//! types: any attribute of any record can name a deleted object, and this
//! walks whichever ones actually do. It reads them through
//! [`super::referrers`], so it only learns about the records a deletion
//! actually reaches. The one piece of domain knowledge the references alone
//! cannot supply is cardinality — the file does not say a `SET [1:?]` cannot go empty — so
//! [`is_mandatory_members_attr`] carries that one fact, by attribute NAME
//! (`RelatedObjects` / `RelatedElements` / `RelatedResourceObjects` on an
//! `IFCREL*` entity), not by entity type. It is the one place this module is
//! a curated fact rather than a derived one, and it is deliberately narrow:
//! wrong here means a relationship survives with fewer members, never that a
//! record silently disappears.

use std::collections::{HashMap, HashSet, VecDeque};

use super::index::{AttrRefs, FileIndex};

pub(crate) struct DeleteResult {
    /// Every id dropped from the output: the requested deletions, cascaded
    /// relationships whose mandatory member set went empty, relationships
    /// left holding a now-dangling scalar reference, and records pruned
    /// because the deletion left them with no referrer at all.
    pub(crate) removed: HashSet<u32>,
    /// Entries to strip from the lists of SURVIVING records: (referrer, attr
    /// index) -> the ids removed from that list. Rendered by the caller,
    /// together with whatever else the plan changes in the same list.
    pub(crate) stripped: HashMap<(u32, usize), HashSet<u32>>,
}

/// True for the attribute this file's schema calls `RelatedObjects` /
/// `RelatedElements` / `RelatedResourceObjects` on an `IFCREL*` entity — the
/// member list every IFC relationship declares `SET [1:?]`, so emptying it
/// by removing a member takes the relationship itself out rather than
/// leaving a rel with nothing related.
fn is_mandatory_members_attr(file_schema: &str, entity_type: &str, index: usize) -> bool {
    if !entity_type.starts_with("IFCREL") {
        return false;
    }
    let Some(names) = ifc_lite_core::attribute_names_for_schema(file_schema, entity_type) else {
        return false;
    };
    matches!(
        names.get(index).copied(),
        Some("RelatedObjects" | "RelatedElements" | "RelatedResourceObjects")
    )
}

/// A record every export keeps even if the cascade would otherwise
/// unreference it: the project root has no referrer by construction, not
/// because something was deleted out from under it.
fn is_protected_root(entity_type: &str) -> bool {
    entity_type == "IFCPROJECT"
}

/// `resolve_deletes` also takes member removals that have nothing to do
/// with a whole-object delete: a patch's copy-on-write detaching itself from
/// a relationship it no longer wants. `extra_detach` is `(referrer, attr
/// index, member to strip)`, one entry per such detach.
///
/// Both sources write into the same per-`(referrer, attr index)` accumulator
/// before any text is rendered, so a relationship that a delete's cascade
/// AND a patch's copy-on-write both touch gets one rewrite reflecting both,
/// not two independent rewrites where the second silently discards the
/// first. It is also why the mandatory-empty cascade check re-runs on every
/// strip: whichever of the two sources happens to land last still sees the
/// other's contribution already in the set.
pub(crate) fn resolve_deletes(
    index: &FileIndex,
    file_schema: &str,
    requested: &HashSet<u32>,
    extra_detach: &[(u32, usize, u32)],
    protected: &HashSet<u32>,
) -> DeleteResult {
    let mut removed: HashSet<u32> = requested.clone();
    let mut worklist: VecDeque<u32> = requested.iter().copied().collect();
    // Per (referrer, attr index): ids stripped from that list so far.
    let mut stripped: HashMap<(u32, usize), HashSet<u32>> = HashMap::new();
    // Distinct referrers each target still has, seeded from the file's
    // count the first time a deletion reaches it; deletions only ever
    // shrink it.
    let mut live: HashMap<u32, usize> = HashMap::new();
    // Records removed because their last referrer went. Every referrer of
    // such a record is already removed, so repairing them is a no-op, and
    // skipping it is what keeps their referrer lists from ever being asked
    // for.
    let mut orphaned: HashSet<u32> = HashSet::new();
    let mut attrs: HashMap<u32, Vec<AttrRefs>> = HashMap::new();

    let mark_removed = |id: u32, removed: &mut HashSet<u32>, worklist: &mut VecDeque<u32>| {
        if removed.insert(id) {
            worklist.push_back(id);
        }
    };

    // Seed the explicit detaches before any whole-object deletion is
    // processed, so every strip the worklist loop below performs already
    // sees them and can tell a truly-empty mandatory list from one that
    // only looks empty from one source's point of view.
    for &(referrer, idx, member) in extra_detach {
        if removed.contains(&referrer) {
            continue;
        }
        let slots = attrs.entry(referrer).or_insert_with(|| index.attrs(referrer).unwrap_or_default());
        if let Some(entries) = slots.get(idx).and_then(|a| a.list.as_ref()) {
            let removed_here = stripped.entry((referrer, idx)).or_default();
            removed_here.insert(member);
            let remaining = entries.iter().flatten().filter(|id| !removed_here.contains(id)).count();
            let entity_type = index.type_of(referrer).unwrap_or_default();
            if remaining == 0 && is_mandatory_members_attr(file_schema, &entity_type, idx) {
                mark_removed(referrer, &mut removed, &mut worklist);
            }
        }
    }

    while let Some(dead) = worklist.pop_front() {
        // 1. Repair every record that named `dead`.
        if !orphaned.contains(&dead) {
            for &(referrer, idx) in index.referrers(dead) {
                if removed.contains(&referrer) {
                    continue;
                }
                let slots = attrs.entry(referrer).or_insert_with(|| index.attrs(referrer).unwrap_or_default());
                match slots.get(idx).and_then(|a| a.list.as_ref()) {
                    Some(entries) => {
                        let removed_here = stripped.entry((referrer, idx)).or_default();
                        removed_here.insert(dead);
                        let remaining = entries.iter().flatten().filter(|id| !removed_here.contains(id)).count();
                        let entity_type = index.type_of(referrer).unwrap_or_default();
                        if remaining == 0 && is_mandatory_members_attr(file_schema, &entity_type, idx) {
                            mark_removed(referrer, &mut removed, &mut worklist);
                        }
                    }
                    // A bare scalar slot pointing at `dead` is now dangling
                    // however it is fixed, so the record carrying it goes
                    // too rather than shipping an unresolved `#ref`.
                    None => mark_removed(referrer, &mut removed, &mut worklist),
                }
            }
        }

        // 2. `dead` no longer refers to anything; a target whose last
        //    referrer that was is now unreferenced, and gets pruned unless
        //    it is a protected root, or an object a patch elsewhere in this
        //    plan is keeping alive through a relationship the source file
        //    never had (so it never counted toward the source's own
        //    referrer total). A target whose count has not been collected
        //    yet is left alone this round.
        //
        //    A relationship's members are never pruned through it: a
        //    relationship going away does not make the objects it related
        //    disposable. Deleting a property set removes the relationship
        //    that attached it, and the walls it was attached to stay.
        let members = relationship_members(index, file_schema, dead);
        for target in index.refs_of(dead) {
            if removed.contains(&target) || members.contains(&target) {
                continue;
            }
            let left = match live.get_mut(&target) {
                Some(left) => left,
                None => match index.referrer_count(target) {
                    Some(n) => live.entry(target).or_insert(n),
                    None => continue,
                },
            };
            *left = left.saturating_sub(1);
            if *left == 0 && !is_protected_root(&index.type_of(target).unwrap_or_default()) && !protected.contains(&target) {
                orphaned.insert(target);
                mark_removed(target, &mut removed, &mut worklist);
            }
        }
    }

    stripped.retain(|(referrer, _), _| !removed.contains(referrer));
    DeleteResult { removed, stripped }
}

/// The ids `id` names in its mandatory member lists, when it is a
/// relationship; empty otherwise.
fn relationship_members(index: &FileIndex, file_schema: &str, id: u32) -> HashSet<u32> {
    let entity_type = index.type_of(id).unwrap_or_default();
    if !entity_type.starts_with("IFCREL") {
        return HashSet::new();
    }
    index
        .attrs(id)
        .unwrap_or_default()
        .into_iter()
        .enumerate()
        .filter(|(idx, _)| is_mandatory_members_attr(file_schema, &entity_type, *idx))
        .filter_map(|(_, a)| a.list)
        .flatten()
        .flatten()
        .collect()
}

#[cfg(test)]
#[path = "delete_tests.rs"]
mod tests;
