// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #5785: reusable sources retain distinct mapped occurrences and f64 frames.

use ifc_lite_processing::{extract_analytic_quantity_sources, extract_swept_disk_definitions, extract_swept_disk_descriptions,
    SweptDiskSourceContext};

fn fixture() -> String {
    std::fs::read_to_string("../geometry/tests/fixtures/swept_disk_trimmed_line.ifc").unwrap()
}

#[test]
fn issue_5810_schema_identity_ignores_comment_and_quoted_decoys() {
    let model = fixture()
        .replace(
            "FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');",
            "FILE_DESCRIPTION(('mentions FILE_SCHEMA((''IFC4X3''));'),'2;1');\n\
             /* FILE_SCHEMA(('IFC4')); */",
        )
        .replace("FILE_SCHEMA(('IFC2X3'));", "file_schema /* real declaration */ (('IFC2X3'));");
    let view = extract_swept_disk_definitions(model.as_bytes(), None);
    assert_eq!(view.schema.as_deref(), Some("IFC2X3"));
    assert_eq!(view.sources.len(), 1);
    assert_eq!(view.sources[0].key.schema.as_deref(), Some("IFC2X3"));
}

#[test]
fn repeated_mapping_targets_share_one_raw_source_with_distinct_world_instances() {
    let model = fixture().replace(
        "#48=IFCSHAPEREPRESENTATION(#16,'Body','MappedRepresentation',(#47));",
        "#1000=IFCCARTESIANPOINT((5000000000.,0.,0.));\n#1001=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#1000,$,$);\n#1002=IFCMAPPEDITEM(#45,#1001);\n#48=IFCSHAPEREPRESENTATION(#16,'Body','MappedRepresentation',(#47,#1002));",
    ).replace("ENDSEC;\nEND-ISO-10303-21;",
        "#51=IFCREINFORCINGBAR('0000000000000000000003',$,'Bar copy',$,$,#30,#49,'BAR-2',$,29.,0.,$,.NOTDEFINED.,$);\nENDSEC;\nEND-ISO-10303-21;");
    let view = extract_swept_disk_definitions(model.as_bytes(), None);
    assert!(view.diagnostics.is_empty(), "{:?}", view.diagnostics);
    assert_eq!(view.sources.len(), 1);
    assert_eq!(view.sources[0].radius, 14.5); // raw millimetres
    assert_eq!(view.sources[0].key.schema.as_deref(), Some("IFC2X3"));
    assert_eq!(view.sources[0].key.length_unit_scale_bits.len(), 16);
    assert!(matches!(&view.sources[0].key.context,
        SweptDiskSourceContext::Mapped { representation_map_path } if representation_map_path == &[45]));
    for id in [50, 51] {
        let instances = &view.instances[&id];
        assert_eq!(instances.len(), 2);
        assert_eq!(instances[0].ordinal, 0);
        assert_eq!(instances[1].ordinal, 1);
        assert_eq!(instances[0].source, instances[1].source);
        assert_eq!(instances[0].mapping_path, vec![47]);
        assert_eq!(instances[1].mapping_path, vec![1002]);
        let near = instances[0].world_from_source.unwrap();
        let far = instances[1].world_from_source.unwrap();
        assert!((near[0] - 0.001).abs() < 1e-15);
        assert!((far[12] - 5_000_000.0).abs() < 1e-6);
        let flattened = extract_swept_disk_descriptions(model.as_bytes(), None);
        assert_eq!(flattened.elements[&id].len(), instances.len());
        assert!((flattened.elements[&id][1].radius - 0.0145).abs() < 1e-12);
        let raw = serde_json::to_value(&view.sources[0].directrix).unwrap();
        let raw_end = raw[0]["end"][0].as_f64().unwrap();
        let world_end = far[0] * raw_end + far[12];
        let flattened_value = serde_json::to_value(&flattened.elements[&id][1]).unwrap();
        let flat_end = flattened_value["Directrix"][0]["end"][0].as_f64().unwrap();
        assert!((world_end - flat_end).abs() < 1e-8);
    }
}

#[test]
fn nonuniform_instance_is_explicitly_unsupported_without_corrupting_source() {
    let model = fixture().replace(
        "#46=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#10,$,$);",
        "#46=IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM($,$,#10,$,$,2.,1.);",
    );
    let view = extract_swept_disk_definitions(model.as_bytes(), None);
    assert_eq!(view.sources.len(), 1);
    assert_eq!(serde_json::to_value(&view.sources[0].status).unwrap()["type"], "complete");
    let instance = &view.instances[&50][0];
    assert_eq!(serde_json::to_value(&instance.status).unwrap()["type"], "unsupported");
    assert!(instance.world_from_source.is_some());
}

#[test]
fn nested_maps_and_mirror_preserve_source_context_and_world_status() {
    let model = fixture().replace(
        "#49=IFCPRODUCTDEFINITIONSHAPE($,$,(#48));",
        "#1003=IFCDIRECTION((0.,-1.,0.));\n#1004=IFCCARTESIANTRANSFORMATIONOPERATOR3D(#12,#1003,#10,$,$);\n#1005=IFCREPRESENTATIONMAP(#13,#48);\n#1006=IFCMAPPEDITEM(#1005,#1004);\n#1007=IFCSHAPEREPRESENTATION(#16,'Body','MappedRepresentation',(#1006));\n#49=IFCPRODUCTDEFINITIONSHAPE($,$,(#1007));",
    );
    let view = extract_swept_disk_definitions(model.as_bytes(), None);
    assert!(view.diagnostics.is_empty(), "{:?}", view.diagnostics);
    assert_eq!(view.sources.len(), 1);
    assert!(matches!(&view.sources[0].key.context,
        SweptDiskSourceContext::Mapped { representation_map_path }
            if representation_map_path == &[1005, 45]));
    let instance = &view.instances[&50][0];
    assert_eq!(instance.mapping_path, vec![1006, 47]);
    let matrix = instance.world_from_source.unwrap();
    assert!(matrix[0] * matrix[5] * matrix[10] < 0.0);
    assert_eq!(serde_json::to_value(&instance.status).unwrap()["type"], "complete");
    assert_eq!(extract_swept_disk_descriptions(model.as_bytes(), None).elements[&50].len(), 1);
}

#[test]
fn unmapped_source_uses_top_level_representation_id() {
    let model = fixture().replace(
        "#49=IFCPRODUCTDEFINITIONSHAPE($,$,(#48));",
        "#49=IFCPRODUCTDEFINITIONSHAPE($,$,(#44));",
    );
    let view = extract_swept_disk_definitions(model.as_bytes(), None);
    assert_eq!(view.sources.len(), 1);
    assert!(matches!(view.sources[0].key.context,
        SweptDiskSourceContext::Direct { representation_id: 44 }));
    assert_eq!(view.instances[&50][0].mapping_path, Vec::<u32>::new());
}

#[test]
fn repeated_csg_operand_keeps_each_instance_and_source_modified_provenance() {
    let model = fixture().replace(
        "#44=IFCSHAPEREPRESENTATION(#16,'Body','AdvancedSweptSolid',(#43));",
        "#1001=IFCBOOLEANRESULT(.UNION.,#43,#43);\n#44=IFCSHAPEREPRESENTATION(#16,'Body','AdvancedSweptSolid',(#1001));",
    );
    let view = extract_swept_disk_definitions(model.as_bytes(), None);
    assert!(view.diagnostics.is_empty(), "{:?}", view.diagnostics);
    assert_eq!(view.sources.len(), 1);
    let instances = &view.instances[&50];
    assert_eq!(instances.len(), 2);
    assert_eq!([instances[0].ordinal, instances[1].ordinal], [0, 1]);
    assert!(instances.iter().all(|instance| instance.source_modified));
}

#[test]
fn distinct_representation_maps_do_not_share_a_source_key() {
    let model = fixture().replace(
        "#48=IFCSHAPEREPRESENTATION(#16,'Body','MappedRepresentation',(#47));",
        "#1005=IFCREPRESENTATIONMAP(#13,#44);\n#1006=IFCMAPPEDITEM(#1005,#46);\n#48=IFCSHAPEREPRESENTATION(#16,'Body','MappedRepresentation',(#47,#1006));",
    );
    let view = extract_swept_disk_definitions(model.as_bytes(), None);
    assert!(view.diagnostics.is_empty(), "{:?}", view.diagnostics);
    assert_eq!(view.sources.len(), 2);
    assert_ne!(view.instances[&50][0].source, view.instances[&50][1].source);
}

#[test]
fn malformed_source_is_reported_without_partial_instances() {
    let model = fixture().replace(
        "#43=IFCSWEPTDISKSOLID(#42,14.5,$,0.,2750.);",
        "#43=IFCSWEPTDISKSOLID(#42,-1.,$,0.,2750.);",
    );
    let view = extract_swept_disk_definitions(model.as_bytes(), None);
    assert!(view.sources.is_empty());
    assert!(view.instances.is_empty());
    assert!(view.diagnostics.iter().any(|item| item.contains("product #50, solid #43")));
}

#[test]
fn issue_5787_combined_walk_matches_standalone_views_and_ordinals() {
    let model = fixture().replace(
        "#48=IFCSHAPEREPRESENTATION(#16,'Body','MappedRepresentation',(#47));",
        "#1000=IFCCARTESIANPOINT((5000000000.,0.,0.));\n#1001=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#1000,$,$);\n#1002=IFCMAPPEDITEM(#45,#1001);\n#48=IFCSHAPEREPRESENTATION(#16,'Body','MappedRepresentation',(#47,#1002));",
    );
    let combined = extract_analytic_quantity_sources(model.as_bytes(), None);
    let descriptions = extract_swept_disk_descriptions(model.as_bytes(), None);
    let definitions = extract_swept_disk_definitions(model.as_bytes(), None);
    assert_eq!(serde_json::to_value(&combined.swept_disk_descriptions).unwrap(),
        serde_json::to_value(&descriptions).unwrap());
    assert_eq!(serde_json::to_value(&combined.swept_disk_definitions).unwrap(),
        serde_json::to_value(&definitions).unwrap());
    assert_eq!(combined.swept_disk_descriptions.elements[&50].len(), 2);
    for instance in &combined.swept_disk_definitions.instances[&50] {
        let description = &combined.swept_disk_descriptions.elements[&50][instance.ordinal];
        assert_eq!(instance.solid_id, description.solid_id);
        assert_eq!(instance.mapping_path, description.mapping_path);
    }
}

#[test]
fn issue_7955_captured_definitions_own_the_authored_rational_directrix() {
    use ifc_lite_geometry::analytic::{with_source_capture, AnalyticStatus, OwnedDirectrix, SourceValue};
    let model = fixture().replace(
        "#43=IFCSWEPTDISKSOLID(#42,14.5,$,0.,2750.);",
        "#60=IFCCARTESIANPOINT((2000.,0.,0.));\n#61=IFCCARTESIANPOINT((2000.,2000.,0.));\n\
#62=IFCCARTESIANPOINT((0.,2000.,0.));\n\
#63=IFCRATIONALBSPLINECURVEWITHKNOTS(2,(#60,#61,#62),.CIRCULAR_ARC.,.F.,.F.,(3,3),(2.,6.),.UNSPECIFIED.,(1.,0.7071067811865476,1.));\n\
#43=IFCSWEPTDISKSOLID(#63,14.5,$,3.5,4.5);",
    );
    let plain = extract_swept_disk_definitions(model.as_bytes(), None);
    assert!(plain.sources[0].source.is_none() && plain.sources[0].owned_directrix.is_none());
    let view = with_source_capture(|| extract_swept_disk_definitions(model.as_bytes(), None));
    assert_eq!(serde_json::to_value(&view).unwrap(), serde_json::to_value(&plain).unwrap(),
        "opt-in source never changes serialized output");
    let source = &view.sources[0];
    assert!(source.directrix.is_empty());
    assert!(matches!(source.status, AnalyticStatus::Unsupported(_)));
    assert_eq!((source.start_param, source.end_param), (Some(3.5), Some(4.5)));
    let Some(OwnedDirectrix::Rational(curve)) = &source.owned_directrix else {
        panic!("missing owned rational directrix");
    };
    // Raw file millimetres and the original weights/knot interval; the length
    // unit is applied once, by each instance's world_from_source.
    assert_eq!(curve.control_points[1], [2000., 2000., 0.]);
    assert_eq!(curve.weights, vec![1., std::f64::consts::FRAC_1_SQRT_2, 1.]);
    assert_eq!(curve.parameter_range, [3.5, 4.5]);
    assert!((view.instances[&50][0].world_from_source.unwrap()[0] - 0.001).abs() < 1e-15);
    let graph = source.source.as_ref().unwrap();
    assert_eq!(graph.capture_status, AnalyticStatus::Complete);
    assert_eq!(graph.records[&43].attributes["Directrix"], SourceValue::EntityRef(63));
    assert_eq!(graph.records[&60].attributes["Coordinates"], SourceValue::List(
        vec![SourceValue::Real(2000.), SourceValue::Real(0.), SourceValue::Real(0.)]));

    let trimmed = with_source_capture(|| extract_swept_disk_definitions(fixture().as_bytes(), None));
    let line = &trimmed.sources[0];
    assert_eq!(line.owned_directrix, Some(OwnedDirectrix::Segments(line.directrix.clone())));
    let graph = line.source.as_ref().unwrap();
    assert_eq!(graph.capture_status, AnalyticStatus::Complete);
    assert!(graph.records.contains_key(&42) && graph.records.contains_key(&41));
}
