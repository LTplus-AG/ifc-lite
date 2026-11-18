// SPDX-License-Identifier: MPL-2.0
//! Rust half of the structural carrier parity pin (#10597): CausedBy as a
//! 'Causes' relationship, both directions. The TypeScript half is
//! `packages/export/src/structural-carriers.parity.test.ts`; both read one fixture.

#[derive(serde::Deserialize)]
struct Case {
    why: String,
    from: String,
    to: String,
    data: String,
    select: Vec<String>,
    expect: Vec<String>,
}

#[test]
fn every_case_agrees_with_the_shared_fixture() {
    let doc: serde_json::Value = serde_json::from_str(include_str!("fixtures/structural_carriers_parity.json")).expect("fixture is valid JSON");
    let owner = doc["owner"].as_str().expect("owner");
    let cases: Vec<Case> = serde_json::from_value(doc["cases"].clone()).expect("cases deserialize");
    assert!(cases.len() >= 4, "anti-vacuity: fixture holds {} cases", cases.len());
    let mut bad = Vec::new();
    for c in &cases {
        let src = format!(
            "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('t','',(''),(''),'','','');\nFILE_SCHEMA(('{}'));\nENDSEC;\nDATA;\n{owner}\n{}\nENDSEC;\nEND-ISO-10303-21;\n",
            c.from, c.data
        );
        let out = ifc_lite_export::export_step_json(src.as_bytes(), Some(c.to.clone()), None, "").expect("export_step_json");
        let got: Vec<&str> = out.lines().filter(|l| l.starts_with('#') && c.select.iter().any(|s| l.contains(s.as_str()))).collect();
        if got != c.expect {
            bad.push(format!("{} -> {} [{}]\n  expect {:#?}\n  got    {:#?}", c.from, c.to, c.why, c.expect, got));
        }
    }
    assert!(bad.is_empty(), "{} mismatches:\n{}", bad.len(), bad.join("\n"));
}
