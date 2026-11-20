// SPDX-License-Identifier: MPL-2.0

#[test]
fn subset_and_edited_exports_convert_varying_actions_11037() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!("fixtures/structural_carriers_parity.json")).unwrap();
    let sample = fixture["cases"].as_array().unwrap().iter()
        .find(|entry| entry["why"].as_str().unwrap().starts_with("a converted varying action:")).unwrap();
    let text = format!("ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC2X3'));\nENDSEC;\nDATA;\n{}\n{}\nENDSEC;\nEND-ISO-10303-21;\n",
        fixture["owner"].as_str().unwrap(), sample["data"].as_str().unwrap());
    let subset = ifc_lite_export::StepOptions { schema: Some("IFC4".into()), included: Some([30, 20].into_iter().collect()), ..Default::default() };
    let edited = ifc_lite_export::StepOptions {
        schema: subset.schema.clone(),
        attribute_mutations: vec![ifc_lite_export::AttrMutation { express_id: 30, index: 13, value: "(#18,#19)".into() }],
        ..Default::default()
    };
    for (options, loads) in [(subset, "#11,#19,#18"), (edited, "#11,#18,#19")] {
        let output = ifc_lite_export::export_step(text.as_bytes(), &options).unwrap();
        assert!(output.contains("#30=IFCSTRUCTURALCURVEACTION("), "{output}");
        assert!(output.contains(&format!("IFCSTRUCTURALLOADCONFIGURATION($,({loads}),$);")), "{output}");
        assert!(!output.contains("IFCSTRUCTURALLINEARACTIONVARYING("), "{output}");
        assert!(output.contains("'Causes',$,(#20),$,#30);"), "{output}");
    }
    let opts = ifc_lite_export::StepOptions { schema: Some("IFC4".into()), ..Default::default() };
    let edit = |slot, value| serde_json::json!({"type":"UPDATE_POSITIONAL_ATTRIBUTE", "entityId":30, "attributeName":slot, "newValue":value});
    let log: ifc_lite_export::MutationLog = serde_json::from_value(serde_json::json!({"mutations": [
        edit("@13", serde_json::json!(["#18", "#19"]))
    ]})).unwrap();
    let (output, _) = ifc_lite_export::export_step_with_log(text.as_bytes(), &opts, &log).unwrap();
    assert!(output.contains("IFCSTRUCTURALLOADCONFIGURATION($,(#11,#18,#19),$);"), "{output}");
    let log = serde_json::from_value(serde_json::json!({"mutations": [
        edit("@12", serde_json::json!("#9999"))
    ]})).unwrap();
    let (fallback, stats) = ifc_lite_export::export_step_with_log(text.as_bytes(), &opts, &log).unwrap();
    assert!(fallback.contains(",#11,.GLOBAL_COORDS.,.F.,.TRUE_LENGTH.,.CONST.);"), "{fallback}");
    assert!(fallback.contains("'Causes',$,(#20),$,#30);"), "{fallback}");
    assert!(!fallback.contains("IFCSTRUCTURALLOADCONFIGURATION("), "{fallback}");
    assert!(stats.warnings.join(" ").contains("no complete load configuration"), "{stats:?}");
}
