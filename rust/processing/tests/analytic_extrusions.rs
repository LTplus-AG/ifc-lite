// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #5784: exact extrusion sources share a bounded occurrence walk with disks.

use std::collections::HashSet;
use ifc_lite_processing::{extract_extrusion_definitions, AnalyticSourceContext};
use ifc_lite_geometry::analytic::AnalyticCurveSegment;
use ifc_lite_geometry::extract_profiles_with_diagnostics;
use nalgebra::{Matrix4, Vector4};

fn mapped_fixture() -> String {
    std::fs::read_to_string("../geometry/tests/fixtures/mapped_instances_synthetic.ifc").unwrap()
}

#[test]
fn mapped_occurrences_share_one_raw_profile_and_have_distinct_f64_world_frames() {
    let model = mapped_fixture();
    let view = extract_extrusion_definitions(model.as_bytes(), Some(&HashSet::from([31, 38])));
    assert!(view.diagnostics.is_empty(), "{:?}", view.diagnostics);
    assert_eq!(view.sources.len(), 1);
    let source = &view.sources[0];
    assert_eq!(source.source.solid_id, 12);
    assert_eq!(source.source.depth, Some(1.0));
    assert_eq!(source.source.profile.as_ref().unwrap().loops[0].signed_area, 1.0);
    let nominal = source.nominal_quantities.as_ref().unwrap();
    assert_eq!((nominal.profile_area, nominal.projected_height, nominal.nominal_volume),
        (1.0, 1.0, 1.0));
    assert!(matches!(&source.key.context,
        AnalyticSourceContext::Mapped { representation_map_path } if representation_map_path == &[16]));
    let first = &view.instances[&31][0];
    let second = &view.instances[&38][0];
    assert_eq!(first.source, second.source);
    assert_eq!(first.mapping_path, vec![25]);
    assert_eq!(second.mapping_path, vec![32]);
    assert_eq!(first.ordinal, 0);
    assert_eq!(second.ordinal, 0);
    assert!((first.world_from_source.unwrap()[12]).abs() < 1e-12);
    assert!((second.world_from_source.unwrap()[12] - 3.0).abs() < 1e-12);
    let empty = extract_extrusion_definitions(model.as_bytes(), Some(&HashSet::new()));
    assert!(empty.sources.is_empty());
    assert!(empty.instances.is_empty());
}

#[test]
fn analytic_extraction_preserves_legacy_drawing_profiles_on_same_mapped_fixture() {
    // #5784: a new analytic consumer must not change the established 2D drawing view.
    let model = mapped_fixture();
    let (mut drawing, skipped) = extract_profiles_with_diagnostics(model.as_bytes(), 0);
    let analytic = extract_extrusion_definitions(model.as_bytes(), Some(&HashSet::from([31, 38])));
    drawing.retain(|profile| [31, 38].contains(&profile.express_id));
    drawing.sort_by_key(|profile| profile.express_id);
    assert!(skipped.is_empty(), "{skipped:?}");
    assert_eq!(drawing.iter().map(|profile| profile.express_id).collect::<Vec<_>>(), [31, 38]);
    for profile in &drawing {
        assert_eq!(profile.ifc_type, "IfcBuildingElementProxy");
        assert_eq!(profile.outer_points, [-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5]);
        assert!(profile.hole_counts.is_empty());
        assert!(profile.hole_points.is_empty());
        assert_eq!(profile.extrusion_depth, 1.0);
    }
    assert!((drawing[1].transform[12] - drawing[0].transform[12] - 3.0).abs() < 1e-6);
    assert!(analytic.diagnostics.is_empty(), "{:?}", analytic.diagnostics);
    assert_eq!(analytic.sources.len(), 1);
    assert_eq!(analytic.instances[&31].len(), 1);
    assert_eq!(analytic.instances[&38].len(), 1);
    assert!((analytic.instances[&38][0].world_from_source.unwrap()[12]
        - analytic.instances[&31][0].world_from_source.unwrap()[12] - 3.0).abs() < 1e-12);
}

#[test]
fn direct_and_mapped_uses_have_distinct_source_contexts() {
    let model = mapped_fixture().replace(
        "#27=IFCPRODUCTDEFINITIONSHAPE($,$,(#26));",
        "#27=IFCPRODUCTDEFINITIONSHAPE($,$,(#13));",
    );
    let view = extract_extrusion_definitions(model.as_bytes(), Some(&HashSet::from([31, 38])));
    assert_eq!(view.sources.len(), 2);
    assert!(matches!(view.instances[&31][0].source.context,
        AnalyticSourceContext::Direct { representation_id: 13 }));
    assert!(matches!(view.instances[&38][0].source.context,
        AnalyticSourceContext::Mapped { .. }));
}

#[test]
fn large_product_origin_stays_f64_and_does_not_mutate_raw_profile() {
    let model = mapped_fixture().replace(
        "#35=IFCCARTESIANPOINT((3.0,2.0,0.));",
        "#35=IFCCARTESIANPOINT((5000000000.0,2.0,0.));",
    );
    let view = extract_extrusion_definitions(model.as_bytes(), Some(&HashSet::from([38])));
    let matrix = view.instances[&38][0].world_from_source.unwrap();
    assert!((matrix[12] - 5_000_000_000.0).abs() < 1e-6);
    assert_eq!(view.sources[0].source.profile.as_ref().unwrap().loops[0].signed_area, 1.0);
}

#[test]
fn profile_solid_and_occurrence_frames_compose_in_authored_order() {
    let model = mapped_fixture()
        .replace("#6=IFCCARTESIANPOINT((0.,0.));", "#6=IFCCARTESIANPOINT((1.,0.));")
        .replace("#7=IFCAXIS2PLACEMENT2D(#6,$);", "#7=IFCAXIS2PLACEMENT2D(#6,#600);")
        .replace("#10=IFCCARTESIANPOINT((0.,0.,0.));", "#10=IFCCARTESIANPOINT((0.,2.,0.));")
        .replace("#11=IFCAXIS2PLACEMENT3D(#10,$,$);", "#11=IFCAXIS2PLACEMENT3D(#10,$,#601);")
        .replace("#17=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#1,$,$);",
            "#17=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#1,2.,$);")
        .replace("#36=IFCAXIS2PLACEMENT3D(#35,$,$);", "#36=IFCAXIS2PLACEMENT3D(#35,$,#602);")
        .replace("ENDSEC;\nEND-ISO-10303-21;",
            "#600=IFCDIRECTION((0.,1.));\n#601=IFCDIRECTION((0.,1.,0.));\n#602=IFCDIRECTION((0.,1.,0.));\nENDSEC;\nEND-ISO-10303-21;");
    let view = extract_extrusion_definitions(model.as_bytes(), Some(&HashSet::from([38])));
    assert!(view.diagnostics.is_empty(), "{:?}", view.diagnostics);
    let source = &view.sources[0].source;
    let profile = source.profile.as_ref().unwrap();
    let profile_frame = Matrix4::from_column_slice(&profile.profile_position.unwrap());
    let solid_frame = Matrix4::from_column_slice(&source.position_matrix.unwrap());
    assert_eq!((profile_frame[(0, 3)], profile_frame[(0, 0)], profile_frame[(1, 0)]),
        (1.0, 0.0, 1.0));
    assert_eq!((solid_frame[(1, 3)], solid_frame[(0, 0)], solid_frame[(1, 0)]),
        (2.0, 0.0, 1.0));
    let instance = &view.instances[&38][0];
    let occurrence_frame = Matrix4::from_column_slice(&instance.world_from_source.unwrap());
    assert_eq!((occurrence_frame[(0, 3)], occurrence_frame[(1, 3)],
        occurrence_frame[(0, 0)], occurrence_frame[(1, 0)]), (3.0, 2.0, 0.0, 2.0));

    let AnalyticCurveSegment::Line { start, end } = &profile.loops[0].segments[0] else {
        panic!("rectangle boundary must start with a line");
    };
    assert_eq!((*start, *end), ([-0.5, -0.5, 0.0], [0.5, -0.5, 0.0]));
    let world_from_profile = occurrence_frame * solid_frame * profile_frame;
    let to_world = |point: &[f64; 3]| {
        let result = world_from_profile * Vector4::new(point[0], point[1], point[2], 1.0);
        [result.x, result.y, result.z]
    };
    // Independently: profile R90+(1,0), solid R90+(0,2), map scale 2,
    // product R90+(3,2). The two authored endpoints land at these world points.
    assert_eq!(to_world(start), [-4.0, 3.0, 0.0]);
    assert_eq!(to_world(end), [-4.0, 1.0, 0.0]);
}

#[test]
fn nested_mapping_origins_and_millimetres_compose_before_world_conversion() {
    let model = mapped_fixture()
        .replace("#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);",
            "#3=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);")
        .replace("#14=IFCCARTESIANPOINT((0.,0.,0.));",
            "#14=IFCCARTESIANPOINT((4.,0.,0.));")
        .replace("#17=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#1,$,$);",
            "#17=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#1,2.,$);")
        .replace("#34=IFCPRODUCTDEFINITIONSHAPE($,$,(#33));",
            "#34=IFCPRODUCTDEFINITIONSHAPE($,$,(#703));")
        .replace("ENDSEC;\nEND-ISO-10303-21;",
            "#700=IFCCARTESIANPOINT((0.,5.,0.));\n#701=IFCAXIS2PLACEMENT3D(#700,$,$);\n#704=IFCREPRESENTATIONMAP(#701,#26);\n#705=IFCCARTESIANPOINT((7.,0.,0.));\n#706=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#705,$,$);\n#702=IFCMAPPEDITEM(#704,#706);\n#703=IFCSHAPEREPRESENTATION(#5,'Body','MappedRepresentation',(#702));\nENDSEC;\nEND-ISO-10303-21;");
    let view = extract_extrusion_definitions(model.as_bytes(), Some(&HashSet::from([38])));
    assert!(view.diagnostics.is_empty(), "{:?}", view.diagnostics);
    assert_eq!(view.length_unit_scale, 0.001);
    assert_eq!(view.sources.len(), 1);
    let source = &view.sources[0];
    assert_eq!(source.source.depth, Some(1.0)); // raw file units
    assert!(matches!(&source.key.context,
        AnalyticSourceContext::Mapped { representation_map_path }
            if representation_map_path == &[704, 16]));
    let instance = &view.instances[&38][0];
    assert_eq!(instance.mapping_path, [702, 25]);
    let matrix = Matrix4::from_column_slice(&instance.world_from_source.unwrap());
    // Product (3,2), outer target (7,0), outer origin (0,5), then
    // inner scale 2 applied to inner origin (4,0): (18,7) raw millimetres.
    assert!((matrix[(0, 3)] - 0.018).abs() < 1e-12);
    assert!((matrix[(1, 3)] - 0.007).abs() < 1e-12);
    assert!((matrix[(0, 0)] - 0.002).abs() < 1e-12);
    let corner = matrix * Vector4::new(-0.5, -0.5, 0.0, 1.0);
    assert!((corner.x - 0.017).abs() < 1e-12);
    assert!((corner.y - 0.006).abs() < 1e-12);
}

#[test]
fn real_revit_window_map_preserves_holed_profile_and_reuses_source() {
    let model = std::fs::read("../geometry/tests/fixtures/issue_098_wall_W.ifc").unwrap();
    let view = extract_extrusion_definitions(&model, Some(&HashSet::from([928638, 928672])));
    assert!(view.diagnostics.is_empty(), "{:?}", view.diagnostics);
    let source = view.sources.iter().find(|source| source.source.solid_id == 338107).unwrap();
    assert_eq!(source.source.profile.as_ref().unwrap().loops.len(), 2);
    assert!(source.nominal_quantities.is_some());
    assert!(matches!(&source.key.context,
        AnalyticSourceContext::Mapped { representation_map_path } if representation_map_path == &[338168]));
    for id in [928638, 928672] {
        let instance = view.instances[&id].iter().find(|instance| instance.solid_id == 338107).unwrap();
        assert_eq!(instance.source, source.key);
        assert_eq!(instance.mapping_path.len(), 1);
        assert!(instance.world_from_source.is_some());
    }
}

#[test]
fn tapered_source_is_retained_with_explicit_unsupported_status() {
    let model = mapped_fixture().replace(
        "#12=IFCEXTRUDEDAREASOLID(#8,#11,#9,1.0);",
        "#12=IFCEXTRUDEDAREASOLIDTAPERED(#8,#11,#9,1.0,#8);",
    );
    let view = extract_extrusion_definitions(model.as_bytes(), Some(&HashSet::from([31])));
    assert_eq!(view.sources.len(), 1);
    assert!(serde_json::to_value(&view.sources[0].source.status).unwrap()["reason"]
        .as_str().unwrap().contains("tapered"));
    assert!(view.sources[0].nominal_quantities.is_none());
    assert_eq!(view.instances[&31].len(), 1);
}

#[test]
fn repeated_csg_operands_keep_two_ordinals_and_modified_provenance() {
    let model = mapped_fixture().replace(
        "#13=IFCSHAPEREPRESENTATION(#5,'Body','SweptSolid',(#12));",
        "#13=IFCSHAPEREPRESENTATION(#5,'Body','SolidModel',(#500));",
    ).replace("ENDSEC;\nEND-ISO-10303-21;",
        "#500=IFCBOOLEANRESULT(.UNION.,#12,#12);\nENDSEC;\nEND-ISO-10303-21;");
    let view = extract_extrusion_definitions(model.as_bytes(), Some(&HashSet::from([31])));
    let instances = view.instances.get(&31).unwrap_or_else(|| panic!("{:?}", view.diagnostics));
    assert_eq!(instances.len(), 2);
    assert_eq!([instances[0].ordinal, instances[1].ordinal], [0, 1]);
    assert_eq!(instances[0].source, instances[1].source);
    assert!(instances.iter().all(|instance| instance.source_modified));
}
