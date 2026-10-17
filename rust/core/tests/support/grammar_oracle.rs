// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The STEP grammar oracle (G7, #7778): one set of assertions that the
//! `rust/core/fuzz` targets and the stable corpus-replay test
//! (`tests/fuzz_regressions.rs`) both run. It lives once and both include it
//! (`#[path]`), so a corpus file replays through exactly what `cargo fuzz`
//! checked. It uses the crate's public API only.
//!
//! Three kinds of property, none of which needs a second parser:
//! - totality: nothing panics or hangs, whatever the bytes;
//! - agreement: where the tokenizer accepts a record, the byte readers read
//!   every attribute the way the token says (one number grammar, one
//!   reference spelling, one literal decode);
//! - fast against decoded: where the full decode has an answer, the raw fast
//!   readers give the same answer or refuse.

#![allow(dead_code)]

use ifc_lite_core::parser::{parse_ref, split_top_level_args, StepRecord};
use ifc_lite_core::step_encoding::decode_step_literal;
use ifc_lite_core::{
    build_entity_index, decode_ifc_string, decode_step_binary, parse_entity, parse_step_real,
    read_step_number, AttributeValue, EntityDecoder, EntityScanner, StepListItems, StepNumber,
    Token,
};

/// Every property over `data`, as given and wrapped into the record shapes the
/// fast readers serve. This is the whole oracle: the fuzz target body and the
/// replay test both call it.
pub fn check_all(data: &[u8]) {
    totality(data);
    agreement(data);
    fast_vs_decoded(data);
    for head in [
        &b"#1=IFCX("[..],
        b"#1=IFCCARTESIANPOINT(",
        b"#1=IFCCARTESIANPOINT((",
        b"#1=IFCPOLYLOOP(",
        b"#1=IFCCLOSEDSHELL(",
        b"#1=IFCFACEOUTERBOUND(",
    ] {
        let mut record = head.to_vec();
        record.extend_from_slice(data);
        record.extend_from_slice(b");");
        totality(&record);
        agreement(&record);
        fast_vs_decoded(&record);
    }
}

/// None of these may panic or hang, whatever the bytes. Results are only
/// observed so the optimizer keeps the calls.
pub fn totality(data: &[u8]) {
    let _ = parse_entity(data);
    let _ = read_step_number(data);
    let _ = parse_step_real(data);
    let _ = parse_ref(data);
    let _ = decode_step_literal(data);
    let _ = decode_step_binary(data);
    let _ = split_top_level_args(data);
    let _ = decode_ifc_string(&String::from_utf8_lossy(data));
    if let Some(items) = StepListItems::of_record(data) {
        items.for_each(drop);
    }
    if let Some(items) = StepListItems::of_list(data) {
        items.for_each(drop);
    }
    if let Some(record) = StepRecord::parse(data) {
        let mut refs = Vec::new();
        for i in 0..4 {
            let _ = (record.attr(i), record.ref_at(i), record.first_ref_at(i), record.real_at(i));
            let _ = (record.point_at(i), record.string_at(i), record.enum_at(i), record.is_present(i));
            let _ = record.ref_list_at(i, &mut refs);
        }
        let _ = record.keyword();
    }
    let _ = ifc_lite_core::parser::header::declared_schemas(data);
    let _ = ifc_lite_core::parser::header::extract_record_args(&String::from_utf8_lossy(data), "FILE_SCHEMA");
    scan(data);
}

/// The string decoders: total on any bytes, as text and as a literal.
pub fn decode_string(data: &[u8]) {
    let text = String::from_utf8_lossy(data);
    let _ = decode_ifc_string(&text);
    let _ = decode_step_literal(data);
    let mut quoted = b"'".to_vec();
    quoted.extend_from_slice(data);
    quoted.push(b'\'');
    let _ = decode_step_literal(&quoted);
    let _ = decode_step_binary(data);
}

/// The scanner and the index builder: total, and every span lies inside the
/// input and starts at its `#`.
pub fn scan(data: &[u8]) {
    let mut scanner = EntityScanner::new(data);
    let mut decoder = EntityDecoder::new(data);
    while let Some((id, _keyword, start, end)) = scanner.next_entity() {
        assert!(start < end && end <= data.len(), "span {start}..{end} of {}", data.len());
        assert_eq!(data[start], b'#', "a span starts at its instance name");
        let _ = id;
        let _ = decoder.decode_at(start, end);
    }
    let index = build_entity_index(data);
    for (_id, &(start, end)) in index.iter() {
        assert!(start <= end && end <= data.len());
    }
}

/// Whenever the tokenizer accepts `record`, the byte readers agree with it.
pub fn agreement(record: &[u8]) {
    let Ok((_id, _ty, tokens)) = parse_entity(record) else {
        return;
    };
    let Some(items) = StepListItems::of_record(record) else {
        panic!("the tokenizer accepts {:?} but it has no attribute list", lossy(record));
    };
    let items: Vec<&[u8]> = items.collect();
    assert_eq!(items.len(), tokens.len(), "{}: item count", lossy(record));
    for (token, item) in tokens.iter().zip(&items) {
        agree(token, item);
    }
}

fn agree(token: &Token, item: &[u8]) {
    let ctx = || format!("{:?} vs token {token:?}", lossy(item));
    match token {
        Token::Float(f) => match read_step_number(item) {
            Some((StepNumber::Real(r), len)) => {
                assert!(r.to_bits() == f.to_bits() && len == item.len(), "{}", ctx())
            }
            other => panic!("{}: {other:?}", ctx()),
        },
        Token::Integer(i) => match read_step_number(item) {
            Some((StepNumber::Integer(r), len)) => assert!(r == *i && len == item.len(), "{}", ctx()),
            other => panic!("{}: {other:?}", ctx()),
        },
        Token::UnrepresentableReal(raw) => {
            assert_eq!(parse_step_real(item), None, "{}", ctx());
            match read_step_number(item) {
                Some((StepNumber::Unrepresentable(r), len)) => {
                    assert!(r == *raw && len == item.len(), "{}", ctx())
                }
                other => panic!("{}: {other:?}", ctx()),
            }
        }
        Token::EntityRef(n) => assert_eq!(parse_ref(item), Some(*n), "{}", ctx()),
        Token::String(_) => {
            let from_token = AttributeValue::from_token(token);
            let decoded = decode_step_literal(item).expect("a string token is a literal");
            assert_eq!(Some(decoded.as_ref()), from_token.as_string(), "{}", ctx());
        }
        Token::Binary(raw) => {
            assert!(item.len() == raw.len() + 2 && item[0] == b'"' && item[1..=raw.len()] == **raw, "{}", ctx())
        }
        Token::Enum(e) => assert!(item.len() == e.len() + 2 && item[1..=e.len()] == **e, "{}", ctx()),
        Token::Null => assert_eq!(item, b"$"),
        Token::Derived => assert_eq!(item, b"*"),
        Token::List(inner) => agree_list(inner, StepListItems::of_list(item), &ctx()),
        Token::TypedValue(name, inner) => {
            assert!(item.starts_with(name), "{}", ctx());
            agree_list(inner, StepListItems::of_list(&item[name.len()..]), &ctx());
        }
    }
}

fn agree_list(tokens: &[Token], items: Option<StepListItems>, ctx: &str) {
    let items: Vec<&[u8]> = items.unwrap_or_else(|| panic!("{ctx}: not a list")).collect();
    assert_eq!(items.len(), tokens.len(), "{ctx}: item count");
    for (token, item) in tokens.iter().zip(&items) {
        agree(token, item);
    }
}

/// The raw fast readers against the full decode of the same one-record file
/// (the record's own instance name, so a record read as given and one wrapped
/// as `#1=...` are both checked).
pub fn fast_vs_decoded(record: &[u8]) {
    let Some(id) = StepRecord::parse(record).and_then(|head| head.id()) else {
        return;
    };
    let mut decoder = EntityDecoder::new(record);
    let Ok(entity) = decoder.decode_by_id(id) else {
        return;
    };
    let attr0 = entity.get(0);
    let ctx = lossy(record);

    // A point: two or three finite numbers.
    let decoded_point = attr0.and_then(AttributeValue::as_list).and_then(|items| {
        let at = |i: usize| items.get(i).and_then(number).filter(|v| v.is_finite());
        match items.len() {
            2 => Some((at(0)?, at(1)?, 0.0)),
            3 => Some((at(0)?, at(1)?, at(2)?)),
            _ => None,
        }
    });
    let fast_point = decoder.get_cartesian_point_fast(id);
    assert_eq!(fast_point.map(bits3), decoded_point.map(bits3), "{ctx}: point");

    // A list of references: every item one.
    let decoded_refs = attr0.and_then(AttributeValue::as_list).and_then(|items| {
        items.iter().map(AttributeValue::as_entity_ref).collect::<Option<Vec<u32>>>()
    });
    let decoded_refs = decoded_refs.filter(|ids| !ids.is_empty());
    assert_eq!(decoder.get_polyloop_point_ids_fast(id), decoded_refs, "{ctx}: polyloop ids");
    assert_eq!(decoder.get_entity_ref_list_fast(id), decoded_refs, "{ctx}: ref list");
}

fn number(v: &AttributeValue) -> Option<f64> {
    match v {
        AttributeValue::Float(f) => Some(*f),
        AttributeValue::Integer(i) => Some(*i as f64),
        _ => None,
    }
}

fn bits3(p: (f64, f64, f64)) -> [u64; 3] {
    [p.0.to_bits(), p.1.to_bits(), p.2.to_bits()]
}

fn lossy(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    text.chars().take(200).collect()
}
