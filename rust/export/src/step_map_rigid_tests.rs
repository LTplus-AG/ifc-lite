// SPDX-License-Identifier: MPL-2.0
//! #6692: root-only covariance preserves representations and logical ownership.
use super::tests::{apply, model, world_mesh};
use super::*;

fn rigid_model(unit: f64) -> String {
    model(unit, true).replace(
        &format!("0.6,0.8,{}", writer::real(0.9996 * unit).unwrap()),
        &format!("0.6,0.8,{}", writer::real(unit).unwrap()),
    )
}

#[test]
fn issue_6692_rigid_root_preserves_all_original_representation_and_child_records() {
    for unit in [1.0, 0.001] {
        let source = rigid_model(unit).replace("ENDSEC;\nEND-ISO", "#90=IFCSHAPEREPRESENTATION(#10,'Box','BoundingBox',(#91));\n#91=IFCBOUNDINGBOX(#12,4.,2.,3.);\nENDSEC;\nEND-ISO")
            .replace("(#44));", "(#44,#90));");
        let plan = plan_map_conversion_normalization(source.as_bytes()).unwrap();
        assert!(plan.warnings.is_empty(), "{:?}", plan.warnings);
        assert_eq!(
            plan.replacements
                .iter()
                .map(|patch| patch.express_id)
                .collect::<Vec<_>>(),
            [80, 61, 10]
        );
        assert_eq!(plan.new_entities.len(), 5);
        let output = apply(&source, &plan);
        let mut before = EntityDecoder::new(&source);
        let mut after = EntityDecoder::new(&output);
        let router = GeometryRouter::with_scale(unit);
        let types = [
            (61, IfcType::IfcMapConversion),
            (60, IfcType::IfcProjectedCRS),
        ];
        let geo = GeoRefExtractor::extract(&mut before, &types)
            .unwrap()
            .unwrap();
        let map = Matrix4::from_column_slice(&geo.to_matrix());
        for id in [50, 81] {
            let product = before.decode_by_id(id).unwrap();
            let old = Matrix4::from_column_slice(
                &router
                    .resolve_scaled_placement_strict(&product, &mut before)
                    .unwrap(),
            );
            let product = after.decode_by_id(id).unwrap();
            let mut new = Matrix4::from_column_slice(
                &router
                    .resolve_scaled_placement_strict(&product, &mut after)
                    .unwrap(),
            );
            let mut engineering = old;
            for row in 0..3 {
                engineering[(row, 3)] /= unit;
            }
            for row in 0..3 {
                for col in 0..3 {
                    new[(row, col)] *= unit;
                }
            }
            let expected = map * engineering;
            assert!((new - expected).amax() < 1e-8, "unit {unit}, product {id}");
        }
        let mut scanner = EntityScanner::new(&source);
        while let Some((id, _, start, end)) = scanner.next_entity() {
            if id == 80 || id == 61 || id == 10 {
                continue;
            }
            assert!(
                output.contains(&source[start..end]),
                "original entity #{id} changed"
            );
        }
        let meshes = world_mesh(&output);
        assert_eq!(meshes.elements.len(), 1);
        assert_eq!(meshes.elements[&50].faces.len(), 12);
        assert_eq!(meshes.elements[&50].color, [1., 0., 0., 1.]);
    }
}

#[test]
fn issue_6692_rigid_root_refuses_invalid_ownership_and_reports_without_partial_patches() {
    let source = rigid_model(1.);
    for invalid in [
        source.replace(
            "#80=IFCLOCALPLACEMENT($,#11)",
            "#80=IFCLOCALPLACEMENT(#20,#11)",
        ),
        source.replace("#30,#45", "$,#45"),
        source.replace(
            "#44=IFCSHAPEREPRESENTATION(#10",
            "#44=IFCSHAPEREPRESENTATION(#60",
        ),
        source.replace(
            "ENDSEC;\nEND-ISO",
            "#99=IFCGRIDPLACEMENT($,$);\nENDSEC;\nEND-ISO",
        ),
    ] {
        let plan = plan_map_conversion_normalization(invalid.as_bytes()).unwrap();
        assert_eq!(plan.warnings.len(), 1);
        assert!(plan.replacements.is_empty());
        assert!(plan.new_entities.is_empty());
    }
}

fn with_entities(source: &str, entities: &str) -> String {
    let end = source.rfind("ENDSEC;").unwrap();
    format!("{}\n{entities}\n{}", &source[..end], &source[end..])
}

#[test]
fn issue_6692_endpoint_local_connections_and_owned_aspects_preserve_original_records() {
    let source = with_entities(
        &rigid_model(1.),
        "\
#90=IFCSPACE('0M7tQ9Jbj1BAeHd7rqnDmS',$,'Space',$,$,#30,$,$,.ELEMENT.,.INTERNAL.,$);\n\
#91=IFCPLANE(#11);\n#92=IFCCONNECTIONSURFACEGEOMETRY(#91,$);\n\
#93=IFCRELSPACEBOUNDARY('0M7tQ9Jbj1BAeHd7rqnDmT',$,$,$,#90,#50,#92,.PHYSICAL.,.INTERNAL.);\n\
#94=IFCSHAPEASPECT((#44),'Aspect',$,.T.,#45);",
    );
    let plan = plan_map_conversion_normalization(source.as_bytes()).unwrap();
    assert!(plan.warnings.is_empty(), "{:?}", plan.warnings);
    let output = apply(&source, &plan);
    for id in [90, 91, 92, 93, 94] {
        assert!(!plan.replacements.iter().any(|patch| patch.express_id == id));
    }
    assert!(output.contains("#92=IFCCONNECTIONSURFACEGEOMETRY(#91,$);"));
    let excessive_aspect = source.replace(
        "((#44),'Aspect'",
        &format!("(({}),'Aspect'", vec!["#44"; 10_000].join(",")),
    );
    let refused = plan_map_conversion_normalization(excessive_aspect.as_bytes()).unwrap();
    assert!(refused
        .warnings
        .iter()
        .any(|warning| warning
            .contains("ShapeAspect context walk exceeded its reference-work bound")));
    assert!(refused.replacements.is_empty() && refused.new_entities.is_empty());
    for invalid in [
        source.replace("#90,#50,#92", "#60,#50,#92"),
        with_entities(
            &source,
            "#95=IFCRELINTERFERESELEMENTS('0M7tQ9Jbj1BAeHd7rqnDmU',$,$,$,#50,#50,#92,$,.T.);",
        ),
        with_entities(&source, "#95=IFCPROPERTYSINGLEVALUE('foreign',$,#80,$);"),
        source.replace("((#44),'Aspect'", "((#96),'Aspect'"),
    ] {
        let plan = plan_map_conversion_normalization(invalid.as_bytes()).unwrap();
        assert!(
            !plan.warnings.is_empty(),
            "missing ownership/context report"
        );
        assert!(plan.replacements.is_empty() && plan.new_entities.is_empty());
    }
}

#[test]
fn issue_6692_rigid_opening_cut_and_fill_preserve_physical_surface_and_style() {
    let source = with_entities(&rigid_model(1.), "\
#90=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,2.,1.);\n\
#91=IFCEXTRUDEDAREASOLID(#90,#11,#43,3.);\n#92=IFCSHAPEREPRESENTATION(#10,'Body','SweptSolid',(#91));\n\
#93=IFCPRODUCTDEFINITIONSHAPE($,$,(#92));\n\
#94=IFCOPENINGELEMENT('0M7tQ9Jbj1BAeHd7rqnDmS',$,'Opening',$,$,#30,#93,$,.OPENING.);\n\
#95=IFCRELVOIDSELEMENT('0M7tQ9Jbj1BAeHd7rqnDmT',$,$,$,#50,#94);\n\
#96=IFCDOOR('0M7tQ9Jbj1BAeHd7rqnDmU',$,'Fill',$,$,#30,#93,$,$,$,.DOOR.,.NOTDEFINED.,$);\n\
#97=IFCRELFILLSELEMENT('0M7tQ9Jbj1BAeHd7rqnDmV',$,$,$,#94,#96);");
    let plan = plan_map_conversion_normalization(source.as_bytes()).unwrap();
    assert!(plan.warnings.is_empty(), "{:?}", plan.warnings);
    let output = apply(&source, &plan);
    let old = world_mesh(&source);
    let new = world_mesh(&output);
    assert!(
        old.elements[&50].faces.len() > 12,
        "actual opening cut has additional faces"
    );
    assert_eq!(old.elements[&50].faces.len(), new.elements[&50].faces.len());
    let mut decoder = EntityDecoder::new(&source);
    let geo = GeoRefExtractor::extract(
        &mut decoder,
        &[
            (61, IfcType::IfcMapConversion),
            (60, IfcType::IfcProjectedCRS),
        ],
    )
    .unwrap()
    .unwrap();
    for id in [50, 96] {
        assert_eq!(new.elements[&id].color, old.elements[&id].color);
        assert_eq!(new.elements[&id].global_id, old.elements[&id].global_id);
        for point in &old.elements[&id].vertices {
            let mapped = geo.local_to_map(point[0], point[1], point[2]);
            let expected = nalgebra::Vector3::new(mapped.0, mapped.1, mapped.2);
            let nearest = new.elements[&id]
                .vertices
                .iter()
                .map(|p| (expected - nalgebra::Vector3::from_column_slice(p)).norm())
                .fold(f64::INFINITY, f64::min);
            assert!(
                nearest < 1e-4,
                "product {id}, physical vertex error {nearest}"
            );
        }
    }
}

#[test]
fn issue_6692_true_north_covaries_without_mutating_shared_direction() {
    let source = with_entities(
        &rigid_model(1.).replace("3,1.E-5,#11,$)", "3,1.E-5,#11,#98)"),
        "#98=IFCDIRECTION((0.3,0.4));\n#99=IFCPROPERTYSINGLEVALUE('shared',$,#98,$);",
    );
    let plan = plan_map_conversion_normalization(source.as_bytes()).unwrap();
    assert!(plan.warnings.is_empty(), "{:?}", plan.warnings);
    let output = apply(&source, &plan);
    let mut decoder = EntityDecoder::new(&output);
    let context = decoder.decode_by_id(10).unwrap();
    let direction = decoder.decode_by_id(context.get_ref(5).unwrap()).unwrap();
    // Authored map R=(.6,.8): R*(.6,.8)=(-.28,.96).
    let ratios = direction.get_list(0).unwrap();
    assert!((ratios[0].as_float().unwrap() + 0.28).abs() < 1e-12);
    assert!((ratios[1].as_float().unwrap() - 0.96).abs() < 1e-12);
    assert!(output.contains("#98=IFCDIRECTION((0.3,0.4));"));
    for invalid in [
        source.replace("(0.3,0.4)", "(0.,0.)"),
        source.replace("(0.3,0.4)", "(0.3,0.4,0.)"),
    ] {
        let plan = plan_map_conversion_normalization(invalid.as_bytes()).unwrap();
        assert!(!plan.warnings.is_empty());
        assert!(plan.replacements.is_empty() && plan.new_entities.is_empty());
    }
}

#[test]
fn issue_6692_unused_definition_context_north_remains_in_its_original_frame() {
    let source = with_entities(
        &rigid_model(1.).replace("(#10),#4", "(#10,#96),#4"),
        "#96=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Plan',3,1.E-5,#11,#98);\n\
#97=IFCSHAPEREPRESENTATION(#96,'Body','SweptSolid',(#42));\n\
#98=IFCDIRECTION((0.3,0.4));\n\
#99=IFCREPRESENTATIONMAP(#11,#97);",
    );
    let plan = plan_map_conversion_normalization(source.as_bytes()).unwrap();
    assert!(plan.warnings.is_empty(), "{:?}", plan.warnings);
    assert!(plan.replacements.iter().any(|patch| patch.express_id == 10));
    assert!(!plan.replacements.iter().any(|patch| patch.express_id == 96));
    let output = apply(&source, &plan);
    let mut decoder = EntityDecoder::new(&output);
    assert_eq!(decoder.decode_by_id(96).unwrap().get_ref(5), Some(98));
    for record in [
        "#97=IFCSHAPEREPRESENTATION(#96,'Body','SweptSolid',(#42));",
        "#98=IFCDIRECTION((0.3,0.4));",
        "#99=IFCREPRESENTATIONMAP(#11,#97);",
    ] {
        assert!(output.contains(record), "unused definition changed: {record}");
    }
}

#[test]
fn issue_6692_only_declared_identity_sibling_contexts_share_the_engineering_frame() {
    let source = with_entities(
        &rigid_model(1.).replace("(#10),#4", "(#10,#96),#4"),
        "\
#96=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Plan',3,1.E-5,#11,$);\n\
#97=IFCSHAPEREPRESENTATION(#96,'FootPrint','SweptSolid',(#42));",
    )
    .replace("(#44));", "(#44,#97));");
    let plan = plan_map_conversion_normalization(source.as_bytes()).unwrap();
    assert!(plan.warnings.is_empty(), "{:?}", plan.warnings);
    assert!(plan.replacements.iter().any(|patch| patch.express_id == 96));
    for invalid in [
        source.replace("(#10,#96),#4", "(#10),#4"),
        source.replace("'Plan',3,1.E-5,#11", "'Plan',3,1.E-5,#21"),
        source.replace("'Plan',3,", "'Plan',2,"),
    ] {
        let plan = plan_map_conversion_normalization(invalid.as_bytes()).unwrap();
        assert!(!plan.warnings.is_empty());
        assert!(plan.replacements.is_empty() && plan.new_entities.is_empty());
    }
}

#[test]
fn issue_6692_no_added_wrapper_preserves_depth_31_colors_and_reports_depth_cycles_and_work_bounds()
{
    let source = super::tests::styled_mapped_chain(31).replace("0.6,0.8,0.9996", "0.6,0.8,1.");
    let plan = plan_map_conversion_normalization(source.as_bytes()).unwrap();
    assert!(plan.warnings.is_empty(), "{:?}", plan.warnings);
    let output = apply(&source, &plan);
    let colored = |source: &str| {
        let result = ifc_lite_processing::process_geometry(&source.as_bytes());
        ifc_lite_processing::build_colored_geometry_data_export(
            &result.meshes,
            result.metadata.coordinate_info.origin_shift,
            None,
        )
    };
    let old = colored(&source);
    let new = colored(&output);
    assert_eq!(
        old.elements[&50].palette,
        vec![[1., 0., 0., 1.], [0., 1., 0., 1.]]
    );
    assert_eq!(new.elements[&50].palette, old.elements[&50].palette);
    assert_eq!(new.elements[&50].geometry.faces.len(), 24);
    for color in [0, 1] {
        assert_eq!(
            new.elements[&50]
                .face_colors
                .iter()
                .filter(|&&value| value == color)
                .count(),
            12
        );
    }
    let cyclic = source.replace(
        "#1000=IFCSHAPEREPRESENTATION(#10,'Body','MappedRepresentation',(#42,#242))",
        "#1000=IFCSHAPEREPRESENTATION(#10,'Body','MappedRepresentation',(#1092))",
    );
    let repeated = source.replace(
        "'MappedRepresentation',(#1092));\n#45",
        &format!(
            "'MappedRepresentation',({}));\n#45",
            vec!["#1092"; 10000].join(",")
        ),
    );
    for (invalid, report) in [
        (
            super::tests::styled_mapped_chain(32).replace("0.6,0.8,0.9996", "0.6,0.8,1."),
            "renderer depth bound",
        ),
        (cyclic, "cyclic"),
        (repeated, "reference-work bound"),
    ] {
        let refused = plan_map_conversion_normalization(invalid.as_bytes()).unwrap();
        assert!(
            refused
                .warnings
                .iter()
                .any(|warning| warning.contains(report)),
            "{report}: {:?}",
            refused.warnings
        );
        assert!(refused.replacements.is_empty() && refused.new_entities.is_empty());
    }
}

fn aligned_model(linear_parent: &str) -> String {
    with_entities(
        &rigid_model(1.),
        &format!("\
#100=IFCLOCALPLACEMENT($,#11);\n\
#101=IFCCARTESIANPOINT((0.,0.,0.));\n#102=IFCCARTESIANPOINT((10.,5.,0.));\n#103=IFCPOLYLINE((#101,#102));\n\
#104=IFCSHAPEREPRESENTATION(#10,'Axis','Curve3D',(#103));\n#105=IFCPRODUCTDEFINITIONSHAPE($,$,(#104));\n\
#106=IFCALIGNMENT('0M7tQ9Jbj1BAeHd7rqnDmU',$,'Alignment',$,$,#100,#105,$);\n\
#107=IFCPOINTBYDISTANCEEXPRESSION(IFCLENGTHMEASURE(4.),1.,0.5,$,#103);\n#108=IFCAXIS2PLACEMENTLINEAR(#107,$,$);\n\
#109=IFCLINEARPLACEMENT({linear_parent},#108,$);\n\
#110=IFCREFERENT('0M7tQ9Jbj1BAeHd7rqnDmV',$,'Station',$,$,#109,$,.STATION.);\n\
#111=IFCLINEARPLACEMENT(#30,#108,$);\n\
#112=IFCREFERENT('0M7tQ9Jbj1BAeHd7rqnDmW',$,'Nested station',$,$,#111,$,.STATION.);"),
    )
}

#[test]
fn issue_7335_alignment_and_linear_placements_covary_with_their_placement_roots() {
    let source = aligned_model("#100");
    let plan = plan_map_conversion_normalization(source.as_bytes()).unwrap();
    assert!(plan.warnings.is_empty(), "{:?}", plan.warnings);
    let output = apply(&source, &plan);
    let mut before = EntityDecoder::new(&source);
    let mut after = EntityDecoder::new(&output);
    let router = GeometryRouter::with_scale(1.);
    let geo = GeoRefExtractor::extract(
        &mut before,
        &[
            (61, IfcType::IfcMapConversion),
            (60, IfcType::IfcProjectedCRS),
        ],
    )
    .unwrap()
    .unwrap();
    let map = Matrix4::from_column_slice(&geo.to_matrix());
    for id in [106, 110, 112, 50] {
        let product = before.decode_by_id(id).unwrap();
        let old = Matrix4::from_column_slice(
            &router
                .resolve_scaled_placement_strict(&product, &mut before)
                .unwrap(),
        );
        let product = after.decode_by_id(id).unwrap();
        let new = Matrix4::from_column_slice(
            &router
                .resolve_scaled_placement_strict(&product, &mut after)
                .unwrap(),
        );
        assert!((new - map * old).amax() < 1e-8, "product #{id}");
    }
    // The station is sampled from the curve (4 along, 1 lateral, 0.5 up),
    // not an identity fallback.
    let station = before.decode_by_id(110).unwrap();
    let sampled = router
        .resolve_scaled_placement_strict(&station, &mut before)
        .unwrap();
    let expected = [35. / 125f64.sqrt(), 30. / 125f64.sqrt(), 0.5];
    for axis in 0..3 {
        assert!(
            (sampled[12 + axis] - expected[axis]).abs() < 1e-9,
            "{sampled:?}"
        );
    }
    // Only placement roots and the map change; linear placements, curves and
    // representations keep their original records.
    let mut scanner = EntityScanner::new(&source);
    while let Some((id, _, start, end)) = scanner.next_entity() {
        if [80, 100, 61, 10].contains(&id) {
            continue;
        }
        assert!(
            output.contains(&source[start..end]),
            "original entity #{id} changed"
        );
    }
}

#[test]
fn issue_7335_world_relative_linear_placement_refuses_without_partial_patches() {
    let plan = plan_map_conversion_normalization(aligned_model("$").as_bytes()).unwrap();
    assert_eq!(plan.warnings.len(), 1, "{:?}", plan.warnings);
    assert!(
        plan.warnings[0].contains("IfcLinearPlacement #109"),
        "{:?}",
        plan.warnings
    );
    assert!(plan.replacements.is_empty());
    assert!(plan.new_entities.is_empty());
}
