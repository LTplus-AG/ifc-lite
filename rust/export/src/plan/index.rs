// SPDX-License-Identifier: MPL-2.0
//! The executor's view of the source file, sized by the file only where it
//! cannot be avoided.
//!
//! One pass records where each record is ([`ifc_lite_core::ColumnarEntityIndex`]:
//! three `u32` columns, 12 bytes a record) plus the few whole-file facts the
//! plan needs: the highest id, the first owner history, ids declared twice,
//! the ids of the GlobalIds the plan names, and the few records new geometry
//! attaches to (projects, representation contexts). Everything else is read on
//! demand from the record's own bytes: its entity type, its attribute
//! references ([`FileIndex::attrs`]). Who refers to a record is answered by
//! [`super::referrers`], which collects it only for the ids a plan asks about.

use std::borrow::Cow;
use std::collections::HashSet;

use ifc_lite_core::parser::{parse_ref, skip_step_trivia, StepRecord};
use ifc_lite_core::{ColumnarEntityIndex, EntityIndex, EntityScanner, StepListItems};
use rustc_hash::{FxHashMap, FxHashSet};

use crate::merged::extract_global_id_fast;
use crate::step_record_frame::record_frame;
use crate::step_slot::slots_of;

use super::referrers::Referrers;

/// One outgoing attribute slot that names other records.
pub(crate) struct AttrRefs {
    /// `Some` for a list attribute (`(#a,#b)`), carrying its entries in
    /// order (non-ref entries stay `None`); `None` for a bare scalar slot
    /// that is itself a single `#id` reference (or holds none).
    pub(crate) list: Option<Vec<Option<u32>>>,
    /// The bare scalar reference, when the slot is not a list.
    pub(crate) scalar: Option<u32>,
    /// References inside the slot that are neither of those: in a nested
    /// list (`IfcBSplineSurface.ControlPointsList`) or a typed value. They
    /// count as uses, but no list edit can strip one.
    pub(crate) nested: Vec<u32>,
}

impl AttrRefs {
    /// Every record this slot names.
    pub(crate) fn refs(&self) -> impl Iterator<Item = u32> + '_ {
        self.list.iter().flatten().flatten().chain(self.scalar.iter()).chain(self.nested.iter()).copied()
    }
}

/// Record spans. `u32` columns need the source under 4 GiB; a larger one
/// falls back to the engine's `usize` hash index.
enum Spans {
    Columnar(ColumnarEntityIndex),
    Wide(EntityIndex),
}

impl Spans {
    fn lookup(&self, id: u32) -> Option<(usize, usize)> {
        match self {
            Spans::Columnar(c) => c.lookup(id),
            Spans::Wide(m) => m.get(&id).copied(),
        }
    }

    fn len(&self) -> usize {
        match self {
            Spans::Columnar(c) => c.len(),
            Spans::Wide(m) => m.len(),
        }
    }

    fn for_each_id(&self, mut f: impl FnMut(u32)) {
        match self {
            Spans::Columnar(c) => c.ids().iter().for_each(|&id| f(id)),
            Spans::Wide(m) => m.keys().for_each(|&id| f(id)),
        }
    }
}

pub(crate) struct FileIndex<'a> {
    content: &'a [u8],
    spans: Spans,
    /// Ids declared more than once. Only the LAST declaration is the record,
    /// as in core and in the crate's other writers (`step_index`), so every
    /// pass over the file has to treat the earlier ones as absent.
    pub(crate) duplicates: FxHashSet<u32>,
    /// `(GlobalId, id)` for the GlobalIds the plan names, first declaration
    /// wins. Never the whole file's.
    guids: FxHashMap<String, u32>,
    pub(crate) max_id: u32,
    pub(crate) first_owner_history: Option<u32>,
    /// Every `IfcProject`, in file order.
    pub(crate) projects: Vec<u32>,
    /// Every `IfcApplication`, in file order.
    pub(crate) applications: Vec<u32>,
    /// Every `IfcGeometricRepresentationContext` and subcontext, in file
    /// order.
    pub(crate) contexts: Vec<u32>,
    pub(crate) referrers: Referrers,
}

impl<'a> FileIndex<'a> {
    /// Scan `content` once. `wanted_guids` are the GlobalIds a plan refers
    /// to objects by; only those are kept.
    pub(crate) fn scan(content: &'a [u8], wanted_guids: &FxHashSet<&str>) -> Self {
        let columnar = u32::try_from(content.len()).is_ok();
        let estimate = if columnar { content.len() / 50 } else { 0 };
        let (mut ids, mut starts, mut lengths) =
            (Vec::with_capacity(estimate), Vec::with_capacity(estimate), Vec::with_capacity(estimate));
        let mut wide = EntityIndex::default();
        let mut duplicates = FxHashSet::default();
        let mut guids: Vec<(String, u32, usize)> = Vec::new();
        let mut max_id = 0u32;
        // `(id, start)`: kept below only where the record is the one an id
        // resolves to, so a declaration a later one replaces counts for nothing.
        let mut owner_histories = Vec::new();
        let mut projects = Vec::new();
        let mut applications = Vec::new();
        let mut contexts = Vec::new();
        let mut ascending = true;

        let mut scanner = EntityScanner::new(content);
        while let Some((id, type_name, start, end)) = scanner.next_entity() {
            max_id = max_id.max(id);
            if type_name.eq_ignore_ascii_case("IFCOWNERHISTORY") {
                owner_histories.push((id, start));
            } else if type_name.eq_ignore_ascii_case("IFCPROJECT") {
                projects.push((id, start));
            } else if type_name.eq_ignore_ascii_case("IFCAPPLICATION") {
                applications.push((id, start));
            } else if type_name.eq_ignore_ascii_case("IFCGEOMETRICREPRESENTATIONCONTEXT")
                || type_name.eq_ignore_ascii_case("IFCGEOMETRICREPRESENTATIONSUBCONTEXT")
            {
                contexts.push((id, start));
            }
            if !wanted_guids.is_empty() {
                note_wanted_guid(&content[start..end], type_name, id, start, wanted_guids, &mut guids);
            }
            if columnar {
                ascending &= ids.last().is_none_or(|&last| last < id);
                ids.push(id);
                starts.push(start as u32);
                lengths.push((end - start) as u32);
            } else if wide.insert(id, (start, end)).is_some() {
                duplicates.insert(id);
            }
        }

        let spans = if columnar {
            if !ascending {
                let mut sorted = ids.clone();
                sorted.sort_unstable();
                duplicates.extend(sorted.windows(2).filter(|w| w[0] == w[1]).map(|w| w[0]));
            }
            ids.shrink_to_fit();
            starts.shrink_to_fit();
            lengths.shrink_to_fit();
            let index = ColumnarEntityIndex::from_owned_columns(ids, starts, lengths)
                .expect("the three columns are pushed together");
            Spans::Columnar(index)
        } else {
            Spans::Wide(wide)
        };

        let kept = |&(id, start): &(u32, usize)| !duplicates.contains(&id) || spans.lookup(id).is_some_and(|(s, _)| s == start);
        let first_owner_history = owner_histories.iter().find(|r| kept(r)).map(|&(id, _)| id);
        let projects = projects.iter().filter(|r| kept(r)).map(|&(id, _)| id).collect();
        let applications = applications.iter().filter(|r| kept(r)).map(|&(id, _)| id).collect();
        let contexts = contexts.iter().filter(|r| kept(r)).map(|&(id, _)| id).collect();
        let mut kept_guids = FxHashMap::default();
        for (guid, id, start) in guids {
            if kept(&(id, start)) {
                kept_guids.entry(guid).or_insert(id);
            }
        }

        Self {
            content,
            spans,
            duplicates,
            guids: kept_guids,
            max_id,
            first_owner_history,
            projects,
            applications,
            contexts,
            referrers: Referrers::default(),
        }
    }

    pub(crate) fn content(&self) -> &'a [u8] {
        self.content
    }

    /// Distinct ids in the file.
    pub(crate) fn len(&self) -> usize {
        self.spans.len()
    }

    pub(crate) fn contains(&self, id: u32) -> bool {
        self.spans.lookup(id).is_some()
    }

    pub(crate) fn for_each_id(&self, f: impl FnMut(u32)) {
        self.spans.for_each_id(f)
    }

    pub(crate) fn resolve(&self, obj: &super::types::ObjectRef) -> Option<u32> {
        match obj {
            super::types::ObjectRef::Id(id) => self.contains(*id).then_some(*id),
            super::types::ObjectRef::Guid(g) => self.guids.get(g).copied(),
        }
    }

    /// The source bytes of record `id`.
    pub(crate) fn record_bytes(&self, id: u32) -> Option<&'a [u8]> {
        self.spans.lookup(id).map(|(s, e)| &self.content[s..e])
    }

    pub(crate) fn raw_line(&self, id: u32) -> Option<Cow<'a, str>> {
        self.spans.lookup(id).map(|(s, e)| String::from_utf8_lossy(&self.content[s..e]))
    }

    /// UPPERCASE entity type of `id`, read from its own declaration.
    pub(crate) fn type_of(&self, id: u32) -> Option<String> {
        let (start, end) = self.spans.lookup(id)?;
        Some(StepRecord::parse(&self.content[start..end])?.keyword()?.to_ascii_uppercase())
    }

    /// `id`'s attribute slots parsed into references: `None` when `id` is
    /// not in the file, empty when its argument list does not scan (same
    /// refusal rule as `step_text`). An unscannable record contributes no
    /// edges, which is conservative for delete/GC: it can neither be
    /// repaired nor pruned.
    pub(crate) fn attrs(&self, id: u32) -> Option<Vec<AttrRefs>> {
        let raw = self.raw_line(id)?;
        Some(parse_attrs(&raw).unwrap_or_default())
    }

    /// Attribute `attr` of `id` (an `entity_type` in `schema`) as the text a
    /// STEP string holds, decoded by core (`''` is one `'`, `\X2\` escapes
    /// are characters). `None` when the slot is not a string.
    pub(crate) fn string_attr(&self, schema: &str, id: u32, entity_type: &str, attr: &str) -> Option<String> {
        let idx = super::attrs::attribute_index(schema, entity_type, attr)?;
        let (start, end) = self.spans.lookup(id)?;
        StepRecord::parse(&self.content[start..end])?.string_at(idx).map(Cow::into_owned)
    }

    /// Ids a record's attributes reference that the file declares, deduplicated.
    pub(crate) fn refs_of(&self, id: u32) -> HashSet<u32> {
        let mut out = HashSet::new();
        for attr in self.attrs(id).unwrap_or_default() {
            out.extend(attr.refs());
        }
        // A dangling reference names no record: nothing to prune or count.
        out.retain(|&target| self.contains(target));
        out
    }

    /// Every distinct record in file order as `(id, type as written, span)`,
    /// a duplicated id at its last declaration only.
    pub(crate) fn records(&self) -> impl Iterator<Item = (u32, &'a str, usize, usize)> + '_ {
        let mut scanner = EntityScanner::new(self.content);
        std::iter::from_fn(move || loop {
            let (id, type_name, start, end) = scanner.next_entity()?;
            if self.duplicates.is_empty()
                || !self.duplicates.contains(&id)
                || self.spans.lookup(id).is_some_and(|(s, _)| s == start)
            {
                return Some((id, type_name, start, end));
            }
        })
    }
}

/// Keep `(GlobalId, id)` when this record's GlobalId is one the plan names.
/// The cheap quoted-token check runs first so the uppercase type and the
/// exact rooted-entity test only run for a candidate.
fn note_wanted_guid(
    line: &[u8],
    type_name: &str,
    id: u32,
    start: usize,
    wanted: &FxHashSet<&str>,
    out: &mut Vec<(String, u32, usize)>,
) {
    let Some(candidate) = ifc_lite_core::guid::leading_global_id(line) else { return };
    if !wanted.contains(candidate) {
        return;
    }
    if let Some(g) = extract_global_id_fast(&type_name.to_ascii_uppercase(), line) {
        if g == candidate {
            out.push((g, id, start));
        }
    }
}

/// Parse a `#id=TYPE(a,b,(c,d),...)` line's top-level attribute list into
/// per-slot references. The record is framed and split exactly as the
/// attribute writer frames and splits it (`step_record_frame`, core's slot
/// grammar), so a slot index read here is the index an edit lands on. A slot
/// that is a list is read as its entries, each `Some` only when it is exactly
/// one `#id`; anything else is a scalar holding zero or one bare `#id`. A
/// reference anywhere else in the slot (a nested list, a typed value) lands in
/// [`AttrRefs::nested`].
/// Comments are trivia throughout.
pub(crate) fn parse_attrs(line: &str) -> Option<Vec<AttrRefs>> {
    let frame = record_frame(line)?;
    let slots = slots_of(frame.args(line))?;
    Some(
        slots
            .into_iter()
            .map(|slot| {
                let mut nested = Vec::new();
                match StepListItems::of_list(slot.as_bytes()) {
                    Some(entries) => {
                        let list = entries
                            .map(|item| {
                                let id = parse_ref(item);
                                if id.is_none() {
                                    crate::step_text::refs_in_line(item, &mut nested);
                                }
                                id
                            })
                            .collect();
                        AttrRefs { list: Some(list), scalar: None, nested }
                    }
                    None => {
                        let scalar = single_ref(slot.as_bytes());
                        if scalar.is_none() {
                            crate::step_text::refs_in_line(slot.as_bytes(), &mut nested);
                        }
                        AttrRefs { list: None, scalar, nested }
                    }
                }
            })
            .collect(),
    )
}

/// `Some(id)` when `slot` is exactly one `#id` token with only trivia around
/// it (typed-select values like `IFCLENGTHMEASURE(1.)` never match).
fn single_ref(slot: &[u8]) -> Option<u32> {
    let start = skip_step_trivia(slot, 0)?;
    let digits = slot.get(start + 1..)?.iter().take_while(|b| b.is_ascii_digit()).count();
    let end = start + 1 + digits;
    (skip_step_trivia(slot, end)? == slot.len()).then_some(())?;
    parse_ref(&slot[start..end])
}

#[cfg(test)]
mod tests {
    use super::parse_attrs;

    /// A comment is trivia: a `(`, `'` or `#` inside one is neither structure
    /// nor a reference, and a reference with a comment beside it still reads.
    #[test]
    fn attribute_references_skip_comments() {
        let attrs = parse_attrs("#5= /* ( */ IFCRELX('g',$,/* it's #99 ( */$,(#1,/* c */#2),#3 /* x */);").unwrap();
        assert_eq!(attrs.len(), 5);
        assert_eq!(attrs[2].scalar, None);
        assert_eq!(attrs[3].list.as_deref(), Some(&[Some(1), Some(2)][..]));
        assert_eq!(attrs[4].scalar, Some(3));
        // Not a value at all, so the record contributes no edges.
        assert!(parse_attrs("#5=IFCRELX(#+5);").is_none());
    }
}
