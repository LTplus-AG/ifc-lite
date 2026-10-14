// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7589: the core decoders read a `\S\` PAGE directive's apostrophe operand
//! as text, as the entity scanners have since #7540. Before, the tokenizer
//! ended `'Para \S\' 5'` at the operand, so `parse_entity` failed and the
//! whole entity was undecodable, and `StepListItems` split the record at the
//! comma inside the literal, shifting every later attribute slot.

use ifc_lite_core::{
    nth_attribute_is_present, parse_entity, EntityDecoder, EntityScanner, StepListItems, Token,
};

fn vectors() -> Vec<(String, String)> {
    let parsed: serde_json::Value = serde_json::from_str(include_str!(
        "fixtures/step-page-directive.json"
    ))
    .unwrap();
    parsed
        .as_array()
        .unwrap()
        .iter()
        .map(|v| {
            (
                v["name"].as_str().unwrap().to_owned(),
                v["literal"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}

const WALL: &str =
    r"#20=IFCWALL('0000000000000000000020',#5,'Para \S\' 5','Art \S\' 7',$,#6,#7,$,$);";

#[test]
fn tokenizer_hands_the_whole_page_literal_to_the_decoder_7589() {
    for (name, literal) in vectors() {
        let record = format!("#1=IFCWALL({literal},#5,$);");
        let (_, _, args) = parse_entity(&record).unwrap_or_else(|e| panic!("{name}: {e}"));
        let inner = &literal.as_bytes()[1..literal.len() - 1];
        assert_eq!(
            args,
            [Token::String(inner), Token::EntityRef(5), Token::Null],
            "{name}"
        );
    }
}

#[test]
fn entity_decoder_reads_page_quote_name_and_description_7589() {
    let content = format!("{WALL}\n#21=IFCWALL('0000000000000000000021',$,'Next',$,$,$,$,$,$);\n");
    let mut decoder = EntityDecoder::new(&content);
    let mut scanner = EntityScanner::new(&content);
    let (id, _, start, end) = scanner.next_entity().unwrap();
    assert_eq!(id, 20);
    let wall = decoder.decode_at(start, end).unwrap();
    assert_eq!(wall.get_string(2), Some("Para \u{A7} 5"));
    assert_eq!(wall.get_string(3), Some("Art \u{A7} 7"));
    assert_eq!(wall.get_ref(1), Some(5));
    assert_eq!(wall.get_ref(5), Some(6));
    assert_eq!(wall.get_ref(6), Some(7));
    assert_eq!(wall.attributes.len(), 9);
}

#[test]
fn page_and_doubled_quote_decode_in_order_7589() {
    // `''` is un-doubled before the backslash layer: the literal reads "§'tail".
    let record = r"#1=IFCLABEL('\S\'''tail');";
    let mut decoder = EntityDecoder::new(record);
    let label = decoder.decode_at(0, record.len()).unwrap();
    assert_eq!(label.get_string(0), Some("\u{A7}'tail"));
}

#[test]
fn step_list_items_split_after_a_page_quote_literal_7589() {
    let items: Vec<&[u8]> = StepListItems::of_record(WALL.as_bytes()).unwrap().collect();
    assert_eq!(items.len(), 9);
    assert_eq!(items[2], br"'Para \S\' 5'");
    assert_eq!(items[3], br"'Art \S\' 7'");
    assert_eq!(items[6], b"#7");
    // Representation (slot 6) is present; slot 7 is `$`.
    assert!(nth_attribute_is_present(WALL.as_bytes(), 6));
    assert!(!nth_attribute_is_present(WALL.as_bytes(), 7));
}

#[test]
fn every_page_vector_keeps_later_slots_in_place_7589() {
    for (name, literal) in vectors() {
        let record = format!("#1=IFCWALL('g',$,{literal},$,$,#6,#7,$);");
        let mut items = StepListItems::of_record(record.as_bytes()).unwrap();
        let collected: Vec<&[u8]> = items.by_ref().collect();
        assert!(items.closed(), "{name}");
        assert_eq!(collected.len(), 8, "{name}");
        assert_eq!(collected[2], literal.as_bytes(), "{name}");
        assert_eq!(collected[6], b"#7", "{name}");
        assert!(nth_attribute_is_present(record.as_bytes(), 6), "{name}");
    }
}
