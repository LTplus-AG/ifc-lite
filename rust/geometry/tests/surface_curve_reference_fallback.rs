// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! A slot 5 that fails to read must not cost the solid its geometry (#8472
//! review). Before slot 5 was read these solids were swept with the
//! rotation-minimising frame, so an unreadable reference keeps exactly the
//! mesh an empty slot 5 gives, and any refusal the decoder counted on the way
//! stays counted. Element #32 of the neutral fixture (see
//! `surface_curve_reference_roll.rs`), with its solid #28 rewritten.

use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::GeometryRouter;

const FIXTURE: &str = "tests/fixtures/surface_curve_reference_roll.ifc";
const SOLID: &str = "#28=IFCSURFACECURVESWEPTAREASOLID(#27,$,#17,$,$,#22);";
const SURFACE_CURVE_EMPTY: &str = "#28=IFCSURFACECURVESWEPTAREASOLID(#27,$,#17,$,$,$);";
const FIXED_REFERENCE_EMPTY: &str = "#28=IFCFIXEDREFERENCESWEPTAREASOLID(#27,$,#17,$,$,$);";

struct Sweep {
    positions: Vec<f32>,
    indices: Vec<u32>,
    refused: u64,
}

/// Element #32 with solid #28 replaced by `solid` plus the extra `records`.
fn sweep(solid: &str, records: &str) -> Result<Sweep, String> {
    let fixture = std::fs::read_to_string(FIXTURE)
        .unwrap_or_else(|e| panic!("failed to read fixture {FIXTURE}: {e}"));
    assert!(fixture.contains(SOLID), "fixture solid #28 changed");
    let content = fixture.replacen(SOLID, &format!("{solid}\n{records}"), 1);
    let entity_index = ifc_lite_core::build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::with_units(&content, &mut decoder);
    let element = decoder.decode_by_id(32).map_err(|e| format!("decode #32: {e}"))?;
    let mesh = router.process_element(&element, &mut decoder).map_err(|e| e.to_string())?;
    Ok(Sweep { positions: mesh.positions, indices: mesh.indices, refused: decoder.refused_records() })
}

/// (case, solid #28, extra records, refusals the decoder counts): the inputs
/// that made `lower()` return an `Err` at 5ef6a56, one per row of the review.
const UNREADABLE: [(&str, &str, &str, u64); 10] = [
    (
        "SweptCurve is an IfcPcurve",
        "#28=IFCSURFACECURVESWEPTAREASOLID(#27,$,#17,$,$,#60);",
        "#60=IFCSURFACEOFLINEAREXTRUSION(#61,#20,#21,1.);\n#61=IFCARBITRARYOPENPROFILEDEF(.CURVE.,$,#62);\n\
         #62=IFCPCURVE(#63,#17);\n#63=IFCPLANE(#20);",
        0,
    ),
    (
        "SweptCurve is an IfcTrimmedCurve with no basis",
        "#28=IFCSURFACECURVESWEPTAREASOLID(#27,$,#17,$,$,#60);",
        "#60=IFCSURFACEOFLINEAREXTRUSION(#61,#20,#21,1.);\n#61=IFCARBITRARYOPENPROFILEDEF(.CURVE.,$,#62);\n\
         #62=IFCTRIMMEDCURVE($,(IFCPARAMETERVALUE(0.)),(IFCPARAMETERVALUE(30.)),.T.,.PARAMETER.);",
        0,
    ),
    (
        "dangling SweptCurve",
        "#28=IFCSURFACECURVESWEPTAREASOLID(#27,$,#17,$,$,#60);",
        "#60=IFCSURFACEOFLINEAREXTRUSION(#61,#20,#21,1.);\n#61=IFCARBITRARYOPENPROFILEDEF(.CURVE.,$,#500);",
        0,
    ),
    (
        "dangling SweptCurve polyline point",
        "#28=IFCSURFACECURVESWEPTAREASOLID(#27,$,#17,$,$,#60);",
        "#60=IFCSURFACEOFLINEAREXTRUSION(#61,#20,#21,1.);\n#61=IFCARBITRARYOPENPROFILEDEF(.CURVE.,$,#62);\n\
         #62=IFCPOLYLINE((#13,#500));",
        0,
    ),
    (
        "dangling ExtrudedDirection",
        "#28=IFCSURFACECURVESWEPTAREASOLID(#27,$,#17,$,$,#60);",
        "#60=IFCSURFACEOFLINEAREXTRUSION(#18,#20,#500,1.);",
        0,
    ),
    ("dangling ReferenceSurface", "#28=IFCSURFACECURVESWEPTAREASOLID(#27,$,#17,$,$,#500);", "", 0),
    (
        "dangling IfcPlane Position",
        "#28=IFCSURFACECURVESWEPTAREASOLID(#27,$,#17,$,$,#60);",
        "#60=IFCPLANE(#500);",
        0,
    ),
    (
        "IfcPlane Position of the wrong type",
        "#28=IFCSURFACECURVESWEPTAREASOLID(#27,$,#17,$,$,#60);",
        "#60=IFCPLANE(#21);",
        1,
    ),
    ("dangling FixedReference", "#28=IFCFIXEDREFERENCESWEPTAREASOLID(#27,$,#17,$,$,#500);", "", 0),
    ("FixedReference of the wrong type", "#28=IFCFIXEDREFERENCESWEPTAREASOLID(#27,$,#17,$,$,#19);", "", 1),
];

#[test]
fn an_unreadable_reference_keeps_the_rotation_minimising_frame() {
    let mut failures = Vec::new();
    for (case, solid, records, refusals) in UNREADABLE {
        let empty = if solid.contains("FIXEDREFERENCE") { FIXED_REFERENCE_EMPTY } else { SURFACE_CURVE_EMPTY };
        let expected = sweep(empty, "").unwrap_or_else(|e| panic!("{case}: empty slot 5: {e}"));
        assert!(!expected.indices.is_empty(), "{case}: an empty slot 5 must still sweep");
        match sweep(solid, records) {
            Err(e) => failures.push(format!("{case}: Err({e})")),
            Ok(actual) if actual.positions != expected.positions || actual.indices != expected.indices => {
                failures.push(format!(
                    "{case}: mesh differs from an empty slot 5 ({} vs {} vertices)",
                    actual.positions.len() / 3,
                    expected.positions.len() / 3
                ))
            }
            Ok(actual) if actual.refused != expected.refused + refusals => failures.push(format!(
                "{case}: {} refusals counted, expected {}",
                actual.refused,
                expected.refused + refusals
            )),
            Ok(_) => {}
        }
    }
    assert!(failures.is_empty(), "{} of {} cases:\n{}", failures.len(), UNREADABLE.len(), failures.join("\n"));
}
