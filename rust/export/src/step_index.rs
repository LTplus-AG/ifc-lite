// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The record index both STEP writers stream a source file through (#7682,
//! EXPORT-STEP-11): where each record's text sits, in file order, and the
//! highest id the file holds.
//!
//! It used to be built twice, by the plain writer and the mutation-log
//! writer's `Source`, and both collapsed a repeated express id silently: the
//! span map took the last record while the order kept the first one's place,
//! with nothing counted. The record kept is the one core resolves the id to,
//! the LAST one in the file (`ifc_lite_core::build_entity_index` and the
//! columnar index are last-wins), so the writer edits and writes the record
//! every ifc-lite reader shows. Each earlier record with that id is listed in
//! `duplicates` for the writer to report. A file with two records under one id
//! is invalid, and writing both would hand that on.

use std::collections::HashMap;

use ifc_lite_core::EntityScanner;

pub(crate) struct RecordIndex {
    /// Ids of the records kept, in file order, each once.
    pub(crate) order: Vec<u32>,
    /// `(start, end)` of each kept record's text in the content.
    pub(crate) spans: HashMap<u32, (usize, usize)>,
    /// Highest express id in the file.
    pub(crate) max_id: u32,
    /// One entry per record dropped because a LATER record has the same id.
    pub(crate) duplicates: Vec<u32>,
}

impl RecordIndex {
    /// Scan `content` once. `on_record` sees EVERY record's id, type keyword
    /// (as written) and start offset, in file order, so a caller can keep the
    /// few types it looks up without the index growing a type column; with a
    /// repeated id it also sees the records that lose, and keeps what it
    /// collected only where [`Self::is_kept`] says so.
    pub(crate) fn build(content: &[u8], mut on_record: impl FnMut(u32, &str, usize)) -> Self {
        let mut order = Vec::new();
        let mut spans: HashMap<u32, (usize, usize)> = HashMap::new();
        let mut duplicates = Vec::new();
        let mut max_id = 0u32;
        let mut scanner = EntityScanner::new(content);
        while let Some((id, type_name, start, end)) = scanner.next_entity() {
            max_id = max_id.max(id);
            // Last wins, as in core: a later record with the id replaces the span.
            if spans.insert(id, (start, end)).is_some() {
                duplicates.push(id);
            }
            order.push(id);
            on_record(id, type_name, start);
        }
        if !duplicates.is_empty() {
            // Each id stays at its LAST occurrence: drop as many earlier
            // occurrences as there were repeats.
            let mut earlier: HashMap<u32, usize> = HashMap::new();
            for &id in &duplicates {
                *earlier.entry(id).or_default() += 1;
            }
            order.retain(|id| match earlier.get_mut(id) {
                Some(n) if *n > 0 => {
                    *n -= 1;
                    false
                }
                _ => true,
            });
        }
        RecordIndex { order, spans, max_id, duplicates }
    }

    /// Whether the record of `id` starting at `start` is the one kept.
    pub(crate) fn is_kept(&self, id: u32, start: usize) -> bool {
        self.spans.get(&id).is_some_and(|&(kept, _)| kept == start)
    }

    /// The warning a writer reports for each dropped duplicate.
    pub(crate) fn duplicate_warning(id: u32) -> String {
        format!(
            "Entity #{id} appears more than once in the source; only its last record, the one ifc-lite reads, was written, and every earlier record with that id was dropped."
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// EXPORT-STEP-11 (#7682): the LAST record with an id is the one indexed,
    /// as in core, and the earlier one is reported instead of half-kept.
    #[test]
    fn the_last_record_wins_as_in_core_and_the_earlier_is_reported() {
        let content = b"DATA;\n#1=IFCA('first');\n#2=IFCB($);\n#1=IFCC('second');\nENDSEC;\n";
        let mut seen = Vec::new();
        let index = RecordIndex::build(content, |id, ty, start| seen.push((id, ty.to_string(), start)));
        seen.retain(|&(id, _, start)| index.is_kept(id, start));
        let seen: Vec<(u32, String)> = seen.into_iter().map(|(id, ty, _)| (id, ty)).collect();
        assert_eq!(index.order, vec![2, 1]);
        assert_eq!(index.duplicates, vec![1]);
        assert_eq!(index.max_id, 2);
        let (s, e) = index.spans[&1];
        assert_eq!(&content[s..e], b"#1=IFCC('second');");
        assert_eq!(seen, vec![(2, "IFCB".to_string()), (1, "IFCC".to_string())]);
        let core = ifc_lite_core::build_entity_index(content);
        assert_eq!(core.get(&1).map(|&(cs, _)| cs), Some(s), "the record core resolves #1 to");
    }
}
