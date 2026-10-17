// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Behaviour the C6 data-model refactors must carry over unchanged (C6-0, #7783).
//!
//! Every assertion states what `main` does today, on the in-tree synthetic
//! file `fixtures/c6_data_model_synthetic.ifc`. They are pins, not
//! endorsements: where today's output is a known wart (the `Number` quantity
//! and the five non-single property kinds are dropped; a `-inf` cell is
//! formula-guarded), the C6 PR that changes it re-pins the line and says why.
//!
//! * Non-finite data (D13/D19/D45): `IFCREAL(1.E400)`, `IFCLENGTHMEASURE(-1.E400)`
//!   and a `1.E400` quantity render as `inf`/`-inf` text in the rows, CSV and
//!   JSON-LD, and as the strings `"inf"`/`"-inf"` in JSON, never as `null`.
//! * Inheritance (opt-in): a type's sets are merged into its occurrence, the
//!   occurrence wins a name collision.
//! * An occurrence typed twice takes its inherited sets from the first
//!   `IfcRelDefinesByType` in file order.
//! * Lowercase keywords, a repeated `#id`.

use ifc_lite_export::{
    build_export_model_with_options, export_csv, export_json, export_jsonld, CsvMode, CsvOptions, EntityRow,
    JsonLdOptions, JsonOptions, ModelOptions,
};
use serde_json::Value;

const SYNTHETIC: &[u8] = include_bytes!("fixtures/c6_data_model_synthetic.ifc");

fn rows(inherit: bool, attributes: bool) -> Vec<EntityRow> {
    let opts = ModelOptions::default().with_inherit_type_properties(inherit).with_attributes(attributes);
    build_export_model_with_options(SYNTHETIC, &opts).entities
}

fn row(rows: &[EntityRow], id: u32) -> &EntityRow {
    rows.iter().find(|r| r.express_id == id).unwrap_or_else(|| panic!("no row for #{id}"))
}

fn pset_names(r: &EntityRow) -> Vec<&str> {
    r.property_sets.iter().map(|p| p.name.as_str()).collect()
}

#[test]
fn non_finite_values_keep_today_s_tokens_in_the_rows() {
    let rows = rows(false, false);
    let wall = row(&rows, 330);
    assert_eq!(wall.lookup("Pset_NonFinite", "HugeReal").as_deref(), Some("inf"));
    assert_eq!(wall.lookup("Pset_NonFinite", "HugeNegativeLength").as_deref(), Some("-inf"));
    assert_eq!(wall.lookup("Pset_NonFinite", "Finite").as_deref(), Some("1.5"));
    let huge = &wall.quantity_sets.iter().find(|q| q.name == "Qto_NonFinite").expect("Qto_NonFinite").quantities[0];
    assert_eq!((huge.name.as_str(), huge.kind), ("Huge", "Length"));
    assert!(huge.value.is_infinite() && huge.value > 0.0, "{}", huge.value);
}

#[test]
fn non_finite_values_keep_today_s_tokens_in_csv_json_and_jsonld() {
    let props = export_csv(SYNTHETIC, CsvMode::Properties, &CsvOptions::default());
    assert!(props.contains(",Pset_NonFinite,HugeReal,inf,IFCREAL\n"), "{props}");
    // A cell starting with `-` is spreadsheet-formula guarded.
    assert!(props.contains(",Pset_NonFinite,HugeNegativeLength,'-inf,IFCLENGTHMEASURE\n"), "{props}");
    let quantities = export_csv(SYNTHETIC, CsvMode::Quantities, &CsvOptions::default());
    assert!(quantities.contains(",Qto_NonFinite,Huge,inf,Length"), "{quantities}");

    let json: Value = serde_json::from_str(&export_json(SYNTHETIC, &JsonOptions::default())).unwrap();
    let wall = json.as_array().unwrap().iter().find(|e| e["expressId"] == 330).expect("wall #330");
    let props = &wall["propertySets"][0]["properties"];
    assert_eq!(props[0]["value"], "inf");
    assert_eq!(props[1]["value"], "-inf");
    assert_eq!(props[2]["value"], 1.5);
    assert_eq!(wall["quantitySets"][0]["quantities"][0]["value"], "inf");

    let ld = export_jsonld(SYNTHETIC, &JsonLdOptions::default());
    assert!(ld.contains(r#""ifc:name":"HugeReal","ifc:nominalValue":"inf""#), "{ld}");
    assert!(ld.contains(r#""ifc:name":"HugeNegativeLength","ifc:nominalValue":"-inf""#), "{ld}");
}

#[test]
fn inheritance_is_opt_in_and_the_occurrence_wins() {
    let own = rows(false, false);
    assert_eq!(pset_names(row(&own, 310)), ["Pset_Occurrence"]);
    assert!(row(&own, 310).quantity_sets.is_empty());

    let merged = rows(true, false);
    let wall = row(&merged, 310);
    // The occurrence's own set first, then what the type adds.
    assert_eq!(pset_names(wall), ["Pset_Occurrence", "Pset_AllKinds"]);
    assert_eq!(wall.quantity_sets.iter().map(|q| q.name.as_str()).collect::<Vec<_>>(), ["Qto_AllKinds"]);
    // `Pset_Occurrence.Text` is the occurrence's; a type set of the same name would only add to it.
    assert_eq!(wall.lookup("Pset_Occurrence", "Text").as_deref(), Some("occurrence wins"));
    // Only the single-valued kinds of `Pset_AllKinds` are decoded today (EXPORT-DATA-2, C6-7).
    let all_kinds = wall.property_sets.iter().find(|p| p.name == "Pset_AllKinds").unwrap();
    let names: Vec<_> = all_kinds.properties.iter().map(|p| p.name.as_str()).collect();
    assert_eq!(names, ["Text", "Flag", "Unknown", "Thickness"]);
    // `IfcQuantityNumber` is dropped by the flat export (C6-14).
    let qto = &wall.quantity_sets[0];
    let kinds: Vec<_> = qto.quantities.iter().map(|q| q.kind).collect();
    assert_eq!(kinds, ["Length", "Area", "Volume", "Count", "Weight", "Time"]);
}

#[test]
fn an_occurrence_typed_twice_takes_the_first_relationship_in_file_order() {
    let merged = rows(true, false);
    // #310 is related to type A (#352) before type B (#353): B's `Pset_TypeB` never arrives.
    let wall = row(&merged, 310);
    assert!(wall.lookup("Pset_TypeB", "TypeOnly").is_none(), "{:?}", pset_names(wall));
    assert!(wall.lookup("Pset_AllKinds", "Text").is_some());
    // #320 is typed once, by A, and has its own `Pset_Duplicate` (repeated #50: the later record wins).
    let single = row(&merged, 320);
    assert_eq!(pset_names(single), ["Pset_Duplicate", "Pset_AllKinds"]);
    assert_eq!(single.lookup("Pset_Duplicate", "Dup").as_deref(), Some("second #50"));
}

#[test]
fn lowercase_keywords_decode_like_uppercase_ones() {
    let rows = rows(false, false);
    let wall = row(&rows, 330);
    assert_eq!(wall.ifc_type, "IfcWall");
    assert_eq!(wall.name.as_deref(), Some("lowercase wall"));
    // Attached through a lowercase `ifcreldefinesbyproperties`.
    assert_eq!(wall.lookup("Pset_AllKinds", "Flag").as_deref(), Some("true"));
    assert_eq!(wall.lookup("Pset_AllKinds", "Unknown").as_deref(), Some("unknown"));
    assert_eq!(wall.lookup("Pset_AllKinds", "Text").as_deref(), Some("Fire \u{e4} proof"));
}

#[test]
fn attributes_render_what_the_class_declares_and_skip_unset_ones() {
    let rows = rows(false, true);
    let wall = row(&rows, 310);
    let attrs: Vec<_> = wall.attributes.iter().map(|a| (a.name.as_str(), a.value.as_str(), a.value_type.as_str())).collect();
    assert_eq!(attrs, [("Tag", "T310", "IFCTEXT"), ("PredefinedType", "STANDARD", "IFCENUM")]);
    assert!(row(&rows, 320).attributes.is_empty());
    let storey = row(&rows, 12);
    assert!(storey.attributes.iter().any(|a| a.name == "Elevation" && a.value == "0" && a.value_type == "IFCREAL"));
    // Off by default.
    assert!(row(&self::rows(false, false), 310).attributes.is_empty());
}

/// EXPORT-DATA-3 (D42, C6-9): `relationships().type_of` agrees with the
/// inheritance merge above: #310 is typed by A (#352 relates it to #350) before
/// B (#353 relates it to #351), and A wins. It used to take B, the last.
#[test]
fn relationships_type_of_takes_the_first_type_like_the_inheritance_merge() {
    let rel = ifc_lite_export::relationships(SYNTHETIC);
    assert_eq!(rel.type_of.get(&310), Some(&350));
    assert_eq!(rel.type_of.get(&320), Some(&350));
}
