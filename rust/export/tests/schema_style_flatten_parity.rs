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

fn file(from: &str, records: &[&str]) -> String {
    format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\n\
         FILE_NAME('t','',(''),(''),'','','');\nFILE_SCHEMA(('{from}'));\nENDSEC;\nDATA;\n{}\nENDSEC;\nEND-ISO-10303-21;\n",
        records.join("\n")
    )
}

/// An assignment the editor created (log-created) and the styled item that
/// names it flatten like a source one: an IFC2X3 model with a style applied in
/// the editor must export to IFC4X3 (review of #7801, finding 3).
#[test]
fn a_log_created_assignment_is_flattened_d59() {
    let source = file("IFC2X3", &["#1=IFCCARTESIANPOINT((0.,0.,0.));", "#3=IFCSURFACESTYLE('s',.BOTH.,());"]);
    let log = ifc_lite_export::MutationLog::from_json(
        r##"{"mutations":[{"type":"CREATE_ENTITY","entityId":21,"attributeName":"IfcStyledItem"},
                         {"type":"CREATE_ENTITY","entityId":20,"attributeName":"IfcPresentationStyleAssignment"}],
            "newEntities":[{"expressId":21,"type":"IfcStyledItem","attributes":["#1",["#20"],null]},
                           {"expressId":20,"type":"IfcPresentationStyleAssignment","attributes":[["#3"]]}]}"##,
    )
    .unwrap();
    let opts = ifc_lite_export::StepOptions { schema: Some("IFC4X3".into()), ..Default::default() };
    let (out, _) = ifc_lite_export::export_step_with_log(source.as_bytes(), &opts, &log).expect("exports");
    assert!(!out.contains("IFCPRESENTATIONSTYLEASSIGNMENT"), "{out}");
    assert!(out.contains("IFCSTYLEDITEM(#1,(#3),$)"), "{out}");
}

/// A copy-on-write copy of an assignment keeps the assignment's members (or the
/// edit's), and the styled item repointed at it flattens.
#[test]
fn a_copy_on_write_assignment_is_flattened_d59() {
    let source = file(
        "IFC2X3",
        &["#1=IFCCARTESIANPOINT((0.,0.,0.));", "#3=IFCSURFACESTYLE('s',.BOTH.,());", "#4=IFCSURFACESTYLE('t',.BOTH.,());",
          "#5=IFCPRESENTATIONSTYLEASSIGNMENT((#3));", "#6=IFCSTYLEDITEM(#1,(#5),$);"],
    );
    let opts = ifc_lite_export::StepOptions {
        schema: Some("IFC4X3".into()),
        copy_on_write: vec![ifc_lite_export::CopyOnWriteMutation {
            express_id: 5,
            index: 0,
            value: "(#4)".into(),
            referrer_id: 6,
            referrer_index: 1,
        }],
        ..Default::default()
    };
    let out = export_step_json_opts(&source, &opts);
    assert!(!out.contains("IFCPRESENTATIONSTYLEASSIGNMENT"), "{out}");
    assert!(out.contains("IFCSTYLEDITEM(#1,(#4),$)"), "{out}");
}

fn export_step_json_opts(source: &str, opts: &ifc_lite_export::StepOptions) -> String {
    let mut buf = Vec::new();
    ifc_lite_export::export_step_to_writer(source.as_bytes(), opts, &mut buf).expect("exports");
    String::from_utf8(buf).unwrap()
}

/// A log edit of a SOURCE assignment's `Styles` reaches the flatten: the styled
/// item gets the edited members, not the source ones (#7801 round 3).
#[test]
fn a_log_edit_of_a_source_assignment_is_flattened() {
    let source = file(
        "IFC2X3",
        &["#1=IFCCARTESIANPOINT((0.,0.,0.));", "#3=IFCSURFACESTYLE('s',.BOTH.,());", "#4=IFCSURFACESTYLE('t',.BOTH.,());",
          "#6=IFCSTYLEDITEM(#1,(#5),$);", "#5=IFCPRESENTATIONSTYLEASSIGNMENT((#3));"],
    );
    let log = ifc_lite_export::MutationLog::from_json(
        r##"{"mutations":[{"type":"UPDATE_ATTRIBUTE","entityId":5,"attributeName":"Styles","newValue":["#4"]}]}"##,
    )
    .unwrap();
    let opts = ifc_lite_export::StepOptions { schema: Some("IFC4X3".into()), ..Default::default() };
    let (out, _) = ifc_lite_export::export_step_with_log(source.as_bytes(), &opts, &log).expect("exports");
    assert!(!out.contains("IFCPRESENTATIONSTYLEASSIGNMENT"), "{out}");
    assert!(out.contains("IFCSTYLEDITEM(#1,(#4),$)"), "{out}");
}

/// Without a conversion nothing flattens: a log-created assignment is written.
#[test]
fn a_log_created_assignment_is_kept_without_a_conversion() {
    let source = file("IFC4", &["#1=IFCCARTESIANPOINT((0.,0.,0.));", "#3=IFCSURFACESTYLE('s',.BOTH.,());"]);
    let log = ifc_lite_export::MutationLog::from_json(
        r##"{"mutations":[{"type":"CREATE_ENTITY","entityId":20,"attributeName":"IfcPresentationStyleAssignment"}],
            "newEntities":[{"expressId":20,"type":"IfcPresentationStyleAssignment","attributes":[["#3"]]}]}"##,
    )
    .unwrap();
    let (out, _) = ifc_lite_export::export_step_with_log(source.as_bytes(), &Default::default(), &log).expect("exports");
    assert!(out.contains("#20=IFCPRESENTATIONSTYLEASSIGNMENT((#3));"), "{out}");
}
