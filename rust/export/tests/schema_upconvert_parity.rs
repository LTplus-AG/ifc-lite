// SPDX-License-Identifier: MPL-2.0
//! Rust half of the schema-upconversion padding pin.
//!
//! `packages/export/src/schema-converter.ts` pads the trailing optional
//! attributes a newer target schema APPENDED (#1416). The Rust port in
//! `rust/export/src/schema_convert.rs` did not, and it is the Rust one that
//! `ifc-lite export --format step --schema IFC4` actually runs (via
//! `exportStep` in the wasm bindings), so every upgraded IfcWall / IfcBeam /
//! IfcOpeningElement / ... came out a positional attribute short -- an
//! invalid file that strict readers reject.
//!
//! Both implementations are now held to ONE fixture
//! (`fixtures/schema_upconvert_sweep.json`); the TypeScript half is
//! `packages/export/src/schema-upconvert-sweep.parity.test.ts`. Following the
//! `rooted_type_parity.rs` precedent, WHICH rows the fixture must contain is
//! pinned here rather than by a count: `fixture_names_every_padded_type`
//! re-derives the required names from `schema_pad`'s own tables, so a row
//! that is deleted -- the failure a `cases.len() > N` floor sleeps through --
//! fails loudly, while adding a type to the tables without a fixture row
//! fails too.
//!
//! Exercised through the public `export_step_json`, not a private helper: the
//! path the CLI takes, header and all.

use std::collections::BTreeSet;

#[derive(serde::Deserialize)]
struct Case {
    why: String,
    from: String,
    to: String,
    line: String,
    expect: String,
}

fn cases() -> Vec<Case> {
    let raw = include_str!("fixtures/schema_upconvert_sweep.json");
    let doc: serde_json::Value = serde_json::from_str(raw).expect("fixture is valid JSON");
    serde_json::from_value(doc["cases"].clone()).expect("cases deserialize")
}

/// Wrap one entity line in a minimal STEP file declaring `schema` and run the
/// real exporter, returning the converted entity line.
fn convert_through_exporter(line: &str, from: &str, to: &str) -> String {
    let src = format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\n\
         FILE_NAME('t','',(''),(''),'','','');\nFILE_SCHEMA(('{from}'));\nENDSEC;\n\
         DATA;\n{line}\nENDSEC;\nEND-ISO-10303-21;\n"
    );
    let out = ifc_lite_export::export_step_json(src.as_bytes(), Some(to.to_string()), None, "")
        .expect("export_step_json");
    out.lines()
        .find(|l| l.starts_with('#'))
        .unwrap_or_else(|| panic!("no entity line in output:\n{out}"))
        .to_string()
}

#[test]
fn every_case_agrees_with_the_shared_fixture() {
    let cases = cases();
    assert!(cases.len() > 100, "anti-vacuity: fixture holds {} cases", cases.len());
    let mut bad = Vec::new();
    for c in &cases {
        let got = convert_through_exporter(&c.line, &c.from, &c.to);
        if got != c.expect {
            bad.push(format!(
                "{} -> {} [{}]\n  in     {}\n  expect {}\n  got    {}",
                c.from, c.to, c.why, c.line, c.expect, got
            ));
        }
    }
    assert!(bad.is_empty(), "{} mismatches:\n{}", bad.len(), bad.join("\n"));
}

/// Coverage gate: every type the padding tables act on must be NAMED by a
/// fixture row, and every padded row must correspond to a table entry. A
/// count floor passes both when rows are silently dropped and when a type is
/// added to the tables with no row to pin it.
#[test]
fn fixture_names_every_padded_type() {
    let required: BTreeSet<(String, String, String)> = ifc_lite_export::padded_type_universe()
        .into_iter()
        .map(|(f, t, n)| (f.to_string(), t.to_string(), n.to_string()))
        .collect();
    assert!(required.len() > 100, "anti-vacuity: universe is {}", required.len());

    let named: BTreeSet<(String, String, String)> = cases()
        .iter()
        .filter_map(|c| {
            let ty = c.line.split_once('=')?.1.split_once('(')?.0.to_string();
            required
                .contains(&(c.from.clone(), c.to.clone(), ty.clone()))
                .then_some((c.from.clone(), c.to.clone(), ty))
        })
        .collect();

    let missing: Vec<_> = required.difference(&named).collect();
    assert!(missing.is_empty(), "fixture names no case for: {missing:?}");
}

/// Negative control: the padding must be a no-op wherever the target schema
/// did not APPEND. Deleting the strict-prefix restriction and padding every
/// short line would still pass `every_case_agrees_with_the_shared_fixture`'s
/// positive rows; it fails here.
#[test]
fn a_reordered_attribute_list_is_never_padded() {
    let got = convert_through_exporter("#7=IFCMATERIALPROPERTIES(#8);", "IFC2X3", "IFC4");
    assert_eq!(
        got, "#7=IFCMATERIALPROPERTIES(#8);",
        "IFC2X3 IfcMaterialProperties is [Material]; IFC4 is \
         [Name, Description, Properties, Material] -- padding would read #8 as the Name"
    );
}
