// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Allocation sized by untrusted input in `ifc-lite-core` (#7675).

use ifc_lite_core::{parse_entity, ColumnarEntityIndex, EntityDecoder, EntityIndex};

/// A ~1 MB record that fails to parse at its very first argument (`1.5abc` is not
/// a STEP REAL; `.5` was one of these until F4-1 made it a legal REAL), so nom's error carries the whole remaining record.
fn malformed_megabyte_record() -> String {
    let mut record = String::from("#1=IFCCARTESIANPOINTLIST3D((1.5abc");
    while record.len() < 1 << 20 {
        record.push_str(",(1.,2.,3.)");
    }
    record.push_str("));");
    record
}

/// CORE-5: nom 7's `Display` for `Err` writes the inner error with `{:?}`,
/// i.e. every remaining input byte as a decimal number, so the message was
/// 4-5x the record. The message must stay bounded whatever the record size.
#[test]
fn core_5_parse_error_message_is_bounded_not_sized_by_the_record() {
    let record = malformed_megabyte_record();
    let err = parse_entity(&record).expect_err("`1.5abc` is not a STEP REAL").to_string();
    assert!(err.len() < 512, "{} byte error for a {} byte record", err.len(), record.len());
}

/// CORE-5, the decoder half: `parse_at` re-formats the tokenizer's error, so a
/// bounded tail there was not enough on its own.
#[test]
fn core_5_decoder_error_message_is_bounded_not_sized_by_the_record() {
    let record = malformed_megabyte_record();
    let mut decoder = EntityDecoder::new(&record);
    let err = decoder.decode_at(0, record.len()).expect_err("malformed").to_string();
    assert!(err.len() < 512, "{} byte error for a {} byte record", err.len(), record.len());
}

/// CORE-24: the columnar index stores `u32` spans. A native source past 4 GiB
/// used to wrap them in release builds (only a `debug_assert` stood guard), so
/// `lookup` returned the span of some other bytes. Whatever the constructor
/// does with such a span, it must never hand back a different one.
#[test]
fn core_24_columnar_index_never_returns_a_wrapped_span() {
    let start = 5_000_000_000usize;
    let end = start + 64;
    let mut map: EntityIndex = Default::default();
    map.insert(7, (start, end));
    match ColumnarEntityIndex::from_hashmap(&map) {
        Ok(index) => assert_eq!(index.lookup(7), Some((start, end))),
        Err(e) => assert!(e.to_string().contains("4 GiB"), "{e}"),
    }
    match ColumnarEntityIndex::from_hashmap_consuming(map) {
        Ok(index) => assert_eq!(index.lookup(7), Some((start, end))),
        Err(e) => assert!(e.to_string().contains("4 GiB"), "{e}"),
    }
}
