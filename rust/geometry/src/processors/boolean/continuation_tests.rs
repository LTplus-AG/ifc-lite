// SPDX-License-Identifier: MPL-2.0
//! Production continuation invariants: conditional admission, loss propagation,
//! path ownership and monotonic work across real boolean/CSG entry points.
use super::*;
use crate::processors::CsgSolidProcessor;
use crate::{GeometryProcessor, kernel::mesh_volume::mesh_volume};

const BLOCK: &str = "#1=IFCBLOCK($,2.,2.,2.);";
const UNSUPPORTED: &str = "#2=IFCSECTIONEDSPINE($,(),());";
const BAD_REAL: &str = "#900=IFCCARTESIANPOINT((1.E400,0.,0.));";

fn run(processor: &dyn GeometryProcessor, decoder: &mut EntityDecoder, root: u32) -> Result<Mesh> {
    let entity = decoder.decode_by_id(root).unwrap();
    processor.process(&entity, decoder, &IfcSchema::new(), TessellationQuality::Medium)
}
fn assert_cube(mesh: &Mesh) {
    assert_eq!(mesh.triangle_count(),12);
    assert!((mesh_volume(mesh)-8.).abs()<1e-7);
}

#[test]
fn dormant_second_references_stay_unread_through_nested_boolean_and_csg_frames() {
    for (keyword, first, expected_cube, reason) in [
        ("XOR",1,true,"unknown"),
        ("DIFFERENCE",2,false,"unsupported"),
        ("INTERSECTION",2,false,"unsupported"),
    ] {
        for csg in [false,true] {
            // DIFFERENCE's provisional collector does resolve the direct
            // cutter; only that cutter's own bad source remains dormant.
            let second = if keyword == "DIFFERENCE" { 901 } else { 900 };
            let source = format!("{BLOCK}{UNSUPPORTED}{BAD_REAL}\
                #901=IFCBOOLEANRESULT(.UNION.,#900,#1);\
                #10=IFCBOOLEANRESULT(.{keyword}.,#{first},#{second});#11=IFCCSGSOLID(#10);");
            let mut decoder = EntityDecoder::new(&source).with_strict_reals();
            let processor = BooleanClippingProcessor::new();
            let csg_processor = CsgSolidProcessor::new();
            let active: &dyn GeometryProcessor = if csg { &csg_processor } else { &processor };
            let mesh = run(active,&mut decoder,if csg {11}else{10}).unwrap();
            if expected_cube { assert_cube(&mesh); } else { assert!(mesh.is_empty()); }
            assert!(decoder.refused_record_ids().is_empty(),"dormant real must not be admitted");
            let failures = active.take_bool_failures();
            assert_eq!(failures.len(),1);
            match reason {
                "unknown" => assert!(matches!(failures[0].reason,BoolFailureReason::UnknownBooleanOperator(_))),
                _ => assert!(matches!(failures[0].reason,BoolFailureReason::UnsupportedOperand(_))),
            }
            assert!(decoder.decode_by_id(900).is_err(),"positive control: real is invalid");
            assert_eq!(decoder.refused_record_ids(),[900]);
        }
    }
}

#[test]
fn unknown_operator_still_requires_its_first_operand_but_never_its_second() {
    let source = format!("{BAD_REAL}#10=IFCBOOLEANRESULT(.XOR.,#999,#900);");
    let mut decoder = EntityDecoder::new(&source).with_strict_reals();
    let processor = BooleanClippingProcessor::new();
    assert!(run(&processor,&mut decoder,10).is_err());
    assert!(processor.take_failures().is_empty(),"operator execution is not reached");
    assert!(decoder.refused_record_ids().is_empty());
}

#[test]
fn prior_losses_survive_errors_through_transient_csg_recorders_and_drain_once() {
    for wrapped in [false,true] {
        let source = format!("{BLOCK}{UNSUPPORTED}\
            #10=IFCBOOLEANRESULT(.UNION.,#2,#20);#20=IFCCSGSOLID(#30);\
            #30=IFCBOOLEANRESULT(.UNION.,#999,#1);#40=IFCCSGSOLID(#10);");
        let mut decoder = EntityDecoder::new(&source);
        let processor = BooleanClippingProcessor::new();
        let csg = CsgSolidProcessor::new();
        let active: &dyn GeometryProcessor = if wrapped {&csg}else{&processor};
        let error = run(active,&mut decoder,if wrapped {40}else{10}).unwrap_err();
        assert!(error.to_string().contains("999"));
        let failures = active.take_bool_failures();
        assert_eq!(failures.len(),1,"the prior unsupported base is preserved on Err");
        assert_eq!(failures[0].op,BoolOp::Unknown);
        assert!(matches!(failures[0].reason,BoolFailureReason::UnsupportedOperand(_)));
        assert!(active.take_bool_failures().is_empty(),"no duplicate transient handoff");
    }
}

#[test]
fn failed_continuation_unwinds_its_paths_without_removing_its_callers_ancestor() {
    let processor = BooleanClippingProcessor::new();
    let mut path = OperandPath::default();
    // Model an enclosing caller's live CSG frame. The tested production entry
    // must remove only its own frames on the early error below.
    assert!(path.insert(777));
    let bad = format!("{BLOCK}#10=IFCBOOLEANRESULT(.UNION.,#1,#20);\
        #20=IFCCSGSOLID(#30);#30=IFCBOOLEANRESULT(.UNION.,#999,#1);");
    let mut decoder = EntityDecoder::new(&bad);
    let entity = decoder.decode_by_id(10).unwrap();
    assert!(processor.process_with_depth(&entity,&mut decoder,&IfcSchema::new(),0,
        TessellationQuality::Medium,&mut path).is_err());
    let valid = format!("{BLOCK}#10=IFCBOOLEANRESULT(.UNION.,#1,#20);\
        #20=IFCCSGSOLID(#30);#30=IFCBOOLEANRESULT(.XOR.,#1,$);\
        #777=IFCBOOLEANRESULT(.XOR.,#1,$);");
    let mut decoder = EntityDecoder::new(&valid);
    let entity = decoder.decode_by_id(10).unwrap();
    let (mesh,_) = processor.process_with_depth(&entity,&mut decoder,&IfcSchema::new(),0,
        TessellationQuality::Medium,&mut path).expect("failed #10 frame must have unwound");
    assert_cube(&mesh);
    processor.take_failures();
    let ancestor = decoder.decode_by_id(777).unwrap();
    let error = processor.process_with_depth(&ancestor,&mut decoder,&IfcSchema::new(),0,
        TessellationQuality::Medium,&mut path).unwrap_err();
    assert!(error.to_string().contains("Cyclic"),"caller frame must still be live: {error}");
}

#[test]
fn completed_continuations_never_refund_the_shared_operand_visit_budget() {
    let source = format!("{BLOCK}#10=IFCBOOLEANRESULT(.XOR.,#1,$);");
    let mut decoder = EntityDecoder::new(&source);
    let entity = decoder.decode_by_id(10).unwrap();
    let processor = BooleanClippingProcessor::new();
    let mut path = OperandPath::default();
    for _ in 0..MAX_OPERAND_VISITS {
        let (mesh,_) = processor.process_with_depth(&entity,&mut decoder,&IfcSchema::new(),0,
            TessellationQuality::Medium,&mut path).unwrap();
        assert_cube(&mesh);
    }
    assert_eq!(processor.take_failures().len(),MAX_OPERAND_VISITS as usize);
    let error = processor.process_with_depth(&entity,&mut decoder,&IfcSchema::new(),0,
        TessellationQuality::Medium,&mut path).unwrap_err();
    assert!(error.to_string().contains("node visits"));
    let failures = processor.take_failures();
    assert_eq!(failures.len(),1);
    assert_eq!(failures[0].reason,BoolFailureReason::OperandBudgetExhausted);
}

#[test]
fn csg_hops_reset_boolean_depth_without_resetting_the_shared_path() {
    for csg_hops in [false,true] {
        let mut source = BLOCK.to_owned();
        let mut previous = 1;
        for i in 0..12 {
            let id = 10+i;
            let second = if csg_hops {
                let csg_id = 100+i;
                source.push_str(&format!("#{csg_id}=IFCCSGSOLID(#{previous});"));
                csg_id
            } else { previous };
            source.push_str(&format!("#{id}=IFCBOOLEANRESULT(.UNION.,#1,#{second});"));
            previous = id;
        }
        let mut decoder = EntityDecoder::new(&source);
        let processor = BooleanClippingProcessor::new();
        let result = run(&processor,&mut decoder,previous);
        if csg_hops {
            assert_cube(&result.expect("CSG's nested boolean depth restarts at zero"));
        } else {
            let error = result.unwrap_err();
            assert!(error.to_string().contains("Boolean nesting depth 11"),"{error}");
        }
        assert!(processor.take_failures().is_empty());
    }
}

#[test]
fn an_empty_union_records_its_first_loss_before_its_second_operand_errors() {
    let source = format!("{BLOCK}\
        #3=IFCPOLYLINE(());#4=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#3);\
        #5=IFCEXTRUDEDAREASOLID(#4,$,$,$);\
        #10=IFCBOOLEANRESULT(.UNION.,#5,#20);#20=IFCCSGSOLID(#30);\
        #30=IFCBOOLEANRESULT(.UNION.,#999,#1);");
    let mut decoder = EntityDecoder::new(&source);
    let processor = BooleanClippingProcessor::new();
    assert!(run(&processor,&mut decoder,10).is_err());
    let failures = processor.take_failures();
    assert_eq!(failures.len(),1);
    assert_eq!(failures[0].op,BoolOp::Union);
    assert_eq!(failures[0].reason,BoolFailureReason::EmptyOperand);
}
