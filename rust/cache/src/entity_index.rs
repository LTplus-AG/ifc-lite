// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The EntityIndex section (`sections/entity-index.ts`) and its v28
//! selection-coverage trailer (`sections/selection-relationships.ts`).
//!
//! Layout: count u32, typeNameCount u32, typeNames (u32 length + UTF-8
//! each), ids u32[], byteOffsets u32[], byteLengths u32[], typeIndices u16[],
//! then the trailer: a presence u32 (0 or 1) and, when 1, the coverage body.
//!
//! The spans are the same `ifc_lite_core::EntityScanner` spans the TS parser
//! gets from the wasm scan (`api/parsing.rs`: `byte_offset = start`,
//! `byte_length = end - start`), so lazy accessors re-attached on a cache hit
//! read the same bytes.
//!
//! The trailer is written ABSENT (0). The coverage it carries (#9947) is the
//! TS parser's `selectionRelationshipIndex`, computed by
//! `packages/parser/src/selection-relationship-index.ts` with no Rust
//! counterpart; porting it would be a second ingest implementation. Absent is
//! a value the reader accepts: the store then has no precomputed coverage and
//! the viewer derives it on demand, as for any store built without it.

use std::collections::HashMap;

use ifc_lite_core::EntityScanner;

use crate::buf::Buf;
use crate::CacheError;

pub(crate) fn write_entity_index(source: &[u8]) -> Result<Vec<u8>, CacheError> {
    // Every span is a u32 offset and length into the source, so a source past
    // u32::MAX is refused up front rather than wrapping a span.
    if u32::try_from(source.len()).is_err() {
        return Err(CacheError::SourceTooLarge(source.len() as u64));
    }
    let mut rows: Vec<(u32, &str, u32, u32)> = Vec::new();
    let mut scanner = EntityScanner::new(source);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        // Both fit: start < end <= source.len() <= u32::MAX.
        rows.push((id, type_name, start as u32, (end - start) as u32));
    }
    // Non-decreasing ids, as the TS column writer requires. A duplicated id
    // keeps EVERY record, in file order (the sort is stable), exactly as the
    // TS writer stores the parser's index (SPEC.md §8); readers resolve it.
    rows.sort_by_key(|row| row.0);

    let mut type_names: Vec<String> = Vec::new();
    let mut type_index: HashMap<String, u16> = HashMap::new();
    let mut indices = Vec::with_capacity(rows.len());
    for (_, type_name, _, _) in &rows {
        let upper = type_name.to_ascii_uppercase();
        let index = match type_index.get(&upper) {
            Some(&index) => index,
            None => {
                let index = type_index_for(type_names.len())?;
                type_index.insert(upper.clone(), index);
                type_names.push(upper);
                index
            }
        };
        indices.push(index);
    }

    let mut buf = Buf::with_capacity(8 + rows.len() * 14);
    buf.u32(rows.len() as u32);
    buf.u32(type_names.len() as u32);
    for name in &type_names {
        buf.string(name);
    }
    for row in &rows {
        buf.u32(row.0);
    }
    for row in &rows {
        buf.u32(row.2);
    }
    for row in &rows {
        buf.u32(row.3);
    }
    for index in indices {
        buf.u16(index);
    }
    // v28 selection-coverage trailer: absent (see the module docs).
    buf.u32(0);
    Ok(buf.into_vec())
}

/// The u16 type index for the `count`th distinct type name, refused past
/// 0xffff instead of wrapping onto the first name (as the TS writer refuses).
fn type_index_for(count: usize) -> Result<u16, CacheError> {
    u16::try_from(count).map_err(|_| CacheError::TooManyTypeNames(count + 1))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rows_are_sorted_by_id_with_uppercase_types_and_an_absent_trailer() {
        let source = b"DATA;\n#5=IFCWALL('a',$);\n#2=IfcSlab('b',$);\n#7=IFCWALL('c',$);\nENDSEC;\n";
        let bytes = write_entity_index(source).unwrap();
        let word = |at: usize| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
        assert_eq!(word(0), 3);
        assert_eq!(word(4), 2, "two distinct type names");
        // "IFCSLAB" (first in id order) then "IFCWALL".
        assert_eq!(&bytes[12..19], b"IFCSLAB");
        assert_eq!(&bytes[23..30], b"IFCWALL");
        assert_eq!([word(30), word(34), word(38)], [2, 5, 7]);
        let start = word(42) as usize;
        let length = word(54) as usize;
        assert!(source[start..start + length].starts_with(b"#2="));
        assert_eq!(&bytes[bytes.len() - 4..], &[0, 0, 0, 0]);
    }

    /// A duplicated id keeps every record in file order, as the TS writer
    /// stores the parser's index; none is dropped (the wall is not lost).
    #[test]
    fn a_duplicated_id_keeps_every_record_in_file_order() {
        let source = b"DATA;\n#5=IFCWALL('a',$);\n#2=IFCSLAB('b',$);\n#5=IFCDOOR('c',$);\nENDSEC;\n";
        let bytes = write_entity_index(source).unwrap();
        let word = |at: usize| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
        assert_eq!(word(0), 3, "three rows: the duplicate is kept");
        // Types in first-row order: IFCSLAB (#2), IFCWALL (#5), IFCDOOR (#5).
        let ids_at = 8 + [b"IFCSLAB".len(), b"IFCWALL".len(), b"IFCDOOR".len()].iter().map(|n| 4 + n).sum::<usize>();
        assert_eq!([word(ids_at), word(ids_at + 4), word(ids_at + 8)], [2, 5, 5]);
        let span = |row: usize| {
            let start = word(ids_at + 12 + row * 4) as usize;
            let length = word(ids_at + 24 + row * 4) as usize;
            &source[start..start + length]
        };
        assert!(span(1).starts_with(b"#5=IFCWALL"), "the first #5 stays first");
        assert!(span(2).starts_with(b"#5=IFCDOOR"), "the later #5 follows it");
    }

    /// The u16 type index refuses the 65,537th distinct name instead of
    /// wrapping it onto the first.
    #[test]
    fn a_type_index_past_u16_is_refused_not_wrapped() {
        assert_eq!(type_index_for(0xffff).unwrap(), 0xffff);
        assert!(matches!(type_index_for(0x1_0000), Err(CacheError::TooManyTypeNames(0x1_0001))));
    }
}
