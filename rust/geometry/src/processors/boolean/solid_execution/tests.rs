// SPDX-License-Identifier: MPL-2.0
use super::*;
use crate::{BoolFailureReason, GeometryProcessor};
use ifc_lite_core::{EntityDecoder, IfcSchema};

fn cube(offset: f32) -> Mesh {
    let mut decoder = EntityDecoder::new("#1=IFCBLOCK($,2.,2.,2.);");
    let entity = decoder.decode_by_id(1).unwrap();
    let mut mesh = crate::processors::BlockProcessor::new().process(
        &entity, &mut decoder, &IfcSchema::new(), TessellationQuality::Medium).unwrap();
    for coordinate in &mut mesh.positions { *coordinate += offset; }
    mesh
}

fn volume(mesh: &Mesh) -> f64 {
    mesh.indices.chunks_exact(3).map(|triangle| {
        let p = |index: u32| {
            let start = index as usize * 3;
            nalgebra::Vector3::new(mesh.positions[start] as f64,
                mesh.positions[start + 1] as f64, mesh.positions[start + 2] as f64)
        };
        p(triangle[0]).dot(&p(triangle[1]).cross(&p(triangle[2]))) / 6.
    }).sum::<f64>().abs()
}

fn plan(operator: BoolOp) -> SolidBooleanPlan {
    SolidBooleanPlan { operator, length_unit_scale: 1.,
        quality: TessellationQuality::Medium, skip_small_cuts: false }
}

#[test]
fn owned_exact_solid_steps_have_independent_overlap_volumes_without_a_decoder() {
    for (operator, expected) in [(BoolOp::Difference, 7.), (BoolOp::Union, 15.), (BoolOp::Intersection, 1.)] {
        let processor = BooleanClippingProcessor::new();
        let (mesh, lost) = plan(operator).evaluate(&processor, cube(0.), cube(1.), false).unwrap();
        assert!(!lost);
        assert!((volume(&mesh) - expected).abs() < 1e-6, "{operator}");
        assert!(processor.take_failures().is_empty());
    }
}

#[test]
fn empty_second_operand_keeps_the_existing_single_loss_contract() {
    for operator in [BoolOp::Difference, BoolOp::Union, BoolOp::Intersection] {
        for already_recorded in [false, true] {
            let processor = BooleanClippingProcessor::new();
            let (mesh, lost) = plan(operator).evaluate(&processor, cube(0.), Mesh::new(), already_recorded).unwrap();
            assert_eq!(mesh.is_empty(), operator == BoolOp::Intersection);
            assert_eq!(lost, operator == BoolOp::Intersection);
            let failures = processor.take_failures();
            assert_eq!(failures.len(), usize::from(!already_recorded));
            if !already_recorded {
                assert_eq!(failures[0].op, operator);
                assert_eq!(failures[0].reason, BoolFailureReason::EmptyOperand);
            }
        }
    }
}

#[test]
fn unknown_numerical_operator_is_refused_without_an_arithmetic_substitution() {
    let processor = BooleanClippingProcessor::new();
    assert!(plan(BoolOp::Unknown).evaluate(&processor, cube(0.), cube(1.), false).is_err());
    assert!(processor.take_failures().is_empty());
}

// Invalid conversion factors are discovered lazily. An empty/skipped solid
// step must retain the existing behavior of never consulting the unused unit.
const INVALID_LAZY_LENGTH_UNIT: &str = "#100=IFCPROJECT('0001projectaaaaaaaaaaa',$,'P',$,$,$,$,$,#101);\n\
    #101=IFCUNITASSIGNMENT((#102));\n\
    #102=IFCCONVERSIONBASEDUNIT(#103,.LENGTHUNIT.,'INVALID_LENGTH',#104);\n\
    #103=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);\n\
    #104=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(1.E400),#105);\n\
    #105=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);";

#[test]
fn production_empty_solid_operands_preserve_lazy_length_unit_refusal() {
    for (keyword, operator) in [("DIFFERENCE", BoolOp::Difference),
        ("UNION", BoolOp::Union), ("INTERSECTION", BoolOp::Intersection)] {
        let source = format!("{INVALID_LAZY_LENGTH_UNIT}\n\
            #1=IFCBLOCK($,2.,2.,2.);\n\
            #2=IFCSECTIONEDSPINE($,(),());\n\
            #3=IFCBOOLEANRESULT(.{keyword}.,#1,#2);");
        let mut decoder = EntityDecoder::new(&source).with_strict_reals();
        let entity = decoder.decode_by_id(3).unwrap();
        let processor = BooleanClippingProcessor::new();
        let mesh = processor.process(&entity, &mut decoder, &IfcSchema::new(),
            TessellationQuality::Medium).unwrap();
        assert_eq!(decoder.refused_records(), 0, "unused length unit consulted for {keyword}");
        assert_eq!(mesh.is_empty(), operator == BoolOp::Intersection);
        if operator != BoolOp::Intersection { assert!((volume(&mesh) - 8.0).abs() < 1e-8); }
        let diagnostics = processor.take_failures();
        assert_eq!(diagnostics.len(), 1, "one unsupported cutter is one loss");
        assert_eq!(diagnostics[0].op, operator);
        assert!(matches!(diagnostics[0].reason, BoolFailureReason::UnsupportedOperand(_)));
        // Positive control: this source really does expose the extra diagnostic
        // when unit lookup occurs; the earlier zero is not a missing fixture.
        assert_eq!(decoder.length_unit_scale(), 1.0);
        assert!(decoder.refused_records() > 0);
    }
}

#[test]
fn production_small_cut_skip_preserves_lazy_length_unit_refusal() {
    let dimension = super::super::cut_heuristics::fast_cut_skip_ratio().min(0.1);
    let source = format!("{INVALID_LAZY_LENGTH_UNIT}\n\
        #1=IFCBLOCK($,2.,2.,2.);\n\
        #2=IFCBLOCK($,{dimension:e},{dimension:e},{dimension:e});\n\
        #3=IFCBOOLEANRESULT(.DIFFERENCE.,#1,#2);");
    let mut decoder = EntityDecoder::new(&source).with_strict_reals();
    let entity = decoder.decode_by_id(3).unwrap();
    let processor = BooleanClippingProcessor::with_skip_small_cuts(true);
    let mesh = processor.process(&entity, &mut decoder, &IfcSchema::new(),
        TessellationQuality::Medium).unwrap();
    assert!((volume(&mesh) - 8.0).abs() < 1e-8, "skipped cut must retain its host");
    assert!(processor.take_failures().is_empty(), "intentional preview skip is not a failed cut");
    assert_eq!(decoder.refused_records(), 0, "skipped cut consulted unused length unit");
    assert_eq!(decoder.length_unit_scale(), 1.0);
    assert!(decoder.refused_records() > 0, "invalid-unit positive control");
}
