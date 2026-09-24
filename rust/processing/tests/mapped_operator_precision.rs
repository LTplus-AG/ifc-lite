// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #5792: a large MappingTarget must survive the intermediate f32 mesh stage.

use std::collections::HashSet;

use ifc_lite_geometry::{analytic::AnalyticCurveSegment, TessellationQuality};
use ifc_lite_processing::{
    build_geometry_data_export, extract_swept_disk_descriptions,
    process_geometry_filtered_with_quality_and_ids, MeshCoordinateSpace, OpeningFilterMode,
};

fn mapped_line(operator: &str) -> Vec<u8> {
    let source = include_str!("../../geometry/tests/fixtures/swept_disk_trimmed_line.ifc");
    let needle = "#46=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#10,$,$);";
    assert!(source.contains(needle));
    source.replace(needle, operator).into_bytes()
}

fn assert_mesh_matches_analytic_endpoints(source: &[u8]) {
    let ids = HashSet::from([50]);
    let descriptions = extract_swept_disk_descriptions(source, Some(&ids));
    assert!(descriptions.diagnostics.is_empty(), "{:?}", descriptions.diagnostics);
    let disk = &descriptions.elements[&50][0];
    let (start, end) = match disk.directrix.as_slice() {
        [AnalyticCurveSegment::Line { start, end }] => (*start, *end),
        segments => panic!("expected one analytic line, got {segments:?}"),
    };

    let result = process_geometry_filtered_with_quality_and_ids(
        source,
        OpeningFilterMode::Default,
        TessellationQuality::High,
        Some(&ids),
    );
    let source_mesh = result.meshes.iter().find(|m| m.express_id == 50).unwrap();
    assert!(
        source_mesh.origin[0].abs() > 1_000_000.0
            || result.metadata.coordinate_info.origin_shift[0].abs() > 1_000_000.0,
        "large mapped translation must stay in an f64 origin or RTC offset"
    );
    assert!(
        source_mesh.positions.chunks_exact(3).all(|p| p[0].abs() < 10.0),
        "local f32 positions must remain element-sized"
    );
    let site_rotation = (result.mesh_coordinate_space == MeshCoordinateSpace::SiteLocal)
        .then_some(result.site_transform.as_deref())
        .flatten();
    let exported = build_geometry_data_export(
        &result.meshes,
        result.metadata.coordinate_info.origin_shift,
        site_rotation,
    );
    let mesh = &exported.elements[&50];
    assert!(!mesh.vertices.is_empty());
    let mesh_low = mesh.vertices.iter().map(|v| v[0]).fold(f64::INFINITY, f64::min);
    let mesh_high = mesh.vertices.iter().map(|v| v[0]).fold(f64::NEG_INFINITY, f64::max);
    let expected_low = start[0].min(end[0]);
    let expected_high = start[0].max(end[0]);
    assert!(
        (mesh_low - expected_low).abs() < 1e-5,
        "mapped mesh minimum {mesh_low:.9} m differs from analytic {expected_low:.9} m"
    );
    assert!(
        (mesh_high - expected_high).abs() < 1e-5,
        "mapped mesh maximum {mesh_high:.9} m differs from analytic {expected_high:.9} m"
    );
}

#[test]
fn mapped_operator_keeps_fractional_translation_at_five_thousand_kilometres() {
    for scale in ["$", "2.", "-1."] {
        let operator = format!(
            "#1000=IFCCARTESIANPOINT((5000000123.456,0.,0.));\n#46=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#1000,{scale},$);"
        );
        assert_mesh_matches_analytic_endpoints(&mapped_line(&operator));
    }
}
