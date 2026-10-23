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
//! (the `SET [1:?]` member lists of the `IFCREL*` entities, such as
//! `RelatedObjects` or `RelatedCoverings`, and a presentation layer's
//! `AssignedItems`), not by entity type. It is the one place this module is
//! a curated fact rather than a derived one, and it is deliberately narrow:
//! wrong here means a relationship survives with fewer members, never that a
//! record silently disappears.
//!
//! What a delete may prune is the records only deleted objects used, never
//! an object or type the plan did not delete (see [`prunable`]). Every list
//! strip is O(1) (see [`ListStrip`]), so deleting tens of thousands of
//! members of one containment or typing relationship costs linear time.

use std::collections::{HashMap, HashSet, VecDeque};

use rustc_hash::{FxHashMap, FxHashSet};

use super::index::FileIndex;

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

/// True for an `IFCREL*` attribute IFC declares as a `SET [1:?]` member
/// list (`RelatedObjects`, `RelatedElements`, `RelatedCoverings`, ...), so
/// emptying it by removing a member takes the relationship itself out rather
/// than leaving a rel with nothing related. A name a schema does not declare
/// (`RelatedSurfaceFeatures` before IFC4X3) never matches there.
/// A presentation layer's `AssignedItems` is `SET [1:?]` the same way: a
/// layer with nothing on it goes.
fn is_mandatory_members_attr(file_schema: &str, entity_type: &str, index: usize) -> bool {
    let Some(names) = ifc_lite_core::attribute_names_for_schema(file_schema, entity_type) else {
        return false;
    };
    let name = names.get(index).copied();
    if entity_type.starts_with("IFCREL") {
        return matches!(
            name,
            Some(
                "RelatedObjects"
                    | "RelatedElements"
                    | "RelatedResourceObjects"
                    | "RelatedCoverings"
                    | "RelatedDefinitions"
                    | "RealizingElements"
                    | "RelatedControlElements"
                    | "RelatedBuildings"
                    | "RelatedPropertySets"
                    | "RelatedProducts"
                    | "RelatedSurfaceFeatures"
            )
        );
    }
    name.is_some_and(|name| is_layer_items(entity_type, name))
}

/// A presentation layer's `AssignedItems`: the one non-relationship member
/// list both delete and the geometry sweep treat by rule.
pub(crate) fn is_layer_items(entity_type: &str, attr_name: &str) -> bool {
    matches!(entity_type, "IFCPRESENTATIONLAYERASSIGNMENT" | "IFCPRESENTATIONLAYERWITHSTYLE") && attr_name == "AssignedItems"
}

/// Whether the cascade may prune `entity_type` once nothing refers to it.
///
/// Objects and types (`IfcObjectDefinition`, the project included) are never
/// pruned: which of them exist is the plan's decision, and losing a referrer
/// is not one. A port whose host is deleted stays as a free product; a type
/// whose last occurrence is deleted stays declared. The project is named too,
/// for a schema the registry does not know. This is only the unreferenced
/// rule: an object that names a removed record through a single-valued
/// attribute still goes (step 1 of [`resolve_deletes`]), and openings and
/// projections go with their host ([`hosted_feature`]).
fn prunable(file_schema: &str, entity_type: &str) -> bool {
    entity_type != "IFCPROJECT" && !ifc_lite_core::is_subtype_of_for_schema(file_schema, entity_type, "IFCOBJECTDEFINITION")
}

/// The opening or projection a removed `IfcRelVoidsElement` /
/// `IfcRelProjectsElement` attached, once no relationship of that kind
/// naming it survives. IFC requires each to belong to exactly one element
/// (the mandatory `VoidsElements` / `ProjectsElements` inverse), so it goes
/// with its host, or with the relationship itself, whatever else still names
/// it. A second host that survives (a file breaking the one-host rule) keeps
/// it. Every removed relationship asks, so the last one to go decides, in any
/// order. `None` too while the feature's referrers are not collected yet:
/// the relationship itself always names it.
fn hosted_feature(index: &FileIndex, file_schema: &str, rel: u32, rel_type: &str, removed: &HashSet<u32>) -> Option<u32> {
    let attr = match rel_type {
        "IFCRELVOIDSELEMENT" => "RelatedOpeningElement",
        "IFCRELPROJECTSELEMENT" => "RelatedFeatureElement",
        _ => return None,
    };
    let feature = super::props_lookup::scalar_attr(index, file_schema, rel, rel_type, attr).filter(|&id| index.contains(id))?;
    let rels = super::props_lookup::sharing_referrers(index, file_schema, feature, &[attr]);
    (!rels.is_empty() && rels.iter().all(|r| removed.contains(r))).then_some(feature)
}

/// One list attribute of a surviving record as the cascade strips it.
/// Counting each id's occurrences once keeps a strip O(1), however long the
/// list: deleting every element of a storey strips its containment list once
/// per element.
struct ListStrip {
    occurrences: FxHashMap<u32, usize>,
    /// Reference entries not stripped yet.
    remaining: usize,
    /// Ids the slot also names nested (see [`list_strip`]).
    nested: FxHashSet<u32>,
    /// The ids stripped so far.
    stripped: HashSet<u32>,
    /// Whether emptying it takes the record out ([`is_mandatory_members_attr`]).
    mandatory: bool,
}

/// The cascade's working state. See [`resolve_deletes`].
struct Cascade<'i> {
    index: &'i FileIndex<'i>,
    file_schema: &'i str,
    removed: HashSet<u32>,
    worklist: VecDeque<u32>,
    /// Per (referrer, attr index): the list as stripped so far. `None` when
    /// the slot is not a top-level list.
    lists: FxHashMap<(u32, usize), Option<ListStrip>>,
}

impl Cascade<'_> {
    fn mark_removed(&mut self, id: u32) {
        if self.removed.insert(id) {
            self.worklist.push_back(id);
        }
    }

    /// Strip `member` from `referrer`'s list attribute `idx`, taking the
    /// referrer out when that empties a mandatory member list. `false` when
    /// the slot is not a top-level list holding `member`, or the member also
    /// appears nested and `through_nested` is off; nothing is recorded then.
    /// A patch's detach strips through a nested use (the writer drops the
    /// top-level entry); a delete does not, since the nested reference would
    /// dangle.
    fn strip(&mut self, referrer: u32, idx: usize, member: u32, through_nested: bool) -> bool {
        let (index, file_schema) = (self.index, self.file_schema);
        let list = self.lists.entry((referrer, idx)).or_insert_with(|| list_strip(index, file_schema, referrer, idx));
        let Some(list) = list.as_mut() else { return false };
        let Some(&count) = list.occurrences.get(&member) else { return false };
        if !through_nested && list.nested.contains(&member) {
            return false;
        }
        if list.stripped.insert(member) {
            list.remaining -= count;
        }
        if list.remaining == 0 && list.mandatory {
            self.mark_removed(referrer);
        }
        true
    }

    /// A patch's copy-on-write detach: a strip through a nested use.
    fn detach(&mut self, referrer: u32, idx: usize, member: u32) {
        self.strip(referrer, idx, member, true);
    }
}

/// `referrer`'s attribute `idx` as a [`ListStrip`], or `None` when it is not
/// a top-level list. A reference in a nested list or typed value cannot be
/// stripped, so the ids that also appear there are kept apart.
fn list_strip(index: &FileIndex, file_schema: &str, referrer: u32, idx: usize) -> Option<ListStrip> {
    let mut slots = index.attrs(referrer).unwrap_or_default();
    let slot = (idx < slots.len()).then(|| slots.swap_remove(idx))?;
    let entries = slot.list?;
    let mut occurrences: FxHashMap<u32, usize> = FxHashMap::default();
    for &id in entries.iter().flatten() {
        *occurrences.entry(id).or_default() += 1;
    }
    let remaining = occurrences.values().sum();
    let nested = slot.nested.into_iter().collect();
    let mandatory = is_mandatory_members_attr(file_schema, &index.type_of(referrer).unwrap_or_default(), idx);
    Some(ListStrip { occurrences, remaining, nested, stripped: HashSet::new(), mandatory })
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
    let mut cascade = Cascade {
        index,
        file_schema,
        removed: requested.clone(),
        worklist: requested.iter().copied().collect(),
        lists: FxHashMap::default(),
    };
    // Distinct referrers each target still has, seeded from the file's
    // count the first time a deletion reaches it; deletions only ever
    // shrink it.
    let mut live: HashMap<u32, usize> = HashMap::new();
    // Records removed because their last referrer went. Every referrer of
    // such a record is already removed, so repairing them is a no-op, and
    // skipping it is what keeps their referrer lists from ever being asked
    // for.
    let mut orphaned: HashSet<u32> = HashSet::new();
    // [`prunable`] walks the schema's supertype chain; asked once per type.
    let mut prunable_by_type: HashMap<String, bool> = HashMap::new();

    // Seed the explicit detaches before any whole-object deletion is
    // processed, so every strip the worklist loop below performs already
    // sees them and can tell a truly-empty mandatory list from one that
    // only looks empty from one source's point of view.
    for &(referrer, idx, member) in extra_detach {
        if !cascade.removed.contains(&referrer) {
            cascade.detach(referrer, idx, member);
        }
    }

    while let Some(dead) = cascade.worklist.pop_front() {
        // 1. Repair every record that named `dead`. A bare scalar slot
        //    pointing at `dead` is dangling however it is fixed, so the
        //    record carrying it goes too rather than shipping an unresolved
        //    `#ref`.
        if !orphaned.contains(&dead) {
            for &(referrer, idx) in index.referrers(dead) {
                if !cascade.removed.contains(&referrer) && !cascade.strip(referrer, idx, dead, false) {
                    cascade.mark_removed(referrer);
                }
            }
        }

        let dead_type = index.type_of(dead).unwrap_or_default();
        if let Some(feature) = hosted_feature(index, file_schema, dead, &dead_type, &cascade.removed).filter(|id| !protected.contains(id)) {
            cascade.mark_removed(feature);
        }

        // 2. `dead` no longer refers to anything; a target whose last
        //    referrer that was is now unreferenced, and gets pruned unless
        //    it is an object or type (see [`prunable`]), or an object a
        //    patch elsewhere in this plan is keeping alive through a
        //    relationship the source file never had (so it never counted
        //    toward the source's own referrer total). A target whose count
        //    has not been collected yet is left alone this round.
        //
        //    A relationship's members are never pruned through it: a
        //    relationship going away does not make the objects it related
        //    disposable. Deleting a property set removes the relationship
        //    that attached it, and the walls it was attached to stay.
        for target in released_by(index, file_schema, dead, &dead_type) {
            if cascade.removed.contains(&target) {
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
            if *left == 0
                && !protected.contains(&target)
                && *prunable_by_type.entry(index.type_of(target).unwrap_or_default()).or_insert_with_key(|t| prunable(file_schema, t))
            {
                orphaned.insert(target);
                cascade.mark_removed(target);
            }
        }
    }

    let Cascade { removed, lists, .. } = cascade;
    let stripped = lists
        .into_iter()
        .filter(|((referrer, _), _)| !removed.contains(referrer))
        .filter_map(|(slot, list)| list.map(|list| (slot, list.stripped)).filter(|(_, ids)| !ids.is_empty()))
        .collect();
    DeleteResult { removed, stripped }
}

/// The records losing `id` can orphan: every record it names that the file
/// declares, except the members of its mandatory member lists when it is a
/// relationship. Its attributes are parsed once.
fn released_by(index: &FileIndex, file_schema: &str, id: u32, entity_type: &str) -> FxHashSet<u32> {
    let is_rel = entity_type.starts_with("IFCREL");
    let mut members: FxHashSet<u32> = FxHashSet::default();
    let mut targets: FxHashSet<u32> = FxHashSet::default();
    for (idx, slot) in index.attrs(id).unwrap_or_default().iter().enumerate() {
        if is_rel && slot.list.is_some() && is_mandatory_members_attr(file_schema, entity_type, idx) {
            members.extend(slot.list.iter().flatten().flatten());
        }
        targets.extend(slot.refs());
    }
    targets.retain(|t| !members.contains(t) && index.contains(*t));
    targets
}

#[cfg(test)]
#[path = "delete_tests.rs"]
mod tests;
