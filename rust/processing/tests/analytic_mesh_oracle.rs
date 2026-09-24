// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #5781: analytic-versus-mesh regression cases and mutation controls.

#[path = "analytic_mesh_oracle/checker.rs"]
mod checker;

use std::fs;
use std::path::PathBuf;

use checker::{compare_model, compare_surface, eligibility};
use ifc_lite_geometry::analytic::AnalyticCurveSegment;
use ifc_lite_processing::extract_swept_disk_descriptions;

fn synthetic(name: &str) -> Vec<u8> {
    fs::read(format!(
        "{}/../geometry/tests/fixtures/{name}.ifc",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap()
}

fn altered_line(replacement: &str) -> Vec<u8> {
    let source = String::from_utf8(synthetic("swept_disk_trimmed_line")).unwrap();
    source
        .replace(
            "#46=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#10,$,$);",
            replacement,
        )
        .into_bytes()
}

fn large_local_placement() -> Vec<u8> {
    let source = String::from_utf8(synthetic("swept_disk_trimmed_line")).unwrap();
    source.replace(
        "#30=IFCLOCALPLACEMENT($,#13);",
        "#1000=IFCCARTESIANPOINT((5000000123.456,0.,0.));\n#1001=IFCAXIS2PLACEMENT3D(#1000,#11,#12);\n#30=IFCLOCALPLACEMENT($,#1001);",
    ).into_bytes()
}

#[test]
fn straight_and_tangent_composite_bars_match_independent_meshes() {
    for (fixture, id) in [
        ("swept_disk_trimmed_line", 50),
        ("swept_disk_composite_arc_lbar", 78),
        ("swept_disk_composite_arc_ubar", 125),
        ("swept_disk_composite_arc_crankbar", 79),
    ] {
        compare_model(&synthetic(fixture), id).unwrap_or_else(|error| panic!("{fixture}: {error}"));
    }
}

#[test]
fn mapped_scaled_mirrored_and_large_world_occurrences_match() {
    let variants = [
        altered_line("#46=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#10,2.,$);"),
        altered_line("#1000=IFCDIRECTION((-1.,0.,0.));\n#46=IFCCARTESIANTRANSFORMATIONOPERATOR3D(#1000,$,#10,$,#11);"),
        large_local_placement(),
    ];
    for (index, variant) in variants.iter().enumerate() {
        compare_model(variant, 50).unwrap_or_else(|error| panic!("variant {index}: {error}"));
    }
}

#[test]
fn catalogued_antea_hollow_curve_matches_when_fixture_is_available() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/models/ifcopenshell/1032-curve.ifc");
    let source = match fs::read(&path) {
        Ok(source) => source,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            eprintln!(
                "skipping {}: run `pnpm fixtures` to fetch catalogued Antea IFC Export model",
                path.display()
            );
            return;
        }
        Err(error) => panic!("read {}: {error}", path.display()),
    };
    let (disk, _) = compare_model(&source, 26).unwrap();
    assert!(
        disk.inner_radius.is_some(),
        "fixture must exercise the hollow tube surface"
    );
}

#[test]
fn analytic_mutations_fail_with_residual_evidence() {
    let (disk, mesh) = compare_model(&synthetic("swept_disk_trimmed_line"), 50).unwrap();
    let mut wrong_radius = disk.clone();
    wrong_radius.radius += 0.005;
    let error = compare_surface(50, &wrong_radius, &mesh).unwrap_err();
    assert!(
        error.contains("product #50")
            && error.contains("solid #43")
            && error.contains("residual")
            && error.contains("tolerance"),
        "{error}"
    );

    let mut wrong_transform = disk;
    for segment in &mut wrong_transform.directrix {
        if let AnalyticCurveSegment::Line { start, end } = segment {
            start[0] += 0.02;
            end[0] += 0.02;
        }
    }
    let error = compare_surface(50, &wrong_transform, &mesh).unwrap_err();
    assert!(
        error.contains("product #50") && error.contains("residual") && error.contains("tolerance"),
        "{error}"
    );
}

#[test]
fn csg_unsupported_and_multiple_source_records_are_explicitly_excluded() {
    let source = String::from_utf8(synthetic("swept_disk_trimmed_line")).unwrap();
    let shape = "#44=IFCSHAPEREPRESENTATION(#16,'Body','AdvancedSweptSolid',(#43));";
    let product_shape = "#49=IFCPRODUCTDEFINITIONSHAPE($,$,(#48));";
    let csg = source
        .replace(shape,
            "#1001=IFCBLOCK(#13,100.,100.,100.);\n#1002=IFCBOOLEANRESULT(.UNION.,#43,#1001);\n#44=IFCSHAPEREPRESENTATION(#16,'Body','CSG',(#1002));")
        .replace(product_shape, "#49=IFCPRODUCTDEFINITIONSHAPE($,$,(#44));");
    let csg = extract_swept_disk_descriptions(csg.as_bytes(), None);
    assert!(csg.diagnostics.is_empty());
    assert_eq!(
        eligibility(&csg.elements[&50]).unwrap_err(),
        "CSG operand is not the final visible mesh"
    );

    let unsupported = source.replace(
        "#46=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#10,$,$);",
        "#46=IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM($,$,#10,$,$,2.,1.);",
    );
    let unsupported = extract_swept_disk_descriptions(unsupported.as_bytes(), None);
    assert!(unsupported.diagnostics.is_empty());
    assert_eq!(
        eligibility(&unsupported.elements[&50]).unwrap_err(),
        "unsupported analytic directrix"
    );

    let repeated = source.replace(
        shape,
        "#44=IFCSHAPEREPRESENTATION(#16,'Body','AdvancedSweptSolid',(#43,#43));",
    );
    let repeated = extract_swept_disk_descriptions(repeated.as_bytes(), None);
    assert!(repeated.diagnostics.is_empty());
    assert_eq!(
        eligibility(&repeated.elements[&50]).unwrap_err(),
        "multiple source solids cannot be compared to one merged mesh"
    );
}
