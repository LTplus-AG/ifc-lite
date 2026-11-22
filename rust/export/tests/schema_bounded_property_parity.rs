// SPDX-License-Identifier: MPL-2.0
use ifc_lite_export::{
    export_merged, export_merged_models, export_merged_models_with_logs, export_step_with_diagnostics,
    MergedModel, MergedOptions, StepOptions,
};

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
    let merged_options = MergedOptions { schema: options.schema.clone(), ..Default::default() };
    for row in cases {
        let from = if row.from == "IFC4X3" { "IFC4X3_ADD2" } else { &row.from };
        let input = format!("ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\n\
            FILE_NAME('fixture','',(''),(''),'','','');\nFILE_SCHEMA(('{from}'));\nENDSEC;\n\
            DATA;\n{}\nENDSEC;\nEND-ISO-10303-21;\n", row.line);
        let result = export_step_with_diagnostics(input.as_bytes(), &options);
        let models = [MergedModel::new(input.as_bytes())];
        let (merged, stats) = export_merged_models(&models, &merged_options);
        if let Some(expected) = row.expect {
            let (output, _, warnings) = result.unwrap();
            assert!(output.contains(&expected), "{}: {output}", row.why);
            assert!(merged.contains(&expected), "{}: {merged}", row.why);
            let losses: Vec<_> = warnings.iter().filter(|w| w.contains("IFCPROPERTYBOUNDEDVALUE.")).collect();
            match row.dropped {
                Some(name) => assert!(losses.len() == 1 && losses[0].contains(&name), "{}: {losses:?}", row.why),
                None => assert!(losses.is_empty(), "{}: {losses:?}", row.why),
            }
        } else {
            let err = result.err().unwrap_or_else(|| panic!("{}: export accepted a property with no bounds", row.why)).to_string();
            assert!(err.contains("#5") && err.contains("IfcPropertyBoundedValue") && err.contains("WR22"), "{err}");
            // Debug also accepts the old String return type so the revert oracle
            // observes the silent output as an assertion failure.
            let plain = format!("{:?}", export_merged(&[input.as_bytes()], &merged_options));
            assert!(plain.starts_with("Err(") && plain.contains("#5") && plain.contains("WR22"), "{plain}");
            assert!(merged.is_empty(), "{}: merge returned an IFC file", row.why);
            assert_eq!(stats.written, 0);
            assert!(stats.warnings.iter().any(|warning| warning.contains("WR22")), "{:?}", stats.warnings);
            let logged = export_merged_models_with_logs(&models, &[], &merged_options);
            assert!(logged.is_err_and(|error| error.to_string().contains("WR22")));
        }
    }
}
