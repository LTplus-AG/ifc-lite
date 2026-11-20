// SPDX-License-Identifier: MPL-2.0
use super::*;
use crate::schema_convert::convert_step_line;
use crate::schema_enum::ConversionChecks;
use crate::schema_ifc2x3_slots::Ifc2x3SlotFill;

/// The table is the shared fixture (the TypeScript twin runs the same
/// comparison), and its members are IFC2X3's own `IfcCurrencyEnum`.
#[test]
fn the_table_is_the_shared_fixture_and_the_ifc2x3_enumeration_10778() {
    let doc: serde_json::Value =
        serde_json::from_str(include_str!("../tests/fixtures/schema_retyped_slots.json")).expect("valid JSON");
    let fixture: Vec<(String, usize, Vec<String>)> = doc["slots"]
        .as_array()
        .expect("slots")
        .iter()
        .map(|s| {
            let members = s["members"].as_array().expect("members").iter().map(|m| m.as_str().unwrap().to_owned()).collect();
            (s["type"].as_str().unwrap().to_owned(), s["index"].as_u64().unwrap() as usize, members)
        })
        .collect();
    let table: Vec<(String, usize, Vec<String>)> =
        RETYPED_SLOTS.iter().map(|(t, i, m)| (t.to_string(), *i, m.iter().map(|s| s.to_string()).collect())).collect();
    assert_eq!(table, fixture);
    let exp = include_str!("../../../packages/codegen/schemas/IFC2X3_TC1.exp");
    let body = exp.split("TYPE IfcCurrencyEnum = ENUMERATION OF").nth(1).and_then(|s| s.split(");").next()).expect("IfcCurrencyEnum");
    let declared: Vec<&str> = body.trim().trim_start_matches('(').split(',').map(str::trim).collect();
    assert_eq!(CURRENCY, declared.as_slice());
    let names = |schema| ifc_lite_core::attribute_names_for_schema(schema, "IFCMONETARYUNIT").unwrap()[0];
    assert_eq!((names("IFC2X3"), names("IFC4"), names("IFC4X3")), ("Currency", "Currency", "Currency"));
}

fn convert(line: &str, from: &str, to: &str) -> (String, usize) {
    let mut checks = ConversionChecks::default();
    let out = convert_step_line(line, from, to, 5, &mut Ifc2x3SlotFill::new(None), Some(&mut checks)).unwrap();
    (out, checks.attribute_values_dropped)
}

#[test]
fn a_currency_member_becomes_a_label_and_back_10778() {
    for to in ["IFC4", "IFC4X3"] {
        assert_eq!(convert("#5=IFCMONETARYUNIT(.EUR.);", "IFC2X3", to), ("#5=IFCMONETARYUNIT('EUR');".to_owned(), 0));
    }
    assert_eq!(convert("#5=IFCMONETARYUNIT('EUR');", "IFC4", "IFC2X3"), ("#5=IFCMONETARYUNIT(.EUR.);".to_owned(), 0));
    assert_eq!(convert("#5=IFCMONETARYUNIT('chf');", "IFC4X3", "IFC2X3"), ("#5=IFCMONETARYUNIT(.CHF.);".to_owned(), 0));
    assert_eq!(convert("#5=IFCMONETARYUNIT(' gbp ');", "IFC4", "IFC2X3").0, "#5=IFCMONETARYUNIT(.GBP.);");
    assert_eq!(convert("#5=IFCMONETARYUNIT('\\X2\\004500550052\\X0\\');", "IFC4", "IFC2X3").0, "#5=IFCMONETARYUNIT(.EUR.);", "an encoded label");
    assert_eq!(convert("#5=IFCMONETARYUNIT(.USD.);", "IFC2X3", "IFC5").0, "#5=IFCMONETARYUNIT('USD');");
    assert_eq!(convert("#5=IFCMONETARYUNIT('USD');", "IFC5", "IFC2X3").0, "#5=IFCMONETARYUNIT(.USD.);");
}

/// Claude review on #10806 (discussion_r4641418586): the dotless i of `ıNR`
/// folds to `I` only under Unicode case rules, and JS trims a U+FEFF Rust does
/// not; the twins fold case and trim whitespace ASCII only, so neither label
/// names a member.
#[test]
fn a_non_ascii_letter_or_space_names_no_currency_10778() {
    assert_eq!(convert("#5=IFCMONETARYUNIT('\\X2\\0131\\X0\\NR');", "IFC4", "IFC2X3"), ("#5=IFCMONETARYUNIT($);".to_owned(), 1));
    assert_eq!(convert("#5=IFCMONETARYUNIT('\\X2\\FEFF\\X0\\INR');", "IFC4", "IFC2X3"), ("#5=IFCMONETARYUNIT($);".to_owned(), 1));
    assert_eq!(convert("#5=IFCMONETARYUNIT(' inr ');", "IFC4", "IFC2X3").0, "#5=IFCMONETARYUNIT(.INR.);");
    // Raw, not encoded: a byte-order mark and a no-break space in the literal itself.
    for raw in ["\u{FEFF}INR", "INR\u{A0}"] {
        assert_eq!(convert(&format!("#5=IFCMONETARYUNIT('{raw}');"), "IFC4", "IFC2X3"), ("#5=IFCMONETARYUNIT($);".to_owned(), 1), "{raw:?}");
    }
}

/// A label IFC2X3 has no member for is dropped and counted, and the required
/// slot left `$` is reported by the slot fill.
#[test]
fn a_label_with_no_ifc2x3_member_is_dropped_and_counted_10778() {
    assert_eq!(convert("#5=IFCMONETARYUNIT('Bitcoin');", "IFC4", "IFC2X3"), ("#5=IFCMONETARYUNIT($);".to_owned(), 1));
    let mut slots = Ifc2x3SlotFill::new(None);
    convert_step_line("#5=IFCMONETARYUNIT('XBT');", "IFC4", "IFC2X3", 5, &mut slots, None).unwrap();
    assert_eq!(slots.required_slots_unfilled(), 1);
    assert_eq!(convert("#5=IFCMONETARYUNIT($);", "IFC4", "IFC2X3"), ("#5=IFCMONETARYUNIT($);".to_owned(), 0));
}

#[test]
fn other_types_and_schema_pairs_are_left_alone_10778() {
    assert_eq!(convert("#5=IFCMONETARYUNIT('EUR');", "IFC4", "IFC4X3").0, "#5=IFCMONETARYUNIT('EUR');");
    assert_eq!(convert("#5=IFCLABELLED(.EUR.);", "IFC2X3", "IFC4").0, "#5=IFCLABELLED(.EUR.);");
}

/// A comment beside the value does not hide it.
#[test]
fn a_comment_beside_the_currency_is_read_past_10778() {
    assert_eq!(convert("#5=IFCMONETARYUNIT(/* c */.EUR. /* d */);", "IFC2X3", "IFC4").0, "#5=IFCMONETARYUNIT('EUR');");
    assert_eq!(convert("#5=IFCMONETARYUNIT(/* c */'EUR'/* d */);", "IFC4", "IFC2X3").0, "#5=IFCMONETARYUNIT(.EUR.);");
    assert_eq!(sole_value("'a/*b*/'"), Some("'a/*b*/'"), "a comment opener inside a literal is text");
    assert_eq!(sole_value(".EUR. .USD."), None, "two tokens are not one value");
}
