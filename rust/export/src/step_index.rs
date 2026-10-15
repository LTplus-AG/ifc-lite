// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The record index both STEP writers stream a source file through (#7682,
//! EXPORT-STEP-11): where each record's text sits, in file order, and the
//! highest id the file holds.
//!
//! It used to be built twice, by the plain writer and the mutation-log
//! writer's `Source`, and both collapsed a repeated express id silently: the
//! span map took the second record while the order kept the first one's
//! place, so the second record's text was written where the first had been
//! and the first vanished, with nothing counted. Here the FIRST record with an
//! id is the one indexed, and every later one is listed in `duplicates` for
//! the writer to report. A file with two records under one id is invalid, and
//! writing both would hand that on.

use std::collections::HashMap;

use ifc_lite_core::EntityScanner;

pub(crate) struct RecordIndex {
    /// Record ids in file order, each once.
    pub(crate) order: Vec<u32>,
    /// `(start, end)` of each indexed record's text in the content.
    pub(crate) spans: HashMap<u32, (usize, usize)>,
    /// Highest express id in the file.
    pub(crate) max_id: u32,
    /// Ids of records dropped because an earlier record already had the id,
    /// one entry per dropped record, in file order.
    pub(crate) duplicates: Vec<u32>,
}

impl RecordIndex {
    /// Scan `content` once. `on_record` sees each indexed record's id and type
    /// keyword (as written), in file order, so a caller can keep the few
    /// types it looks up without the index growing a type column.
    pub(crate) fn build(content: &[u8], mut on_record: impl FnMut(u32, &str)) -> Self {
        let mut order = Vec::new();
        let mut spans: HashMap<u32, (usize, usize)> = HashMap::new();
        let mut duplicates = Vec::new();
        let mut max_id = 0u32;
        let mut scanner = EntityScanner::new(content);
        while let Some((id, type_name, start, end)) = scanner.next_entity() {
            max_id = max_id.max(id);
            match spans.entry(id) {
                std::collections::hash_map::Entry::Occupied(_) => duplicates.push(id),
                std::collections::hash_map::Entry::Vacant(slot) => {
                    slot.insert((start, end));
                    order.push(id);
                    on_record(id, type_name);
                }
            }
        }
        RecordIndex { order, spans, max_id, duplicates }
    }

    /// The warning a writer reports for each dropped duplicate.
    pub(crate) fn duplicate_warning(id: u32) -> String {
        format!(
            "Entity #{id} appears more than once in the source; only its first record was written, and every later record with that id was dropped."
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// EXPORT-STEP-11 (#7682): the first record with an id is the one
    /// indexed, and the repeat is reported instead of replacing its text.
    #[test]
    fn the_first_record_wins_and_the_repeat_is_reported() {
        let content = b"DATA;\n#1=IFCA('first');\n#2=IFCB($);\n#1=IFCC('second');\nENDSEC;\n";
        let mut seen = Vec::new();
        let index = RecordIndex::build(content, |id, ty| seen.push((id, ty.to_string())));
        assert_eq!(index.order, vec![1, 2]);
        assert_eq!(index.duplicates, vec![1]);
        assert_eq!(index.max_id, 2);
        let (s, e) = index.spans[&1];
        assert_eq!(&content[s..e], b"#1=IFCA('first');");
        assert_eq!(seen, vec![(1, "IFCA".to_string()), (2, "IFCB".to_string())]);
    }
}
