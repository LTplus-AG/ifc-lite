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
//! `packages/export/src/schema-upconvert-sweep.parity.test.ts`. Since #7683 the
//! fixture also pins the TRIM half in both directions (an IFC4 quantity's
//! `Formula` on a downgrade, IfcDistributionControlElement's
//! `ControlElementId` on an upgrade). WHICH rows the fixture must contain is
//! pinned by a count-free coverage gate that re-derives every trimmed or
//! padded type from core's EXPRESS registry:
//! `sweep_fixture_names_every_trimmed_and_padded_type_7683` in
//! `src/schema_registry_tests.rs`, a unit test because it needs the
//! converter's private rename tables.
//!
//! Exercised through the public `export_step_json`, not a private helper: the
//! path the CLI takes, header and all.

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

/// Replace the GlobalId of an `IFCPROXY(` line with `<MINTED>`, returning the
/// normalised line and the GlobalId it held.
fn mask_proxy_guid(line: &str) -> (String, String) {
    let Some(at) = line.find("IFCPROXY('") else { return (line.to_string(), String::new()) };
    let start = at + "IFCPROXY('".len();
    let end = start + line[start..].find('\'').expect("closing quote");
    (format!("{}<MINTED>{}", &line[..start - 1], &line[end + 1..]), line[start..end].to_string())
}

/// EXPORT-MERGE-8 (#7683): the IFCPROXY an IFC4X3 alignment product becomes
/// below IFC4X3, held to the vectors the TypeScript twin also runs
/// (`fixtures/schema_product_proxy_vectors.json`). The GlobalId is minted
/// differently on each side, so it is masked and asserted only to differ
/// from the source's.
#[test]
fn product_proxy_vectors_agree_with_the_shared_fixture_7683() {
    let raw = include_str!("fixtures/schema_product_proxy_vectors.json");
    let doc: serde_json::Value = serde_json::from_str(raw).expect("fixture is valid JSON");
    let cases: Vec<Case> = serde_json::from_value(doc["cases"].clone()).expect("cases deserialize");
    assert!(cases.len() >= 5, "anti-vacuity");
    for c in &cases {
        let got = convert_through_exporter(&c.line, &c.from, &c.to);
        let (masked, guid) = mask_proxy_guid(&got);
        assert_eq!(masked, c.expect, "{} -> {} [{}]", c.from, c.to, c.why);
        let source_guid = c.line.split('\'').nth(1).expect("source GlobalId");
        assert!(!guid.is_empty() && guid != source_guid, "minted, not copied: {got}");
    }
}
