// SPDX-License-Identifier: MPL-2.0
//! Finding what a property write lands on: the sets an object or its type
//! already carries, the member a write names, and whether either is shared.
//! Read-only; [`super::props`] decides what to do with the answer.

use std::collections::HashSet;

use super::attrs::attribute_index;
use super::index::FileIndex;
use super::types::PsetKind;

/// The `IfcRelDefinesByProperties` relationships naming `object_id` in their
/// `RelatedObjects`, in file order, once per mention.
pub(super) fn occurrence_rels(index: &FileIndex, schema: &str, object_id: u32) -> Vec<u32> {
    related_by(index, schema, object_id, "IFCRELDEFINESBYPROPERTIES", "RelatingPropertyDefinition")
        .into_iter()
        .map(|(rel, _)| rel)
        .collect()
}

/// The property definition `rel` (an `IfcRelDefinesByProperties`) attaches.
pub(super) fn occurrence_set_of(index: &FileIndex, schema: &str, rel: u32) -> Option<u32> {
    scalar_attr(index, schema, rel, "IFCRELDEFINESBYPROPERTIES", "RelatingPropertyDefinition")
}

/// The sets a type lists in `HasPropertySets`.
pub(super) fn type_sets(index: &FileIndex, schema: &str, type_id: u32) -> Vec<u32> {
    let entity = index.type_of(type_id).unwrap_or_default();
    list_attr(index, schema, type_id, &entity, "HasPropertySets").unwrap_or_default()
}

/// The last `IfcRelDefinesByType` in file order relating `object_id`, with
/// its `RelatingType`.
pub(super) fn type_rel(index: &FileIndex, schema: &str, object_id: u32) -> Option<(u32, u32)> {
    related_by(index, schema, object_id, "IFCRELDEFINESBYTYPE", "RelatingType").pop()
}

/// `(relationship, target)` for every relationship of type `rel_type` whose
/// `RelatedObjects` list names `object_id`, where `target` is the scalar the
/// relationship's `relating` attribute holds; relationships without one are
/// skipped. Read from `object_id`'s referrers, so only the relationships
/// actually attached to it are ever parsed.
pub(super) fn related_by(index: &FileIndex, schema: &str, object_id: u32, rel_type: &str, relating: &str) -> Vec<(u32, u32)> {
    let (Some(related_idx), Some(relating_idx)) =
        (attribute_index(schema, rel_type, "RelatedObjects"), attribute_index(schema, rel_type, relating))
    else {
        return Vec::new();
    };
    index
        .referrers(object_id)
        .iter()
        .filter(|&&(rel, idx)| idx == related_idx && index.type_of(rel).as_deref() == Some(rel_type))
        .filter_map(|&(rel, _)| {
            let attrs = index.attrs(rel)?;
            attrs.get(related_idx)?.list.as_ref()?;
            Some((rel, attrs.get(relating_idx)?.scalar?))
        })
        .collect()
}

pub(super) fn list_attr(index: &FileIndex, schema: &str, id: u32, entity_type: &str, name: &str) -> Option<Vec<u32>> {
    let idx = attribute_index(schema, entity_type, name)?;
    let refs = index.attrs(id)?.into_iter().nth(idx)?.list?;
    Some(refs.into_iter().flatten().collect())
}

pub(super) fn scalar_attr(index: &FileIndex, schema: &str, id: u32, entity_type: &str, name: &str) -> Option<u32> {
    let idx = attribute_index(schema, entity_type, name)?;
    index.attrs(id)?.get(idx)?.scalar
}

/// Which container/member entity names a write's `kind` uses, and the member
/// attribute name on the container.
pub(super) fn container_names(kind: PsetKind) -> (&'static str, &'static str) {
    match kind {
        PsetKind::Property => ("IFCPROPERTYSET", "HasProperties"),
        PsetKind::Quantity => ("IFCELEMENTQUANTITY", "Quantities"),
    }
}

/// Distinct referrers of `target` whose (referrer type, attribute) resolves
/// to one of `attr_names` — the fan-out that decides sharing.
pub(super) fn sharing_referrers(index: &FileIndex, schema: &str, target: u32, attr_names: &[&str]) -> HashSet<u32> {
    index
        .referrers(target)
        .iter()
        .filter(|&&(r, idx)| {
            let rtype = index.type_of(r).unwrap_or_default();
            ifc_lite_core::attribute_names_for_schema(schema, &rtype)
                .and_then(|names| names.get(idx))
                .is_some_and(|n| attr_names.contains(n))
        })
        .map(|&(r, _)| r)
        .collect()
}

/// The records that own `pset`: types listing it in `HasPropertySets` and
/// relationships naming it as `RelatingPropertyDefinition`. More than one
/// means an edit in place would reach another owner's objects.
pub(super) fn pset_owners(index: &FileIndex, schema: &str, pset: u32) -> HashSet<u32> {
    sharing_referrers(index, schema, pset, &["HasPropertySets", "RelatingPropertyDefinition"])
}

/// Whether every owner of `pset` is `target` itself or a relationship that
/// relates it to `target` alone, so an edit in place reaches nothing else.
pub(super) fn pset_reaches_only(index: &FileIndex, schema: &str, pset: u32, target: u32) -> bool {
    const REL: &str = "IFCRELDEFINESBYPROPERTIES";
    pset_owners(index, schema, pset).into_iter().all(|owner| {
        owner == target
            || (index.type_of(owner).as_deref() == Some(REL)
                && list_attr(index, schema, owner, REL, "RelatedObjects").as_deref() == Some(&[target][..]))
    })
}

/// Whether `leaf` (a value already found inside `owner`'s member list) is
/// ALSO named, at the same member-list attribute, by some OTHER record of
/// `container_type` — the leaf-level counterpart of [`pset_owners`].
/// Sharing there is judged at the containing set: a set with exactly one
/// owner still looks unshared even when one of its own members is a value
/// record an exporter deduplicated into a second, unrelated set. Reads only
/// `leaf`'s own (targeted, on-demand) referrers, never the whole file.
pub(super) fn leaf_is_shared(index: &FileIndex, container_type: &str, member_idx: usize, leaf: u32, owner: u32) -> bool {
    index.referrers(leaf).iter().any(|&(r, idx)| r != owner && idx == member_idx && index.type_of(r).as_deref() == Some(container_type))
}

/// The set in `pset_ids` that a write lands on: `(set, member-list attribute
/// index, its members)`. With an exact `target`, the set that lists it,
/// preferring one named `pset_name` over an earlier one with another name
/// (two sets may list a shared value record). Without one, the first set
/// named `pset_name`.
pub(super) fn find_set<'a>(
    index: &FileIndex,
    schema: &str,
    pset_ids: impl Iterator<Item = &'a u32>,
    kind: PsetKind,
    pset_name: &str,
    target: Option<u32>,
) -> Option<(u32, usize, Vec<Option<u32>>)> {
    let (container_type, _) = container_names(kind);
    let named = |pset_id: u32| decoded_name(index, schema, pset_id, container_type).as_deref() == Some(pset_name);
    let listing = |pset_id: u32| -> Option<(usize, Vec<Option<u32>>)> {
        let (idx, members) = set_members(index, schema, pset_id, kind)?;
        target.is_none_or(|t| members.contains(&Some(t))).then_some((idx, members))
    };
    let mut fallback = None;
    for pset_id in pset_ids.copied() {
        // Without a target the name is the whole question: check it first.
        if target.is_none() && !named(pset_id) {
            continue;
        }
        let Some((idx, members)) = listing(pset_id) else { continue };
        if target.is_none() || named(pset_id) {
            return Some((pset_id, idx, members));
        }
        fallback.get_or_insert((pset_id, idx, members));
    }
    fallback
}

/// `(member-list attribute index, members)` of `set`, when it is a set of
/// `kind`'s container type.
pub(super) fn set_members(index: &FileIndex, schema: &str, set: u32, kind: PsetKind) -> Option<(usize, Vec<Option<u32>>)> {
    let (container_type, member_attr) = container_names(kind);
    if index.type_of(set).as_deref() != Some(container_type) {
        return None;
    }
    let idx = attribute_index(schema, container_type, member_attr)?;
    Some((idx, index.attrs(set)?.into_iter().nth(idx)?.list?))
}

/// The member of `members` a write lands on: its exact `target` when it has
/// one and the set lists it, else the first named `prop_name`.
pub(super) fn find_member(index: &FileIndex, schema: &str, members: &[Option<u32>], prop_name: &str, target: Option<u32>) -> Option<u32> {
    if let Some(target) = target {
        return members.contains(&Some(target)).then_some(target);
    }
    members.iter().flatten().copied().find(|&member| {
        let member_type = index.type_of(member).unwrap_or_default();
        decoded_name(index, schema, member, &member_type).as_deref() == Some(prop_name)
    })
}

/// A record's `Name`, decoded: the text a caller names a set or a property
/// by, so `'O''Brien'` in the file matches `O'Brien` in the plan.
pub(super) fn decoded_name(index: &FileIndex, schema: &str, id: u32, entity_type: &str) -> Option<String> {
    index.string_attr(schema, id, entity_type, "Name")
}
