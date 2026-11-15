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

pub(crate) fn write_entity_index(source: &[u8]) -> Vec<u8> {
    let mut rows: Vec<(u32, &str, u32, u32)> = Vec::new();
    let mut scanner = EntityScanner::new(source);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        rows.push((id, type_name, start as u32, (end - start) as u32));
    }
    // Ascending ids, as the TS column writer requires. A duplicate id keeps
    // its first record: one row per id, like the TS by-id index.
    rows.sort_by_key(|row| row.0);
    rows.dedup_by_key(|row| row.0);

    let mut type_names: Vec<String> = Vec::new();
    let mut type_index: HashMap<String, u16> = HashMap::new();
    let mut indices = Vec::with_capacity(rows.len());
    for (_, type_name, _, _) in &rows {
        let upper = type_name.to_ascii_uppercase();
        let next = type_names.len() as u16;
        let index = *type_index.entry(upper.clone()).or_insert_with(|| {
            type_names.push(upper);
            next
        });
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
    buf.into_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rows_are_sorted_by_id_with_uppercase_types_and_an_absent_trailer() {
        let source = b"DATA;\n#5=IFCWALL('a',$);\n#2=IfcSlab('b',$);\n#7=IFCWALL('c',$);\nENDSEC;\n";
        let bytes = write_entity_index(source);
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
}
