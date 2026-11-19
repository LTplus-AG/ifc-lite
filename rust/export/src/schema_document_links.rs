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
//! extra listing is reported. Types come from the source, so only an unedited
//! full export arms it. Twin of `schema-converter-document-links.ts`.
use std::collections::{HashMap, HashSet};
use crate::schema_structural_axes::list_items;
use crate::schema_structural_links::{slot_ref, slot_unset};

const DOC: &str = "IFCDOCUMENTINFORMATION";
const REF: &str = "IFCDOCUMENTREFERENCE";

#[derive(Default)]
pub(crate) struct DocumentLinks {
    /// The converted type and the index of its link slot.
    slot: Option<(&'static str, usize)>,
    /// Converted record id -> the value its link slot takes.
    fill: HashMap<u32, String>,
    /// Source records whose dropped link value `fill` writes on the other side.
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
        // The few document records, kept ones only, by type.
        let mut records: HashMap<u32, (bool, Vec<String>)> = HashMap::new();
        let mut order = Vec::new();
        let mut scanner = ifc_lite_core::EntityScanner::new(content);
        while let Some((id, ty, start, end)) = scanner.next_entity() {
            let is_doc = ty.eq_ignore_ascii_case(DOC);
            if !(is_doc || ty.eq_ignore_ascii_case(REF)) || !kept(id, start) { continue; }
            let Some((_, slots)) = crate::step_log::read_slots(&String::from_utf8_lossy(&content[start..end])) else { continue };
            if crate::schema_convert::schema_attribute_names(from, if is_doc { DOC } else { REF }).is_some_and(|names| names.len() == slots.len()) {
                records.insert(id, (is_doc, slots));
                order.push(id);
            }
        }
        let is = |id: u32, doc: bool| records.get(&id).is_some_and(|r| r.0 == doc);
        if up {
            let (Some(list_at), Some(at)) = (index(from, DOC, "DocumentReferences"), index(to, REF, "ReferencedDocument")) else { return links };
            links.slot = Some((REF, at));
            for &doc in order.iter().filter(|&&id| is(id, true)) {
                let Some(listed) = list_items(&records[&doc].1[list_at]) else { continue };
                let mut whole = !listed.is_empty();
                for reference in listed.iter().map(|m| slot_ref(m)) {
                    match reference.filter(|&r| is(r, false)) {
                        Some(r) if !links.fill.contains_key(&r) => drop(links.fill.insert(r, format!("#{doc}"))),
                        Some(_) => { links.listed_again += 1; whole = false; }
                        None => whole = false,
                    }
                }
                if whole { links.restored.insert(doc); }
            }
        } else {
            let (Some(doc_at), Some(at)) = (index(from, REF, "ReferencedDocument"), index(to, DOC, "DocumentReferences")) else { return links };
            links.slot = Some((DOC, at));
            let mut lists: HashMap<u32, Vec<String>> = HashMap::new();
            for &reference in order.iter().filter(|&&id| is(id, false)) {
                let Some(doc) = slot_ref(&records[&reference].1[doc_at]).filter(|&d| is(d, true)) else { continue };
                lists.entry(doc).or_default().push(format!("#{reference}"));
                links.restored.insert(reference);
            }
            links.fill = lists.into_iter().map(|(doc, refs)| (doc, format!("({})", refs.join(",")))).collect();
        }
        links
    }

    /// `line`, converted from source record `id`, with its link slot written;
    /// a value this restores is taken back out of `dropped`.
    pub(crate) fn apply(&self, id: u32, line: String, dropped: &mut usize) -> String {
        if self.restored.contains(&id) { *dropped = dropped.saturating_sub(1); }
        let (Some(value), Some((ty, at))) = (self.fill.get(&id), self.slot) else { return line };
        match crate::step_log::read_slots(&line) {
            Some((t, slots)) if t == ty && slots.get(at).is_some_and(|s| slot_unset(s)) => crate::step_log::replace_argument(&line, at, value).unwrap_or(line),
            _ => line,
        }
    }

    pub(crate) fn warnings(&self) -> Vec<String> {
        (self.listed_again > 0).then(|| format!(
            "{} IfcDocumentReference listing(s) past a reference's first IfcDocumentInformation were dropped: IFC4 ReferencedDocument names one document (#10846).",
            self.listed_again
        )).into_iter().collect()
    }
}

#[cfg(test)]
#[path = "schema_document_links_tests.rs"]
mod tests;
