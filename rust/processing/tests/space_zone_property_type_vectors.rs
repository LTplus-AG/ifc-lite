// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Pins `processor::properties::resolve_space_zone_properties_lazy` (via
//! `process_geometry`) to the SAME shared fixture as its TypeScript
//! counterpart, `packages/parser/src/space-zone-property.parity.test.ts`
//! (which drives `extractPropertiesOnDemand` /
//! `property-value-parser.ts::parsePropertyValueWithComplex`).
//!
//! `properties.rs` previously carried a doc comment claiming byte-identical
//! "Parity", but the comparison it actually verified was against this
//! crate's OWN earlier eager decode path, never against the TypeScript
//! property extractor it is a twin of for `IfcSpace`/`IfcZone` — see the
//! corrected doc comment on `resolve_space_zone_properties_lazy`. This test
//! is the first thing that actually runs both sides on one fixture and
//! records where they agree and where they structurally differ.
//!
//! Both sides land on the SAME resolved values (modulo Rust's compact,
//! always-a-string output shape — see below); nothing here is a defect. The
//! two structural differences are pinned so a future change can't silently
//! reintroduce them as a live bug once (if ever) `MeshData::properties` gets
//! a real downstream reader:
//!
//! 1. **Type erasure.** `MeshData::properties` is `BTreeMap<String, String>`,
//!    not a typed value — every property, including booleans/logicals, comes
//!    out as its bare enumeration token (`.T.` -> `"T"`, `.U.` -> `"U"`).
//!    TypeScript's on-demand extractor preserves the IFC-declared TYPE
//!    (`PropertyValueType.Boolean`/`.Logical`) for the property panel. This
//!    is a real printed-text divergence if the two are ever compared
//!    side-by-side, but as of this test `MeshData::properties` has no
//!    downstream reader (the wasm bridge explicitly drops it — see
//!    `rust/wasm-bindings/src/zero_copy/mesh.rs`), so there is nothing today
//!    a user could see disagree.
//! 2. **Absent-value handling.** `$` (unset) NominalValue is dropped
//!    entirely from the Rust map (no key at all); the TS panel keeps the
//!    property with a `null` value so the panel can still show the property
//!    exists. Neither is wrong for its own consumer.
//!
//! The `\S\`/`\X2\...\X0\` STEP character-escape decoding (attribute-parse
//! time, ahead of both extractors) is NOT re-verified here — that is
//! `entity-extractor.ts`'s `decodeIfcString` on the TS side and
//! `ifc_lite_core`'s decoder on the Rust side, both exercised by their own
//! scanner/tokenizer suites. This fixture only checks that the DECODED text
//! reaches the property value unchanged on both sides.

use ifc_lite_processing::process_geometry;
use std::collections::BTreeMap;

fn fixture_ifc() -> String {
    let json_text = include_str!("fixtures/space_zone_property_type_vectors.json");
    let json: serde_json::Value = serde_json::from_str(json_text).expect("valid JSON fixture");
    json["ifc"].as_str().expect("ifc field").to_string()
}

fn space_properties() -> BTreeMap<String, String> {
    let ifc = fixture_ifc();
    let result = process_geometry(ifc.as_bytes());
    let space = result
        .meshes
        .iter()
        .find(|m| m.express_id == 30)
        .expect("IfcSpace #30 should produce a mesh");
    space
        .properties
        .clone()
        .expect("space mesh should carry space_zone_properties")
}

#[test]
fn resolves_every_supported_value_kind_to_its_printed_form() {
    let props = space_properties();

    // Plain text (also exercises the \S\ escape, decoded ahead of this
    // extractor: 'e' shifted +128 -> "å").
    assert_eq!(props.get("TextProp").map(String::as_str), Some("Cafå"));
    // Numeric measures stringify via Display, matching the TS panel's
    // printed number.
    assert_eq!(props.get("RealProp").map(String::as_str), Some("3.5"));
    assert_eq!(props.get("IntProp").map(String::as_str), Some("4"));
    // IfcPropertyEnumeratedValue: single-entry enumeration list.
    assert_eq!(props.get("EnumProp").map(String::as_str), Some("Red"));
    // \X2\00E9\X0\ decodes to the same "é" both sides see.
    assert_eq!(props.get("UnicodeProp").map(String::as_str), Some("café"));
}

#[test]
fn booleans_and_logicals_lose_their_declared_type_stringifying_to_the_bare_token() {
    // Documents divergence (1) from the module doc comment: the TS side
    // preserves `PropertyValueType.Boolean`/`.Logical`; this map cannot,
    // since its value type is `String`. A future reader of this field that
    // wants boolean-shaped output must convert "T"/"F"/"U" itself.
    let props = space_properties();
    assert_eq!(props.get("BoolProp").map(String::as_str), Some("T"));
    assert_eq!(props.get("LogicalProp").map(String::as_str), Some("U"));
}

#[test]
fn absent_nominal_value_is_dropped_rather_than_kept_as_an_empty_entry() {
    // Documents divergence (2): the TS panel keeps `AbsentProp` with a
    // `null` value so the property is still listed; this map omits the key
    // entirely.
    let props = space_properties();
    assert!(!props.contains_key("AbsentProp"));
    assert!(!props.contains_key("PsetA.AbsentProp"));
}

#[test]
fn same_named_property_in_two_psets_survives_under_its_scoped_key() {
    // PsetA and PsetB both declare `TextProp`. The unscoped key is
    // first-wins (PsetA, decoded first in file/scan order); BOTH pset-scoped
    // aliases survive, so no value is actually lost — a caller that reads
    // the scoped key sees the right value for either pset.
    let props = space_properties();
    assert_eq!(props.get("TextProp").map(String::as_str), Some("Cafå"));
    assert_eq!(props.get("PsetA.TextProp").map(String::as_str), Some("Cafå"));
    assert_eq!(
        props.get("PsetB.TextProp").map(String::as_str),
        Some("Overridden")
    );
}
