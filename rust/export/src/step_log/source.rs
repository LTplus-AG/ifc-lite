// SPDX-License-Identifier: MPL-2.0
//! The source file as the mutation-log writer reads it: one index pass, then
//! random access to the few records the log touches.
//!
//! Nothing here holds record TEXT. The index is the same `(start, end)` span
//! map the plain writer builds (`step::emit`), plus id lists for the handful
//! of record types the TypeScript exporter looks up by type
//! (`effective.byType.get(...)`). A record's text is read from `content` when
//! it is needed, which is what keeps the pass bounded on a file the host has
//! memory-mapped.

use std::borrow::Cow;
use std::collections::HashMap;

use ifc_lite_core::EntityScanner;

use super::extract::extract_entity;
use super::jsval::JsVal;

/// Record types the port reads by type. Kept to exactly what a phase asks for,
/// so the index does not grow a per-record type column.
const TRACKED: &[&str] = &[
    "IFCRELDEFINESBYPROPERTIES",
    "IFCPROPERTYSET",
    "IFCELEMENTQUANTITY",
    "IFCOWNERHISTORY",
    "IFCPROJECT",
    "IFCGEOMETRICREPRESENTATIONCONTEXT",
    "IFCPROJECTEDCRS",
    "IFCMAPCONVERSION",
    "IFCMAPCONVERSIONSCALED",
];

pub(crate) struct Source<'a> {
    pub(crate) content: &'a [u8],
    /// Every record id in the order the TypeScript exporter visits them: the
    /// parser's compact entity index is sorted by express id, and
    /// `writeSourceEntityLines` iterates it.
    pub(crate) order: Vec<u32>,
    line_of: HashMap<u32, (usize, usize)>,
    /// Highest express id in the file.
    pub(crate) max_id: u32,
    by_type: HashMap<&'static str, Vec<u32>>,
}

impl<'a> Source<'a> {
    pub(crate) fn index(content: &'a [u8]) -> Self {
        let mut order = Vec::new();
        let mut line_of: HashMap<u32, (usize, usize)> = HashMap::new();
        let mut by_type: HashMap<&'static str, Vec<u32>> = HashMap::new();
        let mut max_id = 0u32;
        let mut scanner = EntityScanner::new(content);
        while let Some((id, type_name, start, end)) = scanner.next_entity() {
            max_id = max_id.max(id);
            if line_of.insert(id, (start, end)).is_none() {
                order.push(id);
                if let Some(tracked) = TRACKED.iter().find(|t| type_name.eq_ignore_ascii_case(t)) {
                    by_type.entry(tracked).or_default().push(id);
                }
            }
        }
        order.sort_unstable();
        Source { content, order, line_of, max_id, by_type }
    }

    pub(crate) fn has(&self, id: u32) -> bool {
        self.line_of.contains_key(&id)
    }

    pub(crate) fn span(&self, id: u32) -> Option<(usize, usize)> {
        self.line_of.get(&id).copied()
    }

    /// The record's text, exactly as the file has it.
    pub(crate) fn line(&self, id: u32) -> Option<Cow<'a, str>> {
        let (s, e) = self.span(id)?;
        Some(String::from_utf8_lossy(&self.content[s..e]))
    }

    /// The record's UPPERCASE type, read off its text.
    pub(crate) fn type_of(&self, id: u32) -> Option<String> {
        let line = self.line(id)?;
        let eq = line.find('=')?;
        let rest = line[eq + 1..].trim_start();
        let end = rest.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_')).unwrap_or(rest.len());
        (end > 0).then(|| rest[..end].to_ascii_uppercase())
    }

    /// `EntityExtractor.extractEntity` over the record: `(UPPER type, attributes)`.
    pub(crate) fn entity(&self, id: u32) -> Option<(String, Vec<JsVal>)> {
        let line = self.line(id)?;
        extract_entity(&line).map(|(_, ty, attrs)| (ty, attrs))
    }

    /// Ids of a tracked record type, in file order.
    pub(crate) fn of_type(&self, upper: &str) -> &[u32] {
        debug_assert!(TRACKED.contains(&upper), "{upper} is not a tracked type");
        self.by_type.get(upper).map(Vec::as_slice).unwrap_or(&[])
    }
}
