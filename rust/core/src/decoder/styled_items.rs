// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Source-bound inverse StyledItem.Item lookup. No presentation interpretation.
use super::{EntityDecoder, EntityScanner, Error, Result};
use rustc_hash::{FxHashMap, FxHashSet};

impl EntityDecoder<'_> {
    /// Return file-ordered IfcStyledItem ids attached to a representation item.
    /// One lazy index belongs to the shared source columnar index (or this
    /// decoder without one), surviving per-element/batch decoder recreation; failures are
    /// cached too. Refuses sources over 256 MiB, over one million styled-item
    /// reference edges, malformed records, or over 64 styles on one item.
    /// A refusal is never interpreted as an unstyled item.
    pub fn styled_item_ids(&mut self, item_id: u32) -> Result<&[u32]> {
        if self.content.len() <= 256 * 1024 * 1024 {
            self.build_index();
        }
        let cache = match self.entity_index.as_ref() {
            Some(crate::columnar_index::EntityIndexStore::Columnar(index)) => {
                &index.styled_item_index
            }
            _ => &self.styled_item_index,
        };
        match cache.get_or_init(|| self.build_styled_item_index()) {
            Ok(index) => Ok(index.get(&item_id).map(Vec::as_slice).unwrap_or(&[])),
            Err(message) => Err(Error::parse(0, message.clone())),
        }
    }

    fn build_styled_item_index(&self) -> std::result::Result<FxHashMap<u32, Vec<u32>>, String> {
        if self.content.len() > 256 * 1024 * 1024 {
            return Err("StyledItem inverse lookup source-byte budget exceeded".into());
        }
        let mut index: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
        let mut scanner = EntityScanner::new(self.content);
        let mut edges = 0usize;
        let mut seen_ids = FxHashSet::default();
        while let Some((id, type_name, start, end)) = scanner.next_entity() {
            if type_name != "IFCSTYLEDITEM" {
                continue;
            }
            if end - start > 16 * 1024 {
                return Err("StyledItem record-byte budget exceeded".into());
            }
            if self
                .entity_index
                .as_ref()
                .and_then(|index| index.lookup(id))
                != Some((start, end))
            {
                return Err("StyledItem inverse lookup overwritten entity id".into());
            }
            if !seen_ids.insert(id) {
                return Err("StyledItem inverse lookup duplicate entity id".into());
            }
            edges += 1;
            if edges > 1_000_000 {
                return Err("StyledItem inverse lookup edge budget exceeded".into());
            }
            let styled = self
                .decode_at_uncached(start, end)
                .map_err(|e| e.to_string())?;
            let Some(item) = styled.get(0) else {
                return Err("StyledItem missing Item".into());
            };
            if item.is_null() {
                continue;
            }
            let item_id = item
                .as_entity_ref()
                .ok_or("StyledItem has invalid Item reference")?;
            let ids = index.entry(item_id).or_default();
            if ids.len() >= 64 {
                return Err("StyledItem inverse lookup per-item budget exceeded".into());
            }
            ids.push(id);
        }
        if scanner.skipped_oversized_ids() > 0 || scanner.malformed_record_start().is_some() {
            return Err("StyledItem inverse lookup encountered malformed source records".into());
        }
        Ok(index)
    }
}

#[cfg(test)]
mod tests {
    use crate::{ColumnarEntityIndex, EntityDecoder};
    use std::sync::Arc;

    #[test]
    fn styled_lookup_4406_survives_decoder_recreation_and_source_replacement() {
        let source = "#1=IFCSTYLEDITEM(#10,(#20),$);#2=IFCSTYLEDITEM(#11,(#21),$);";
        let index = Arc::new(ColumnarEntityIndex::from_scan(source.as_bytes()));
        let mut first = EntityDecoder::with_arc_columnar_index(source, index.clone());
        let ids = first.styled_item_ids(10).unwrap();
        assert_eq!(ids, &[1]);
        let pointer = ids.as_ptr();
        drop(first);
        let mut second = EntityDecoder::with_arc_columnar_index(source, index);
        assert_eq!(
            second.styled_item_ids(10).unwrap().as_ptr(),
            pointer,
            "source-owned lookup storage is reused across jobs"
        );
        assert_eq!(second.styled_item_ids(11).unwrap(), &[2]);
        assert!(second.styled_item_ids(12).unwrap().is_empty());
        let replacement = "#3=IFCSTYLEDITEM(#10,(#22),$);";
        let replacement_index = Arc::new(ColumnarEntityIndex::from_scan(replacement.as_bytes()));
        let mut replaced = EntityDecoder::with_arc_columnar_index(replacement, replacement_index);
        assert_eq!(replaced.styled_item_ids(10).unwrap(), &[3]);
    }

    #[test]
    fn styled_lookup_4406_budget_is_cached_failure_not_empty_style() {
        let source = (1..=65)
            .map(|id| format!("#{id}=IFCSTYLEDITEM(#100,(#200),$);"))
            .collect::<String>();
        let index = Arc::new(ColumnarEntityIndex::from_scan(source.as_bytes()));
        for _ in 0..2 {
            let mut decoder = EntityDecoder::with_arc_columnar_index(&source, index.clone());
            assert!(decoder
                .styled_item_ids(100)
                .unwrap_err()
                .to_string()
                .contains("per-item budget"));
            assert!(
                decoder.styled_item_ids(101).is_err(),
                "failed index must never report unstyled success"
            );
        }
    }
    #[test]
    fn styled_lookup_4406_duplicate_ids_never_alias_another_attachment() {
        let source = "#1=IFCSTYLEDITEM(#10,(#20),$);#1=IFCSTYLEDITEM(#11,(#21),$);";
        let index = Arc::new(ColumnarEntityIndex::from_scan(source.as_bytes()));
        let mut decoder = EntityDecoder::with_arc_columnar_index(source, index);
        for item in [10, 11] {
            assert!(decoder
                .styled_item_ids(item)
                .unwrap_err()
                .to_string()
                .contains("entity id"));
        }
    }

    #[test]
    fn styled_lookup_4406_overwritten_by_different_entity_type_refuses() {
        let source = "#1=IFCSTYLEDITEM(#10,(#20),$);#1=IFCCOLOURRGB($,0.2,0.6,0.8);";
        let mut decoder = EntityDecoder::new(source);
        assert!(decoder
            .styled_item_ids(10)
            .unwrap_err()
            .to_string()
            .contains("overwritten entity id"));
    }
}
