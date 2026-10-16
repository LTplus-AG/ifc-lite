// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Rust half of the `RelatingPropertyDefinition` parity pin (#7681). The
//! TypeScript half is `packages/parser/src/property-definition-refs.parity.test.ts`;
//! both read `tests/fixtures/property_definition_refs_vectors.json`, whose
//! `_comment` says what each field means. A shape one half reads and the other
//! drops is a property set the viewer and the exports disagree about.

use ifc_lite_core::{build_entity_index, EntityDecoder};

#[test]
fn get_refs_matches_the_shared_property_definition_vectors() {
    let raw = include_str!("fixtures/property_definition_refs_vectors.json");
    let doc: serde_json::Value = serde_json::from_str(raw).expect("fixture is valid JSON");
    let cases = doc["cases"].as_array().expect("cases is an array");
    assert!(cases.len() >= 15, "expected the vectors, found {}", cases.len());

    for case in cases {
        let name = case["name"].as_str().expect("name is a string");
        let attr5 = case["attr5"].as_str().expect("attr5 is a string");
        let decodes = case["decodes"].as_bool().unwrap_or(true);
        let want: Option<Vec<u32>> = case["refs"]
            .as_array()
            .map(|ids| ids.iter().map(|id| id.as_u64().expect("an id") as u32).collect());

        let content = format!(
            "ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n\
             #1=IFCRELDEFINESBYPROPERTIES('g',$,$,$,(#50),{attr5});\n\
             ENDSEC;\nEND-ISO-10303-21;\n"
        );
        let bytes = content.as_bytes();
        let mut decoder = EntityDecoder::with_index(bytes, build_entity_index(bytes));
        match decoder.decode_by_id(1) {
            Ok(entity) => {
                assert!(decodes, "case `{name}`: expected the record not to decode");
                assert_eq!(entity.get_refs(5), want, "case `{name}`: {attr5}");
            }
            Err(_) => assert!(!decodes, "case `{name}`: expected {attr5:?} to decode"),
        }
    }
}
