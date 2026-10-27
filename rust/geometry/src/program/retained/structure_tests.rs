// SPDX-License-Identifier: MPL-2.0
//! #7955 S1 review: authored structural members cannot disappear at admission.
use super::*;

fn retained_result(bytes: &str, root: u32) -> std::result::Result<RetainedProductPlan, RetainedFailure> {
    let source = SourceBundle::new(bytes.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(bytes, &mut decoder);
    let entity = decoder.decode_by_id(root).unwrap();
    let mut program = RetainedProgram::product_parts(&entity, contract());
    drive(&mut program, &router, &mut decoder);
    program.finish()
}

pub(super) fn exact_parts(bytes: &str) -> Vec<Mesh> {
    let source = SourceBundle::new(bytes.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(bytes, &mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let mut program =
        GeometryProgram::product(&entity, crate::router::processing::SourceHygiene::IndexOnly);
    while let Some(ticket) = program.request().unwrap() {
        let reply = program.execute(ticket, &router, &mut decoder).unwrap();
        program
            .accept(reply, &router)
            .unwrap_or_else(|e| panic!("{:?}", e.error));
    }
    program.finish_parts().unwrap()
}

pub(super) fn assert_exact_unchanged(bytes: &str, expected: &[Mesh]) {
    let actual = exact_parts(bytes);
    assert_eq!(actual.len(), expected.len());
    for (actual, expected) in actual.iter().zip(expected) {
        assert!(!actual.is_empty(), "the exact fixture must actually render");
        assert_eq!(actual.positions, expected.positions);
        assert_eq!(actual.normals, expected.normals);
        assert_eq!(actual.indices, expected.indices);
    }
}

#[test]
fn malformed_later_items_refuse_whole_retained_plan_and_preserve_exact() {
    let expected = exact_parts(SOURCE);
    assert_eq!(expected.len(), 1);
    assert!((crate::mesh_check::signed_volume(&expected[0]).abs() - 24.).abs() < 1e-6);
    for member in ["$", "*", "42", "0.5", "'bad'", "(#13)", "IFCLABEL('bad')"] {
        let bytes = SOURCE.replace(
            "'SweptSolid',(#13)",
            &format!("'SweptSolid',(#13,{member})"),
        );
        assert!(
            retained_result(&bytes, 10).is_err(),
            "Items member {member} must refuse the whole plan"
        );
        assert_exact_unchanged(&bytes, &expected);
    }
}

#[test]
fn malformed_later_representations_refuse_whole_retained_plan_and_preserve_exact() {
    let expected = exact_parts(SOURCE);
    for member in ["$", "*", "42", "0.5", "'bad'", "(#12)", "IFCLABEL('bad')"] {
        let bytes = SOURCE.replace("SHAPE($,$,(#12))", &format!("SHAPE($,$,(#12,{member}))"));
        assert!(
            retained_result(&bytes, 10).is_err(),
            "Representations member {member} must refuse the whole plan"
        );
        assert_exact_unchanged(&bytes, &expected);
    }
}

#[test]
fn wrong_representation_entity_after_supported_body_cannot_be_filtered_to_success() {
    let expected = exact_parts(SOURCE);
    for member in ["#53", "#90", "#91"] {
        let bytes = SOURCE
            .replace("SHAPE($,$,(#12))", &format!("SHAPE($,$,(#12,{member}))"))
            .replace(
                "ENDSEC;END-ISO-10303-21;",
                "
#90=IFCREPRESENTATION(#2,'Body','SweptSolid',(#13));
#91=IFCSTYLEDREPRESENTATION(#2,'Body','SweptSolid',(#13));
ENDSEC;END-ISO-10303-21;",
            );
        assert!(
            retained_result(&bytes, 10).is_err(),
            "wrong representation record {member} must refuse the whole plan"
        );
        assert_exact_unchanged(&bytes, &expected);
    }
}

#[test]
fn selection_may_skip_valid_axis_but_cannot_hide_malformed_items() {
    let bytes = SOURCE
        .replace("SHAPE($,$,(#12))", "SHAPE($,$,(#12,#90))")
        .replace(
            "ENDSEC;END-ISO-10303-21;",
            "
#90=IFCSHAPEREPRESENTATION(#2,'Axis','Curve3D',(#53));
ENDSEC;END-ISO-10303-21;",
        );
    let plan = retained_result(&bytes, 10).unwrap();
    assert_eq!(
        plan.values.len(),
        1,
        "valid non-body selection still applies"
    );
    for member in ["$", "*", "42", "'bad'", "(#53)"] {
        let malformed = bytes.replace("'Curve3D',(#53)", &format!("'Curve3D',(#53,{member})"));
        assert!(
            retained_result(&malformed, 10).is_err(),
            "selection must not conceal malformed Items {member}"
        );
    }
}

#[test]
fn malformed_structural_list_containers_are_not_empty_products() {
    for list in ["$", "*", "#13", "()", "42", "'bad'"] {
        let items = SOURCE.replace("'SweptSolid',(#13)", &format!("'SweptSolid',{list}"));
        assert!(retained_result(&items, 10).is_err(), "invalid Items {list}");
        let reps = SOURCE.replace("SHAPE($,$,(#12))", &format!("SHAPE($,$,{list})"));
        assert!(
            retained_result(&reps, 10).is_err(),
            "invalid Representations {list}"
        );
    }
    let derived = SOURCE.replace("#9,#11,$,$", "#9,*,$,$");
    assert!(
        retained_result(&derived, 10).is_err(),
        "Representation is not derived"
    );
}

#[test]
fn non_product_material_layer_root_refuses_while_real_absent_representation_stays_empty() {
    let bytes = SOURCE.replace(
        "ENDSEC;END-ISO-10303-21;",
        "
#82=IFCMATERIAL('Layer material',$,$);
#83=IFCMATERIALLAYER(#82,0.2,$,$,$,$,$);
ENDSEC;END-ISO-10303-21;",
    );
    // This real non-product has $ at both placement/representation offsets:
    // the old code could complete it as an empty product, unlike BoilerType.
    assert!(
        retained_result(&bytes, 83).is_err(),
        "IfcMaterialLayer is not an IfcProduct"
    );
    for placement in ["#9", "$"] {
        let empty = SOURCE.replace("#9,#11,$,$", &format!("{placement},$,$,$"));
        let plan = retained_result(&empty, 10).unwrap();
        assert!(plan.values.is_empty());
        assert_eq!(
            plan.remaining,
            vec![
                RetainedRequirement::OpeningClosure,
                RetainedRequirement::MaterialLayers,
                RetainedRequirement::IfcAppearance,
                RetainedRequirement::PersistentFaces,
            ]
        );
    }
}

#[path = "reference_tests.rs"]
mod references;
