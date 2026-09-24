// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #5559: exact authored swept-disk descriptions at the public processing boundary.

use ifc_lite_processing::extract_swept_disk_descriptions;

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(format!("../geometry/tests/fixtures/{name}.ifc")).unwrap()
}

fn assert_near(actual: f64, expected: f64) {
    assert!((actual - expected).abs() < 1e-10, "expected {expected}, got {actual}");
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
fn malformed_selected_items_omit_valid_sibling_geometry_atomically() {
    let source = String::from_utf8(fixture("swept_disk_trimmed_line")).unwrap();
    let shape = "#49=IFCPRODUCTDEFINITIONSHAPE($,$,(#48));";
    let cases = [
        (
            "#1001=IFCSHAPEREPRESENTATION(#16,'Body','AdvancedSweptSolid');",
            "missing Items",
        ),
        (
            "#1001=IFCSHAPEREPRESENTATION(#16,'Body','AdvancedSweptSolid',#43);",
            "malformed Items",
        ),
        (
            "#1001=IFCSHAPEREPRESENTATION(#16,'Body','AdvancedSweptSolid',(#43,$));",
            "malformed Items",
        ),
        (
            "#1001=IFCSHAPEREPRESENTATION(#16,'Body','AdvancedSweptSolid',());",
            "malformed Items",
        ),
    ];
    for (bad_rep, reason) in cases {
        // #44 is a valid direct-body representation. #1001 is selected too,
        // so returning #44 alone would misrepresent a partial extraction.
        let model = source.replace(
            shape,
            &format!("{bad_rep}\n#49=IFCPRODUCTDEFINITIONSHAPE($,$,(#44,#1001));"),
        );
        let result = extract_swept_disk_descriptions(model.as_bytes(), None);
        assert!(!result.elements.contains_key(&50), "{reason}: partial geometry escaped");
        assert!(
            result.diagnostics.iter().any(|d| {
                d.contains("product #50") && d.contains("representation #1001") && d.contains(reason)
            }),
            "{reason}: {:?}",
            result.diagnostics
        );
    }

    let valid = source.replace(shape, "#49=IFCPRODUCTDEFINITIONSHAPE($,$,(#44));");
    let result = extract_swept_disk_descriptions(valid.as_bytes(), None);
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    assert_eq!(result.elements[&50][0].solid_id, 43);
}

#[test]
fn malformed_sweep_beside_valid_sweep_omits_product_atomically() {
    let source = String::from_utf8(fixture("swept_disk_trimmed_line")).unwrap();
    let model = source.replace(
        "#49=IFCPRODUCTDEFINITIONSHAPE($,$,(#48));",
        "#1001=IFCSWEPTDISKSOLID(#999,14.5,$,$,$);\n#1002=IFCSHAPEREPRESENTATION(#16,'Body','AdvancedSweptSolid',(#1001));\n#49=IFCPRODUCTDEFINITIONSHAPE($,$,(#44,#1002));",
    );
    let result = extract_swept_disk_descriptions(model.as_bytes(), None);
    assert!(!result.elements.contains_key(&50), "valid sibling must not escape");
    assert!(
        result.diagnostics.iter().any(|d| d.contains("product #50") && d.contains("solid #1001")),
        "{:?}",
        result.diagnostics
    );
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
    let metrics = disk.directrix_metrics().unwrap();
    assert_near(metrics.total_length, 2.75);
    assert_eq!(metrics.segments.len(), 1);
    assert_eq!(metrics.segments[0].segment_index, 0);
    assert_near(metrics.segments[0].length, 2.75);
    assert_eq!(metrics.segments[0].bend_angle, None);
    let value = serde_json::to_value(disk).unwrap();
    assert_eq!(value["status"]["type"], "complete");
    assert_eq!(value["directrix_metrics"]["total_length"], 2.75);
    assert_eq!(value["directrix_metrics"]["segments"][0]["segment_index"], 0);
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
fn invalid_mapping_target_omits_mapped_product_atomically() {
    let source = String::from_utf8(fixture("swept_disk_trimmed_line")).unwrap();
    let shape = "#48=IFCSHAPEREPRESENTATION(#16,'Body','MappedRepresentation',(#47));";
    for target in ["$", "42.", "#10"] {
        let bad_item = format!("#1001=IFCMAPPEDITEM(#45,{target});");
        let model = source.replace(
            shape,
            &format!("{bad_item}\n#48=IFCSHAPEREPRESENTATION(#16,'Body','MappedRepresentation',(#47,#1001));"),
        );
        let result = extract_swept_disk_descriptions(model.as_bytes(), None);
        assert!(!result.elements.contains_key(&50), "{target}: valid sibling escaped");
        assert!(
            result.diagnostics.iter().any(|d| {
                d.contains("product #50") && d.contains("mapped item #1001") && d.contains("MappingTarget")
            }),
            "{target}: {:?}",
            result.diagnostics
        );
    }

    let wrong_type = source.replace(
        "#46=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#10,$,$);",
        "#46=IFCCARTESIANPOINT((0.,0.,0.));",
    );
    let result = extract_swept_disk_descriptions(wrong_type.as_bytes(), None);
    assert!(!result.elements.contains_key(&50));
    assert!(result.diagnostics.iter().any(|d| d.contains("product #50") && d.contains("MappingTarget #46")));
}

#[test]
fn mapped_origin_and_operator_axes_must_resolve_before_claiming_world_coordinates() {
    let source = String::from_utf8(fixture("swept_disk_trimmed_line")).unwrap();
    let map = "#45=IFCREPRESENTATIONMAP(#13,#44);";
    let operator = "#46=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#10,$,$);";
    let cases = [
        (source.replace(map, "#45=IFCREPRESENTATIONMAP($,#44);"), "MappingOrigin"),
        (source.replace(map, "#45=IFCREPRESENTATIONMAP(#12,#44);"), "MappingOrigin"),
        (source.replace(map, "#1000=IFCAXIS2PLACEMENT3D(#10,42.,#12);\n#45=IFCREPRESENTATIONMAP(#1000,#44);"), "Axis"),
        (source.replace(map, "#1000=IFCAXIS2PLACEMENT3D(#10,#11,#10);\n#45=IFCREPRESENTATIONMAP(#1000,#44);"), "RefDirection"),
        (source.replace(operator, "#46=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,$,$,$);"), "LocalOrigin"),
        (source.replace(operator, "#46=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#12,$,$);"), "LocalOrigin"),
        (source.replace(operator, "#46=IFCCARTESIANTRANSFORMATIONOPERATOR3D(42.,$,#10,$,$);"), "Axis1"),
        (source.replace(operator, "#46=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,#10,#10,$,$);"), "Axis2"),
        (source.replace(operator, "#46=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#10,$,42.);"), "Axis3"),
    ];
    for (model, reason) in cases {
        let result = extract_swept_disk_descriptions(model.as_bytes(), None);
        assert!(!result.elements.contains_key(&50), "{reason}: false world description");
        assert!(
            result.diagnostics.iter().any(|d| {
                d.contains("product #50") && d.contains("mapped item #47") && d.contains(reason)
            }),
            "{reason}: {:?}",
            result.diagnostics
        );
    }

    // The mapped source can use a valid 2D origin even though this path cannot
    // claim a 2D *product* LocalPlacement until the router supports that case.
    let valid_2d_origin = source.replace(
        map,
        "#1000=IFCAXIS2PLACEMENT2D(#10,#14);\n#45=IFCREPRESENTATIONMAP(#1000,#44);",
    );
    let result = extract_swept_disk_descriptions(valid_2d_origin.as_bytes(), None);
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    assert_eq!(result.elements[&50][0].solid_id, 43);
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
    // The authored U-bar has three straight runs and two 101.5 mm quarter bends.
    let metrics = disk.directrix_metrics().unwrap();
    let lengths = [0.322, 0.1015 * std::f64::consts::FRAC_PI_2, 0.245685133619932,
        0.1015 * std::f64::consts::FRAC_PI_2, 0.250];
    assert_near(metrics.total_length, lengths.iter().sum());
    for (index, (segment, expected_length)) in metrics.segments.iter().zip(lengths).enumerate() {
        assert_eq!(segment.segment_index, index);
        assert_near(segment.length, expected_length);
        if index == 1 || index == 3 {
            assert_near(segment.bend_angle.unwrap(), std::f64::consts::FRAC_PI_2);
        } else {
            assert_eq!(segment.bend_angle, None);
        }
    }
}

#[test]
fn l_bar_metrics_include_only_the_authored_quarter_bend() {
    let result = extract_swept_disk_descriptions(&fixture("swept_disk_composite_arc_lbar"), None);
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    let metrics = result.elements[&78][0].directrix_metrics().unwrap();
    assert_eq!(metrics.segments.len(), 3);
    assert_near(metrics.total_length, 1.601 + 0.0895 * std::f64::consts::FRAC_PI_2 + 0.160);
    assert_near(metrics.segments[1].bend_angle.unwrap(), std::f64::consts::FRAC_PI_2);
    assert_eq!(metrics.segments[0].bend_angle, None);
    assert_eq!(metrics.segments[2].bend_angle, None);
}

#[test]
fn crank_bar_metrics_include_both_small_bends() {
    let result = extract_swept_disk_descriptions(&fixture("swept_disk_composite_arc_crankbar"), None);
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    let metrics = result.elements[&79][0].directrix_metrics().unwrap();
    assert_eq!(metrics.segments.len(), 5);
    let bends = [0.0822700254876878, 0.0822700254876865];
    let expected = 2.96012202484092 + 0.1305 * bends[0] + 0.561192138816509
        + 0.1305 * bends[1] + 1.31913733788869;
    assert_near(metrics.total_length, expected);
    for (index, segment) in metrics.segments.iter().enumerate() {
        assert_eq!(segment.segment_index, index);
        match index {
            1 => assert_near(segment.bend_angle.unwrap(), bends[0]),
            3 => assert_near(segment.bend_angle.unwrap(), bends[1]),
            _ => assert_eq!(segment.bend_angle, None),
        }
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
    let metrics = disk.directrix_metrics().unwrap();
    assert_near(metrics.total_length, 5.5);
    assert_near(metrics.segments[0].length, 5.5);
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
fn malformed_placement_chain_never_claims_world_directrix() {
    let source = String::from_utf8(fixture("swept_disk_trimmed_line")).unwrap();
    let product = "#50=IFCREINFORCINGBAR('0000000000000000000002',$,'Bar',$,$,#30,#49,'BAR-1',$,29.,0.,$,.NOTDEFINED.,$);";
    let placement = "#30=IFCLOCALPLACEMENT($,#13);";
    let axes = "#13=IFCAXIS2PLACEMENT3D(#10,#11,#12);";
    let cases = [
        source.replace(product, &product.replace("#30,#49,", "#10,#49,")),
        source.replace(placement, "#30=IFCLOCALPLACEMENT($,#10);"),
        source.replace(placement, "#30=IFCLOCALPLACEMENT($,$);"),
        source.replace(placement, "#30=IFCLOCALPLACEMENT(#10,#13);"),
        source.replace(placement, "#1000=IFCAXIS2PLACEMENT2D(#10,#14);\n#30=IFCLOCALPLACEMENT($,#1000);"),
        source.replace(axes, "#13=IFCAXIS2PLACEMENT3D(#10,42.,#12);"),
        source.replace(axes, "#13=IFCAXIS2PLACEMENT3D(#10,#11,42.);"),
    ];
    for (index, model) in cases.iter().enumerate() {
        let result = extract_swept_disk_descriptions(model.as_bytes(), None);
        assert!(!result.elements.contains_key(&50), "case {index}: false world description");
        assert!(
            result.diagnostics.iter().any(|d| d.contains("product #50: placement:")),
            "case {index}: {:?}",
            result.diagnostics
        );
    }
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
    assert!(value["directrix_metrics"].is_null());
    assert!(disk.directrix_metrics().is_none());
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
    assert!(disks.iter().all(|disk| disk.directrix_metrics().is_some_and(|m| (m.total_length - 2.75).abs() < 1e-10)));
}

#[test]
fn malformed_boolean_operands_and_csg_root_omit_product_atomically() {
    let source = String::from_utf8(fixture("swept_disk_trimmed_line")).unwrap();
    let shape = "#44=IFCSHAPEREPRESENTATION(#16,'Body','AdvancedSweptSolid',(#43));";
    let cases = [
        (
            "#1001=IFCBOOLEANRESULT(.UNION.,$,#43);",
            "FirstOperand",
        ),
        (
            "#1001=IFCBOOLEANRESULT(.UNION.,#43,$);",
            "SecondOperand",
        ),
        (
            "#1001=IFCBOOLEANRESULT(.UNION.,'invalid',#43);",
            "FirstOperand",
        ),
        ("#1001=IFCCSGSOLID($);", "TreeRootExpression"),
        ("#1001=IFCCSGSOLID('invalid');", "TreeRootExpression"),
    ];
    for (item, missing) in cases {
        let broken = source.replace(
            shape,
            &format!("{item}\n#44=IFCSHAPEREPRESENTATION(#16,'Body','AdvancedSweptSolid',(#1001));"),
        );
        let result = extract_swept_disk_descriptions(broken.as_bytes(), None);
        assert!(!result.elements.contains_key(&50), "{missing}: partial description escaped");
        assert!(
            result.diagnostics.iter().any(|d| {
                d.contains("product #50") && d.contains("#1001") && d.contains(missing)
            }),
            "{missing}: {:?}",
            result.diagnostics
        );
    }

    let valid = source.replace(
        shape,
        "#1002=IFCBOOLEANRESULT(.UNION.,#43,#43);\n#1001=IFCCSGSOLID(#1002);\n#44=IFCSHAPEREPRESENTATION(#16,'Body','AdvancedSweptSolid',(#1001));",
    );
    let result = extract_swept_disk_descriptions(valid.as_bytes(), None);
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    assert_eq!(result.elements[&50].len(), 2);
    assert!(result.elements[&50].iter().all(|disk| disk.solid_id == 43));
}

#[test]
fn invalid_boolean_operand_and_csg_root_types_omit_valid_sibling() {
    let source = String::from_utf8(fixture("swept_disk_trimmed_line")).unwrap();
    let shape = "#44=IFCSHAPEREPRESENTATION(#16,'Body','AdvancedSweptSolid',(#43));";
    let product_shape = "#49=IFCPRODUCTDEFINITIONSHAPE($,$,(#48));";
    for (item, reason) in [
        ("#1001=IFCBOOLEANRESULT(.UNION.,#43,#10);", "IfcBooleanOperand"),
        ("#1001=IFCCSGSOLID(#10);", "IfcCsgSelect"),
    ] {
        let model = source
            .replace(shape, &format!("{item}\n#44=IFCSHAPEREPRESENTATION(#16,'Body','AdvancedSweptSolid',(#43,#1001));"))
            .replace(product_shape, "#49=IFCPRODUCTDEFINITIONSHAPE($,$,(#44));");
        let result = extract_swept_disk_descriptions(model.as_bytes(), None);
        assert!(!result.elements.contains_key(&50), "{reason}: valid sibling escaped");
        assert!(
            result.diagnostics.iter().any(|d| d.contains("product #50") && d.contains(reason) && d.contains("#10")),
            "{reason}: {:?}",
            result.diagnostics
        );
    }

    // IfcBlock is a valid IfcCsgPrimitive3D select member. The extractor does
    // not describe that primitive, but must retain the swept-disk operand.
    let valid_other = source
        .replace(
            shape,
            "#1001=IFCBLOCK(#13,100.,100.,100.);\n#1002=IFCBOOLEANRESULT(.UNION.,#43,#1001);\n#44=IFCSHAPEREPRESENTATION(#16,'Body','CSG',(#1002));",
        )
        .replace(product_shape, "#49=IFCPRODUCTDEFINITIONSHAPE($,$,(#44));");
    let result = extract_swept_disk_descriptions(valid_other.as_bytes(), None);
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    assert_eq!(result.elements[&50].len(), 1);
    assert!(result.elements[&50][0].source_modified);
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

#[test]
fn repeated_representations_bound_stack_before_expanding_second_items_list() {
    let source = String::from_utf8(fixture("swept_disk_trimmed_line")).unwrap();
    let items = vec!["#47"; 60_000].join(",");
    let model = source
        .replace(
            "#48=IFCSHAPEREPRESENTATION(#16,'Body','MappedRepresentation',(#47));",
            &format!("#48=IFCSHAPEREPRESENTATION(#16,'Body','MappedRepresentation',({items}));"),
        )
        .replace(
            "#49=IFCPRODUCTDEFINITIONSHAPE($,$,(#48));",
            "#49=IFCPRODUCTDEFINITIONSHAPE($,$,(#48,#48));",
        );
    let result = extract_swept_disk_descriptions(model.as_bytes(), None);
    assert!(!result.elements.contains_key(&50));
    assert!(
        result.diagnostics.iter().any(|d| d.contains("product #50") && d.contains("representation items exceed work budget")),
        "{:?}",
        result.diagnostics
    );
}

#[test]
fn oversized_raw_representations_list_is_bounded_before_resolution() {
    let source = String::from_utf8(fixture("swept_disk_trimmed_line")).unwrap();
    let reps = vec!["#48"; 100_001].join(",");
    let model = source.replace(
        "#49=IFCPRODUCTDEFINITIONSHAPE($,$,(#48));",
        &format!("#49=IFCPRODUCTDEFINITIONSHAPE($,$,({reps}));"),
    );
    let result = extract_swept_disk_descriptions(model.as_bytes(), None);
    assert!(!result.elements.contains_key(&50));
    assert!(
        result.diagnostics.iter().any(|d| d.contains("product #50") && d.contains("Representations list exceeds work budget")),
        "{:?}",
        result.diagnostics
    );
}
