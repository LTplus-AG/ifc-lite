// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #5787: nominal quantities come from world-space source geometry, not mesh tessellation.

use ifc_lite_core::{build_entity_index, EntityDecoder};
use ifc_lite_geometry::analytic::{extract_analytic_extrusion, AnalyticStatus};
use ifc_lite_processing::extrusion_nominal_quantities;
use ifc_lite_processing::{extract_swept_disk_descriptions, SweptDiskOccurrence};

fn fixture() -> String {
    std::fs::read_to_string(format!(
        "{}/../geometry/tests/fixtures/swept_disk_trimmed_line.ifc",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap()
}

fn sweep(source: &str) -> SweptDiskOccurrence {
    let result = extract_swept_disk_descriptions(source.as_bytes(), None);
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    let disks = &result.elements[&50];
    assert_eq!(disks.len(), 1);
    disks[0].clone()
}

fn near(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() <= expected.abs().max(1.0) * 1e-11,
        "actual {actual}, expected {expected}"
    );
}

fn extrusion(bytes: &[u8], id: u32) -> ifc_lite_geometry::analytic::AnalyticExtrusion {
    let mut decoder = EntityDecoder::with_index(bytes, build_entity_index(bytes));
    let solid = decoder.decode_by_id(id).unwrap();
    extract_analytic_extrusion(&solid, &mut decoder)
}

#[test]
fn source_profile_area_and_oblique_extrusion_height_are_exact() {
    let bytes = include_bytes!("../../geometry/tests/fixtures/mapped_instances_synthetic.ifc");
    let straight = extrusion(bytes, 12);
    let quantities = extrusion_nominal_quantities(&straight).unwrap();
    near(quantities.profile_area, 1.0);
    near(quantities.projected_height, 1.0);
    near(quantities.nominal_volume, 1.0);

    let source = String::from_utf8(bytes.to_vec()).unwrap();
    let skew = source.replace(
        "#9=IFCDIRECTION((0.,0.,1.));",
        "#9=IFCDIRECTION((1.,0.,1.));",
    );
    let oblique = extrusion(skew.as_bytes(), 12);
    let quantities = extrusion_nominal_quantities(&oblique).unwrap();
    near(quantities.profile_area, 1.0);
    near(quantities.projected_height, std::f64::consts::FRAC_1_SQRT_2);
    near(quantities.nominal_volume, std::f64::consts::FRAC_1_SQRT_2);
}

#[test]
fn real_revit_profile_hole_reduces_nominal_material_volume() {
    let bytes = include_bytes!("../../geometry/tests/fixtures/issue_098_wall_W.ifc");
    let solid = extrusion(bytes, 338107);
    let profile = solid.profile.as_ref().unwrap();
    assert_eq!(profile.loops.len(), 2);
    let quantities = extrusion_nominal_quantities(&solid).unwrap();
    let outer = profile.loops[0].signed_area.abs();
    let hole = profile.loops[1].signed_area.abs();
    assert!(hole > 0.0 && hole < outer);
    near(quantities.profile_area, outer - hole);
    assert!(quantities.nominal_volume < outer * quantities.projected_height);
}

#[test]
fn issue_6316_outside_revit_hole_has_no_nominal_extrusion_quantity() {
    let bytes = include_bytes!("../../geometry/tests/fixtures/issue_098_wall_W.ifc");
    let valid = extrusion(bytes, 338107);
    assert_eq!(valid.status, AnalyticStatus::Complete);
    assert!(extrusion_nominal_quantities(&valid).is_some());

    let mut source = String::from_utf8(bytes.to_vec()).unwrap();
    for (id, coords) in [
        (338092, "10.1,-0.1"),
        (338094, "9.9,-0.1"),
        (338096, "9.9,0.1"),
        (338098, "10.1,0.1"),
    ] {
        let prefix = format!("#{id}=");
        let start = source.find(&prefix).unwrap();
        let end = start + source[start..].find(';').unwrap() + 1;
        source.replace_range(start..end, &format!("#{id}=IFCCARTESIANPOINT(({coords}));"));
    }

    let invalid = extrusion(source.as_bytes(), 338107);
    assert!(matches!(invalid.status, AnalyticStatus::Unsupported(_)));
    let profile = invalid.profile.as_ref().unwrap();
    assert!(matches!(profile.status, AnalyticStatus::Unsupported(_)));
    assert!(profile.loops.is_empty());
    assert!(extrusion_nominal_quantities(&invalid).is_none());
}

#[test]
fn invalid_or_curve_profile_has_no_nominal_extrusion_quantity() {
    let source = String::from_utf8(
        include_bytes!("../../geometry/tests/fixtures/mapped_instances_synthetic.ifc").to_vec(),
    )
    .unwrap();
    let curve = source.replace(
        "#8=IFCRECTANGLEPROFILEDEF(.AREA.,",
        "#8=IFCRECTANGLEPROFILEDEF(.CURVE.,",
    );
    assert!(extrusion_nominal_quantities(&extrusion(curve.as_bytes(), 12)).is_none());
    let horizontal = source.replace(
        "#9=IFCDIRECTION((0.,0.,1.));",
        "#9=IFCDIRECTION((1.,0.,0.));",
    );
    assert!(extrusion_nominal_quantities(&extrusion(horizontal.as_bytes(), 12)).is_none());
}

#[test]
fn millimetre_source_gives_world_square_and_cubic_metres() {
    let disk = sweep(&fixture());
    let quantities = disk.nominal_quantities().unwrap();
    let radius = 0.0145_f64;
    let length = 2.75_f64;
    near(
        quantities.cross_section_area,
        std::f64::consts::PI * radius * radius,
    );
    near(
        quantities.nominal_volume,
        std::f64::consts::PI * radius * radius * length,
    );
    near(
        quantities.outer_lateral_area,
        std::f64::consts::TAU * radius * length,
    );
    assert_eq!(quantities.inner_lateral_area, None);
    let json = serde_json::to_value(&disk).unwrap();
    near(
        json["nominal_quantities"]["nominal_volume"]
            .as_f64()
            .unwrap(),
        quantities.nominal_volume,
    );
}

#[test]
fn hollow_section_and_mapped_uniform_scale_keep_dimensions() {
    let hollow = fixture().replace(
        "IFCSWEPTDISKSOLID(#42,14.5,$,0.,2750.)",
        "IFCSWEPTDISKSOLID(#42,14.5,9.5,0.,2750.)",
    );
    let base = sweep(&hollow).nominal_quantities().unwrap();
    near(
        base.cross_section_area,
        std::f64::consts::PI * (0.0145 - 0.0095) * (0.0145 + 0.0095),
    );
    near(
        base.inner_lateral_area.unwrap(),
        std::f64::consts::TAU * 0.0095 * 2.75,
    );
    let scaled = hollow.replace(
        "IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#10,$,$)",
        "IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#10,2.,$)",
    );
    let world = sweep(&scaled).nominal_quantities().unwrap();
    near(world.cross_section_area, base.cross_section_area * 4.0);
    near(world.nominal_volume, base.nominal_volume * 8.0);
    near(world.outer_lateral_area, base.outer_lateral_area * 4.0);
    near(
        world.inner_lateral_area.unwrap(),
        base.inner_lateral_area.unwrap() * 4.0,
    );
}

#[test]
fn csg_operand_and_nonuniform_world_disk_have_no_nominal_product_quantity() {
    let source = fixture();
    let csg = source.replace(
        "#44=IFCSHAPEREPRESENTATION(#16,'Body','AdvancedSweptSolid',(#43));",
        "#1001=IFCBLOCK(#13,100.,100.,100.);\n#1002=IFCBOOLEANRESULT(.UNION.,#43,#1001);\n#44=IFCSHAPEREPRESENTATION(#16,'Body','CSG',(#1002));",
    );
    let operand = sweep(&csg);
    assert!(operand.source_modified);
    assert!(operand.nominal_quantities().is_none());

    let nonuniform = source.replace(
        "IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#10,$,$)",
        "IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM($,$,#10,$,$,2.,1.)",
    );
    let unsupported = sweep(&nonuniform);
    assert!(unsupported.directrix_metrics().is_none());
    assert!(unsupported.nominal_quantities().is_none());
}

#[test]
fn issue_5787_arc_tighter_than_disk_has_no_nominal_volume() {
    let source = fixture().replace(
        "#43=IFCSWEPTDISKSOLID(#42,14.5,$,0.,2750.);",
        "#43=IFCSWEPTDISKSOLID(#42,14.5,$,$,$);",
    );
    let circular = |radius: f64| {
        let source = source.replace(
            "#42=IFCTRIMMEDCURVE(#41,(IFCPARAMETERVALUE(0.)),(IFCPARAMETERVALUE(2750.)),.T.,.PARAMETER.);",
            &format!("#42=IFCCIRCLE(#13,{radius});"),
        );
        assert!(source.contains("#42=IFCCIRCLE(#13,"));
        sweep(&source)
    };
    let valid = circular(20.0);
    assert_eq!(valid.status, ifc_lite_geometry::analytic::AnalyticStatus::Complete);
    assert!(valid.nominal_quantities().unwrap().nominal_volume > 0.0);

    let tangent = circular(14.5);
    assert_eq!(tangent.status, ifc_lite_geometry::analytic::AnalyticStatus::Complete);
    assert!(tangent.nominal_quantities().is_none());

    let folded = circular(10.0);
    assert_eq!(folded.status, ifc_lite_geometry::analytic::AnalyticStatus::Complete);
    assert!(folded.nominal_quantities().is_none());
}

#[test]
fn issue_5787_zero_length_directrix_has_no_nominal_volume() {
    let source = fixture()
        .replace(
            "#42=IFCTRIMMEDCURVE(#41,(IFCPARAMETERVALUE(0.)),(IFCPARAMETERVALUE(2750.)),.T.,.PARAMETER.);",
            "#42=IFCTRIMMEDCURVE(#41,(IFCPARAMETERVALUE(0.)),(IFCPARAMETERVALUE(0.)),.T.,.PARAMETER.);",
        )
        .replace(
            "#43=IFCSWEPTDISKSOLID(#42,14.5,$,0.,2750.);",
            "#43=IFCSWEPTDISKSOLID(#42,14.5,$,$,$);",
        );
    let disk = sweep(&source);
    assert_eq!(disk.status, ifc_lite_geometry::analytic::AnalyticStatus::Complete);
    assert_eq!(disk.directrix_metrics().unwrap().total_length, 0.0);
    assert!(disk.nominal_quantities().is_none());
}

#[test]
fn issue_5787_disconnected_or_degenerate_composite_has_no_nominal_tube_volume() {
    let source = include_str!("../../geometry/tests/fixtures/swept_disk_composite_arc_ubar.ifc");
    let disk = |content: &str| {
        let descriptions = extract_swept_disk_descriptions(content.as_bytes(), None);
        assert!(descriptions.diagnostics.is_empty());
        descriptions.elements[&125][0].clone()
    };
    assert!(disk(source).nominal_quantities().is_some());
    let gap = source.replace(
        "#56=IFCCARTESIANPOINT((101.5,0.,-423.5));",
        "#56=IFCCARTESIANPOINT((102.5,0.,-423.5));",
    );
    let gapped = disk(&gap);
    assert_eq!(gapped.status, AnalyticStatus::Complete);
    assert!(gapped.directrix_metrics().is_some());
    assert!(gapped.nominal_quantities().is_none());

    let degenerate = source.replace(
        "(IFCPARAMETERVALUE(322.)),.T.,.PARAMETER.",
        "(IFCPARAMETERVALUE(0.0000001)),.T.,.PARAMETER.",
    );
    let collapsed = disk(&degenerate);
    assert_eq!(collapsed.status, AnalyticStatus::Complete);
    assert!(collapsed.directrix_metrics().unwrap().total_length > 0.0);
    assert!(collapsed.nominal_quantities().is_none());
}
