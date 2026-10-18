// SPDX-License-Identifier: MPL-2.0
//! Continuation boundaries preserve source admission and numerical policy.
use super::*;
use crate::processors::BlockProcessor;

fn host() -> Mesh {
    let mut decoder = EntityDecoder::new("#1=IFCBLOCK($,1.,1.,1.);");
    let entity = decoder.decode_by_id(1).unwrap();
    BlockProcessor::new().lower(&entity, &mut decoder).unwrap().evaluate()
}
fn volume(mesh: &Mesh) -> f64 {
    mesh.indices.chunks_exact(3).map(|triangle| {
        let p = |index: u32| {
            let i = index as usize * 3;
            nalgebra::Vector3::new(mesh.positions[i] as f64,
                mesh.positions[i + 1] as f64, mesh.positions[i + 2] as f64)
        };
        p(triangle[0]).dot(&p(triangle[1]).cross(&p(triangle[2]))) / 6.
    }).sum::<f64>().abs()
}
fn done(admission: StepAdmission) -> (Mesh, bool) {
    let StepAdmission::Done(result) = admission else { panic!("expected terminal admission") };
    result
}

#[test]
fn unknown_step_operator_keeps_host_without_resolving_its_malformed_operand() {
    let source = "#9=IFCCARTESIANPOINT((1.E400,0.,0.));#3=IFCBOOLEANRESULT(.XOR.,$,#9);";
    let mut decoder = EntityDecoder::new(source).with_strict_reals();
    let entity = decoder.decode_by_id(3).unwrap();
    let processor = BooleanClippingProcessor::new();
    let expected = host();
    let (actual, lost) = done(processor.begin_boolean_step(&entity, expected.clone(), &mut decoder,
        TessellationQuality::Medium, true).unwrap());
    assert!(!lost);
    assert_eq!(actual.positions, expected.positions);
    assert_eq!(actual.indices, expected.indices);
    assert!(decoder.refused_record_ids().is_empty());
    let failures = processor.take_failures();
    assert_eq!(failures.len(), 1);
    assert_eq!(failures[0].op, BoolOp::Unknown);
    assert!(matches!(&failures[0].reason, BoolFailureReason::UnknownBooleanOperator(keyword) if keyword == "XOR"));
}

#[test]
fn unresolved_step_operand_retains_operation_specific_recovery_and_one_loss() {
    for (keyword, operator) in [("DIFFERENCE", BoolOp::Difference),
        ("UNION", BoolOp::Union), ("INTERSECTION", BoolOp::Intersection)] {
        let source = format!("#3=IFCBOOLEANRESULT(.{keyword}.,$,#999);");
        let mut decoder = EntityDecoder::new(&source);
        let entity = decoder.decode_by_id(3).unwrap();
        let processor = BooleanClippingProcessor::new();
        let (mesh, lost) = done(processor.begin_boolean_step(&entity, host(), &mut decoder,
            TessellationQuality::Medium, true).unwrap());
        assert_eq!(mesh.is_empty(), operator == BoolOp::Intersection);
        assert_eq!(lost, operator == BoolOp::Intersection);
        if !mesh.is_empty() { assert!((volume(&mesh) - 1.).abs() < 1e-12); }
        let failures = processor.take_failures();
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].op, operator);
        assert_eq!(failures[0].reason, BoolFailureReason::EmptyOperand);
    }
}

#[test]
fn solid_admission_hands_constructor_execution_to_the_continuation() {
    // Negative dimensions would fail the primitive constructor. Admission must
    // retain its decoded source and host rather than eagerly running it.
    let source = "#2=IFCBLOCK($,-1.,1.,1.);#3=IFCBOOLEANRESULT(.DIFFERENCE.,$,#2);";
    let mut decoder = EntityDecoder::new(source);
    let entity = decoder.decode_by_id(3).unwrap();
    let processor = BooleanClippingProcessor::new();
    let StepAdmission::Solid { operator, first, operand } = processor.begin_boolean_step(
        &entity, host(), &mut decoder, TessellationQuality::Medium, true).unwrap()
        else { panic!("solid operand must return to the continuation") };
    assert_eq!(operator, BoolOp::Difference);
    assert_eq!(operand.id, 2);
    assert!((volume(&first) - 1.).abs() < 1e-12);
    assert!(processor.take_failures().is_empty());
    assert!(BlockProcessor::new().lower(&operand, &mut decoder).is_err());
}

#[test]
fn plane_step_completes_with_material_side_volume_and_cap_before_solid_continuation() {
    let source = "#1=IFCCARTESIANPOINT((0.25,0.,0.));#2=IFCDIRECTION((1.,0.,0.));
#3=IFCAXIS2PLACEMENT3D(#1,#2,$);#4=IFCPLANE(#3);#5=IFCHALFSPACESOLID(#4,.T.);
#6=IFCBOOLEANRESULT(.DIFFERENCE.,$,#5);";
    let mut decoder = EntityDecoder::new(source);
    let entity = decoder.decode_by_id(6).unwrap();
    let processor = BooleanClippingProcessor::new();
    let (mesh, lost) = done(processor.begin_boolean_step(&entity, host(), &mut decoder,
        TessellationQuality::Medium, true).unwrap());
    assert!(!lost);
    assert!((volume(&mesh) - 0.75).abs() < 1e-6);
    assert_eq!(mesh.bounds().0.x, 0.25);
    assert!(processor.take_failures().is_empty());
}

#[test]
fn empty_solid_completion_does_not_discover_an_unused_invalid_unit() {
    let source = "#100=IFCPROJECT('0001projectaaaaaaaaaaa',$,'P',$,$,$,$,$,#101);
#101=IFCUNITASSIGNMENT((#102));
#102=IFCCONVERSIONBASEDUNIT(#103,.LENGTHUNIT.,'INVALID_LENGTH',#104);
#103=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);
#104=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(1.E400),#105);
#105=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);";
    let mut decoder = EntityDecoder::new(source).with_strict_reals();
    let processor = BooleanClippingProcessor::new();
    let (mesh, lost) = processor.finish_solid_step(BoolOp::Difference, host(), (Mesh::new(), true),
        &mut decoder, TessellationQuality::Medium).unwrap();
    assert!(!lost);
    assert!((volume(&mesh) - 1.).abs() < 1e-12);
    assert!(decoder.refused_record_ids().is_empty());
    assert!(processor.take_failures().is_empty(), "pre-recorded operand loss must not duplicate");
    assert_eq!(decoder.length_unit_scale(), 1.);
    assert!(!decoder.refused_record_ids().is_empty(), "invalid unit positive control");
}
