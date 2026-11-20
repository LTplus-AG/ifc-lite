// SPDX-License-Identifier: MPL-2.0
//! IfcDocumentInformation <-> IfcDocumentReference: the link IFC4 moved to
//! the other record (#10846). IFC2X3 lists a document's references in
//! `IfcDocumentInformation.DocumentReferences`; IFC4 made that an inverse and
//! points each reference at its document with
//! `IfcDocumentReference.ReferencedDocument`. A line converter can only write
//! `$` for the slot on the other record, so this prepass reads the links from
//! the source and [`DocumentLinks::apply`] writes them: on an upgrade,
//! ReferencedDocument on each listed reference; on a downgrade,
//! DocumentReferences on each document a reference names.
//!
//! IFC2X3 lets one document list a reference (`ReferenceToDocument : SET
//! [0:1]`), so a reference listed again keeps its first document and the
//! extra listing is reported. WR1 (`EXISTS(Name) XOR EXISTS(the document)`,
//! in both schemas) leaves the name to the document, so a listed reference
//! with a Name already breaks IFC2X3 WR1; the upgrade drops that Name,
//! reported. One whose Name is all that identifies it
//! (IfcExternalReference.WR1 needs Location, Identification or Name) keeps
//! the Name and is not linked, reported. Types come from the source, so only
//! an unedited full export arms it. Twin of
//! `schema-converter-document-links.ts`.
use std::collections::{hash_map::Entry, HashMap, HashSet};
use crate::schema_structural_axes::list_items;
use crate::schema_structural_links::{slot_ref, slot_unset};

const DOC: &str = "IFCDOCUMENTINFORMATION";
const REF: &str = "IFCDOCUMENTREFERENCE";

#[derive(Default)]
pub(crate) struct DocumentLinks {
    /// The index of the link slot in the converted record.
    at: usize,
    /// The converted reference's Name slot on an upgrade.
    name_at: Option<usize>,
    /// Source references whose Name an upgrade drops for WR1.
    unnamed: HashSet<u32>,
    /// Listed source references an upgrade leaves unlinked: a Name is all that identifies them.
    name_only: HashSet<u32>,
    /// Converted record id -> the value its link slot takes.
    fill: HashMap<u32, String>,
    /// Source records whose dropped link value `fill` writes on the other side
    /// (Rust counts dropped values per record; TypeScript does not).
    restored: HashSet<u32>,
    /// Listings of a reference past its first document.
    listed_again: usize,
}

/// The index of `attribute` in `entity` as `schema` declares it.
fn index(schema: &str, entity: &str, attribute: &str) -> Option<usize> {
    crate::schema_convert::schema_attribute_names(schema, entity)?.iter().position(|a| *a == attribute)
}

impl DocumentLinks {
    /// Reads the links of an IFC2X3 <-> IFC4/IFC4X3 source; anything else arms nothing.
    pub(crate) fn scan(content: &[u8], from: &str, to: &str, kept: &dyn Fn(u32, usize) -> bool) -> Self {
        let ifc4 = |s: &str| s == "IFC4" || s == "IFC4X3";
        let up = from == "IFC2X3" && ifc4(to);
        let mut links = Self::default();
        if !(up || (to == "IFC2X3" && ifc4(from))) { return links; }
        // The side that holds the link in the source, its slot, and the slot it moves to.
        let (holder, target, read_at, write_at) = if up {
            (DOC, REF, index(from, DOC, "DocumentReferences"), index(to, REF, "ReferencedDocument"))
        } else {
            (REF, DOC, index(from, REF, "ReferencedDocument"), index(to, DOC, "DocumentReferences"))
        };
        let (Some(read_at), Some(at), Some(arity)) = (read_at, write_at, crate::schema_convert::schema_attribute_names(from, holder).map(<[_]>::len)) else { return links };
        links.at = at;
        if up { links.name_at = index(to, REF, "Name"); }
        // Kept records only: the holders' link slots, in file order, and the targets' ids.
        let (mut holders, mut targets, mut named) = (Vec::new(), HashSet::new(), HashSet::new());
        let mut scanner = ifc_lite_core::EntityScanner::new(content);
        while let Some((id, ty, start, end)) = scanner.next_entity() {
            if ty.eq_ignore_ascii_case(target) && kept(id, start) {
                // IFC2X3 IfcDocumentReference: Location, ItemReference, Name.
                let slots = if up { crate::step_log::read_slots(&String::from_utf8_lossy(&content[start..end])).map(|(_, s)| s) } else { None };
                let set = |i: usize| slots.as_ref().and_then(|s| s.get(i)).is_some_and(|s| !slot_unset(s));
                if set(2) { named.insert(id); }
                if !set(2) || set(0) || set(1) { targets.insert(id); }
            } else if ty.eq_ignore_ascii_case(holder) && kept(id, start) {
                let Some((_, mut slots)) = crate::step_log::read_slots(&String::from_utf8_lossy(&content[start..end])) else { continue };
                if slots.len() == arity { holders.push((id, slots.swap_remove(read_at))); }
            }
        }
        if up {
            for (doc, listed) in holders {
                let Some(listed) = list_items(&listed) else { continue };
                let (tag, mut whole) = (format!("#{doc}"), !listed.is_empty());
                for reference in listed.iter().map(|m| slot_ref(m)) {
                    if let Some(r) = reference.filter(|r| named.contains(r) && !targets.contains(r)) { links.name_only.insert(r); }
                    match reference.filter(|r| targets.contains(r)).map(|r| links.fill.entry(r)) {
                        Some(Entry::Vacant(e)) => drop(e.insert(tag.clone())),
                        // A repeat inside one list is not a second document.
                        Some(Entry::Occupied(e)) if *e.get() != tag => { links.listed_again += 1; whole = false; }
                        Some(Entry::Occupied(_)) => {}
                        None => whole = false,
                    }
                }
                if whole { links.restored.insert(doc); }
            }
            links.unnamed = links.fill.keys().copied().filter(|r| named.contains(r)).collect();
        } else {
            let mut lists: HashMap<u32, Vec<String>> = HashMap::new();
            for (reference, doc) in holders {
                let Some(doc) = slot_ref(&doc).filter(|d| targets.contains(d)) else { continue };
                lists.entry(doc).or_default().push(format!("#{reference}"));
                links.restored.insert(reference);
            }
            links.fill = lists.into_iter().map(|(doc, refs)| (doc, format!("({})", refs.join(",")))).collect();
        }
        links
    }

    /// `line`, converted from source record `id`, with its link slot written;
    /// a value this restores is taken back out of `dropped`, a Name WR1 clears
    /// is added to it.
    pub(crate) fn apply(&self, id: u32, line: String, dropped: &mut usize) -> String {
        if self.fill.is_empty() { return line; }
        if self.restored.contains(&id) { *dropped = dropped.saturating_sub(1); }
        let Some(value) = self.fill.get(&id) else { return line };
        let Some(frame) = crate::step_record_frame::record_frame(&line) else { return line };
        let Some(mut slots) = crate::step_slot::slots_of(frame.args(&line)).filter(|s| s.get(self.at).is_some_and(|s| slot_unset(s))) else { return line };
        slots[self.at] = value;
        if let Some(name) = self.name_at.filter(|&n| self.unnamed.contains(&id) && n < slots.len()) {
            slots[name] = "$";
            *dropped += 1;
        }
        frame.with_args(&line, &slots.join(","))
    }

    pub(crate) fn warnings(&self) -> Vec<String> {
        let again = (self.listed_again > 0).then(|| format!(
            "{} IfcDocumentReference listing(s) past a reference's first IfcDocumentInformation were dropped: IFC4 ReferencedDocument names one document (#10846).",
            self.listed_again
        ));
        let unnamed = (!self.unnamed.is_empty()).then(|| format!(
            "{} IfcDocumentReference Name(s) were dropped (the source breaks IFC2X3 WR1 too): IFC4 WR1 gives a reference a Name only when it has no ReferencedDocument, whose Name stands (#10846).",
            self.unnamed.len()
        ));
        let name_only = (!self.name_only.is_empty()).then(|| format!(
            "{} IfcDocumentReference(s) identified only by Name keep it and lose their IfcDocumentInformation link (the source breaks IFC2X3 WR1): IFC4 WR1 forbids Name beside ReferencedDocument, and IfcExternalReference.WR1 needs Location, Identification or Name (#10846).",
            self.name_only.len()
        ));
        again.into_iter().chain(unnamed).chain(name_only).collect()
    }
}

#[cfg(test)]
#[path = "schema_document_links_tests.rs"]
mod tests;
