// SPDX-License-Identifier: MPL-2.0
use ifc_lite_export::{export_step_with_diagnostics, StepOptions};

fn convert(from: &str, to: &str, ty: &str, tail: &str) -> (String, String, usize, usize) {
    let source = format!("ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('test.ifc','',(''),(''),'','','');\nFILE_SCHEMA(('{from}'));\nENDSEC;\nDATA;\n#1={ty}('0YvctVUKr0kugbFTf53O9L',$,'sample',$,$,$,$,$,{tail});\nENDSEC;\nEND-ISO-10303-21;");
    let options = StepOptions { schema: Some(to.into()), ..Default::default() };
    let (step, stats, warnings) = export_step_with_diagnostics(source.as_bytes(), &options).unwrap();
    (step.lines().find(|line| line.starts_with("#1=")).unwrap().into(), warnings.join("\n"),
        stats.attribute_values_dropped, stats.enum_values_lost)
}

#[test]
fn direct_facility_usage_has_no_elevation_in_either_target_11589() {
    for to in ["IFC4", "IFC2X3"] {
        let (line, warnings, dropped, _) = convert("IFC4X3", to, "IFCFACILITYPART", ".ELEMENT.,.LATERAL.");
        assert!(line.starts_with("#1=IFCBUILDINGSTOREY(") && line.ends_with(",.ELEMENT.,$);"), "{line}");
        assert!(warnings.contains("IFCFACILITYPART.UsageType"), "{warnings}");
        assert_eq!(dropped, 1);
        let (_, warnings, dropped, _) = convert("IFC4X3", to, "IFCFACILITYPART", ".ELEMENT.,$");
        assert!(!warnings.contains("UsageType"));
        assert_eq!(dropped, 0);
    }
}

#[test]
fn concrete_facility_parts_write_storey_layout_and_name_actual_losses_11589() {
    for to in ["IFC4", "IFC2X3"] {
        let (storey, _, _, _) = convert("IFC4X3", to, "IFCBUILDINGSTOREY", ".ELEMENT.,12.5");
        assert!(storey.ends_with(",12.5);"), "{storey}");
        for ty in ["IFCFACILITYPARTCOMMON", "IFCBRIDGEPART", "IFCROADPART", "IFCRAILWAYPART", "IFCMARINEPART"] {
            for (usage, classification) in [(".LATERAL.", "$"), ("$", ".NOTDEFINED."), (".LATERAL.", ".NOTDEFINED."), ("$", "$")] {
                let (line, warnings, dropped, _) = convert("IFC4X3", to, ty, &format!(".ELEMENT.,{usage},{classification}"));
                assert_eq!(line.split(',').count(), 10, "{line}");
                assert!(line.starts_with("#1=IFCBUILDINGSTOREY(") && line.ends_with(",.ELEMENT.,$);"), "{line}");
                assert_eq!(warnings.contains(&format!("{ty}.UsageType")), usage != "$", "{warnings}");
                assert_eq!(warnings.contains(&format!("{ty}.PredefinedType")), classification != "$", "{warnings}");
                assert_eq!(dropped, usize::from(usage != "$") + usize::from(classification != "$"));
            }
        }
    }
}

#[test]
fn proxy_downgrade_reports_source_classification_and_preserves_compatible_upgrade_11589() {
    let routes: Vec<[String; 3]> = serde_json::from_str(include_str!("fixtures/proxy_classification_routes.json")).unwrap();
    for [from, ty, member] in routes {
        let (line, warnings, _, lost) = convert(&from, "IFC2X3", &ty, &format!("/* classification */ .{member}."));
        assert!(line.starts_with("#1=IFCBUILDINGELEMENTPROXY(") && line.ends_with(",$);"), "{line}");
        assert!(warnings.contains(&format!(".{member}. (source {ty}.PredefinedType)")), "{warnings}");
        assert_eq!(lost, 1);
    }
    let (line, warnings, _, lost) = convert("IFC2X3", "IFC4", "IFCBUILDINGELEMENTPROXY", ".ELEMENT.");
    assert!(line.ends_with(",.ELEMENT.);"), "{line}");
    assert!(!warnings.contains("CompositionType"));
    assert_eq!(lost, 0);
}
