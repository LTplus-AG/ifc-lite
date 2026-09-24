// SPDX-License-Identifier: MPL-2.0
//! #5307, the Rust twin of #5202's finding 2: an IFC4X3 model exported as IFC4
//! keeps `$` in `IfcProjectedCRS.Name`, which IFC4 requires. Nothing may be
//! invented for it, so the export has to SAY the file is not valid IFC4.
//! Before the fix it wrote the `$` and reported nothing.
//!
//! Driven through the public merged export and its existing `warnings`
//! channel, so the test compiles against the crate with or without the fix.

use ifc_lite_export::{export_merged_models, MergedModel, MergedOptions};

fn ifc4x3_model(crs_name: &str) -> String {
    format!(
        "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4X3_ADD2'));\nENDSEC;\nDATA;\n\
         #1=IFCPROJECT('0OSuGGYUFyIf0LtE29OSuG',$,'P',$,$,$,$,$,$);\n\
         #10=IFCPROJECTEDCRS({crs_name},'A description',$,$,$,$,$);\n\
         #11=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#12);\n\
         ENDSEC;\nEND-ISO-10303-21;\n"
    )
}

fn export_as(schema: &str, model: &str) -> (String, Vec<String>) {
    let inputs = [MergedModel::new(model.as_bytes())];
    let opts = MergedOptions { schema: Some(schema.to_string()), ..MergedOptions::default() };
    let (out, stats) = export_merged_models(&inputs, &opts);
    (out, stats.warnings)
}

fn slot_warnings(warnings: &[String]) -> Vec<&String> {
    warnings.iter().filter(|w| w.contains("where IFC4 requires a value")).collect()
}

#[test]
fn an_ifc4x3_crs_without_a_name_exported_as_ifc4_is_reported() {
    let (out, warnings) = export_as("IFC4", &ifc4x3_model("$"));
    assert!(out.contains("IFCPROJECTEDCRS($,'A description'"), "Name stays $, nothing invented:\n{out}");
    let hits = slot_warnings(&warnings);
    assert_eq!(hits.len(), 1, "{warnings:?}");
    assert!(hits[0].starts_with("1 slot(s)"), "{warnings:?}");
}

#[test]
fn a_populated_name_or_an_ifc4x3_target_reports_nothing() {
    let (_, warnings) = export_as("IFC4", &ifc4x3_model("'EPSG:27700'"));
    assert!(slot_warnings(&warnings).is_empty(), "{warnings:?}");
    let (_, warnings) = export_as("IFC4X3", &ifc4x3_model("$"));
    assert!(slot_warnings(&warnings).is_empty(), "{warnings:?}");
}

#[test]
fn a_populated_boolean_flag_is_left_exactly_as_written() {
    let (out, _) = export_as("IFC4", &ifc4x3_model("$"));
    assert!(out.contains("IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,"), "{out}");
}
