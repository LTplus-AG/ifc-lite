// SPDX-License-Identifier: MPL-2.0
//! P1 behavioral fixtures through the same product, mapping and placement program.
//! Logical/source witnesses only: no runtime or final-product qualification.
use super::*;
use crate::{GeometryRouter, Result};
use ifc_lite_core::EntityDecoder;
use nalgebra::Vector4;
use std::collections::HashSet;

const NESTED_MM: &str = "#1=IFCCARTESIANPOINT((0.,0.,0.));
#2=IFCAXIS2PLACEMENT3D(#1,$,$);#3=IFCDIRECTION((0.,0.,1.));
#4=IFCDIRECTION((0.,1.,0.));#5=IFCDIRECTION((-1.,0.,0.));
#6=IFCDIRECTION((0.,-1.,0.));#7=IFCDIRECTION((1.,0.,0.));
#10=IFCWALL('w',$,'Wall',$,$,#80,#11,$,$);
#11=IFCPRODUCTDEFINITIONSHAPE($,$,(#12));
#12=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#60));
#13=IFCEXTRUDEDAREASOLID(#14,#17,#3,3000.);
#14=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,2000.,4000.);
#16=IFCCARTESIANPOINT((100.,200.,300.));#17=IFCAXIS2PLACEMENT3D(#16,#3,#4);
#20=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#13));
#21=IFCCARTESIANPOINT((1000001.,2000.,0.));#22=IFCAXIS2PLACEMENT3D(#21,$,$);
#23=IFCREPRESENTATIONMAP(#22,#20);
#24=IFCCARTESIANPOINT((10000.,20000.,0.));
#25=IFCCARTESIANTRANSFORMATIONOPERATOR3D(#4,#5,#24,1.,#3);
#30=IFCMAPPEDITEM(#23,#25);
#40=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#30));
#41=IFCCARTESIANPOINT((-3000.,4000.,0.));#42=IFCAXIS2PLACEMENT3D(#41,$,$);
#43=IFCREPRESENTATIONMAP(#42,#40);
#44=IFCCARTESIANPOINT((-5000.,6000.,0.));
#45=IFCCARTESIANTRANSFORMATIONOPERATOR3D(#6,#7,#44,1.,#3);
#60=IFCMAPPEDITEM(#43,#45);
#80=IFCLOCALPLACEMENT($,#81);#81=IFCAXIS2PLACEMENT3D(#82,$,$);
#82=IFCCARTESIANPOINT((5000000000.,7000.,11000.));";

fn drain(source: &str, router: &GeometryRouter) -> Result<(RetainedProductPlan, usize)> {
    let mut decoder=EntityDecoder::new(source);
    let mut program=GeometryProgram::retained_parts(decoder.decode_by_id(10)?,
        RetainedContract {source_epoch:7,source_revision:11});
    let mut constructions=0;
    while let Some(request)=program.request().expect("common request") {
        let (reply,operation)=program.admit_retained_with_inputs(request,router,&mut decoder,None,None)
            .expect("common admission");
        constructions+=usize::from(operation.is_some());
        program.accept(reply,router).expect("original reply");
    }
    program.finish_retained().map(|plan|(plan,constructions))
}

#[test]
fn p1_nested_mm_source_position_origins_targets_and_late_product_world_corners() {
    let mut router=GeometryRouter::with_scale(0.001);
    router.set_rtc_offset((5_000_000.,0.,0.));
    let (plan,constructions)=drain(NESTED_MM,&router).unwrap();
    assert_eq!(constructions,1);
    assert_eq!(plan.values.len(),1);
    assert!(!plan.remaining.contains(&RetainedRequirement::ProductPlacement));
    assert!(plan.remaining.contains(&RetainedRequirement::OpeningClosure));
    let value=&plan.values[0];
    assert_eq!(value.placements().len(),3);
    assert!(matches!(value.placements()[0].stage,RetainedPlacementStage::Mapping {source_id:23}));
    assert!(matches!(value.placements()[1].stage,RetainedPlacementStage::Mapping {source_id:43}));
    assert!(matches!(value.placements()[2].stage,RetainedPlacementStage::Product {product_id:10}));
    let frame=value.world_from_evaluation();
    // Independent authored corners. Units scale geometry once, each mapping
    // translation once; survey position stays in f64 and does not absorb RTC.
    for x in [0.,2.] { for y in [0.,4.] { for z in [0.,3.] {
        let corner=frame*Vector4::new(x,y,z,1.);
        let expected=[5_001_021.101-y,7.2+x,11.3+z];
        for axis in 0..3 {assert!((corner[axis]-expected[axis]).abs()<1e-8,"{corner:?} != {expected:?}");}
    }}}
    assert!((frame.fixed_view::<3,3>(0,0).determinant().abs()*24.-24.).abs()<1e-10);
    let inverse=frame.try_inverse().unwrap();
    let recovered=inverse*Vector4::new(5_001_017.101,9.2,14.3,1.);
    assert!((recovered-Vector4::new(2.,4.,3.,1.)).norm()<1e-8);
}

#[test]
fn p1_diamond_preserves_256_occurrences_but_only_reached_cache_definitions_share() {
    let mut source=NESTED_MM.replace("(#60)","(#1002)");
    let mut child=60;
    for level in 0..8 {
        let map=1000+level*3;
        source.push_str(&format!("#{map}=IFCREPRESENTATIONMAP(#2,#{rep});
            #{rep}=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#{child},#{child}));
            #{item}=IFCMAPPEDITEM(#{map},$);",rep=map+1,item=map+2));
        child=map+2;
    }
    source=source.replace("(#1002)",&format!("(#{child})"));
    let router=GeometryRouter::with_scale(0.001);
    let (plan,constructions)=drain(&source,&router).unwrap();
    assert_eq!(constructions,1,"sharing begins only at reached map publication");
    assert_eq!(plan.values.len(),256,"DAG multiplicity survives caching");
    assert_eq!(plan.values.iter().map(LogicalRetainedValue::slot).collect::<HashSet<_>>().len(),256);
    assert_eq!(plan.values.iter().map(LogicalRetainedValue::definition).collect::<HashSet<_>>().len(),1);
    let expected=plan.values[0].world_from_evaluation();
    assert!(plan.values.iter().all(|v|v.world_from_evaluation()==expected));
    let uncached=NESTED_MM.replace("'SweptSolid',(#13)","'SweptSolid',(#13,#13)");
    let (plan,constructions)=drain(&uncached,&router).unwrap();
    assert_eq!(constructions,2,"STEP id alone cannot memoize an accumulating leaf");
    assert_ne!(plan.values[0].definition(),plan.values[1].definition());
}

#[test]
fn p1_nonrigid_refusal_is_explicit_and_is_not_a_coverage_witness() {
    let router=GeometryRouter::with_scale(0.001);
    for scale in ["2.","-1.","0."] {
        let source=NESTED_MM.replace("#24,1.,#3",&format!("#24,{scale},#3"));
        let result=drain(&source,&router);
        assert!(result.is_err(),"unqualified mapping cannot publish logical final output");
    }
}

#[test]
fn p1_retained_empty_items_still_reach_late_placement_fault() {
    let source=NESTED_MM.replace("(#60)","()").replace("$,#80,#11","$,#999,#11");
    let result=drain(&source,&GeometryRouter::new());
    assert!(result.unwrap_err().to_string().contains("999"));
}

#[test]
fn p1_exact_warm_mesh_cache_cannot_authenticate_retained_source() {
    let source=format!("{}#90=IFCREPRESENTATIONMAP(#2,#999);#91=IFCMAPPEDITEM(#90,#25);",
        NESTED_MM.replace("(#60)","(#91)"));
    let router=GeometryRouter::with_scale(0.001);
    let mut decoder=EntityDecoder::new(&source);
    let item=decoder.decode_by_id(30).unwrap();
    let mesh=router.process_mapped_item_parts(&item,&mut decoder).unwrap().remove(0);
    router.publish_mapped_source(90,&mesh,false).unwrap();
    let item=decoder.decode_by_id(91).unwrap();
    assert!(!router.process_mapped_item_parts(&item,&mut decoder).unwrap().is_empty(),
        "ordinary warm contract skips malformed representation");
    let error=drain(&source,&router).unwrap_err();
    assert!(error.to_string().contains("999"),"retained is cold, not a mesh reinterpretation: {error}");
    // Exact publication has not been consumed or cleared by retained refusal.
    assert!(!router.process_mapped_item_parts(&item,&mut decoder).unwrap().is_empty());
}

#[test]
fn p1_retained_warm_cache_reuses_definition_but_not_later_target_fault() {
    use std::sync::{Arc,Mutex};
    use super::mapping::RetainedCache;
    for broken_target in [false,true] {
        let source=format!("{}#90=IFCMAPPEDITEM(#23,{});",NESTED_MM,
            if broken_target {"#999"} else {"#45"});
        let router=GeometryRouter::with_scale(0.001);
        let mut decoder=EntityDecoder::new(&source);
        let cache=Arc::new(Mutex::new(RetainedCache::default()));
        let contract=RetainedContract {source_epoch:7,source_revision:11};
        let mut values=Vec::new();
        let mut constructions=0;
        for id in [30,90] {
            let item=decoder.decode_by_id(id).unwrap();
            let mut program=GeometryProgram::retained_mapped(&item,contract,&router,cache.clone()).unwrap();
            while let Some(request)=program.request().unwrap() {
                let (reply,operation)=program.admit_retained_with_inputs(request,&router,&mut decoder,None,None).unwrap();
                constructions+=usize::from(operation.is_some());
                program.accept(reply,&router).unwrap();
            }
            let result=program.take_geometry_output();
            if id==90 && broken_target {
                assert!(result.err().unwrap().to_string().contains("999"));
            } else {
                let super::inner::GeometryOutput::Retained(output)=result.unwrap() else {panic!("retained contract")};
                values.extend(output);
            }
        }
        assert_eq!(constructions,1);
        if !broken_target {
            assert_eq!(values.len(),2);
            assert_eq!(values[0].definition(),values[1].definition());
            assert_ne!(values[0].slot(),values[1].slot());
            assert_ne!(values[0].world_from_evaluation(),values[1].world_from_evaluation());
        }
    }
}

#[test]
fn p1_retained_cache_rejects_changed_selected_source_cache_provenance() {
    use std::sync::{Arc,Mutex};
    let router=GeometryRouter::with_scale(0.001);
    let mut decoder=EntityDecoder::new(NESTED_MM);
    let cache=Arc::new(Mutex::new(super::mapping::RetainedCache::default()));
    let contract=RetainedContract {source_epoch:7,source_revision:11};
    let item=decoder.decode_by_id(30).unwrap();
    let mut first=GeometryProgram::retained_mapped(&item,contract,&router,cache.clone()).unwrap();
    while let Some(request)=first.request().unwrap() {
        let (reply,_)=first.admit_retained_with_inputs(request,&router,&mut decoder,None,None).unwrap();
        first.accept(reply,&router).unwrap();
    }
    assert!(matches!(first.take_geometry_output().unwrap(),super::inner::GeometryOutput::Retained(_)));
    let cached=decoder.decode_by_id(23).unwrap();
    decoder.inject_shared_cache(&[(23,Arc::new(cached))].into_iter().collect());
    let mut stale=GeometryProgram::retained_mapped(&item,contract,&router,cache).unwrap();
    while let Some(request)=stale.request().unwrap() {
        let (reply,operation)=stale.admit_retained_with_inputs(request,&router,&mut decoder,None,None).unwrap();
        assert!(operation.is_none(),"stale source cannot authenticate another construction");
        stale.accept(reply,&router).unwrap();
    }
    assert!(stale.take_geometry_output().err().unwrap().to_string().contains("provenance"));
}

#[test]
fn p1_cache_publication_resource_stop_keeps_earlier_source_local_definition() {
    use crate::resource::{ExecutionAccount,ExecutionPolicy,ResourceLimits,ProgramStop,Dimension};
    use std::sync::{Arc,Mutex};
    let router=GeometryRouter::with_scale(0.001);
    let mut decoder=EntityDecoder::new(NESTED_MM);
    let cache=Arc::new(Mutex::new(super::mapping::RetainedCache::default()));
    let item=decoder.decode_by_id(60).unwrap();
    let mut program=GeometryProgram::retained_mapped(&item,
        RetainedContract {source_epoch:7,source_revision:11},&router,cache.clone()).unwrap();
    let account=ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits {
        copy_bytes:Some(0),..Default::default()
    }));
    let mut constructions=0;
    while let Some(request)=program.request().unwrap() {
        let (reply,operation)=account.scope(||program.admit_retained_with_inputs(
            request,&router,&mut decoder,None,None)).unwrap();
        constructions+=usize::from(operation.is_some());
        account.scope(||program.accept(reply,&router)).unwrap();
    }
    assert_eq!(constructions,1);
    assert!(matches!(account.check(),Err(ProgramStop::ResourceRefused(f)) if f.dimension==Dimension::CopyBytes));
    assert!(program.take_geometry_output().is_err());
    let cache=cache.lock().unwrap();
    assert!(cache.get(23).unwrap().is_some(),"completed independent source publication survives later refusal");
    assert!(cache.get(43).unwrap().is_none(),"refused parent is never published");
}

#[test]
fn p1_empty_occurrence_manifest_is_valid_after_actual_late_placement_admission() {
    let source=NESTED_MM.replace("(#60)","()");
    let (plan,constructions)=drain(&source,&GeometryRouter::with_scale(0.001)).unwrap();
    assert_eq!(constructions,0);
    assert!(plan.values.is_empty());
    assert!(!plan.remaining.contains(&RetainedRequirement::ProductPlacement));
    assert!(plan.remaining.contains(&RetainedRequirement::OpeningClosure));
}

#[test]
fn p1_product_placement_fault_is_read_only_after_reached_construction_and_mapping() {
    let source=NESTED_MM.replace("$,#80,#11","$,#999,#11");
    let mut decoder=EntityDecoder::new(&source);
    let router=GeometryRouter::with_scale(0.001);
    let mut program=GeometryProgram::retained_parts(decoder.decode_by_id(10).unwrap(),
        RetainedContract {source_epoch:7,source_revision:11});
    let mut constructions=0;
    while let Some(request)=program.request().unwrap() {
        if constructions==0 {assert!(decoder.get_cached(999).is_none());}
        let (reply,operation)=program.admit_retained_with_inputs(request,&router,&mut decoder,None,None).unwrap();
        constructions+=usize::from(operation.is_some());
        program.accept(reply,&router).unwrap();
    }
    assert_eq!(constructions,1,"placement fault does not short-circuit reached source construction");
    assert!(program.finish_retained().unwrap_err().to_string().contains("999"));
}

#[test]
fn p1_rigidity_policy_bounds_gram_error_and_excludes_reflection() {
    use super::retained::proper_rigid;
    use crate::math::tol::RETAINED_RIGID_DOT_EPS;
    use nalgebra::{Matrix4,Rotation3};
    let rotation=Rotation3::from_euler_angles(0.31,-0.27,0.43).to_homogeneous();
    assert!(proper_rigid(&rotation).is_ok());
    let reflection=Matrix4::new_nonuniform_scaling(&nalgebra::Vector3::new(-1.,1.,1.));
    assert!(proper_rigid(&reflection).is_err(),"orthogonal Gram matrix does not certify proper orientation");
    let mut shear=Matrix4::identity();
    shear[(0,1)]=RETAINED_RIGID_DOT_EPS/2.;
    assert!(proper_rigid(&shear).is_ok(),"bounded floating point frame noise");
    shear[(0,1)]=RETAINED_RIGID_DOT_EPS*2.;
    assert!(proper_rigid(&shear).is_err(),"unit determinant alone cannot admit shear");
    let mut scale=Matrix4::identity();scale[(0,0)]+=RETAINED_RIGID_DOT_EPS;
    assert!(proper_rigid(&scale).is_err(),"Gram norm also detects non-unit axis length");
    let mut invalid=Matrix4::identity();invalid[(0,0)]=f64::NAN;
    assert!(proper_rigid(&invalid).is_err());
}
