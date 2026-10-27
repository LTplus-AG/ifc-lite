// SPDX-License-Identifier: MPL-2.0
//! #7955 S1 review: finite inputs do not guarantee finite composed frames.
use super::*;

fn positioned_source(solid_x: &str, product_x: &str) -> String {
    SOURCE
        .replace(
            "#13=IFCEXTRUDEDAREASOLID(#14,#5",
            "#13=IFCEXTRUDEDAREASOLID(#14,#90",
        )
        .replace("((10.,20.,30.))", &format!("(({product_x},0.,0.))"))
        .replace(
            "ENDSEC;END-ISO-10303-21;",
            &format!(
                "
#90=IFCAXIS2PLACEMENT3D(#91,$,$);
#91=IFCCARTESIANPOINT(({solid_x},0.,0.));
ENDSEC;END-ISO-10303-21;"
            ),
        )
}

fn admission(bytes: &str) -> (Vec<RetainedPlanOperation>, std::result::Result<RetainedProductPlan, RetainedFailure>, u64) {
    let source = SourceBundle::new(bytes.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(bytes, &mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let mut program = RetainedProgram::product_parts(&entity, contract());
    let operations = drive(&mut program, &router, &mut decoder);
    let domain = program.selection().unwrap().program();
    (operations, program.finish(), domain)
}

#[test]
fn finite_extrusion_and_product_translations_overflow_only_at_composition_and_refuse() {
    let bytes = positioned_source("1.E308", "1.E308");
    let (operations, result, domain) = admission(&bytes);
    assert_eq!(
        operations.len(),
        1,
        "the finite positioned extrusion must actually be admitted"
    );
    let value = operations[0].value();
    assert!(value.source_from_evaluation().iter().all(|x| x.is_finite()));
    assert!(value.evaluation_from_source().iter().all(|x| x.is_finite()));
    assert!(value.object_frame().iter().all(|x| x.is_finite()));
    assert_eq!(value.object_frame()[12], 1e308);
    assert!(
        result.is_err(),
        "1e308 + 1e308 must refuse the whole product plan"
    );

    // S2 validates the original traversal domain before frame composition.
    // Use that domain so the overflow guard, not foreign-owner refusal, is reached.
    // The same reached value also witnesses transactional placement: failure
    // must not change the slot, frames, lineage, or product-placed flag.
    let mut value = value.try_copy().unwrap();
    let before = value.try_copy().unwrap();
    let translation = nalgebra::Matrix4::new_translation(&nalgebra::Vector3::new(1e308, 0., 0.));
    assert!(value
        .place_in_place(
            &translation,
            domain,
            RetainedPlacementStage::Product { product_id: 10 }
        )
        .is_err());
    assert_eq!(
        value, before,
        "failed object-frame composition must leave the value unchanged"
    );
}

#[test]
fn source_frame_overflow_also_preserves_the_last_valid_occurrence() {
    let (operations, result, domain) = admission(SOURCE);
    assert_eq!(result.unwrap().values.len(), 1);
    let mut value = operations[0].value().try_copy().unwrap();
    let translation = nalgebra::Matrix4::new_translation(&nalgebra::Vector3::new(1e308, 0., 0.));
    value
        .place_in_place(
            &translation,
            domain,
            RetainedPlacementStage::Product { product_id: 10 },
        )
        .unwrap();
    assert_eq!(value.world_from_source().unwrap()[12], 1e308);
    let before = value.try_copy().unwrap();
    assert!(value
        .place_in_place(
            &translation,
            domain,
            RetainedPlacementStage::Product { product_id: 10 }
        )
        .is_err());
    assert_eq!(
        value, before,
        "failed source-frame composition must preserve the placed value"
    );
}

fn unit_overflow_source() -> String {
    positioned_source("2.E305", "0.")
        .replace("$,.METRE.", ".KILO.,.METRE.")
        .replace("#90,#15,3.)", "#90,#15,0.003)")
        .replace("$,$,2.,4.)", "$,$,0.002,0.004)")
        .replace(
            "#90=IFCAXIS2PLACEMENT3D(#91,$,$)",
            "#90=IFCAXIS2PLACEMENT3D(#91,$,#92)",
        )
        .replace(
            "ENDSEC;END-ISO-10303-21;",
            "#92=IFCDIRECTION((1.,1.,0.));ENDSEC;END-ISO-10303-21;",
        )
}

#[test]
fn source_unit_composition_overflow_refuses_before_admitting_a_construction() {
    // A 45-degree source rotation keeps each inverse-frame translation at
    // about 1.414e308, while the unrotated unit-scaled X would be 2e308.
    // Thus the source lowerer's finite inverse does not imply finite composition.
    let bytes = unit_overflow_source();
    // Prove the reached source lowerer succeeds with finite frames; refusal
    // must be caused by unit composition, not an unrelated source error.
    let source = SourceBundle::new(bytes.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(&bytes, &mut decoder);
    assert_eq!(router.unit_scale(), 1000.);
    let solid = decoder.decode_by_id(13).unwrap();
    let recipe = crate::document::RetainedRecipe::Extrusion(crate::document::RetainedExtrusion {
        source: crate::analytic::with_source_capture(|| {
            crate::analytic::extract_analytic_extrusion(&solid, &mut decoder)
        }),
        length_unit_scale: router.unit_scale(),
    });
    let payload = recipe.lower().unwrap();
    assert!(payload.source_from_evaluation.iter().all(|x| x.is_finite()));
    assert!(payload.evaluation_from_source.iter().all(|x| x.is_finite()));
    let (operations, result, _) = admission(&bytes);
    assert!(
        result.is_err(),
        "initial unit composition must refuse the whole plan"
    );
    assert!(
        operations.is_empty(),
        "non-finite constructions cannot be admitted"
    );
}

#[test]
fn rotated_translated_source_and_product_keep_their_ordered_finite_frames() {
    let bytes = positioned_source("4.", "10.")
        .replace(
            "#7=IFCAXIS2PLACEMENT3D(#8,$,$)",
            "#7=IFCAXIS2PLACEMENT3D(#8,$,#92)",
        )
        .replace(
            "#90=IFCAXIS2PLACEMENT3D(#91,$,$)",
            "#90=IFCAXIS2PLACEMENT3D(#91,$,#92)",
        )
        .replace("((4.,0.,0.))", "((4.,5.,6.))")
        .replace("((10.,0.,0.))", "((10.,20.,30.))")
        .replace(
            "ENDSEC;END-ISO-10303-21;",
            "#92=IFCDIRECTION((0.,1.,0.));ENDSEC;END-ISO-10303-21;",
        );
    let (operations, result, _) = admission(&bytes);
    assert_eq!(operations.len(), 1);
    let plan = result.unwrap();
    assert_eq!(plan.values.len(), 1);
    let value = &plan.values[0];
    assert!(value.is_product_placed());
    assert!(value.object_frame().iter().all(|x| x.is_finite()));
    let placements = value.placements();
    assert_eq!(placements.len(), 1);
    assert_eq!(placements[0].input, operations[0].value().slot());
    assert_eq!(placements[0].output, value.slot());
    assert_ne!(placements[0].input, placements[0].output);
    // Rectangle anchor (-1,-2,0), source Rz(90)+[4,5,6], then
    // product Rz(90)+[10,20,30]: origin [6,26,36], X points to -X.
    for (local, expected) in [
        ([0., 0., 0., 1.], [6., 26., 36., 1.]),
        ([2., 0., 3., 1.], [4., 26., 39., 1.]),
    ] {
        let actual = value.world_from_evaluation() * nalgebra::Vector4::from(local);
        assert!((actual - nalgebra::Vector4::from(expected)).norm() < 1e-12);
    }
    let world_from_source =
        nalgebra::Matrix4::from_column_slice(value.world_from_source().unwrap());
    assert!(
        (world_from_source * nalgebra::Vector4::new(4., 5., 6., 1.)
            - nalgebra::Vector4::new(5., 24., 36., 1.))
        .norm()
            < 1e-12
    );
}

#[test]
fn reached_nonrigid_placement_refuses_without_changing_the_occurrence() {
    let (operations, result, domain) = admission(SOURCE);
    assert_eq!(result.unwrap().values.len(), 1);
    let original = operations[0].value();
    for scale in [2., -1.] {
        let mut value = original.try_copy().unwrap();
        let transform = nalgebra::Matrix4::new_nonuniform_scaling(&nalgebra::Vector3::new(scale, 1., 1.));
        assert!(value.place_in_place(&transform, domain, RetainedPlacementStage::Product { product_id: 10 }).is_err());
        assert_eq!(&value, original, "nonrigid refusal must preserve all logical state");
    }
    let mut rigid = original.try_copy().unwrap();
    rigid.place_in_place(&nalgebra::Matrix4::identity(), domain, RetainedPlacementStage::Product { product_id: 10 }).unwrap();
    assert!(rigid.is_product_placed());
    assert_ne!(rigid.slot(), original.slot());
}

#[test]
fn reached_singular_placement_refuses_without_changing_the_occurrence() {
    let (operations, result, domain) = admission(SOURCE);
    assert_eq!(result.unwrap().values.len(), 1);
    let original = operations[0].value();
    let mut value = original.try_copy().unwrap();
    let singular = nalgebra::Matrix4::new_nonuniform_scaling(&nalgebra::Vector3::new(0., 1., 1.));
    assert!(value.place_in_place(&singular, domain, RetainedPlacementStage::Product { product_id: 10 }).is_err());
    assert_eq!(&value, original, "singular refusal must preserve all logical state");
}

// #7955 S2: separately finite nonsingular inputs may compose to a singular
// matrix through underflow. Refuse before mutating the reached occurrence.
#[test]
fn nonrigid_composition_underflow_refuses_atomically_in_the_original_domain() {
    let (operations, result, domain) = admission(SOURCE);
    assert_eq!(result.unwrap().values.len(), 1);
    let mut value = operations[0].value().try_copy().unwrap();
    let transform = nalgebra::Matrix4::new_nonuniform_scaling(
        &nalgebra::Vector3::new(1e-200, 1., 1.));
    let stage = RetainedPlacementStage::Mapping { source_id: 61 };
    value.place_in_place(&transform, domain, stage).unwrap();
    assert_eq!(value.object_frame()[0], 1e-200);
    let before = value.try_copy().unwrap();
    assert!(value.place_in_place(&transform, domain, stage).is_err());
    assert_eq!(value, before, "singular composition must not mutate the value");
}

#[test]
fn boolean_output_mapping_overflow_preserves_operation_frames_and_slot() {
    // #7955 S2 exercises the derived-operation branch of checked composition,
    // in addition to the original S1 source-frame and unit-frame witnesses.
    let (operations, result, domain) = admission(&boolean_tests::nested());
    assert_eq!(result.unwrap().values.len(), 1);
    let mut value = operations.last().unwrap().value().try_copy().unwrap();
    assert!(matches!(value.definition(), LogicalRetainedDefinition::Operation(_)));
    let transform = nalgebra::Matrix4::new_translation(&nalgebra::Vector3::new(1e308, 0., 0.));
    let stage = RetainedPlacementStage::Mapping { source_id: 61 };
    value.place_in_place(&transform, domain, stage).unwrap();
    assert_eq!(value.object_frame()[12], 1e308);
    let before = value.try_copy().unwrap();
    assert!(value.place_in_place(&transform, domain, stage).is_err());
    assert_eq!(value, before, "failed derived frame composition is atomic");
}

#[test]
fn s2_r2_nan_determinant_placement_refuses_atomically_in_original_domain() {
    // #7955 R2: use a real admitted source and its domain, not a foreign-owner
    // refusal. The candidate composed entries stay finite under this matrix.
    let (operations, result, domain) = admission(SOURCE);
    assert_eq!(result.unwrap().values.len(), 1);
    let mut value = operations[0].value().try_copy().unwrap();
    let before = value.try_copy().unwrap();
    let transform = nalgebra::Matrix4::<f64>::new_nonuniform_scaling(&nalgebra::Vector3::new(0., 1e200, 1e200));
    assert!(transform.iter().all(|entry| entry.is_finite()));
    assert!(transform.fixed_view::<3, 3>(0, 0).determinant().is_nan());
    assert!((transform * value.world_from_evaluation()).iter().all(|entry| entry.is_finite()));
    let error = value.place_in_place(&transform, domain,
        RetainedPlacementStage::Mapping { source_id: 61 }).unwrap_err();
    assert!(error.to_string().contains("finite nonsingular affine"), "{error}");
    assert_eq!(value, before, "singular placement preserves frames, slot, lineage and product flag");
}

#[test]
fn s2_r2_extreme_valid_matrix_is_conservatively_refused_without_mutation() {
    // #7955 R2: explicit limit of the minimal finite-determinant policy.
    let (operations, result, domain) = admission(SOURCE);
    assert_eq!(result.unwrap().values.len(), 1);
    let mut value = operations[0].value().try_copy().unwrap();
    let before = value.try_copy().unwrap();
    let transform = nalgebra::Matrix4::<f64>::new_nonuniform_scaling(&nalgebra::Vector3::new(1., 1e200, 1e200));
    assert!(transform.iter().all(|entry| entry.is_finite()));
    assert!(transform.fixed_view::<3, 3>(0, 0).determinant().is_infinite());
    assert!(value.place_in_place(&transform, domain,
        RetainedPlacementStage::Mapping { source_id: 61 }).is_err());
    assert_eq!(value, before);
}

#[path = "frame_origin_tests.rs"]
mod origins;
