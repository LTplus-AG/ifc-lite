// SPDX-License-Identifier: MPL-2.0
use ifc_lite_export::{export_step_with_diagnostics, StepOptions};

#[derive(serde::Deserialize)]
struct Case {
    why: String,
    from: String,
    line: String,
    expect: Option<String>,
    dropped: Option<String>,
}

#[test]
fn ifc2x3_bounded_property_wr22_11117() {
    let cases: Vec<Case> = serde_json::from_str(include_str!("fixtures/schema_bounded_property_vectors.json")).unwrap();
    let options = StepOptions { schema: Some("IFC2X3".into()), ..Default::default() };
    for row in cases {
        let from = if row.from == "IFC4X3" { "IFC4X3_ADD2" } else { &row.from };
        let input = format!("ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\n\
            FILE_NAME('fixture','',(''),(''),'','','');\nFILE_SCHEMA(('{from}'));\nENDSEC;\n\
            DATA;\n{}\nENDSEC;\nEND-ISO-10303-21;\n", row.line);
        let result = export_step_with_diagnostics(input.as_bytes(), &options);
        if let Some(expected) = row.expect {
            let (output, _, warnings) = result.unwrap();
            assert!(output.contains(&expected), "{}: {output}", row.why);
            let losses: Vec<_> = warnings.iter().filter(|w| w.contains("IFCPROPERTYBOUNDEDVALUE.")).collect();
            match row.dropped {
                Some(name) => assert!(losses.len() == 1 && losses[0].contains(&name), "{}: {losses:?}", row.why),
                None => assert!(losses.is_empty(), "{}: {losses:?}", row.why),
            }
        } else {
            let err = result.err().unwrap_or_else(|| panic!("{}: export accepted a property with no bounds", row.why)).to_string();
            assert!(err.contains("#5") && err.contains("IfcPropertyBoundedValue") && err.contains("WR22"), "{err}");
        }
    }
}
