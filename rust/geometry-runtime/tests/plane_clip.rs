// SPDX-License-Identifier: MPL-2.0
//! Actual gated SDK candidates for opcode20 runtime binding; UNRUN at delivery.
//! Synthetic source invariants, not real-model or whole-product qualification.
#![cfg(not(target_arch="wasm32"))]
use ifc_lite_core::{build_entity_index,EntityDecoder};
use ifc_lite_geometry::{analytic::extract_analytic_extrusion,document::{
    BooleanOperation,EvaluationContract,GeometryDocument,RetainedExtrusion,RetainedRequest}};
use ifc_lite_geometry_runtime::{MeshLimits,PlaneClipMode as Mode,PlaneSide as Side,
    RetainedDependency as Input,RetainedLineage,RetainedRealization,RetainedTransformInput,
    SmlibWorker,WorkerError};
const I:[f64;16]=[1.,0.,0.,0.,0.,1.,0.,0.,0.,0.,1.,0.,0.,0.,0.,1.];
fn worker() -> Option<SmlibWorker> {
    let Some(path)=std::env::var_os("IFCLITE_SMLIB_WORKER") else {
        eprintln!("SKIP actual plane runtime: build pinned adapter and set IFCLITE_SMLIB_WORKER"); return None;
    };
    Some(SmlibWorker::spawn(path).unwrap())
}
fn request(w:&SmlibWorker,circle:bool) -> RetainedRequest {
    let profile=if circle {"IFCCIRCLEPROFILEDEF(.AREA.,$,#2,1.)"} else {"IFCRECTANGLEPROFILEDEF(.AREA.,$,#2,2.,2.)"};
    let input=format!("#1=IFCCARTESIANPOINT((0.,0.));#2=IFCAXIS2PLACEMENT2D(#1,$);#3={profile};#4=IFCDIRECTION((0.,0.,1.));#5=IFCEXTRUDEDAREASOLID(#3,$,#4,2.);");
    let mut d=EntityDecoder::with_index(input.as_bytes(),build_entity_index(input.as_bytes()));
    let entity=d.decode_by_id(5).unwrap();let mut document=GeometryDocument::new();
    let definition=document.add_retained_extrusion(RetainedExtrusion {source:extract_analytic_extrusion(&entity,&mut d),
        length_unit_scale:1.,source_epoch:1,source_revision:1}).unwrap();
    document.prepare_retained_extrusion(definition,EvaluationContract::RetainedBrep,w.incarnation()).unwrap()
}
fn source(s:&RetainedRealization, frame:[f64;16]) -> Input<'_> { Input::Source {realization:s,world_from_source:frame} }
#[test]
fn actual_plane_runtime_box_survey_frame_chaining_and_independent_release() {
    let Some(mut w)=worker() else {return};
    let request=request(&w,false);
    let s=w.evaluate_retained_extrusion(request.clone(),0.001,5.,MeshLimits::default()).unwrap();
    let frame=[0.,1.,0.,0.,-1.,0.,0.,0.,0.,0.,1.,0.,3e8,4e8,5e8,1.];
    let plane=[0.,0.,1.,0.,0.,2.];
    let c=w.clip_retained_plane(source(&s,frame),plane,Side::Positive,Mode::Intersection,0.001,5.,MeshLimits::default()).unwrap();
    assert!((w.volume(c.solid(),1e-8).unwrap()-4.).abs()<1e-5);
    assert!((w.volume(s.solid(),1e-8).unwrap()-8.).abs()<1e-5);
    let expected_frame=ifc_lite_geometry_runtime_frame(frame,s.completion().source_from_evaluation);
    assert_eq!(*c.world_from_evaluation(),expected_frame);
    assert_eq!(c.operation_identity().input,s.solid());assert_eq!(c.operation_identity().plane,plane);
    let RetainedLineage::PlaneClip {input,..}=c.lineage() else {panic!("missing unary ancestry")};
    let RetainedLineage::Source {request:original,..}=input.as_ref() else {panic!("missing source")};
    assert!(original.same_admission(&request));
    let next=w.clip_retained_plane(Input::Clip(&c),[0.,0.,1.5,0.,0.,1.],Side::Positive,Mode::Difference,0.001,5.,MeshLimits::default()).unwrap();
    assert!((w.volume(next.solid(),1e-8).unwrap()-2.).abs()<1e-5);
    let affine=w.copy_retained_affine(RetainedTransformInput::Clip(&next),I).unwrap();
    let from_affine=w.clip_retained_plane(Input::Affine {copy:&affine,world_from_affine:frame},
        [0.,0.,1.25,0.,0.,1.],Side::Positive,Mode::Intersection,0.001,5.,MeshLimits::default()).unwrap();
    assert!((w.volume(from_affine.solid(),1e-8).unwrap()-1.).abs()<1e-5);
    let replacement=[1.,0.,0.,0.,0.,1.,0.,0.,0.,0.,1.,0.,7e7,8e7,9e7,1.];
    let original_frame=*next.world_from_evaluation();
    let replaced_clip=w.clip_retained_plane(Input::PlacedClip {clip:&next,world_from_clip:replacement},
        [0.,0.,1.25,0.,0.,1.],Side::Positive,Mode::Intersection,0.001,5.,MeshLimits::default()).unwrap();
    assert!((w.volume(replaced_clip.solid(),1e-8).unwrap()-1.).abs()<1e-5);
    assert_eq!(replaced_clip.world_from_evaluation(),&replacement);
    assert_eq!(next.world_from_evaluation(),&original_frame);
    assert_eq!(replaced_clip.operation_identity().input,next.solid());
    let RetainedLineage::PlaneClip {input,..}=replaced_clip.lineage() else {panic!("clip lineage")};
    assert!(matches!(input.as_ref(),RetainedLineage::Placed {value,world_from_evaluation}
        if world_from_evaluation==&replacement && matches!(value.as_ref(),RetainedLineage::PlaneClip {..})));
    for scale in [2.,-1.,f64::NAN] {
        let mut invalid=replacement;invalid[0]=scale;
        assert!(w.clip_retained_plane(Input::PlacedClip {clip:&next,world_from_clip:invalid},
            [0.,0.,1.25,0.,0.,1.],Side::Positive,Mode::Intersection,0.001,5.,MeshLimits::default()).is_err());
        next.validate_live().unwrap();replaced_clip.validate_live().unwrap();
    }
    let result=w.evaluate_retained_boolean(Input::Clip(&c),Input::Clip(&next),BooleanOperation::Intersection,
        0.001,5.,MeshLimits::default()).unwrap();
    let placed=w.clip_retained_plane(Input::PlacedResult {result:&result,world_from_result:frame},
        [0.,0.,1.25,0.,0.,1.],Side::Positive,Mode::Intersection,0.001,5.,MeshLimits::default()).unwrap();
    assert_eq!(placed.world_from_evaluation(),&frame);
    let RetainedLineage::PlaneClip {input,..}=placed.lineage() else {panic!("missing clip")};
    assert!(matches!(input.as_ref(),RetainedLineage::Placed {..}));
    let from_result=w.clip_retained_plane(Input::Result(&result),[0.,0.,1.25,0.,0.,1.],Side::Positive,
        Mode::Intersection,0.001,5.,MeshLimits::default()).unwrap();
    assert!((w.volume(from_result.solid(),1e-8).unwrap()-1.).abs()<1e-5);
    let old=c.solid();drop(s);drop(c);drop(next);drop(result);w.flush_releases().unwrap();
    assert!(matches!(w.volume(old,1e-8),Err(WorkerError::WrongWorker)));
    replaced_clip.validate_live().unwrap();
    affine.validate_live().unwrap();placed.validate_live().unwrap();from_affine.validate_live().unwrap();
    w.release(placed.solid()).unwrap();assert!(placed.validate_live().is_err());from_result.validate_live().unwrap();
}
fn ifc_lite_geometry_runtime_frame(a:[f64;16],b:[f64;16]) -> [f64;16] {
    std::array::from_fn(|i|(0..4).map(|k|a[4*k+i%4]*b[4*(i/4)+k]).sum())
}
#[test]
fn actual_plane_runtime_cylinder_empty_and_empty_chaining_use_semantic_query() {
    let Some(mut w)=worker() else {return};w.qualify_ordered_regions().unwrap();
    let request=request(&w,true);let s=w.evaluate_retained_extrusion(request,0.001,5.,MeshLimits::default()).unwrap();
    let c=w.clip_retained_plane(source(&s,I),[0.,0.,1.,0.,0.,1.],Side::Positive,Mode::Intersection,
        0.001,5.,MeshLimits::default()).unwrap();
    assert!((w.volume(c.solid(),1e-8).unwrap()-std::f64::consts::PI).abs()<1e-4);
    assert!(w.is_manifold(c.solid()).unwrap());assert!(!w.is_empty(c.solid()).unwrap());
    let empty=w.clip_retained_plane(Input::Clip(&c),[0.,0.,3.,0.,0.,1.],Side::Positive,Mode::Intersection,
        0.001,5.,MeshLimits::default()).unwrap();
    assert!(empty.is_empty());assert!(w.is_empty(empty.solid()).unwrap());assert!(empty.mesh().indices.is_empty());
    let again=w.clip_retained_plane(Input::Clip(&empty),[0.,0.,1.,0.,0.,1.],Side::Negative,Mode::Difference,
        0.001,5.,MeshLimits::default()).unwrap();
    assert!(again.is_empty());assert_eq!(again.operation_identity().certificate.method(),0);
    assert!((w.volume(s.solid(),1e-8).unwrap()-2.*std::f64::consts::PI).abs()<1e-4);
}
#[test]
fn actual_plane_runtime_rejects_foreign_released_and_invalid_without_retiring_inputs() {
    let Some(mut a)=worker() else {return};let Some(mut b)=worker() else {return};
    let r=request(&a,false);let s=a.evaluate_retained_extrusion(r,0.001,5.,MeshLimits::default()).unwrap();
    assert!(matches!(b.clip_retained_plane(source(&s,I),[0.,0.,1.,0.,0.,1.],Side::Positive,
        Mode::Intersection,0.001,5.,MeshLimits::default()),Err(WorkerError::WrongWorker)));
    assert!(a.clip_retained_plane(source(&s,I),[0.;6],Side::Positive,Mode::Intersection,
        0.001,5.,MeshLimits::default()).is_err());
    s.validate_live().unwrap();assert_ne!(b.incarnation(),0);
    a.release(s.solid()).unwrap();assert!(a.clip_retained_plane(source(&s,I),[0.,0.,1.,0.,0.,1.],Side::Positive,
        Mode::Intersection,0.001,5.,MeshLimits::default()).is_err());assert_ne!(a.incarnation(),0);
}
