// SPDX-License-Identifier: MPL-2.0
//! Real file-controlled mixed-controller graphs. Bounds are finite even with
//! Compatibility accounting; path membership never memoises accumulated output.
use super::*;
use crate::{Error,GeometryRouter};
use crate::resource::{Dimension,ProgramStop};
use ifc_lite_core::EntityDecoder;
use std::collections::HashSet;

const BASE:&str="#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);
#3=IFCDIRECTION((0.,0.,1.));#4=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,2.,4.);
#5=IFCEXTRUDEDAREASOLID(#4,#2,#3,3.);";
fn source(root:u32,body:&str)->String {
    format!("{BASE}#10=IFCWALL('mixed',$,$,$,$,$,#11,$,$);
        #11=IFCPRODUCTDEFINITIONSHAPE($,$,(#12));
        #12=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#{root}));{body}")
}
fn stopped(program:GeometryProgram,stop:ProgramStop)->crate::Result<RetainedProductPlan> {
    // Even a caller that tries to finish after a refused request cannot obtain
    // a partial success. The captured root first fault wins over local state.
    assert!(matches!(program.finish_retained(),Err(Error::ProgramStopped(actual)) if actual==stop));
    Err(Error::ProgramStopped(stop))
}
fn run(source:&str,work_limit:Option<u64>)->crate::Result<RetainedProductPlan> {
    let mut decoder=EntityDecoder::new(source);
    let router=GeometryRouter::new();
    let mut program=GeometryProgram::retained_parts(decoder.decode_by_id(10)?,
        RetainedContract {source_epoch:7,source_revision:11});
    if let Some(limit)=work_limit {program.retained_walk.as_ref().unwrap().set_test_work_limit(limit);}
    loop {
        let request=match program.request() {
            Ok(Some(request))=>request,Ok(None)=>break,
            Err(ProgramError::TraversalStopped(stop))=>return stopped(program,stop),
            Err(error)=>panic!("unexpected source protocol error: {error:?}"),
        };
        let (reply,_operations)=match program.admit_retained_with_inputs(request,&router,&mut decoder,None,None) {
            Ok(value)=>value,
            Err(ProgramError::TraversalStopped(stop))=>return stopped(program,stop),
            Err(error)=>panic!("unexpected retained admission error: {error:?}"),
        };
        program.accept(reply,&router).expect("original common reply");
    }
    program.finish_retained()
}
fn bound(error:Error,dimension:Dimension) {
    assert!(matches!(error,Error::ProgramStopped(ProgramStop::ResourceRefused(f)) if f.dimension==dimension),
        "mixed graph must report a typed {dimension:?} bound, not success or an unrelated refusal");
    assert!(super::retained_walk::current().is_none(),"lexical ancestry never leaks across a returned reply");
}

#[test]
fn p2_mixed_mapping_boolean_self_cycle_reports_shared_path_bound_in_compatibility() {
    let input=source(22,"#20=IFCSHAPEREPRESENTATION($,'Body','CSG',(#30));
        #21=IFCREPRESENTATIONMAP(#2,#20);#22=IFCMAPPEDITEM(#21,$);
        #30=IFCBOOLEANRESULT(.UNION.,#5,#22);");
    bound(run(&input,None).unwrap_err(),Dimension::Representation);
    assert_eq!(run(&source(5,""),None).unwrap().values.len(),1,
        "a stopped root cannot poison another root on the same thread");
}

#[test]
fn p2_mixed_mapping_boolean_mutual_cycle_reports_shared_path_bound() {
    let input=source(22,"#20=IFCSHAPEREPRESENTATION($,'Body','CSG',(#30));
        #21=IFCREPRESENTATIONMAP(#2,#20);#22=IFCMAPPEDITEM(#21,$);
        #30=IFCBOOLEANRESULT(.UNION.,#5,#42);
        #40=IFCSHAPEREPRESENTATION($,'Body','CSG',(#50));
        #41=IFCREPRESENTATIONMAP(#2,#40);#42=IFCMAPPEDITEM(#41,$);
        #50=IFCBOOLEANRESULT(.UNION.,#5,#22);");
    bound(run(&input,None).unwrap_err(),Dimension::Representation);
}

#[test]
fn p2_long_acyclic_alternating_chain_stops_before_recursive_child_stack_growth() {
    let mut body=String::new();let mut child=5;
    for level in 0..(ifc_lite_core::MAX_MAPPED_ITEM_DEPTH+4) {
        let boolean=1000+level*4;
        body.push_str(&format!("#{boolean}=IFCBOOLEANRESULT(.UNION.,#{child},#5);
            #{rep}=IFCSHAPEREPRESENTATION($,'Body','CSG',(#{boolean}));
            #{map}=IFCREPRESENTATIONMAP(#2,#{rep});#{mapped}=IFCMAPPEDITEM(#{map},$);",
            rep=boolean+1,map=boolean+2,mapped=boolean+3));
        child=boolean+3;
    }
    bound(run(&source(child,&body),None).unwrap_err(),Dimension::Representation);
}
fn diamond(levels:u32)->String {
    let mut body=String::new();let mut child=5;
    for level in 0..levels {
        let rep=1000+level*3;
        body.push_str(&format!("#{rep}=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#{child},#{child}));
            #{map}=IFCREPRESENTATIONMAP(#2,#{rep});#{mapped}=IFCMAPPEDITEM(#{map},$);",map=rep+1,mapped=rep+2));
        child=rep+2;
    }
    source(child,&body)
}
#[test]
fn p2_accumulating_dag_fanout_has_a_shared_work_budget_in_compatibility() {
    // An explicit smaller root allowance makes the source-driven regression
    // small; production's finite bound is derived from the shared IFC limits.
    bound(run(&diamond(10),Some(512)).unwrap_err(),Dimension::Work);
}
#[test]
fn p2_shared_guards_preserve_every_real_diamond_and_repeated_boolean_occurrence() {
    let plan=run(&diamond(4),None).unwrap();
    assert_eq!(plan.values.len(),16);
    assert_eq!(plan.values.iter().map(LogicalRetainedValue::slot).collect::<HashSet<_>>().len(),16);
    assert_eq!(plan.values.iter().map(LogicalRetainedValue::definition).collect::<HashSet<_>>().len(),1);
    let input=source(30,"#20=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#5));
        #21=IFCREPRESENTATIONMAP(#2,#20);#22=IFCMAPPEDITEM(#21,$);
        #30=IFCBOOLEANRESULT(.UNION.,#22,#22);");
    assert_eq!(run(&input,None).unwrap().values.len(),1,
        "a repeated operand is another valid path occurrence, not a cycle");
}
