// SPDX-License-Identifier: MPL-2.0
//! Rust half of the `IfcPresentationStyleAssignment` flatten pin (#7742, D57),
//! plus the corpus probe: duplex and IfcOpenHouse export to IFC4X3 (they did on
//! main) with no assignment left and no reference to a record that is not
//! written. TypeScript half: `packages/export/src/schema-style-flatten.parity.test.ts`.

use ifc_lite_export::export_step_json;

#[derive(serde::Deserialize)]
struct Case {
    why: String,
    from: String,
    to: String,
    records: Vec<String>,
    expect: Vec<String>,
}

fn export(from: &str, to: &str, records: &[String]) -> Result<String, String> {
    let src = format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\n\
         FILE_NAME('t','',(''),(''),'','','');\nFILE_SCHEMA(('{from}'));\nENDSEC;\nDATA;\n{}\nENDSEC;\nEND-ISO-10303-21;\n",
        records.join("\n")
    );
    export_step_json(src.as_bytes(), Some(to.to_string()), None, "").map_err(|e| e.to_string())
}

fn records(out: &str) -> Vec<String> {
    out.lines().filter(|l| l.starts_with('#')).map(str::to_string).collect()
}

#[test]
fn every_case_agrees_with_the_shared_fixture_d57() {
    let doc: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/schema_style_flatten_vectors.json")).expect("valid JSON");
    let cases: Vec<Case> = serde_json::from_value(doc["cases"].clone()).expect("cases");
    assert!(cases.len() >= 8, "anti-vacuity");
    for c in &cases {
        let out = export(&c.from, &c.to, &c.records).unwrap_or_else(|e| panic!("{} -> {} [{}]: {e}", c.from, c.to, c.why));
        assert_eq!(records(&out), c.expect, "{} -> {} [{}]", c.from, c.to, c.why);
    }
}

/// Every `#n` named by a written record has a record in the output.
fn dangling(out: &str) -> Vec<u32> {
    let mut defined = std::collections::HashSet::new();
    let mut used = Vec::new();
    for line in out.lines().filter(|l| l.starts_with('#')) {
        let (head, body) = line.split_once('=').expect("record");
        defined.insert(head[1..].trim().parse::<u32>().expect("id"));
        let mut in_str = false;
        let b = body.as_bytes();
        let mut i = 0;
        while i < b.len() {
            match b[i] {
                b'\'' => in_str = !in_str,
                b'#' if !in_str => {
                    let n: String = body[i + 1..].chars().take_while(char::is_ascii_digit).collect();
                    if let Ok(v) = n.parse() {
                        used.push(v);
                    }
                }
                _ => {}
            }
            i += 1;
        }
    }
    used.retain(|u| !defined.contains(u));
    used
}

#[test]
fn duplex_and_open_house_export_to_ifc4x3_without_assignments_d57() {
    for name in ["ara3d/duplex.ifc", "ara3d/IfcOpenHouse_IFC4.ifc"] {
        let Some(content) = ifc_lite_testkit::fixture_bytes(name) else { continue };
        let before = String::from_utf8_lossy(&content).matches("IFCPRESENTATIONSTYLEASSIGNMENT(").count();
        assert!(before > 0, "{name}: anti-vacuity, the source holds assignments");
        let out = export_step_json(&content, Some("IFC4X3".to_string()), None, "")
            .unwrap_or_else(|e| panic!("{name} -> IFC4X3 must export: {e}"));
        assert!(!out.contains("IFCPRESENTATIONSTYLEASSIGNMENT"), "{name}: assignments left");
        assert!(out.matches("IFCSTYLEDITEM(").count() > 0, "{name}: styled items kept");
        let source_dangling = dangling(&String::from_utf8_lossy(&content));
        let new: Vec<u32> = dangling(&out).into_iter().filter(|r| !source_dangling.contains(r)).collect();
        assert!(new.is_empty(), "{name}: references to unwritten records: {new:?}");
    }
}
