// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #6443: extrusion source/mesh agreement and mutation controls.

use std::collections::HashSet;
use std::fs;

use ifc_lite_geometry::analytic::{AnalyticCurveSegment, AnalyticStatus};
use ifc_lite_processing::extract_extrusion_definitions;
use nalgebra::Matrix4;

use super::extrusion::{compare_model, compare_surface, eligibility};

fn mapped() -> String {
    fs::read_to_string(format!(
        "{}/../geometry/tests/fixtures/mapped_instances_synthetic.ifc",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap()
}

fn replace_line(model: &str, old: &str, new: &str) -> String {
    assert!(model.contains(old), "fixture line absent: {old}");
    model.replace(old, new)
}

#[test]
fn rectangular_mapped_scaled_mirrored_and_large_occurrences_match() {
    let base = mapped();
    let variants = [
        base.clone(),
        replace_line(&base,
            "#17=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#1,$,$);",
            "#17=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#1,2.,$);"),
        replace_line(&base,
            "#17=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#1,$,$);",
            "#500=IFCDIRECTION((-1.,0.,0.));\n#501=IFCDIRECTION((0.,1.,0.));\n#17=IFCCARTESIANTRANSFORMATIONOPERATOR3D(#500,#501,#1,$,#9);"),
        replace_line(&base,
            "#35=IFCCARTESIANPOINT((3.0,2.0,0.));",
            "#35=IFCCARTESIANPOINT((5000.125,2.0,0.));"),
        replace_line(&base,
            "#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);",
            "#3=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);"),
        replace_line(&base,
            "#6=IFCCARTESIANPOINT((0.,0.));",
            "#6=IFCCARTESIANPOINT((0.25,0.));")
            .replace("#10=IFCCARTESIANPOINT((0.,0.,0.));",
                "#10=IFCCARTESIANPOINT((0.,0.5,0.));")
            .replace("#36=IFCAXIS2PLACEMENT3D(#35,$,$);",
                "#500=IFCDIRECTION((0.,1.,0.));\n#36=IFCAXIS2PLACEMENT3D(#35,$,#500);"),
    ];
    for (index, model) in variants.iter().enumerate() {
        let (source, instance, mesh) = compare_model(model.as_bytes(), 38)
            .unwrap_or_else(|error| panic!("variant {index}: {error}"));
        assert_eq!(source.solid_id, 12);
        assert_eq!(instance.product_id, 38);
        assert!(!mesh.faces.is_empty());
        assert_eq!(instance.mapping_path.len(), 1);
        let frame = Matrix4::from_column_slice(&instance.world_from_source.unwrap());
        if index == 2 {
            assert!(frame.fixed_view::<3, 3>(0, 0).determinant() < 0.0);
        }
        if index == 3 {
            assert!(frame[(0, 3)] > 1_000.0);
        }
        if index == 4 {
            assert!((frame[(0, 0)] - 0.001).abs() < 1e-12);
        }
    }
}

#[test]
fn circle_holed_profile_and_nonaxial_sweep_match() {
    let base = mapped();
    let circle = replace_line(
        &base,
        "#8=IFCRECTANGLEPROFILEDEF(.AREA.,$,#7,1.0,1.0);",
        "#8=IFCCIRCLEPROFILEDEF(.AREA.,$,#7,0.5);",
    );
    compare_model(circle.as_bytes(), 31).unwrap();

    let holed = replace_line(&base,
        "#8=IFCRECTANGLEPROFILEDEF(.AREA.,$,#7,1.0,1.0);",
        "#500=IFCCARTESIANPOINT((-1.,-1.));\n#501=IFCCARTESIANPOINT((1.,-1.));\n#502=IFCCARTESIANPOINT((1.,1.));\n#503=IFCCARTESIANPOINT((-1.,1.));\n#504=IFCPOLYLINE((#500,#501,#502,#503,#500));\n#505=IFCCARTESIANPOINT((-0.25,-0.25));\n#506=IFCCARTESIANPOINT((-0.25,0.25));\n#507=IFCCARTESIANPOINT((0.25,0.25));\n#508=IFCCARTESIANPOINT((0.25,-0.25));\n#509=IFCPOLYLINE((#505,#506,#507,#508,#505));\n#8=IFCARBITRARYPROFILEDEFWITHVOIDS(.AREA.,$,#504,(#509));");
    let (source, _, _) = compare_model(holed.as_bytes(), 31).unwrap();
    assert_eq!(source.profile.unwrap().loops.len(), 2);

    let angled = replace_line(
        &base,
        "#9=IFCDIRECTION((0.,0.,1.));",
        "#9=IFCDIRECTION((0.2,0.,1.));",
    );
    compare_model(angled.as_bytes(), 31).unwrap();

    // A profile rotation applies to its boundary, not to the solid-local
    // ExtrudedDirection. This pair distinguishes the two frames.
    let rotated_and_angled = replace_line(
        &angled,
        "#7=IFCAXIS2PLACEMENT2D(#6,$);",
        "#600=IFCDIRECTION((0.,1.));\n#7=IFCAXIS2PLACEMENT2D(#6,#600);",
    );
    compare_model(rotated_and_angled.as_bytes(), 31).unwrap();
}

#[test]
fn radius_loop_depth_direction_and_occurrence_mutations_fail() {
    let circle = replace_line(
        &mapped(),
        "#8=IFCRECTANGLEPROFILEDEF(.AREA.,$,#7,1.0,1.0);",
        "#8=IFCCIRCLEPROFILEDEF(.AREA.,$,#7,0.5);",
    );
    let (source, instance, mesh) = compare_model(circle.as_bytes(), 31).unwrap();
    let mut wrong_radius = source.clone();
    let AnalyticCurveSegment::Arc { radius, .. } =
        &mut wrong_radius.profile.as_mut().unwrap().loops[0].segments[0]
    else {
        panic!("circle")
    };
    *radius += 0.1;
    assert_failure(compare_surface(31, &wrong_radius, &instance, &mesh));

    let mut wrong_depth = source.clone();
    wrong_depth.depth = Some(wrong_depth.depth.unwrap() + 0.1);
    assert_failure(compare_surface(31, &wrong_depth, &instance, &mesh));

    let mut wrong_direction = source.clone();
    wrong_direction.axis_unit_vector = Some([0.2, 0.0, 0.979_795_897_113_271_2]);
    assert_failure(compare_surface(31, &wrong_direction, &instance, &mesh));

    let mut wrong_occurrence = instance.clone();
    wrong_occurrence.world_from_source.as_mut().unwrap()[12] += 0.1;
    assert_failure(compare_surface(31, &source, &wrong_occurrence, &mesh));

    let (source, instance, mesh) = compare_model(mapped().as_bytes(), 31).unwrap();
    let mut wrong_loop = source.clone();
    let AnalyticCurveSegment::Line { start, end } =
        &mut wrong_loop.profile.as_mut().unwrap().loops[0].segments[0]
    else {
        panic!("rectangle")
    };
    start[1] -= 0.1;
    end[1] -= 0.1;
    assert_failure(compare_surface(31, &wrong_loop, &instance, &mesh));
}

fn assert_failure(result: Result<(), String>) {
    let error = result.expect_err("mutated source must disagree with mesh");
    assert!(
        error.contains("product #31")
            && error.contains("solid #12")
            && error.contains("profile #8")
            && error.contains("residual")
            && error.contains("tolerance"),
        "{error}"
    );
}

#[test]
fn modified_tapered_and_multiple_sources_are_explicitly_excluded() {
    let base = mapped();
    let variants = [
        (replace_line(&base,
            "#13=IFCSHAPEREPRESENTATION(#5,'Body','SweptSolid',(#12));",
            "#500=IFCBLOCK(#11,1.,1.,1.);\n#501=IFCBOOLEANRESULT(.UNION.,#12,#500);\n#13=IFCSHAPEREPRESENTATION(#5,'Body','CSG',(#501));"),
            "CSG operand is not the final visible mesh"),
        (replace_line(&base,
            "#12=IFCEXTRUDEDAREASOLID(#8,#11,#9,1.0);",
            "#12=IFCEXTRUDEDAREASOLIDTAPERED(#8,#11,#9,1.0,#8);"),
            "unsupported or tapered extrusion/profile/occurrence"),
        (replace_line(&base,
            "#13=IFCSHAPEREPRESENTATION(#5,'Body','SweptSolid',(#12));",
            "#13=IFCSHAPEREPRESENTATION(#5,'Body','SweptSolid',(#12,#12));"),
            "multiple source solids cannot be compared to one merged mesh"),
    ];
    for (model, reason) in variants {
        let view = extract_extrusion_definitions(model.as_bytes(), Some(&HashSet::from([31])));
        assert!(view.diagnostics.is_empty(), "{:?}", view.diagnostics);
        assert_eq!(
            eligibility(&view.sources, &view.instances[&31]).unwrap_err(),
            reason
        );
    }
}

#[test]
fn real_authoring_tool_fixture_has_eligible_occurrence() {
    // Catalogued Revit export: tests/models/manifest.json. CI requires
    // fixtures; a developer without them gets an explicit skip instruction.
    let path = format!(
        "{}/../../tests/models/various/01_Snowdon_Towers_Sample_Structural(1).ifc",
        env!("CARGO_MANIFEST_DIR")
    );
    let model = match fs::read(&path) {
        Ok(model) => model,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let required = match std::env::var("IFC_LITE_REQUIRE_FIXTURES") {
                Ok(value) if value == "1" => true,
                Ok(value) if value.is_empty() || value == "0" => false,
                Err(std::env::VarError::NotPresent) => false,
                other => panic!("invalid IFC_LITE_REQUIRE_FIXTURES value: {other:?}"),
            };
            assert!(
                !required,
                "IFC_LITE_REQUIRE_FIXTURES=1 but {path} is missing ({error}); run `pnpm fixtures`"
            );
            eprintln!("skipping {path}: run `pnpm fixtures`");
            return;
        }
        Err(error) => panic!("read {path}: {error}"),
    };
    let view = extract_extrusion_definitions(&model, None);
    assert!(view.diagnostics.is_empty(), "{:?}", view.diagnostics);
    let ids: Vec<_> = view
        .instances
        .iter()
        .filter_map(|(&id, instances)| eligibility(&view.sources, instances).ok().map(|_| id))
        .collect();
    assert_eq!(ids.len(), 370, "Revit fixture eligibility drifted");
    for id in [186, 10802] {
        assert!(ids.contains(&id), "selected Revit product #{id} must be eligible");
        let (source, instance, mesh) = compare_model(&model, id).unwrap();
        assert!(matches!(source.status, AnalyticStatus::Complete));
        assert_eq!(instance.product_id, id);
        assert!(!mesh.faces.is_empty());
        if id == 10802 {
            assert_eq!(source.profile.unwrap().loops.len(), 2,
                "mapped Revit HSS column has a hollow source profile");
        }
    }
}
