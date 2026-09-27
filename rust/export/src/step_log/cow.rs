// SPDX-License-Identifier: MPL-2.0
//! Copy-on-write for property and quantity sets an edit reaches through a
//! SHARED `IfcRelDefinesByProperties` (`step-pset-copy-on-write.ts`, #5794).
//!
//! The edited element gets its own regenerated set and relation (the
//! generation phase writes both), it leaves the shared relation's
//! `RelatedObjects`, and every other element keeps the original set. A
//! relation and its set are withheld only when no element this export writes
//! is left on them; a type-owned set likewise stays while another type object
//! or surviving relation names it. The regenerated copy references the source
//! member atom of every property the session did not edit, so list,
//! enumerated, bounded, table, reference and complex members keep their class.

use std::collections::{HashMap, HashSet};

use super::collect::is_type_class;
use super::pass::Pass;
use super::readers;
use super::refilter::detach_related_objects;

/// Property name -> source member atom id, per regenerated set name.
pub(crate) type SourceMembers = HashMap<String, HashMap<String, u32>>;

/// The shared sets one collection pass has taken an edited owner off.
#[derive(Default)]
pub(crate) struct SharedSetDetachments {
    /// `(rel, set, detached elements)`, in first-detach order.
    by_rel: Vec<(u32, u32, HashSet<u32>)>,
    /// Type-owned set -> the type objects whose own copy replaces it.
    type_owned: Vec<(u32, HashSet<u32>)>,
}

impl SharedSetDetachments {
    /// `detach`: `entity` gets its own copy of the set `rel` relates it to.
    pub(crate) fn detach(&mut self, rel: u32, set: u32, entity: u32) {
        match self.by_rel.iter_mut().find(|(r, _, _)| *r == rel) {
            Some(entry) => {
                entry.2.insert(entity);
            }
            None => self.by_rel.push((rel, set, HashSet::from([entity]))),
        }
    }

    /// `withholdTypeOwned`: type object `ty` drops `set` from `HasPropertySets`.
    pub(crate) fn withhold_type_owned(&mut self, set: u32, ty: u32) {
        match self.type_owned.iter_mut().find(|(s, _)| *s == set) {
            Some(entry) => {
                entry.1.insert(ty);
            }
            None => self.type_owned.push((set, HashSet::from([ty]))),
        }
    }

    /// `settle`, on the export's own omission predicate (`isOmittedFromPassOutput`).
    pub(crate) fn settle(
        self,
        pass: &mut Pass<'_, '_>,
        related_by_rel: &HashMap<u32, Vec<u32>>,
        rels_by_entity: &HashMap<u32, Vec<(u32, u32)>>,
    ) {
        let mut kept_by_relation: HashSet<u32> = HashSet::new();
        let mut touched_rels: HashSet<u32> = HashSet::new();
        for (rel, set, detached) in self.by_rel {
            touched_rels.insert(rel);
            let related = related_by_rel.get(&rel).map(Vec::as_slice).unwrap_or(&[]);
            if related.iter().any(|id| !detached.contains(id) && !pass.is_omitted(*id)) {
                pass.detached.insert(rel, detached);
                kept_by_relation.insert(set);
                continue;
            }
            pass.skip.insert(rel);
            withhold(pass, set);
        }
        if self.type_owned.is_empty() {
            return;
        }
        let owners_of = |set: u32| self.type_owned.iter().find(|(s, _)| *s == set).map(|(_, o)| o);
        let mut still_named = kept_by_relation;
        for (&entity, rels) in rels_by_entity {
            if pass.is_omitted(entity) {
                continue;
            }
            for &(rel, set) in rels {
                if touched_rels.contains(&rel) || owners_of(set).is_none() {
                    continue;
                }
                if !pass.skip.contains(&rel) {
                    still_named.insert(set);
                }
            }
        }
        let live: Vec<u32> = pass
            .src
            .order
            .iter()
            .copied()
            .chain(pass.overlay.new_entities.iter().map(|e| e.express_id))
            .collect();
        for ty in live {
            if pass.is_omitted(ty) || !pass.type_of(ty).is_some_and(|t| is_type_class(&t)) {
                continue;
            }
            for set in super::collect::type_owned_ids(pass, ty) {
                if owners_of(set).is_some_and(|o| !o.contains(&ty)) {
                    still_named.insert(set);
                }
            }
        }
        for (set, _) in &self.type_owned {
            if !still_named.contains(set) {
                withhold(pass, *set);
            }
        }
    }
}

/// Withhold a source set and its member atoms.
fn withhold(pass: &mut Pass<'_, '_>, set: u32) {
    pass.skip.insert(set);
    if let Some(line) = pass.src.line(set) {
        pass.skip.extend(readers::property_ids_in_set(&line));
    }
}

/// `unmodifiedSourceMembers`: property name -> source member atom, for every
/// member of `set` whose property the session left unedited on `entity`. The
/// first member wins a duplicated name.
pub(crate) fn unmodified_source_members(pass: &Pass<'_, '_>, entity: u32, set_name: &str, set: u32) -> HashMap<String, u32> {
    let mut members = HashMap::new();
    let Some(line) = pass.src.line(set) else { return members };
    for member in readers::property_ids_in_set(&line) {
        let Some((_, attrs)) = pass.src.entity(member) else { continue };
        let Some(name) = attrs.first().and_then(|v| v.as_str()) else { continue };
        if members.contains_key(name) {
            continue;
        }
        if pass.overlay.props.contains_key(&(entity, set_name.to_string(), name.to_string())) {
            continue;
        }
        members.insert(name.to_string(), member);
    }
    members
}

/// `reuseSourceMembers` for one element: keyed by set NAME, so a name two
/// distinct source sets share on the element reuses nothing.
#[derive(Default)]
pub(crate) struct ReuseByName {
    pub(crate) members: SourceMembers,
    seen: HashMap<String, u32>,
}

impl ReuseByName {
    pub(crate) fn offer(&mut self, pass: &Pass<'_, '_>, regenerated: &HashSet<String>, entity: u32, name: &str, set: u32) {
        if !regenerated.contains(name) {
            return;
        }
        match self.seen.get(name) {
            Some(&seen) if seen == set => {}
            Some(_) => {
                self.members.insert(name.to_string(), HashMap::new());
            }
            None => {
                self.seen.insert(name.to_string(), set);
                self.members.insert(name.to_string(), unmodified_source_members(pass, entity, name, set));
            }
        }
    }
}

/// `retainReusedSourceMembers`: keep every atom a regenerated copy references.
pub(crate) fn retain_reused_source_members<'m>(pass: &mut Pass<'_, '_>, all: impl Iterator<Item = &'m SourceMembers>) {
    for members in all {
        for by_name in members.values() {
            for id in by_name.values() {
                pass.skip.remove(id);
            }
        }
    }
}

/// `detachRelatedObjects`: the elements that got their own copy leave a
/// shared relation's `RelatedObjects`. `None` withholds the line.
pub(crate) fn detach(pass: &Pass<'_, '_>, id: u32, line: String) -> Option<String> {
    match pass.detached.get(&id) {
        Some(detached) => detach_related_objects(&line, detached),
        None => Some(line),
    }
}
