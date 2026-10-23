// SPDX-License-Identifier: MPL-2.0
//! #7983: synthetic mapped bars; no client geometry or metadata.
use ifc_lite_geometry::analytic::{AnalyticCurveSegment, AnalyticStatus};
use ifc_lite_processing::{
    extract_swept_disk_definitions, extract_swept_disk_descriptions, process, ProcessingRequest,
};

fn model(application: &str, start: &str, end: &str) -> String {
    let base = include_str!("../../geometry/tests/fixtures/swept_disk_trimmed_line.ifc");
    base.replace("IFC2X3", "IFC4")
        .replace("#20=IFCPROJECT('0000000000000000000001',$,", "#20=IFCPROJECT('0000000000000000000001',#102,")
        .replace("#42=IFCTRIMMEDCURVE(#41,(IFCPARAMETERVALUE(0.)),(IFCPARAMETERVALUE(2750.)),.T.,.PARAMETER.);",
            "#42=IFCPOLYLINE((#10,#110,#111,#112));\n#110=IFCCARTESIANPOINT((1000.,0.,0.));\n#111=IFCCARTESIANPOINT((1000.,2000.,0.));\n#112=IFCCARTESIANPOINT((4000.,2000.,0.));")
        .replace("#43=IFCSWEPTDISKSOLID(#42,14.5,$,0.,2750.);", &format!("#43=IFCSWEPTDISKSOLID(#42,14.5,$,{start},{end});"))
        .replace("#48=IFCSHAPEREPRESENTATION(#16,'Body','MappedRepresentation',(#47));",
            "#48=IFCSHAPEREPRESENTATION(#16,'Body','MappedRepresentation',(#47,#120));\n#113=IFCCARTESIANPOINT((0.,5000.,0.));\n#114=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#113,1.00000000000001,$);\n#120=IFCMAPPEDITEM(#45,#114);")
        .replace("ENDSEC;\nEND-ISO", &format!("#100=IFCORGANIZATION($,'Test',$,$,$);\n#101=IFCAPPLICATION(#100,'2024.1','{application}','{application}');\n#102=IFCOWNERHISTORY($,#101,$,.ADDED.,$,$,$,0);\nENDSEC;\nEND-ISO"))
}

fn assert_matches_full_path(source: String) {
    let full = model("Other", "$", "$");
    let request = ProcessingRequest::full_pass();
    let actual = process(source.as_bytes(), &request, &mut ());
    let expected = process(full.as_bytes(), &request, &mut ());
    assert!(!actual.meshes.is_empty());
    assert_eq!(actual.meshes.len(), expected.meshes.len());
    for (a, b) in actual.meshes.iter().zip(&expected.meshes) {
        assert_eq!(
            a.positions, b.positions,
            "#7983: a mapped occurrence lost part of its path"
        );
        assert_eq!(a.indices, b.indices);
        assert_eq!(a.origin, b.origin);
        assert_eq!(a.color, b.color);
    }
    // Independent geometric invariant: the two 6 m bars occupy a 4 m by 7 m
    // envelope (including their 5 m mapping separation), plus the disk radius.
    // Sorting spans makes this independent of IFC Z-up/viewer Y-up conversion.
    let mut minimum = [f64::INFINITY; 3];
    let mut maximum = [f64::NEG_INFINITY; 3];
    for mesh in &actual.meshes {
        for vertex in mesh.positions.chunks_exact(3) {
            for axis in 0..3 {
                let coordinate = mesh.origin[axis] + f64::from(vertex[axis]);
                minimum[axis] = minimum[axis].min(coordinate);
                maximum[axis] = maximum[axis].max(coordinate);
            }
        }
    }
    let mut spans: [f64; 3] = std::array::from_fn(|axis| maximum[axis] - minimum[axis]);
    spans.sort_by(f64::total_cmp);
    for (actual_span, expected_span) in spans.into_iter().zip([0.029, 4.0, 7.0]) {
        assert!(
            (actual_span - expected_span).abs() < 0.04,
            "#7983: unexpected mapped mesh span {actual_span}"
        );
    }
    let definitions = extract_swept_disk_definitions(source.as_bytes(), None);
    assert!(
        definitions.diagnostics.is_empty(),
        "{:?}",
        definitions.diagnostics
    );
    assert_eq!(definitions.sources.len(), 1);
    assert_eq!(
        (
            definitions.sources[0].start_param,
            definitions.sources[0].end_param
        ),
        (Some(0.0), Some(1.0))
    );
    let descriptions = extract_swept_disk_descriptions(source.as_bytes(), None);
    assert!(
        descriptions.diagnostics.is_empty(),
        "{:?}",
        descriptions.diagnostics
    );
    let disks = &descriptions.elements[&50];
    assert_eq!(disks.len(), 2, "both mapped occurrences must survive");
    for disk in disks {
        assert_eq!(disk.status, AnalyticStatus::Complete);
        assert_eq!(
            disk.directrix.len(),
            3,
            "all three synthetic path segments must survive"
        );
        let length: f64 = disk
            .directrix
            .iter()
            .map(|s| match s {
                AnalyticCurveSegment::Line { start, end } => start
                    .iter()
                    .zip(end)
                    .map(|(a, b)| (b - a).powi(2))
                    .sum::<f64>()
                    .sqrt(),
                _ => panic!("expected polyline"),
            })
            .sum();
        assert!(
            (length - 6.0).abs() < 1e-9,
            "expected the complete 6 m path, got {length}"
        );
    }
}

#[test]
fn issue_7983_allplan_unit_range_keeps_complete_mapped_bars() {
    for (name, identifier) in [("Allplan", "Other"), ("Other", "aLlPlAn")] {
        let source = model("Other", "0.", "1.")
            .replace("'Other','Other'", &format!("'{name}','{identifier}'"));
        assert_matches_full_path(source);
    }
}

fn assert_trimmed_length(source: &str, expected_length: f64) {
    let descriptions = extract_swept_disk_descriptions(source.as_bytes(), None);
    assert!(
        descriptions.diagnostics.is_empty(),
        "{:?}",
        descriptions.diagnostics
    );
    assert_eq!(descriptions.elements[&50].len(), 2);
    for disk in &descriptions.elements[&50] {
        assert_eq!(disk.status, AnalyticStatus::Complete);
        assert_eq!(
            disk.directrix.len(),
            1,
            "#7983: intentional trims must survive"
        );
        let AnalyticCurveSegment::Line { start, end } = &disk.directrix[0] else {
            panic!("expected a trimmed line");
        };
        let length = start
            .iter()
            .zip(end)
            .map(|(a, b)| (b - a).powi(2))
            .sum::<f64>()
            .sqrt();
        assert!(
            (length - expected_length).abs() < 1e-9,
            "expected {expected_length} m, got {length}"
        );
    }
}

#[test]
fn issue_7983_missing_or_other_project_provenance_keeps_standard_trimming() {
    let other = model("Other", "0.", "1.");
    // An otherwise valid Allplan application in the file is insufficient without
    // the project's OwnerHistory link.
    let missing = model("Allplan", "0.", "1.").replace(
        "#20=IFCPROJECT('0000000000000000000001',#102,",
        "#20=IFCPROJECT('0000000000000000000001',$,",
    );
    let unrelated = model("Not Allplan", "0.", "1.");
    for source in [other, missing, unrelated] {
        assert_trimmed_length(&source, 1.0);
    }
}

#[test]
fn issue_7983_allplan_other_explicit_ranges_keep_index_parameter_trimming() {
    for (start, end, length) in [("1.", "2.", 2.0), ("0.", "0.5", 0.5), ("2.", "3.", 3.0)] {
        assert_trimmed_length(&model("Allplan", start, end), length);
    }
}

#[test]
fn issue_7983_allplan_non_polyline_unit_range_keeps_standard_trimming() {
    // A raw line must use line parameters, even for the Allplan 0..1
    // combination. Its vector magnitude is one millimetre.
    let source = model("Allplan", "0.", "1.").replace(
        "#42=IFCPOLYLINE((#10,#110,#111,#112));",
        "#42=IFCLINE(#10,#40);",
    );
    assert_trimmed_length(&source, 0.001);
}
