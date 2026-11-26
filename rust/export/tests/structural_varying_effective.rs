// SPDX-License-Identifier: MPL-2.0

fn varying_fixture() -> String {
    let fixture: serde_json::Value = serde_json::from_str(include_str!("fixtures/structural_carriers_parity.json")).unwrap();
    let sample = fixture["cases"].as_array().unwrap().iter()
        .find(|entry| entry["why"].as_str().unwrap().starts_with("a converted varying action:")).unwrap();
    format!("ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC2X3'));\nENDSEC;\nDATA;\n{}\n{}\nENDSEC;\nEND-ISO-10303-21;\n",
        fixture["owner"].as_str().unwrap(), sample["data"].as_str().unwrap())
}

#[test]
fn subset_and_edited_exports_convert_varying_actions_11037() {
    let text = varying_fixture().replace("\nENDSEC;\nEND-ISO-10303-21;",
        "\n#100=IFCCLASSIFICATION('Source','1',#101,'Classification');\n#101=IFCCALENDARDATE(29,2,2024);\nENDSEC;\nEND-ISO-10303-21;");
    let assert_dates = |output: &str| {
        assert!(output.contains("#100=IFCCLASSIFICATION('Source','1','2024-02-29','Classification',$,$,$);"), "{output}");
        assert!(!output.contains("IFCCALENDARDATE("), "{output}");
    };
    let subset = ifc_lite_export::StepOptions { schema: Some("IFC4".into()), included: Some([30, 20, 100, 101].into_iter().collect()), ..Default::default() };
    let edited = ifc_lite_export::StepOptions {
        schema: subset.schema.clone(),
        attribute_mutations: vec![ifc_lite_export::AttrMutation { express_id: 30, index: 13, value: "(#18,#19)".into() }],
        ..Default::default()
    };
    for (options, loads) in [(subset, "#11,#19,#18"), (edited, "#11,#18,#19")] {
        let (output, stats, _) = ifc_lite_export::export_step_with_diagnostics(text.as_bytes(), &options).unwrap();
        assert_eq!(stats.written, output.lines().filter(|line| line.starts_with('#')).count());
        assert!(output.contains("#30=IFCSTRUCTURALCURVEACTION("), "{output}");
        assert!(output.contains(&format!("IFCSTRUCTURALLOADCONFIGURATION($,({loads}),$);")), "{output}");
        assert!(!output.contains("IFCSTRUCTURALLINEARACTIONVARYING("), "{output}");
        assert!(output.contains("'Causes',$,(#20),$,#30);"), "{output}");
        assert_dates(&output);
    }
    let opts = ifc_lite_export::StepOptions { schema: Some("IFC4".into()), ..Default::default() };
    let edit = |slot, value| serde_json::json!({"type":"UPDATE_POSITIONAL_ATTRIBUTE", "entityId":30, "attributeName":slot, "newValue":value});
    let log: ifc_lite_export::MutationLog = serde_json::from_value(serde_json::json!({"mutations": [
        edit("@13", serde_json::json!(["#18", "#19"]))
    ]})).unwrap();
    let (output, stats) = ifc_lite_export::export_step_with_log(text.as_bytes(), &opts, &log).unwrap();
    assert!(output.contains("IFCSTRUCTURALLOADCONFIGURATION($,(#11,#18,#19),$);"), "{output}");
    assert!(output.contains("3 modifications"), "{output}");
    assert_eq!((stats.modified_entities, stats.new_entities), (1, 2));
    assert_eq!(stats.written, output.lines().filter(|line| line.starts_with('#')).count());
    assert_dates(&output);
    let log = serde_json::from_value(serde_json::json!({"mutations": [
        edit("@12", serde_json::json!("#9999"))
    ]})).unwrap();
    let (fallback, stats) = ifc_lite_export::export_step_with_log(text.as_bytes(), &opts, &log).unwrap();
    assert!(fallback.contains(",#11,.GLOBAL_COORDS.,.F.,.TRUE_LENGTH.,.CONST.);"), "{fallback}");
    assert!(fallback.contains("'Causes',$,(#20),$,#30);"), "{fallback}");
    assert!(!fallback.contains("IFCSTRUCTURALLOADCONFIGURATION("), "{fallback}");
    assert!(stats.warnings.join(" ").contains("no complete load configuration"), "{stats:?}");
}

#[test]
fn edited_export_keeps_a_commented_applied_load_in_the_constant_action_11354() {
    let plain = varying_fixture();
    assert!(plain.contains(",#11,.GLOBAL_COORDS."), "fixture shape");
    for slot in ["#11", "#11 /* initial load */", "/* x */#11"] {
        let text = plain.replace(",#11,.GLOBAL_COORDS.", &format!(",{slot},.GLOBAL_COORDS."));
        let options = ifc_lite_export::StepOptions {
            schema: Some("IFC4".into()),
            attribute_mutations: vec![ifc_lite_export::AttrMutation { express_id: 30, index: 12, value: "#9999".into() }],
            ..Default::default()
        };
        let (output, _, warnings) = ifc_lite_export::export_step_with_diagnostics(text.as_bytes(), &options).unwrap();
        assert!(output.contains(&format!(",{slot},.GLOBAL_COORDS.,.F.,.TRUE_LENGTH.,.CONST.);")), "{slot}: {output}");
        assert!(!warnings.iter().any(|w| w.contains("no usable AppliedLoad")), "{slot}: {warnings:?}");
    }
}

#[test]
fn edited_export_counts_each_varying_action_that_loses_its_configuration_11037() {
    let text = varying_fixture();
    let second = text.lines().find(|line| line.starts_with("#30=")).unwrap()
        .replace("#30=", "#90=").replace("3sXjCM_kPHN8ZCpuBhV_98", "0sXjCM_kPHN8ZCpuBhV_98");
    let text = text.replace("\nENDSEC;\nEND-ISO-10303-21;", &format!("\n{second}\nENDSEC;\nEND-ISO-10303-21;"));
    let options = ifc_lite_export::StepOptions {
        schema: Some("IFC4".into()),
        attribute_mutations: [30, 90].into_iter().map(|express_id| ifc_lite_export::AttrMutation {
            express_id, index: 12, value: "#9999".into(),
        }).collect(),
        ..Default::default()
    };
    let (_, _, warnings) = ifc_lite_export::export_step_with_diagnostics(text.as_bytes(), &options).unwrap();
    assert!(warnings.iter().any(|warning| warning.starts_with("2 structural conversion record(s): ")
        && warning.contains("no complete load configuration")), "{warnings:?}");
}

#[test]
fn logged_export_counts_typed_properties_and_deferred_varying_records_once_10797() {
    let text = varying_fixture().replace(
        "\nENDSEC;\nEND-ISO-10303-21;",
        "\n#90=IFCMATERIAL('Concrete');\n#91=IFCGENERALMATERIALPROPERTIES(#90,$,$,42.);\nENDSEC;\nEND-ISO-10303-21;",
    );
    let opts = ifc_lite_export::StepOptions { schema: Some("IFC4".into()), ..Default::default() };
    let log = serde_json::from_value(serde_json::json!({"mutations": [
        {"type": "UPDATE_POSITIONAL_ATTRIBUTE", "entityId": 30,
         "attributeName": "@13", "newValue": ["#18", "#19"]}
    ]})).unwrap();
    let (output, stats) = ifc_lite_export::export_step_with_log(text.as_bytes(), &opts, &log).unwrap();
    assert!(output.contains("IFCPROPERTYSINGLEVALUE('MassDensity',$,IFCMASSDENSITYMEASURE(42.),$);"), "{output}");
    assert!(output.contains("IFCSTRUCTURALLOADCONFIGURATION($,(#11,#18,#19),$);"), "{output}");
    assert!(output.contains("'Causes',$,(#20),$,#30);"), "{output}");
    assert!(output.contains("3 modifications"), "{output}");
    assert_eq!((stats.modified_entities, stats.new_entities), (1, 3));
    let ids: Vec<_> = output.lines().filter(|line| line.starts_with('#'))
        .map(|line| line.split_once('=').unwrap().0).collect();
    assert_eq!(stats.written, ids.len());
    assert_eq!(ids.iter().collect::<std::collections::HashSet<_>>().len(), ids.len(), "{output}");
}

#[test]
fn effective_exports_refuse_an_action_without_a_usable_initial_load_11354() {
    use ifc_lite_export::{export_step_with_diagnostics, export_step_with_log, AttrMutation, StepOptions};

    let source = varying_fixture();
    let options = StepOptions { schema: Some("IFC4".into()), ..StepOptions::default() };
    let edited = StepOptions {
        attribute_mutations: vec![AttrMutation { express_id: 30, index: 7, value: "$".into() }],
        schema: options.schema.clone(),
        ..StepOptions::default()
    };
    let log = serde_json::from_value(serde_json::json!({"mutations": [
        {"type": "UPDATE_POSITIONAL_ATTRIBUTE", "entityId": 30, "attributeName": "@7", "newValue": "#9"}
    ]})).unwrap();
    let Err(edited_error) = export_step_with_diagnostics(source.as_bytes(), &edited) else {
        panic!("edited IFC4 export accepted an unset AppliedLoad");
    };
    let logged_error = export_step_with_log(source.as_bytes(), &options, &log).unwrap_err();
    for error in [edited_error, logged_error] {
        let diagnostic = error.to_string();
        assert!(diagnostic.contains("#30 (IFCSTRUCTURALLINEARACTIONVARYING)"), "{diagnostic}");
        assert!(diagnostic.contains("no usable AppliedLoad"), "{diagnostic}");
    }
}
