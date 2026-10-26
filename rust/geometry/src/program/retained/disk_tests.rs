// SPDX-License-Identifier: MPL-2.0
//! #7955 R2: source-derived disks through public request/admit/accept/finish.
use super::*;
use crate::analytic::{AnalyticCurveSegment, AnalyticStatus, OwnedDirectrix, SourceValue};
use crate::document::RetainedRecipe;

fn disk_source(items: &str) -> String {
    SOURCE
        .replace("$,.METRE.", ".MILLI.,.METRE.")
        .replace(
            "'SweptSolid',(#13)",
            &format!("'AdvancedSweptSolid',({items})"),
        )
        .replace(
            "ENDSEC;END-ISO-10303-21;",
            "
#90=IFCSWEPTDISKSOLID(#91,250.,$,$,$);
#91=IFCPOLYLINE((#92,#93));
#92=IFCCARTESIANPOINT((1000.,2000.,3000.));
#93=IFCCARTESIANPOINT((1000.,2000.,8000.));
#94=IFCSWEPTDISKSOLID(#91,250.,100.,$,$);
#95=IFCSWEPTDISKSOLID(#96,250.,$,$,$);
#96=IFCPOLYLINE((#92,#93,#97));
#97=IFCCARTESIANPOINT((2000.,2000.,8000.));
ENDSEC;END-ISO-10303-21;",
        )
}

fn assert_disk_source(operation: &RetainedPlanOperation) {
    assert!(matches!(
        operation.value().definition(),
        LogicalRetainedDefinition::Source {
            source_id: 90,
            source_epoch: 7,
            source_revision: 9,
            ..
        }
    ));
    let Some(RetainedRecipe::SweptDisk(recipe)) = operation.construction() else {
        panic!("the authored disk must reach the disk construction path");
    };
    assert_eq!(recipe.solid_id, 90);
    assert_eq!(recipe.length_unit_scale, 0.001);
    assert_eq!(recipe.source.directrix_id, 91);
    assert_eq!(recipe.source.radius, 250.);
    assert_eq!(recipe.source.inner_radius, None);
    let original = recipe
        .source
        .source
        .as_ref()
        .expect("captured original disk");
    assert_eq!(original.root_entity_id, 90);
    assert_eq!(original.capture_status, AnalyticStatus::Complete);
    assert_eq!(
        original.records[&90].attributes["Directrix"],
        SourceValue::EntityRef(91)
    );
    assert_eq!(
        original.records[&91].attributes["Points"],
        SourceValue::List(vec![SourceValue::EntityRef(92), SourceValue::EntityRef(93)])
    );
    assert_eq!(
        recipe.source.owned_directrix,
        Some(OwnedDirectrix::Segments(vec![AnalyticCurveSegment::Line {
            start: [1000., 2000., 3000.],
            end: [1000., 2000., 8000.]
        },]))
    );
    // Authored units and evaluation metres must stay distinct.
    let source_frame =
        nalgebra::Matrix4::from_column_slice(operation.value().source_from_evaluation());
    let evaluation_frame =
        nalgebra::Matrix4::from_column_slice(operation.value().evaluation_from_source());
    let start = nalgebra::Vector4::new(1000., 2000., 3000., 1.);
    let end = nalgebra::Vector4::new(1000., 2000., 8000., 1.);
    assert!((evaluation_frame * start - nalgebra::Vector4::new(0., 0., 0., 1.)).norm() < 1e-12);
    assert!((evaluation_frame * end - nalgebra::Vector4::new(0., 0., 5., 1.)).norm() < 1e-12);
    assert!((source_frame * nalgebra::Vector4::new(0., 0., 5., 1.) - end).norm() < 1e-9);
}

#[test]
fn swept_disk_preserves_source_directrix_repeated_occurrences_and_scaled_frames() {
    let bytes = disk_source("#90,#90");
    let source = SourceBundle::new(bytes.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(&bytes, &mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let mut program = RetainedProgram::product_parts(&entity, contract());
    let operations = drive(&mut program, &router, &mut decoder);
    assert_eq!(
        operations.len(),
        2,
        "positive disk admission, never a vacuous refusal"
    );
    assert_ne!(operations[0].value().slot(), operations[1].value().slot());
    for operation in &operations {
        assert_disk_source(operation);
    }
    let plan = program.finish().unwrap();
    assert_eq!(plan.values.len(), 2);
    assert_ne!(plan.values[0].slot(), plan.values[1].slot());
    for (value, operation) in plan.values.iter().zip(&operations) {
        assert_eq!(value.definition(), operation.value().definition());
        assert!(value.is_product_placed());
        let placement = &value.placements()[0];
        assert_eq!(value.placements().len(), 1);
        assert_eq!(
            placement.stage,
            RetainedPlacementStage::Product { product_id: 10 }
        );
        assert_eq!(placement.input, operation.value().slot());
        assert_eq!(placement.output, value.slot());
        let world_from_source =
            nalgebra::Matrix4::from_column_slice(value.world_from_source().unwrap());
        for (raw, local, expected) in [
            (
                [1000., 2000., 3000., 1.],
                [0., 0., 0., 1.],
                [1.01, 2.02, 3.03, 1.],
            ),
            (
                [1000., 2000., 8000., 1.],
                [0., 0., 5., 1.],
                [1.01, 2.02, 8.03, 1.],
            ),
        ] {
            let expected = nalgebra::Vector4::from(expected);
            assert!((world_from_source * nalgebra::Vector4::from(raw) - expected).norm() < 1e-12);
            assert!(
                (value.world_from_evaluation() * nalgebra::Vector4::from(local) - expected).norm()
                    < 1e-12
            );
        }
    }
}

#[test]
fn later_hollow_or_multisegment_disk_refuses_whole_plan_after_supported_disk() {
    for unsupported in ["#94", "#95"] {
        let bytes = disk_source(&format!("#90,{unsupported}"));
        let source = SourceBundle::new(bytes.as_bytes().to_vec());
        let mut decoder = source.decoder();
        let router = GeometryRouter::with_units(&bytes, &mut decoder);
        let entity = decoder.decode_by_id(10).unwrap();
        let mut program = RetainedProgram::product_parts(&entity, contract());
        let operations = drive(&mut program, &router, &mut decoder);
        assert_eq!(
            operations.len(),
            1,
            "supported first item must actually be admitted"
        );
        assert_disk_source(&operations[0]);
        assert!(
            program.finish().is_err(),
            "no partial plan after {unsupported}"
        );
        // Refusal restores the opt-in capture scope; a later ordinary exact
        // request still has its real mesh route and no retained source graph.
        let solid = decoder.decode_by_id(90).unwrap();
        let ordinary = crate::analytic::extract_swept_disk(&solid, &mut decoder).unwrap();
        assert!(ordinary.source.is_none());
        let mesh = router
            .process_representation_item(&solid, &mut decoder)
            .unwrap();
        assert!(!mesh.is_empty());
    }
}
