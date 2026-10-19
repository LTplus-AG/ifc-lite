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
        if let Err(rejected)=program.accept(reply,&router) {
            match rejected.error {
                ProgramError::TraversalStopped(stop)=>return stopped(program,stop),
                error=>panic!("unexpected original reply rejection: {error:?}"),
            }
        }
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
    // The lowest source contains (#5,#5), two reached uncached leaves. Its
    // completed map is then reused, preserving both definitions eight times.
    let definitions=plan.values.iter().map(LogicalRetainedValue::definition).collect::<HashSet<_>>();
    assert_eq!(definitions.len(),2);
    for definition in definitions {
        assert_eq!(plan.values.iter().filter(|value|value.definition()==definition).count(),8);
    }
    let input=source(30,"#20=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#5));
        #21=IFCREPRESENTATIONMAP(#2,#20);#22=IFCMAPPEDITEM(#21,$);
        #30=IFCBOOLEANRESULT(.UNION.,#22,#22);");
    assert_eq!(run(&input,None).unwrap().values.len(),1,
        "a repeated operand is another valid path occurrence, not a cycle");
}

#[test]
fn retained_plain_styled_leaf_enters_ancestry_once_and_mapped_cycles_still_stop() {
    let input=source(5,"");
    let mut decoder=EntityDecoder::new(&input);let router=GeometryRouter::new();
    let contract=RetainedContract {source_epoch:7,source_revision:11};
    let mut program=GeometryProgram::retained_submeshes(decoder.decode_by_id(10).unwrap(),contract);
    let mut constructions=0;
    while let Some(request)=program.request().unwrap() {
        let (reply,operations)=program.admit_retained_with_inputs(request,&router,&mut decoder,None,None).unwrap();
        for operation in &operations {
            let construction=operation.construction().expect("plain extrusion source");
            assert_eq!(construction.solid_id(),5);
            let extrusion=construction.extrusion().expect("owned authored extrusion");
            assert_eq!(extrusion.source.depth,Some(3.));
            assert_eq!(extrusion.length_unit_scale,1.);
        }
        constructions+=operations.len();program.accept(reply,&router).unwrap();
    }
    let plan=program.finish_retained().unwrap();
    assert_eq!(constructions,1);assert_eq!(plan.values.len(),1);
    assert!(plan.values[0].is_product_placed());assert!(!plan.values[0].presentation().is_empty());
    assert!(super::retained_walk::current().is_none());
    let cache=std::sync::Arc::new(std::sync::Mutex::new(super::mapping::RetainedCache::default()));
    let mut standalone=GeometryProgram::retained_styled(&decoder.decode_by_id(5).unwrap(),false,contract,&router,cache).unwrap();
    let mut standalone_constructions=0;
    while let Some(request)=standalone.request().unwrap() {
        let (reply,operations)=standalone.admit_retained_with_inputs(request,&router,&mut decoder,None,None).unwrap();
        standalone_constructions+=operations.len();standalone.accept(reply,&router).unwrap();
    }
    let super::inner::GeometryOutput::Retained(values)=standalone.take_geometry_output().unwrap() else {panic!("logical leaf")};
    assert_eq!(standalone_constructions,1);assert_eq!(values.len(),1);
    assert!(!values[0].is_product_placed(),"a standalone styled wrapper cannot invent product placement");
    let cycle=source(22,"#20=IFCSHAPEREPRESENTATION($,'Body','CSG',(#30));
        #21=IFCREPRESENTATIONMAP(#2,#20);#22=IFCMAPPEDITEM(#21,$);
        #30=IFCBOOLEANRESULT(.UNION.,#5,#22);");
    bound(run(&cycle,None).unwrap_err(),Dimension::Representation);
}

#[test]
fn retained_iterative_boolean_spine_preserves_exact_accepted_42_operand_chain() {
    // Shared-walk preservation review: a legal FirstOperand spine is not 42
    // recursive mapped children. Check the actual exact producer as the
    // admission oracle; retained operation capture alone proves no arithmetic.
    let mut body=String::new();let mut child=5;
    for level in 0..42 {
        let id=1000+level;
        body.push_str(&format!("#{id}=IFCBOOLEANRESULT(.UNION.,#{child},#5);"));
        child=id;
    }
    let input=source(child,&body);
    let router=GeometryRouter::new();
    let mut decoder=EntityDecoder::new(&input);
    let mut exact=GeometryProgram::parts(decoder.decode_by_id(10).unwrap());
    while let Some(request)=exact.request().unwrap() {
        let reply=exact.execute(request,&router,&mut decoder).unwrap();
        exact.accept(reply,&router).unwrap();
    }
    let parts=exact.finish_parts().unwrap();
    assert_eq!(parts.len(),1);
    assert!(crate::exact_topology::strict_closed_mesh(&parts[0]));
    assert_eq!(crate::mesh_check::signed_volume(&parts[0]).abs(),24.);

    let mut retained=GeometryProgram::retained_parts(decoder.decode_by_id(10).unwrap(),
        RetainedContract {source_epoch:7,source_revision:11});
    let mut prior=None;let mut boolean_count=0;
    while let Some(request)=retained.request().unwrap() {
        let (reply,operations)=retained.admit_retained_with_inputs(request,&router,&mut decoder,None,None).unwrap();
        for operation in operations {
            match operation.kind() {
                RetainedOperationKind::Construction(_)=>{},
                RetainedOperationKind::Boolean {inputs,operation:kind}=>{
                    assert_eq!(*kind,crate::document::BooleanOperation::Union);
                    if let Some(slot)=prior {assert_eq!(inputs[0].slot(),slot);}
                    prior=Some(operation.value().slot());boolean_count+=1;
                }
                other=>panic!("plain Boolean spine produced {other:?}"),
            }
        }
        retained.accept(reply,&router).unwrap();
    }
    let plan=retained.finish_retained().unwrap();
    assert_eq!(boolean_count,42);
    assert_eq!(plan.values.len(),1);
    assert_eq!(plan.values[0].definition(),&LogicalRetainedDefinition::Operation(prior.unwrap()));
    assert!(!plan.remaining.is_empty(),"source admission cannot certify final geometry");
}
