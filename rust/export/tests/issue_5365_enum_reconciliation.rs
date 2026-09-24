// SPDX-License-Identifier: MPL-2.0
//! #5365, the Rust half of the enum-reconciliation charter: a schema
//! conversion must not carry an enum member the target schema does not define
//! into a file declaring that schema. Same cases as the TypeScript
//! `schema-converter-enums.test.ts`, through the public exports.

use ifc_lite_export::{
    export_merged_models, export_step_to_writer_with_report, export_step_with_report,
    export_step_with_stats, MergedModel, MergedOptions, StepOptions,
};

fn model(schema: &str, record: &str) -> String {
    format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('t.ifc','',(''),(''),'','','');\n\
         FILE_SCHEMA(('{schema}'));\nENDSEC;\nDATA;\n\
         #1=IFCPROJECT('0OSuGGYUFyIf0LtE29OSuG',$,'P',$,$,$,$,$,$);\n{record}\nENDSEC;\nEND-ISO-10303-21;\n"
    )
}

fn line_for(out: &str, id: &str) -> String {
    out.lines().find(|l| l.starts_with(&format!("{id}="))).unwrap_or_default().to_string()
}

fn merged(schema_in: &str, schema_out: &str, record: &str) -> (String, Vec<String>) {
    let content = model(schema_in, record);
    let inputs = [MergedModel::new(content.as_bytes())];
    let opts = MergedOptions { schema: Some(schema_out.to_string()), ..MergedOptions::default() };
    let (out, stats) = export_merged_models(&inputs, &opts);
    (out, stats.warnings.into_iter().filter(|w| w.contains("#5365")).collect())
}

#[test]
fn ifc4x3_turnstile_becomes_userdefined_in_ifc4_with_the_name_in_element_type() {
    let (out, warnings) = merged(
        "IFC4X3_ADD2",
        "IFC4",
        "#20=IFCDOORTYPE('1a2B3c4D5e6F7g8H9i0J1k',$,'Turnstile',$,$,$,$,$,$,.TURNSTILE.,.SINGLE_SWING_LEFT.,.T.,$);",
    );
    let line = line_for(&out, "#20");
    assert!(line.contains("'TURNSTILE',.USERDEFINED."), "{line}");
    assert!(!line.contains(".TURNSTILE."), "{line}");
    assert!(warnings.is_empty(), "{warnings:?}");
}

#[test]
fn ifc4_louvre_becomes_userdefined_in_ifc2x3() {
    let (out, _) = merged(
        "IFC4",
        "IFC2X3",
        "#30=IFCAIRTERMINALTYPE('1a2B3c4D5e6F7g8H9i0J1k',$,'AT',$,$,$,$,$,$,.LOUVRE.);",
    );
    let line = line_for(&out, "#30");
    assert!(line.contains("'LOUVRE',.USERDEFINED."), "{line}");
}

#[test]
fn an_occupied_label_slot_is_reported() {
    let (out, warnings) = merged(
        "IFC4X3_ADD2",
        "IFC4",
        "#41=IFCDOOR('1a2B3c4D5e6F7g8H9i0J1k',$,'D',$,'Gate',$,$,$,$,$,.TURNSTILE.,$,$);",
    );
    assert!(line_for(&out, "#41").contains("'Gate',$,$,$,$,$,.USERDEFINED."), "{out}");
    assert_eq!(warnings.len(), 1, "{warnings:?}");
    assert!(warnings[0].contains("IFCDOOR.PredefinedType .TURNSTILE."), "{warnings:?}");
}

#[test]
fn single_model_export_rewrites_the_member_too() {
    let content = model(
        "IFC4X3_ADD2",
        "#20=IFCDOORTYPE('1a2B3c4D5e6F7g8H9i0J1k',$,'Turnstile',$,$,$,$,$,$,.TURNSTILE.,.SINGLE_SWING_LEFT.,.T.,$);",
    );
    let opts = StepOptions { schema: Some("IFC4".into()), ..Default::default() };
    let (out, _) = export_step_with_stats(content.as_bytes(), &opts).unwrap();
    assert!(line_for(&out, "#20").contains("'TURNSTILE',.USERDEFINED."), "{out}");
}

#[test]
fn a_member_the_target_defines_is_left_alone() {
    let record = "#50=IFCDOOR('1a2B3c4D5e6F7g8H9i0J1k',$,'D',$,$,$,$,$,$,$,.DOOR.,$,$);";
    let (out, warnings) = merged("IFC4X3_ADD2", "IFC4", record);
    assert_eq!(line_for(&out, "#50"), record);
    assert!(warnings.is_empty(), "{warnings:?}");
}

#[test]
fn single_model_export_reports_a_lost_value_in_the_conversion_report() {
    let content = model(
        "IFC4X3_ADD2",
        "#41=IFCDOOR('1a2B3c4D5e6F7g8H9i0J1k',$,'D',$,'Gate',$,$,$,$,$,.TURNSTILE.,$,$);\n\
         #10=IFCPROJECTEDCRS($,'A description',$,$,$,$,$);",
    );
    let opts = StepOptions { schema: Some("IFC4".into()), ..Default::default() };
    let (_, _, report) = export_step_with_report(content.as_bytes(), &opts).unwrap();
    assert_eq!(report.enum_values_lost, 1, "{report:?}");
    assert_eq!(report.enum_values_refused, 0, "{report:?}");
    assert_eq!(report.ifc4_required_slots_unfilled, 1, "{report:?}");
    assert_eq!(report.warnings.len(), 2, "{report:?}");
}

#[test]
fn the_streaming_writer_returns_the_same_report() {
    let content = model("IFC4X3_ADD2", "#10=IFCPROJECTEDCRS($,'A description',$,$,$,$,$);");
    let opts = StepOptions { schema: Some("IFC4".into()), ..Default::default() };
    let mut out = Vec::new();
    let (_, report) = export_step_to_writer_with_report(content.as_bytes(), &opts, &mut out).unwrap();
    assert_eq!(report.ifc4_required_slots_unfilled, 1, "{report:?}");
    assert_eq!(report.warnings.len(), 1, "{report:?}");
}
