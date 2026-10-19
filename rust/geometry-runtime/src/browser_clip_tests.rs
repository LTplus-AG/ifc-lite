// SPDX-License-Identifier: MPL-2.0
//! Actual module Worker witnesses. UNRUN; requires canonical staged /smlib assets.
use super::*;
use crate::browser::{BrowserDependency as Input,BrowserTransformInput,BrowserWorker};
use ifc_lite_core::{build_entity_index,EntityDecoder};
use ifc_lite_geometry::{analytic::extract_analytic_extrusion,document::{
    BooleanOperation,EvaluationContract,GeometryDocument,RetainedExtrusion,RetainedRequest}};
use wasm_bindgen_futures::JsFuture;
use wasm_bindgen_test::*;
use std::{future::Future,task::{Context,Poll,Waker}};
wasm_bindgen_test_configure!(run_in_browser);
const I:[f64;16]=[1.,0.,0.,0.,0.,1.,0.,0.,0.,0.,1.,0.,0.,0.,0.,1.];
fn request(w:&BrowserWorker,circle:bool) -> RetainedRequest {
    let profile=if circle {"IFCCIRCLEPROFILEDEF(.AREA.,$,#2,1.)"} else {"IFCRECTANGLEPROFILEDEF(.AREA.,$,#2,2.,2.)"};
    let input=format!("#1=IFCCARTESIANPOINT((0.,0.));#2=IFCAXIS2PLACEMENT2D(#1,$);#3={profile};#4=IFCDIRECTION((0.,0.,1.));#5=IFCEXTRUDEDAREASOLID(#3,$,#4,2.);");
    let mut d=EntityDecoder::with_index(input.as_bytes(),build_entity_index(input.as_bytes()));
    let entity=d.decode_by_id(5).unwrap();let mut document=GeometryDocument::new();
    let definition=document.add_retained_extrusion(RetainedExtrusion {source:extract_analytic_extrusion(&entity,&mut d),
        length_unit_scale:1.,source_epoch:1,source_revision:1}).unwrap();
    document.prepare_retained_extrusion(definition,EvaluationContract::RetainedBrep,w.incarnation()).unwrap()
}
fn volume(mesh:&RetainedTessellation) -> f64 {
    let p=|i:u32|{let i=i as usize*3;[mesh.positions[i],mesh.positions[i+1],mesh.positions[i+2]]};
    mesh.indices.chunks_exact(3).map(|t|{let [a,b,c]=[p(t[0]),p(t[1]),p(t[2])];
        (a[0]*(b[1]*c[2]-b[2]*c[1])+a[1]*(b[2]*c[0]-b[0]*c[2])+a[2]*(b[0]*c[1]-b[1]*c[0]))/6.
    }).sum::<f64>().abs()
}
#[wasm_bindgen_test(async)]
async fn actual_browser_plane_box_survey_rotation_chaining_and_release() {
    let mut w=BrowserWorker::new_retained_execution().unwrap();w.qualify().await.unwrap();
    let r=request(&w,false);let s=w.evaluate(r.clone(),0.001,5.,1_048_576).await.unwrap();
    let frame=[0.,1.,0.,0.,-1.,0.,0.,0.,0.,0.,1.,0.,3e8,4e8,5e8,1.];
    let plane=[0.,0.,1.,0.,0.,2.];
    let c=w.clip_retained_plane(Input::Source {realization:&s,world_from_source:frame},plane,
        PlaneSide::Positive,PlaneClipMode::Intersection,0.001,5.,1_048_576).await.unwrap();
    assert!((volume(c.mesh())-4.).abs()<0.01);assert!((volume(&s.completion().tessellation)-8.).abs()<0.01);
    assert_eq!(c.operation_identity().input,*s.handle());
    assert_eq!(*c.world_from_evaluation(),crate::retained_values::multiply(frame,s.completion().source_from_evaluation));
    let RetainedLineage::PlaneClip {input,..}=c.lineage() else {panic!("clip lineage")};
    let RetainedLineage::Source {request:original,..}=input.as_ref() else {panic!("source lineage")};
    assert!(original.same_admission(&r));
    let next=w.clip_retained_plane(Input::Clip(&c),[0.,0.,1.5,0.,0.,1.],PlaneSide::Positive,
        PlaneClipMode::Difference,0.001,5.,1_048_576).await.unwrap();
    assert!((volume(next.mesh())-2.).abs()<0.01);
    let replacement=[1.,0.,0.,0.,0.,1.,0.,0.,0.,0.,1.,0.,7e7,8e7,9e7,1.];
    let original_frame=*next.world_from_evaluation();
    let replaced_clip=w.clip_retained_plane(Input::PlacedClip {clip:&next,world_from_clip:replacement},
        [0.,0.,1.25,0.,0.,1.],PlaneSide::Positive,PlaneClipMode::Intersection,0.001,5.,1_048_576).await.unwrap();
    assert!((volume(replaced_clip.mesh())-1.).abs()<0.01);
    assert_eq!(replaced_clip.world_from_evaluation(),&replacement);
    assert_eq!(next.world_from_evaluation(),&original_frame);
    assert_eq!(replaced_clip.operation_identity().input,*next.handle());
    let RetainedLineage::PlaneClip {input,..}=replaced_clip.lineage() else {panic!("clip lineage")};
    assert!(matches!(input.as_ref(),RetainedLineage::Placed {value,world_from_evaluation}
        if world_from_evaluation==&replacement && matches!(value.as_ref(),RetainedLineage::PlaneClip {..})));
    for scale in [2.,-1.,f64::NAN] {
        let mut invalid=replacement;invalid[0]=scale;
        assert!(w.clip_retained_plane(Input::PlacedClip {clip:&next,world_from_clip:invalid},
            [0.,0.,1.25,0.,0.,1.],PlaneSide::Positive,PlaneClipMode::Intersection,0.001,5.,1_048_576).await.is_err());
        next.validate_live().unwrap();replaced_clip.validate_live().unwrap();
    }
    let result=w.evaluate_retained_boolean(Input::Clip(&c),Input::Clip(&next),BooleanOperation::Intersection,
        0.001,5.,1_048_576).await.unwrap();
    let placed=w.clip_retained_plane(Input::PlacedResult {result:&result,world_from_result:frame},
        [0.,0.,1.25,0.,0.,1.],PlaneSide::Positive,PlaneClipMode::Intersection,0.001,5.,1_048_576).await.unwrap();
    assert_eq!(placed.world_from_evaluation(),&frame);assert!((volume(placed.mesh())-1.).abs()<0.01);
    let RetainedLineage::PlaneClip {input,..}=placed.lineage() else {panic!("clip lineage")};
    assert!(matches!(input.as_ref(),RetainedLineage::Placed {..}));
    let copy=w.copy_retained_affine(BrowserTransformInput::Clip(&next),I).await.unwrap();
    let from_affine=w.clip_retained_plane(Input::Affine {copy:&copy,world_from_affine:frame},
        [0.,0.,1.25,0.,0.,1.],PlaneSide::Positive,PlaneClipMode::Intersection,0.001,5.,1_048_576).await.unwrap();
    assert!((volume(from_affine.mesh())-1.).abs()<0.01);
    let from_result=w.clip_retained_plane(Input::Result(&result),[0.,0.,1.25,0.,0.,1.],PlaneSide::Positive,
        PlaneClipMode::Intersection,0.001,5.,1_048_576).await.unwrap();
    assert!((volume(from_result.mesh())-1.).abs()<0.01);
    drop(s);drop(c);drop(next);drop(result);
    replaced_clip.validate_live().unwrap();
    placed.validate_live().unwrap();copy.validate_live().unwrap();from_affine.validate_live().unwrap();from_result.validate_live().unwrap();
    let owner=w.cancellation();drop(placed);assert!(owner.incarnation().is_some());
}
#[wasm_bindgen_test(async)]
async fn actual_browser_plane_cylinder_and_semantic_empty_chaining() {
    let mut w=BrowserWorker::new_retained_execution().unwrap();w.qualify().await.unwrap();
    let r=request(&w,true);let s=w.evaluate(r,0.001,5.,1_048_576).await.unwrap();
    let c=w.clip_retained_plane(Input::Source {realization:&s,world_from_source:I},[0.,0.,1.,0.,0.,1.],
        PlaneSide::Positive,PlaneClipMode::Intersection,0.001,5.,1_048_576).await.unwrap();
    assert!(!c.is_empty());assert!((volume(c.mesh())-std::f64::consts::PI).abs()<0.01);
    let empty=w.clip_retained_plane(Input::Clip(&c),[0.,0.,3.,0.,0.,1.],PlaneSide::Positive,
        PlaneClipMode::Intersection,0.001,5.,1_048_576).await.unwrap();
    assert!(empty.is_empty());assert!(empty.mesh().indices.is_empty());
    let again=w.clip_retained_plane(Input::Clip(&empty),[0.,0.,1.,0.,0.,1.],PlaneSide::Negative,
        PlaneClipMode::Difference,0.001,5.,1_048_576).await.unwrap();
    assert!(again.is_empty());assert_eq!(again.operation_identity().certificate.method(),0);
}
#[wasm_bindgen_test(async)]
async fn actual_browser_plane_foreign_and_invalid_are_unsent_and_drop_after_dispatch_retires_owner() {
    let mut w=BrowserWorker::new_retained_execution().unwrap();w.qualify().await.unwrap();
    let r=request(&w,false);let s=w.evaluate(r,0.001,5.,1_048_576).await.unwrap();
    let mut other=BrowserWorker::new_retained_execution().unwrap();
    assert!(other.clip_retained_plane(Input::Source {realization:&s,world_from_source:I},[0.,0.,1.,0.,0.,1.],
        PlaneSide::Positive,PlaneClipMode::Intersection,0.001,5.,1_048_576).await.is_err());
    assert!(w.clip_retained_plane(Input::Source {realization:&s,world_from_source:I},[0.;6],
        PlaneSide::Positive,PlaneClipMode::Intersection,0.001,5.,1_048_576).await.is_err());s.validate_live().unwrap();
    let owner=w.cancellation();let dispatched=owner.observe_dispatch(20);
    let mut future=Box::pin(w.clip_retained_plane(Input::Source {realization:&s,world_from_source:I},
        [0.,0.,1.,0.,0.,1.],PlaneSide::Positive,PlaneClipMode::Intersection,0.001,5.,1_048_576));
    let mut context=Context::from_waker(Waker::noop());
    assert!(matches!(future.as_mut().poll(&mut context),Poll::Pending));
    assert_eq!(JsFuture::from(dispatched).await.unwrap().as_f64(),Some(20.));
    drop(future);assert!(owner.incarnation().is_none());assert!(s.validate_live().is_err());
    let r=request(&other,false);let replacement=other.evaluate(r,0.001,5.,1_048_576).await.unwrap();
    owner.retire();replacement.validate_live().unwrap();
}
