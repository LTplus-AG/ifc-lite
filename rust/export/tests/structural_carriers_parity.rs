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
    expect: Vec<String>,
}

#[test]
fn every_case_agrees_with_the_shared_fixture() {
    let doc: serde_json::Value = serde_json::from_str(include_str!("fixtures/structural_carriers_parity.json")).expect("fixture is valid JSON");
    let owner = doc["owner"].as_str().expect("owner");
    let select_ids: Vec<u32> = serde_json::from_value(doc["selectIds"].clone()).expect("record ids");
    let select_types: Vec<String> = serde_json::from_value(doc["selectTypes"].clone()).expect("entity types");
    let cases: Vec<Case> = serde_json::from_value(doc["cases"].clone()).expect("cases deserialize");
    assert!(cases.len() >= 4, "anti-vacuity: fixture holds {} cases", cases.len());
    let mut bad = Vec::new();
    for c in &cases {
        assert!(c.expect.iter().any(|line| line.split_once('=').is_some_and(|(_, body)| body.starts_with("IFCSTRUCTURAL"))),
            "{}: fixture must pin a structural record", c.why);
        let src = format!(
            "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('t','',(''),(''),'','','');\nFILE_SCHEMA(('{}'));\nENDSEC;\nDATA;\n{owner}\n{}\nENDSEC;\nEND-ISO-10303-21;\n",
            c.from, c.data
        );
        let out = ifc_lite_export::export_step_json(src.as_bytes(), Some(c.to.clone()), None, "").expect("export_step_json");
        let got: Vec<&str> = out.lines().filter(|line| {
            let Some((id, body)) = line.strip_prefix('#').and_then(|record| record.split_once('=')) else { return false };
            if !id.bytes().all(|byte| byte.is_ascii_digit()) { return false; }
            let Ok(id) = id.parse::<u32>() else { return false };
            let Some((entity_type, _)) = body.split_once('(') else { return false };
            if entity_type.is_empty() || !entity_type.bytes().all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_') { return false; }
            select_ids.contains(&id) || select_types.iter().any(|ty| ty == entity_type)
        }).collect();
        if got != c.expect {
            bad.push(format!("{} -> {} [{}]\n  expect {:#?}\n  got    {:#?}", c.from, c.to, c.why, c.expect, got));
        }
    }
    assert!(bad.is_empty(), "{} mismatches:\n{}", bad.len(), bad.join("\n"));
}
