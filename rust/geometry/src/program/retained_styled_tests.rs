// SPDX-License-Identifier: MPL-2.0
//! P1 styled/type-map regressions use real source and the canonical linear program.
use super::*;
use crate::{GeometryRouter, Result};
use ifc_lite_core::EntityDecoder;
use std::{collections::HashSet,sync::{Arc,Mutex}};

pub(super) const SOURCE:&str="#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);
#3=IFCDIRECTION((0.,0.,1.));#4=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,2.,4.);
#5=IFCEXTRUDEDAREASOLID(#4,#2,#3,3.);
#6=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#5));#7=IFCREPRESENTATIONMAP(#2,#6);
#8=IFCMAPPEDITEM(#7,$);#9=IFCMAPPEDITEM(#7,#15);
#10=IFCWALL('w',$,'Wall',$,$,$,#11,$,$);#11=IFCPRODUCTDEFINITIONSHAPE($,$,(#12));
#12=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#8,#9));
#14=IFCCARTESIANPOINT((10.,0.,0.));#15=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#14,1.,$);
#20=IFCREPRESENTATIONMAP(#2,#12);#21=IFCMAPPEDITEM(#20,$);";
const CONTRACT:RetainedContract=RetainedContract {source_epoch:3,source_revision:7};
pub(super) fn drive(program:&mut GeometryProgram,router:&GeometryRouter,decoder:&mut EntityDecoder<'_>)->Result<usize> {
    let mut count=0;let mut polls=0;
    while let Some(request)=program.request().expect("common request") {
        polls+=1;assert!(polls<30000,"bounded real fixture");
        let (reply,op)=program.admit_retained_with_inputs(request,router,decoder,None,None)
            .expect("same common admission");
        count+=op.len();program.accept(reply,router).expect("original reply");
    }
    Ok(count)
}
fn styled(source:&str,router:&GeometryRouter)->Result<(RetainedProductPlan,usize)> {
    let mut decoder=EntityDecoder::new(source);
    let mut program=GeometryProgram::retained_submeshes(decoder.decode_by_id(10)?,CONTRACT);
    let count=drive(&mut program,router,&mut decoder)?;program.finish_retained().map(|p|(p,count))
}
#[test]
fn p1_styled_nested_repeated_maps_preserve_occurrence_style_and_analytic_frames() {
    let source=SOURCE.replace("(#8,#9)","(#21,#21)").replace("#20=IFCREPRESENTATIONMAP(#2,#12)",
        "#20=IFCREPRESENTATIONMAP(#2,#22);#22=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#8,#9))");
    let (plan,count)=styled(&source,&GeometryRouter::new()).unwrap();
    assert_eq!(count,4,"uncached styled leaves are independent constructions");assert_eq!(plan.values.len(),4);
    assert_eq!(plan.values.iter().map(LogicalRetainedValue::slot).collect::<HashSet<_>>().len(),4);
    let xs:Vec<_>=plan.values.iter().map(|v|v.world_from_evaluation()[(0,3)]).collect();
    assert_eq!(xs[0],xs[2]);assert_eq!(xs[1],xs[3]);assert_eq!(xs[1]-xs[0],10.);
    for (index,value) in plan.values.iter().enumerate() {
        let style:Vec<_>=value.presentation().iter().map(|p|p.style_source_id).collect();
        assert_eq!(style,vec![5,if index%2==0 {8}else {9},21]);
        assert!(value.is_product_placed());
    }
    assert!(plan.remaining.contains(&RetainedRequirement::IfcAppearance));
}
#[test]
fn p1_styled_template_and_placeholder_share_definition_without_aliasing_occurrences() {
    for batch in [false,true] {
        let mut router=GeometryRouter::new();router.enable_output_instancing(Arc::new([(7,(2,8))].into_iter().collect()));
        router.set_instancing_batch_local(batch);
        let (plan,count)=styled(SOURCE,&router).unwrap();assert_eq!(count,1);
        assert_eq!(plan.values.len(),2);assert_eq!(plan.values[0].definition(),plan.values[1].definition());
        assert_ne!(plan.values[0].slot(),plan.values[1].slot());
        let a=plan.values[0].presentation().last().unwrap();let b=plan.values[1].presentation().last().unwrap();
        assert_eq!((a.geometry_id,b.geometry_id),(5,5));assert!(a.template);assert!(b.placeholder);
        assert_eq!((a.style_source_id,b.style_source_id),(8,9));
        assert_eq!(plan.values[1].world_from_evaluation()[(0,3)]-plan.values[0].world_from_evaluation()[(0,3)],10.);
        assert_eq!(router.mapped_shared_unique_count(),0,"retained entries never populate mesh caches");
    }
}
#[test]
fn p1_styled_indexed_palette_excludes_placeholder_and_carries_pending_binding() {
    let mut router=GeometryRouter::new();router.enable_output_instancing(Arc::new([(7,(2,8))].into_iter().collect()));
    router.enable_indexed_colour_split_guard(Arc::new([5].into_iter().collect()));
    let (plan,count)=styled(SOURCE,&router).unwrap();assert_eq!(count,2);
    assert!(plan.values.iter().all(|value|value.presentation()[0].indexed_palette_pending));
    assert!(plan.values.iter().flat_map(|v|v.presentation()).all(|p|!p.placeholder));
}
#[test]
fn p1_type_map_uses_ordered_styled_children_and_late_origin_without_product_placement() {
    let mut decoder=EntityDecoder::new(SOURCE);let router=GeometryRouter::new();
    let mut program=GeometryProgram::retained_type_map_id(20,CONTRACT);
    assert_eq!(drive(&mut program,&router,&mut decoder).unwrap(),2);
    let plan=program.finish_retained_type_map(100,2,[0.2,0.3,0.4,1.]).unwrap();
    assert_eq!(plan.values.len(),2);
    for value in &plan.values {
        assert!(!value.is_product_placed());
        assert!(matches!(value.placements().last().unwrap().stage,RetainedPlacementStage::TypeMap {representation_map:20}));
        let binding=value.presentation().last().unwrap();assert_eq!(binding.type_product,Some((100,2)));
        assert_eq!(binding.fallback_color,Some([0.2,0.3,0.4,1.]));
    }
    assert_eq!(plan.values[1].world_from_evaluation()[(0,3)]-plan.values[0].world_from_evaluation()[(0,3)],10.);
}
#[test]
fn p1_styled_cache_rejects_changed_decoder_configuration_and_contract() {
    let cache=Arc::new(Mutex::new(super::mapping::RetainedCache::default()));
    let router=GeometryRouter::new();let mut decoder=EntityDecoder::new(SOURCE);
    let item=decoder.decode_by_id(8).unwrap();
    let mut first=GeometryProgram::retained_styled(&item,false,CONTRACT,&router,cache.clone()).unwrap();
    drive(&mut first,&router,&mut decoder).unwrap();assert!(first.take_geometry_output().is_ok());
    let mut other=EntityDecoder::new(SOURCE);
    let mut stale=GeometryProgram::retained_styled(&item,false,CONTRACT,&router,cache.clone()).unwrap();
    drive(&mut stale,&router,&mut other).unwrap();assert!(stale.take_geometry_output().is_err());
    let mut stale=GeometryProgram::retained_styled(&item,false,RetainedContract {source_revision:8,..CONTRACT},&router,cache).unwrap();
    drive(&mut stale,&router,&mut decoder).unwrap();assert!(stale.take_geometry_output().is_err());
}
#[test]
fn p1_styled_retained_refusal_never_becomes_successful_empty_or_exact_fallback() {
    for source in [SOURCE.replace("#9=IFCMAPPEDITEM(#7,#15)","#9=IFCMAPPEDITEM(#7,#999)"),
        SOURCE.replace("(#5)","(#999)"), SOURCE.replace("(#5)","(#99)")+"#99=IFCBLOCK(#2,1.,2.,3.);"] {
        assert!(styled(&source,&GeometryRouter::new()).is_err());
    }
    let empty=SOURCE.replace("(#5)","()").replace("#9=IFCMAPPEDITEM(#7,#15)","#9=IFCMAPPEDITEM(#7,$)");
    let (plan,count)=styled(&empty,&GeometryRouter::new()).unwrap();assert_eq!(count,0);assert!(plan.values.is_empty());
}
#[test]
fn p1_styled_resource_stop_before_source_admission_is_typed_and_sticky() {
    use crate::resource::{ExecutionAccount,ExecutionPolicy,ResourceLimits};
    let account=ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits {occurrences:Some(0),..Default::default()}));
    let result=account.scope(||styled(SOURCE,&GeometryRouter::new()));
    assert!(matches!(result,Err(crate::Error::ProgramStopped(_))));assert!(account.check().is_err());
}

#[test]
fn p1_exact_styled_textured_repeated_maps_have_real_uv_pixels_and_exclude_placeholders() {
    let source=include_str!("../../tests/fixtures/p1-styled-textured-maps.ifc");
    let mut decoder=EntityDecoder::new(source);let textures=crate::build_texture_index(source.as_bytes(),&mut decoder);
    assert_eq!(textures.len(),1);
    let crate::processors::texture::TextureSource::Decoded(pixels)=&textures[&5].texture else {panic!("embedded pixel witness")};
    assert_eq!(pixels.rgba.as_slice(),&[255,0,0,255]);
    let mut router=GeometryRouter::new();router.enable_output_instancing(Arc::new([(7,(2,8))].into_iter().collect()));
    let mut program=GeometryProgram::submeshes(decoder.decode_by_id(10).unwrap());
    while let Some(request)=program.request().unwrap() {
        let reply=program.execute_with_textures(request,&router,&mut decoder,Some(&textures)).unwrap();
        program.accept(reply,&router).unwrap();
    }
    let meshes=program.finish_submeshes().unwrap();assert_eq!(meshes.len(),2);
    for sub in &meshes.sub_meshes {
        assert_eq!(sub.geometry_id,5);assert_eq!(sub.mesh.indices.len(),6);
        assert_eq!(sub.uvs.as_ref().unwrap().len(),sub.mesh.vertex_count()*2);
        assert!(sub.uvs.as_ref().unwrap().iter().any(|v|*v==1.));
        assert_eq!(sub.texture.as_ref().unwrap().texture_id,41);
        assert!(!sub.mesh.positions.is_empty(),"textured source cannot emit an instance-only placeholder");
    }
    // A retained face-set constructor is still an explicit family obligation;
    // positive exact UV pixels must not authenticate a retained construction.
    let mut retained=GeometryProgram::retained_submeshes(decoder.decode_by_id(10).unwrap(),CONTRACT);
    while let Some(request)=retained.request().unwrap() {
        let (reply,_)=retained.admit_retained_with_inputs(request,&router,&mut decoder,Some(&textures),None).unwrap();
        retained.accept(reply,&router).unwrap();
    }
    assert!(retained.finish_retained().is_err());
}

#[test]
fn p1_styled_placeholder_before_template_publishes_source_local_definition_at_reached_recovery() {
    let source=SOURCE.replace("(#8,#9)","(#9)");
    let mut router=GeometryRouter::new();router.enable_output_instancing(Arc::new([(7,(2,8))].into_iter().collect()));
    let (plan,count)=styled(&source,&router).unwrap();assert_eq!(count,1);
    assert_eq!(plan.values.len(),1);assert!(plan.values[0].presentation().last().unwrap().placeholder);
    assert_eq!(plan.values[0].presentation()[0].geometry_id,5);
    assert_eq!(plan.values[0].placements().iter().filter(|p|matches!(p.stage,RetainedPlacementStage::Mapping {source_id:7})).count(),1);
}
#[test]
fn p1_retained_type_map_origin_null_wrong_class_and_invalid_are_late() {
    for (origin,ok) in [("$",true),("#5",true),("#999",false)] {
        let source=SOURCE.replace("#20=IFCREPRESENTATIONMAP(#2,#12)",&format!("#20=IFCREPRESENTATIONMAP({origin},#12)"));
        let mut decoder=EntityDecoder::new(&source);let router=GeometryRouter::new();
        let mut program=GeometryProgram::retained_type_map_id(20,CONTRACT);
        assert_eq!(drive(&mut program,&router,&mut decoder).unwrap(),2,"late origin cannot skip ordered constructors");
        assert_eq!(program.finish_retained_type_map(100,1,[0.;4]).is_ok(),ok);
    }
    let source=SOURCE.replace("#20=IFCREPRESENTATIONMAP(#2,#12)","#20=IFCREPRESENTATIONMAP(#999,#12)").replace("(#8,#9)","(#8,#998)");
    let mut decoder=EntityDecoder::new(&source);let router=GeometryRouter::new();
    let mut program=GeometryProgram::retained_type_map_id(20,CONTRACT);
    assert_eq!(drive(&mut program,&router,&mut decoder).unwrap(),0,"whole Items precede every constructor and origin");
    assert!(program.finish_retained_type_map(100,1,[0.;4]).is_err());
}

#[test]
fn p1_styled_diamond_preserves_256_ordered_edges_and_stops_under_work_budget() {
    let mut source=SOURCE.to_string();let mut item=8;
    for level in 0..8 {
        let map=1000+level*3;
        source.push_str(&format!("#{map}=IFCREPRESENTATIONMAP(#2,#{rep});#{rep}=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#{item},#{item}));#{next}=IFCMAPPEDITEM(#{map},$);",rep=map+1,next=map+2));
        item=map+2;
    }
    source=source.replace("(#8,#9)",&format!("(#{item})"));
    let (plan,count)=styled(&source,&GeometryRouter::new()).unwrap();assert_eq!(count,256);assert_eq!(plan.values.len(),256);
    assert_eq!(plan.values.iter().map(LogicalRetainedValue::slot).collect::<HashSet<_>>().len(),256);
    assert!(plan.values.iter().all(|v|v.presentation().len()==10));
    use crate::resource::{ExecutionAccount,ExecutionPolicy,ResourceLimits};
    let account=ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits {work:Some(200),..Default::default()}));
    assert!(matches!(account.scope(||styled(&source,&GeometryRouter::new())),Err(crate::Error::ProgramStopped(_))));
}

#[test]
fn p1_cancelled_first_claim_rolls_back_before_next_actual_template_execution() {
    let mut decoder=EntityDecoder::new(SOURCE);let mut router=GeometryRouter::new();
    router.enable_output_instancing(Arc::new([(7,(2,8))].into_iter().collect()));router.set_instancing_batch_local(true);
    let cache=Arc::new(Mutex::new(super::mapping::RetainedCache::default()));
    let item=decoder.decode_by_id(8).unwrap();
    let mut cancelled=GeometryProgram::retained_styled(&item,true,CONTRACT,&router,cache.clone()).unwrap();
    let mut reached=false;
    while let Some(request)=cancelled.request().unwrap() {
        let (reply,operation)=cancelled.admit_retained_with_inputs(request,&router,&mut decoder,None,None).unwrap();
        if !operation.is_empty() {drop(reply);reached=true;break;}
        cancelled.accept(reply,&router).unwrap();
    }
    assert!(reached);cancelled.cancel_with_reports(&router).unwrap();drop(cancelled);
    let mut retry=GeometryProgram::retained_styled(&item,true,CONTRACT,&router,cache).unwrap();
    assert_eq!(drive(&mut retry,&router,&mut decoder).unwrap(),1);
    let super::inner::GeometryOutput::Retained(values)=retry.take_geometry_output().unwrap() else {panic!("retained styled output")};
    assert_eq!(values.len(),1);let binding=values[0].presentation().last().unwrap();
    assert!(binding.template);assert!(!binding.placeholder,"abandoned first claim cannot force recovery/placeholder output");
}
#[test]
fn p1_later_styled_refusal_preserves_an_independent_completed_template_entry() {
    let source=format!("{SOURCE}#30=IFCMAPPEDITEM(#7,#999);");
    let mut decoder=EntityDecoder::new(&source);let mut router=GeometryRouter::new();
    router.enable_output_instancing(Arc::new([(7,(2,8))].into_iter().collect()));
    let cache=Arc::new(Mutex::new(super::mapping::RetainedCache::default()));
    let mut first=GeometryProgram::retained_styled(&decoder.decode_by_id(8).unwrap(),true,CONTRACT,&router,cache.clone()).unwrap();
    assert_eq!(drive(&mut first,&router,&mut decoder).unwrap(),1);
    let super::inner::GeometryOutput::Retained(first)=first.take_geometry_output().unwrap() else {panic!("retained source template")};
    let mut bad=GeometryProgram::retained_styled(&decoder.decode_by_id(30).unwrap(),true,CONTRACT,&router,cache.clone()).unwrap();
    assert_eq!(drive(&mut bad,&router,&mut decoder).unwrap(),0);assert!(bad.take_geometry_output().is_err());
    let mut cached=GeometryProgram::retained_styled(&decoder.decode_by_id(9).unwrap(),true,CONTRACT,&router,cache).unwrap();
    assert_eq!(drive(&mut cached,&router,&mut decoder).unwrap(),0,"completed definition survives a later independent transform refusal");
    let super::inner::GeometryOutput::Retained(cached)=cached.take_geometry_output().unwrap() else {panic!("retained cached source")};
    assert_eq!(cached.len(),1);assert_eq!(cached[0].definition(),first[0].definition());
    assert_ne!(cached[0].slot(),first[0].slot());assert!(cached[0].presentation().last().unwrap().placeholder);
}

#[test]
fn p2_styled_affine_occurrences_bake_independently_from_the_original_cached_template() {
    let source=SOURCE.replace("#8=IFCMAPPEDITEM(#7,$)","#8=IFCMAPPEDITEM(#7,#15)")
        .replace("#14,1.,$","#14,2.,$")
        .replace("#9=IFCMAPPEDITEM(#7,#15)","#9=IFCMAPPEDITEM(#7,#18)")
        +"#17=IFCCARTESIANPOINT((20.,0.,0.));#18=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#17,3.,$);";
    let mut router=GeometryRouter::new();
    router.enable_output_instancing(Arc::new([(7,(2,8))].into_iter().collect()));
    let mut decoder=EntityDecoder::new(&source);
    let mut program=GeometryProgram::retained_submeshes(decoder.decode_by_id(10).unwrap(),CONTRACT);
    let mut operations=Vec::new();
    while let Some(request)=program.request().unwrap() {
        let (reply,batch)=program.admit_retained_with_inputs(request,&router,&mut decoder,None,None).unwrap();
        operations.extend(batch);program.accept(reply,&router).unwrap();
    }
    let plan=program.finish_retained().unwrap();
    assert_eq!(operations.len(),3,"one source, two distinct physical occurrences");
    assert!(matches!(operations[0].kind(),RetainedOperationKind::Construction(_)));
    assert_eq!(plan.values.len(),2);
    for (index,(scale,x)) in [(2.,10.),(3.,20.)].into_iter().enumerate() {
        let RetainedOperationKind::Affine {input,matrix}=operations[index+1].kind() else {panic!("missing physical bake")};
        assert_eq!(input.definition(),operations[0].value().definition(),"cache retains the original source definition");
        let frame=nalgebra::Matrix4::from_column_slice(matrix);
        assert_eq!(frame.fixed_view::<3,3>(0,0).determinant(),scale*scale*scale);
        assert_eq!(frame[(0,3)],x);
        assert_eq!(operations[index+1].value().definition(),plan.values[index].definition());
        assert_eq!(plan.values[index].world_from_evaluation(),nalgebra::Matrix4::identity());
        let binding=plan.values[index].presentation().last().unwrap();
        assert_eq!(binding.style_source_id,8+index as u32);
        assert_eq!(binding.placeholder,index==1);
    }
    assert_ne!(plan.values[0].slot(),plan.values[1].slot());
    assert!(plan.remaining.contains(&RetainedRequirement::IfcAppearance));
    // Logical operation/appearance proof only; no SDK numerical result is supplied.
}

#[test]
fn p2_styled_and_type_map_roots_share_bounds_across_a_mapped_boolean_cycle() {
    let source=SOURCE.replace("'SweptSolid',(#5)","'CSG',(#30)")
        +"#30=IFCBOOLEANRESULT(.UNION.,#8,#5);";
    for type_map in [false,true] {
        let mut decoder=EntityDecoder::new(&source);let router=GeometryRouter::new();
        let mut program=if type_map {GeometryProgram::retained_type_map_id(20,CONTRACT)}
            else {GeometryProgram::retained_submeshes(decoder.decode_by_id(10).unwrap(),CONTRACT)};
        let mut stopped=false;
        for _ in 0..1000 {
            let request=match program.request() {
                Err(ProgramError::TraversalStopped(_))=>{stopped=true;break},
                Ok(Some(request))=>request,Ok(None)=>break,other=>panic!("unexpected request {other:?}"),
            };
            match program.admit_retained_with_inputs(request,&router,&mut decoder,None,None) {
                Err(ProgramError::TraversalStopped(_))=>{stopped=true;break},
                Ok((reply,_))=>program.accept(reply,&router).unwrap(),
                Err(error)=>panic!("unexpected admission {error:?}"),
            }
        }
        assert!(stopped,"mixed controller cycle must report its shared bound");
        if type_map {assert!(program.finish_retained_type_map(100,1,[1.;4]).is_err())}
        else {assert!(program.finish_retained().is_err())}
    }
}

#[test]
fn p2_mapped_affine_admission_preserves_reflections_and_refuses_singular_before_source_work() {
    // The same canonical paths must reach physical reflection work, while a
    // singular target must fail before even looking up its malformed source.
    for styled in [false,true] {
        for singular in [false,true] {
            let scale=if singular {"0."} else {"-1."};
            let mut source=SOURCE.replace("(#8,#9)","(#8)")
                .replace("#8=IFCMAPPEDITEM(#7,$)","#8=IFCMAPPEDITEM(#7,#15)")
                .replace("#14,1.,$",&format!("#14,{scale},$"));
            if singular {source=source.replace("'SweptSolid',(#5)","'SweptSolid',(#999)");}
            let mut decoder=EntityDecoder::new(&source);let router=GeometryRouter::new();
            let element=decoder.decode_by_id(10).unwrap();
            let mut program=if styled {GeometryProgram::retained_submeshes(element,CONTRACT)}
                else {GeometryProgram::retained_parts(element,CONTRACT)};
            let mut constructions=0;let mut reflections=0;let mut polls=0;
            while let Some(request)=program.request().unwrap() {
                polls+=1;assert!(polls<1000,"bounded actual source fixture");
                let (reply,operations)=program.admit_retained_with_inputs(request,&router,&mut decoder,None,None).unwrap();
                for operation in operations {
                    match operation.kind() {
                        RetainedOperationKind::Construction(_)=>constructions+=1,
                        RetainedOperationKind::Affine {matrix,..}=> {
                            assert!(!singular);
                            let matrix=nalgebra::Matrix4::from_column_slice(matrix);
                            assert_eq!(matrix.fixed_view::<3,3>(0,0).determinant(),-1.);
                            assert_eq!(matrix[(0,3)],10.);reflections+=1;
                        }
                        _=>panic!("mapping fixture contains no Boolean"),
                    }
                }
                program.accept(reply,&router).unwrap();
            }
            let result=program.finish_retained();
            if singular {
                let error=result.unwrap_err().to_string();
                assert!(error.contains("nonsingular affine"),"must refuse the target before missing source #999: {error}");
                assert_eq!((constructions,reflections),(0,0));
            } else {
                assert_eq!(result.unwrap().values.len(),1);
                assert_eq!((constructions,reflections),(1,1));
            }
        }
    }
}
