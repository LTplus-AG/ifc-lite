// SPDX-License-Identifier: MPL-2.0
//! Relationship bookkeeping for [`super::Disposition::Add`]: containment,
//! aggregation, type assignment, and material and classification
//! association, gathered across every Add in a plan and written once at the
//! end, and the declaration of a type added on its own to the project.
//!
//! Deferring the write is what keeps a file from gaining one
//! `IfcRelContainedInSpatialStructure` per added object. Ten walls added to
//! the same storey extend the storey's existing relationship once, or share
//! one new relationship when the storey had none (including a storey added
//! earlier in the same plan). The same holds for a type's
//! `IfcRelDefinesByType`, and for the `IfcRelAssociatesMaterial` or
//! `IfcRelAssociatesClassification` of a material or classification
//! reference.
//!
//! List appends go through the same attribute-edit map delete uses, and
//! start from delete's rewritten list when there is one, so a plan that
//! deletes one wall from a storey and adds another keeps both edits.

use std::collections::{BTreeMap, HashMap, HashSet};

use crate::step_ids::IdAllocator;

use super::add_types::GlobalId;
use super::attrs::{attribute_index, build_record};
use super::index::FileIndex;
use super::props_synth::{ref_list, ref_or_unset};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) enum RelKind {
    Contained,
    Aggregates,
    DefinesByType,
    AssociatesMaterial,
    AssociatesClassification,
    Declares,
}

impl RelKind {
    /// (entity, relating attribute, related list attribute)
    fn names(self) -> (&'static str, &'static str, &'static str) {
        match self {
            RelKind::Contained => ("IFCRELCONTAINEDINSPATIALSTRUCTURE", "RelatingStructure", "RelatedElements"),
            RelKind::Aggregates => ("IFCRELAGGREGATES", "RelatingObject", "RelatedObjects"),
            RelKind::DefinesByType => ("IFCRELDEFINESBYTYPE", "RelatingType", "RelatedObjects"),
            RelKind::AssociatesMaterial => ("IFCRELASSOCIATESMATERIAL", "RelatingMaterial", "RelatedObjects"),
            RelKind::AssociatesClassification => ("IFCRELASSOCIATESCLASSIFICATION", "RelatingClassification", "RelatedObjects"),
            RelKind::Declares => ("IFCRELDECLARES", "RelatingContext", "RelatedDefinitions"),
        }
    }

    fn role(self) -> &'static str {
        match self {
            RelKind::Contained => "rel/contained",
            RelKind::Aggregates => "rel/aggregates",
            RelKind::DefinesByType => "rel/type",
            RelKind::AssociatesMaterial => "rel/material",
            RelKind::AssociatesClassification => "rel/classification",
            RelKind::Declares => "rel/declares",
        }
    }
}

/// A relationship request from one Add, applied only once that Add has
/// built completely.
#[derive(Debug, Clone, Copy)]
pub(crate) struct RelRequest {
    pub(crate) kind: RelKind,
    pub(crate) relating: u32,
    pub(crate) related: u32,
    /// GlobalId of the related object; a relationship this creates takes its
    /// own id from the FIRST related object's id, so it is stable per plan.
    pub(crate) seed: GlobalId,
}

pub(crate) struct RelAccumulator<'a> {
    index: &'a FileIndex<'a>,
    removed: &'a HashSet<u32>,
    /// The first live, extendable relationship of each kind per relating
    /// object, in file order, once looked up.
    existing: HashMap<(RelKind, u32), Option<u32>>,
    /// (record, attribute index) -> ids to append to that list attribute.
    appends: BTreeMap<(u32, usize), Vec<u32>>,
    /// Relationships to create, keyed so emission order is stable.
    create: BTreeMap<(RelKind, u32), (GlobalId, Vec<u32>)>,
}

impl<'a> RelAccumulator<'a> {
    pub(crate) fn new(index: &'a FileIndex<'a>, removed: &'a HashSet<u32>) -> Self {
        Self { index, removed, existing: HashMap::new(), appends: BTreeMap::new(), create: BTreeMap::new() }
    }

    /// The first live relationship of `kind` naming `relating` in its
    /// relating slot, whose related list scanned as a list (any other gets
    /// a fresh relationship instead). Read from `relating`'s referrers, so
    /// only an object in the source has one.
    fn existing(&mut self, schema: &str, kind: RelKind, relating: u32) -> Option<u32> {
        let (index, removed) = (self.index, self.removed);
        *self.existing.entry((kind, relating)).or_insert_with(|| {
            if !index.contains(relating) {
                return None;
            }
            let (entity, relating_attr, related_attr) = kind.names();
            let relating_idx = attribute_index(schema, entity, relating_attr)?;
            let related_idx = attribute_index(schema, entity, related_attr)?;
            index.referrers(relating).iter().map(|&(rel, _)| rel).find(|&rel| {
                !removed.contains(&rel)
                    && index.type_of(rel).as_deref() == Some(entity)
                    && index.attrs(rel).is_some_and(|a| {
                        a.get(relating_idx).is_some_and(|slot| slot.scalar == Some(relating))
                            && a.get(related_idx).is_some_and(|slot| slot.list.is_some())
                    })
            })
        })
    }

    pub(crate) fn relate(&mut self, schema: &str, req: RelRequest) {
        let (entity, _, related_attr) = req.kind.names();
        if let Some(rel) = self.existing(schema, req.kind, req.relating) {
            if let Some(idx) = attribute_index(schema, entity, related_attr) {
                self.append_to_list(rel, idx, req.related);
                return;
            }
        }
        self.create.entry((req.kind, req.relating)).or_insert_with(|| (req.seed, Vec::new())).1.push(req.related);
    }

    /// Append `id` to list attribute `idx` of record `target` (a
    /// relationship's related list, or `IfcProject.RepresentationContexts`).
    pub(crate) fn append_to_list(&mut self, target: u32, idx: usize, id: u32) {
        self.appends.entry((target, idx)).or_default().push(id);
    }

    /// Write every list append into `edits_by_id` and return the new
    /// relationship records. Call after delete's list edits are merged in.
    ///
    /// All or nothing: every new record and every list text is built first
    /// (an id can run out, a slot can turn out not to be a list), and
    /// `edits_by_id` is written only once all of them have succeeded. On an
    /// error it is exactly as the caller passed it in.
    pub(crate) fn finish(
        self,
        schema: &str,
        ids: &mut IdAllocator,
        owner_history: Option<u32>,
        edits_by_id: &mut HashMap<u32, BTreeMap<usize, String>>,
    ) -> Result<Vec<(u32, String)>, String> {
        let mut records = Vec::new();
        for ((kind, relating), (seed, related)) in self.create {
            let (entity, relating_attr, related_attr) = kind.names();
            let id = ids.allocate().ok_or("id space exhausted")?;
            let fields = [
                ("GlobalId", format!("'{}'", seed.derive(kind.role()).encode())),
                ("OwnerHistory", ref_or_unset(owner_history)),
                (relating_attr, format!("#{relating}")),
                (related_attr, ref_list(&related)),
            ];
            records.push((id, build_record(schema, id, entity, &fields)));
        }

        let mut texts = Vec::with_capacity(self.appends.len());
        for ((target, idx), added) in self.appends {
            let current = match edits_by_id.get(&target).and_then(|e| e.get(&idx)) {
                Some(text) => text.clone(),
                None => self
                    .index
                    .raw_line(target)
                    .and_then(|line| crate::step_text::attribute_of(&line, idx))
                    .ok_or_else(|| format!("#{target} attribute {idx} did not scan"))?,
            };
            let text = extend_list_text(&current, &added)
                .ok_or_else(|| format!("#{target} attribute {idx} is not a list: {current}"))?;
            texts.push((target, idx, text));
        }
        for (target, idx, text) in texts {
            edits_by_id.entry(target).or_default().insert(idx, text);
        }
        Ok(records)
    }
}

/// `(#a,#b)` plus `[c, d]` -> `(#a,#b,#c,#d)`. `$` (an unset optional list)
/// becomes a list of just the new entries.
fn extend_list_text(current: &str, added: &[u32]) -> Option<String> {
    let mut entries: Vec<String> = if current.trim() == "$" {
        Vec::new()
    } else {
        let mut items = ifc_lite_core::StepListItems::of_list(current.as_bytes())?;
        let entries = items.by_ref().map(|e| std::str::from_utf8(e).ok().map(str::to_owned)).collect::<Option<Vec<_>>>()?;
        items.closed().then_some(entries)?
    };
    entries.extend(added.iter().map(|id| format!("#{id}")));
    Some(format!("({})", entries.join(",")))
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, HashMap, HashSet};

    use super::super::add_types::GlobalId;
    use super::super::index::FileIndex;
    use super::{extend_list_text, RelAccumulator, RelKind, RelRequest};

    #[test]
    fn extends_a_list_an_empty_list_and_an_unset_slot() {
        assert_eq!(extend_list_text("(#1,#2)", &[5]).as_deref(), Some("(#1,#2,#5)"));
        assert_eq!(extend_list_text("()", &[5, 6]).as_deref(), Some("(#5,#6)"));
        assert_eq!(extend_list_text("$", &[5]).as_deref(), Some("(#5)"));
        assert_eq!(extend_list_text("#3", &[5]), None);
    }

    /// An exhausted id space fails while allocating a NEW relationship
    /// record, before any pending list append is written into
    /// `edits_by_id`: the caller must be able to trust that a `finish`
    /// error left the map exactly as passed in, with nothing half-applied.
    #[test]
    fn an_exhausted_id_space_leaves_edits_by_id_untouched() {
        let index = FileIndex::complete(b"");
        let removed = HashSet::new();
        let mut rels = RelAccumulator::new(&index, &removed);

        // A list append that would succeed on its own...
        rels.append_to_list(1, 0, 99);
        // ...alongside a brand new relationship, which needs an id this
        // allocator has none left to give.
        rels.relate("IFC4", RelRequest { kind: RelKind::Contained, relating: 1, related: 2, seed: GlobalId(1) });

        let mut ids = crate::step_ids::IdAllocator::after(u32::MAX);
        let mut edits_by_id: HashMap<u32, BTreeMap<usize, String>> = HashMap::new();
        edits_by_id.insert(999, BTreeMap::from([(0, "sentinel".to_string())]));
        let before = edits_by_id.clone();

        let result = rels.finish("IFC4", &mut ids, None, &mut edits_by_id);

        assert!(result.is_err(), "expected id exhaustion to fail finish()");
        assert_eq!(edits_by_id, before, "a failed finish() must not have applied any list append");
    }

    /// A slot that is not a list fails `finish` after an earlier append in
    /// the same call already rendered; neither may land.
    #[test]
    fn a_slot_that_is_not_a_list_leaves_earlier_appends_unapplied() {
        let index = FileIndex::complete(b"");
        let removed = HashSet::new();
        let mut rels = RelAccumulator::new(&index, &removed);
        rels.append_to_list(1, 0, 99);
        rels.append_to_list(3, 0, 98);

        let mut ids = crate::step_ids::IdAllocator::after(100);
        let mut edits_by_id: HashMap<u32, BTreeMap<usize, String>> = HashMap::new();
        edits_by_id.insert(1, BTreeMap::from([(0, "(#2)".to_string())]));
        edits_by_id.insert(3, BTreeMap::from([(0, "#4".to_string())]));
        let before = edits_by_id.clone();

        let err = rels.finish("IFC4", &mut ids, None, &mut edits_by_id).unwrap_err();

        assert!(err.contains("not a list"), "{err}");
        assert_eq!(edits_by_id, before, "the append to #1 must not survive the failure on #3");
    }
}
