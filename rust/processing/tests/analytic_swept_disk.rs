// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #5559: exact authored swept-disk descriptions at the public processing boundary.

use ifc_lite_processing::extract_swept_disk_descriptions;

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(format!("../geometry/tests/fixtures/{name}.ifc")).unwrap()
}

#[test]
fn broken_product_representation_is_reported_but_absent_representation_is_valid() {
    let source = String::from_utf8(fixture("swept_disk_trimmed_line")).unwrap();
    let product = "#50=IFCREINFORCINGBAR('0000000000000000000002',$,'Bar',$,$,#30,#49,'BAR-1',$,29.,0.,$,.NOTDEFINED.,$);";

    let broken = source.replace(product, &product.replace("#30,#49,", "#30,#999,"));
    let result = extract_swept_disk_descriptions(broken.as_bytes(), None);
    assert!(!result.elements.contains_key(&50));
    assert!(
        result
            .diagnostics
            .iter()
            .any(|d| d.contains("product #50") && d.contains("Representation #999")),
        "{:?}",
        result.diagnostics
    );

    let absent = source.replace(product, &product.replace("#30,#49,", "#30,$,"));
    let result = extract_swept_disk_descriptions(absent.as_bytes(), None);
    assert!(!result.elements.contains_key(&50));
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
}

#[test]
fn malformed_product_representation_shape_is_reported() {
    let source = String::from_utf8(fixture("swept_disk_trimmed_line")).unwrap();
    let product = "#50=IFCREINFORCINGBAR('0000000000000000000002',$,'Bar',$,$,#30,#49,'BAR-1',$,29.,0.,$,.NOTDEFINED.,$);";
    let shape = "#49=IFCPRODUCTDEFINITIONSHAPE($,$,(#48));";
    let cases = [
        (
            source.replace(product, &product.replace("#30,#49,", "#30,#43,")),
            "not IfcProductDefinitionShape",
        ),
        (
            source.replace(shape, "#49=IFCPRODUCTDEFINITIONSHAPE($,$);"),
            "no Representations attribute",
        ),
        (
            source.replace(shape, "#49=IFCPRODUCTDEFINITIONSHAPE($,$,#48);"),
            "malformed Representations list",
        ),
        (
            source.replace(shape, "#49=IFCPRODUCTDEFINITIONSHAPE($,$,(#999));"),
            "Representations:",
        ),
    ];
    for (broken, reason) in cases {
        let result = extract_swept_disk_descriptions(broken.as_bytes(), None);
        assert!(!result.elements.contains_key(&50), "{reason}");
        assert!(
            result
                .diagnostics
                .iter()
                .any(|d| d.contains("product #50") && d.contains(reason)),
            "{reason}: {:?}",
            result.diagnostics
        );
    }
}

#[test]
fn mapped_trimmed_line_has_world_metre_endpoints_and_radius() {
    let result = extract_swept_disk_descriptions(&fixture("swept_disk_trimmed_line"), None);
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    let disk = &result.elements[&50][0];
    assert_eq!(disk.solid_id, 43);
    assert_eq!(disk.mapping_path, [47]);
    assert_eq!(disk.radius, 0.0145);
    assert_eq!(disk.directrix.len(), 1);
    let value = serde_json::to_value(disk).unwrap();
    assert_eq!(value["status"]["type"], "complete");
    assert_eq!(value["Directrix"][0]["type"], "line");
    assert_eq!(
        value["Directrix"][0]["start"],
        serde_json::json!([0.0, 0.0, 0.0])
    );
    assert_eq!(
        value["Directrix"][0]["end"],
        serde_json::json!([2.75, 0.0, 0.0])
    );
}

#[test]
fn composite_bar_keeps_ordered_lines_and_xz_arcs() {
    let result = extract_swept_disk_descriptions(&fixture("swept_disk_composite_arc_ubar"), None);
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    let disk = &result.elements[&125][0];
    assert_eq!(disk.radius, 0.0145);
    let value = serde_json::to_value(disk).unwrap();
    assert_eq!(value["status"]["type"], "complete");
    let types: Vec<_> = value["Directrix"]
        .as_array()
        .unwrap()
        .iter()
        .map(|segment| segment["type"].as_str().unwrap())
        .collect();
    assert_eq!(types, ["line", "arc", "line", "arc", "line"]);
    for arc in value["Directrix"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|s| s["type"] == "arc")
    {
        assert_eq!(arc["center"][1], 0.0);
        assert_eq!(arc["radius"], 0.1015);
    }
}

#[test]
fn mapped_occurrence_scales_radius_and_places_directrix_once() {
    let source = String::from_utf8(fixture("swept_disk_trimmed_line")).unwrap();
    let source = source.replace(
        "#46=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#10,$,$);",
        "#1000=IFCCARTESIANPOINT((1000.,0.,0.));\n#46=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#1000,2.,$);",
    );
    let result = extract_swept_disk_descriptions(source.as_bytes(), None);
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    let disk = &result.elements[&50][0];
    assert_eq!(disk.radius, 0.029);
    let value = serde_json::to_value(disk).unwrap();
    assert_eq!(
        value["Directrix"][0]["start"],
        serde_json::json!([1.0, 0.0, 0.0])
    );
    assert_eq!(
        value["Directrix"][0]["end"],
        serde_json::json!([6.5, 0.0, 0.0])
    );
}

#[test]
fn deep_placement_is_reported_instead_of_claiming_world_coordinates() {
    let source = String::from_utf8(fixture("swept_disk_trimmed_line")).unwrap();
    let mut chain = String::new();
    for id in 200..=320 {
        let parent = if id == 320 {
            "$".to_string()
        } else {
            format!("#{}", id + 1)
        };
        chain.push_str(&format!("#{id}=IFCLOCALPLACEMENT({parent},#13);\n"));
    }
    let source = source.replace(
        "#30=IFCLOCALPLACEMENT($,#13);",
        &format!("{chain}#30=IFCLOCALPLACEMENT(#200,#13);"),
    );
    let result = extract_swept_disk_descriptions(source.as_bytes(), None);
    assert!(!result.elements.contains_key(&50));
    assert!(
        result
            .diagnostics
            .iter()
            .any(|d| d.contains("exceeded maximum depth")),
        "{:?}",
        result.diagnostics
    );
}

#[test]
fn nonuniform_mapped_disk_reports_unsupported_world_circle() {
    let source = String::from_utf8(fixture("swept_disk_trimmed_line")).unwrap();
    let source = source.replace(
        "#46=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#10,$,$);",
        "#46=IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM($,$,#10,$,$,2.,1.);",
    );
    let result = extract_swept_disk_descriptions(source.as_bytes(), None);
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    let disk = &result.elements[&50][0];
    let value = serde_json::to_value(disk).unwrap();
    assert_eq!(value["status"]["type"], "unsupported");
    assert_eq!(value["Directrix"], serde_json::json!([]));
    assert_eq!(value["Radius"], 0.0145); // authored radius in metres; no world circle
}

#[test]
fn repeated_solid_in_boolean_keeps_both_source_contributions() {
    let source = String::from_utf8(fixture("swept_disk_trimmed_line")).unwrap();
    let source = source.replace(
        "#44=IFCSHAPEREPRESENTATION(#16,'Body','AdvancedSweptSolid',(#43));",
        "#1001=IFCBOOLEANRESULT(.UNION.,#43,#43);\n#44=IFCSHAPEREPRESENTATION(#16,'Body','AdvancedSweptSolid',(#1001));",
    );
    let result = extract_swept_disk_descriptions(source.as_bytes(), None);
    let disks = &result.elements[&50];
    assert_eq!(disks.len(), 2);
    assert!(disks
        .iter()
        .all(|disk| disk.source_modified && disk.solid_id == 43));
}

#[test]
fn independent_exporter_circle_trim_and_hollow_radius() {
    // #5559: IFC.JAVA's checked-in IFC2X3 export uses an IfcCircle directrix
    // with solid-level angle bounds; a full circle would overstate its path.
    let path = "../../tests/models/ifcopenshell/1032-curve.ifc";
    let Ok(bytes) = std::fs::read(path) else {
        eprintln!(
            "skipping independent exporter fixture; run pnpm fixtures ifcopenshell/1032-curve.ifc"
        );
        return;
    };
    let result = extract_swept_disk_descriptions(&bytes, None);
    let disk = &result.elements[&26][0];
    assert_eq!(disk.radius, 0.0167);
    assert!((disk.inner_radius.unwrap() - 0.01215).abs() < 1e-12);
    let value = serde_json::to_value(disk).unwrap();
    assert_eq!(value["status"]["type"], "complete");
    assert_eq!(value["Directrix"][0]["type"], "arc");
    assert_eq!(value["Directrix"][0]["radius"], 0.0381);
    assert_eq!(value["Directrix"][0]["sweep_angle"], 0.79);
}

#[test]
fn repeated_mapped_directrices_exhaust_aggregate_output_atomically() {
    // Each mapped source has only 100 line segments, but 1,001 occurrences
    // would emit 100,100 segments for one product. The product must not expose
    // the first 100,000 as if its extraction had completed.
    let source = String::from_utf8(fixture("swept_disk_trimmed_line")).unwrap();
    let points = (0..=100)
        .map(|i| format!("#{}=IFCCARTESIANPOINT(({}.,0.,0.));", 1_000 + i, i))
        .collect::<Vec<_>>()
        .join("\n");
    let refs = (0..=100)
        .map(|i| format!("#{}", 1_000 + i))
        .collect::<Vec<_>>()
        .join(",");
    let mapped_entities = (2_000..3_000)
        .map(|id| format!("#{id}=IFCMAPPEDITEM(#45,#46);"))
        .collect::<Vec<_>>()
        .join("\n");
    let mapped_items = std::iter::once("#47".to_string())
        .chain((2_000..3_000).map(|id| format!("#{id}")))
        .collect::<Vec<_>>()
        .join(",");
    let source = source
        .replace(
            "#43=IFCSWEPTDISKSOLID(#42,14.5,$,0.,2750.);",
            &format!(
                "{points}\n#1101=IFCPOLYLINE(({refs}));\n#43=IFCSWEPTDISKSOLID(#1101,14.5,$,$,$);"
            ),
        )
        .replace(
            "#48=IFCSHAPEREPRESENTATION(#16,'Body','MappedRepresentation',(#47));",
            &format!(
                "{mapped_entities}\n#48=IFCSHAPEREPRESENTATION(#16,'Body','MappedRepresentation',({mapped_items}));"
            ),
        );
    let result = extract_swept_disk_descriptions(source.as_bytes(), None);
    assert!(
        !result.elements.contains_key(&50),
        "partial product description escaped the output budget"
    );
    assert!(
        result
            .diagnostics
            .iter()
            .any(|d| d.contains("directrix output exceeds work budget")),
        "{:?}",
        result.diagnostics
    );
}
