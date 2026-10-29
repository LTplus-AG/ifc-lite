// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #7955 M6: real SDK; missing fixtures/SDK fail this qualification lane.
use ifc_lite_core::SourceBundle;
use ifc_lite_retained_native::{run_model_native, ModelOptions, ProductOutcome, ShapeOnlyProduct};
use ifc_lite_retained_native::oracle::bounded;
#[allow(dead_code)]
#[path="../examples/compare/metrics.rs"]
mod metrics;
const SOURCE:&str=include_str!("../../../tests/fixtures/synthetic-retained/f-f-halfspaces.ifc");
#[path="support/m6_boundary_equivalence.rs"]
mod boundary_equivalence;
fn worker()->Option<std::ffi::OsString> {
    let path=std::env::var_os("IFCLITE_SMLIB_WORKER");
    if path.is_none() {
        assert!(std::env::var_os("IFCLITE_REQUIRE_SMLIB").is_none(),"M6 requires real SDK; set IFCLITE_SMLIB_WORKER");
        eprintln!("SKIP M6 native: SDK absent; not qualification evidence");
    }
    path
}
fn run(text:&str,ids:&[u32])->Vec<ProductOutcome> {
    let mut outcomes=Vec::new();run_model_native(SourceBundle::new(text.as_bytes().to_vec()),worker().unwrap(),
        &ModelOptions{ids:Some(ids.iter().copied().collect()),..Default::default()},|o|outcomes.push(o)).unwrap();
    assert_eq!(outcomes.len(),ids.len());outcomes
}
fn shape(outcomes:&[ProductOutcome],id:u32)->&ShapeOnlyProduct {
    outcomes.iter().find_map(|o|match o{ProductOutcome::Published(s) if s.product_id==id=>Some(s),_=>None})
        .unwrap_or_else(||panic!("missing published #{id}: {outcomes:?}"))
}
fn code(outcome:&ProductOutcome)->&str {match outcome{ProductOutcome::Published(_)=>"published",ProductOutcome::Refused{refusal,..}=>refusal.code()}}
fn measure(shape:&ShapeOnlyProduct)->metrics::Metrics {
    let mut m=metrics::Metrics::default();for part in &shape.parts {
        let points=part.positions.chunks_exact(3).map(|p|metrics::transform(&part.world_from_object,[p[0],p[1],p[2]])).collect::<Vec<_>>();
        m.add_mesh(&points,&part.indices).unwrap();
    }m
}
fn verify(text:&str,shape:&ShapeOnlyProduct,hand:Option<f64>) {
    let sources=ifc_lite_processing::extract_analytic_quantity_sources(text.as_bytes(),None);
    verify_sources(text,shape,hand,&sources,false);
}
fn verify_sources(text:&str,shape:&ShapeOnlyProduct,hand:Option<f64>,sources:&ifc_lite_processing::AnalyticQuantitySources,require_volume:bool) {
    let e=bounded::expected(text.as_bytes(),sources,shape.product_id).expect("independent source oracle required");
    assert!(!require_volume || hand.is_some() || e.section_volume.is_some(),
        "#{} has no volume authority: {:?}",shape.product_id,e.section_unavailable);
    let actual=measure(shape);let tol:serde_json::Value=serde_json::from_str(include_str!("../../../tests/fixtures/cli-retained/tolerances.d/m6.json")).unwrap();
    let key=if e.curved{"curved"}else{"linear"};
    for volume in [hand,e.section_volume].into_iter().flatten() {
        assert!((actual.volume-volume).abs()<=tol["boundedSectionVolumeRelative"][key].as_f64().unwrap()*volume.abs(),"#{} {} vs {volume}",shape.product_id,actual.volume);
    }
    assert!(actual.volume>=0.&&actual.volume<=e.host_volume*(1.+tol["boundedVolumeBoundsRelative"][key].as_f64().unwrap()));
    let extent=(0..3).map(|i|actual.bbox[i+3]-actual.bbox[i]).fold(0.,f64::max);
    let limit=tol["boundedOutsideMaterialMetres"]["absolute"].as_f64().unwrap()+extent*tol["boundedOutsideMaterialMetres"]["extentFactor"].as_f64().unwrap();
    for part in &shape.parts {for p in part.positions.chunks_exact(3) {
        let world=metrics::transform(&part.world_from_object,[p[0],p[1],p[2]]);
        assert!(e.removed_clearance(world)<=limit,"#{} vertex {world:?} lies in removed material",shape.product_id);
    }}
    assert_eq!(actual.defects,0,"#{} closure",shape.product_id);
    println!("M6 source oracle: {}",serde_json::json!({"id":shape.product_id,"volume":actual.volume,"section":e.section_volume,"hand":hand,"closure":actual.defects}));
}
#[test]
fn m6_native_bounded_volumes_nonconvex_overlap_arc_and_frames() {
    if worker().is_none(){return;}
    let ids=[1000,1001,1002,1003,1005,1010,1014,1015];let outcomes=run(SOURCE,&ids);
    let pins:serde_json::Value=serde_json::from_str(include_str!("../../../tests/fixtures/cli-retained/expected.d/m6-halfspaces.json")).unwrap();
    for id in ids {verify(SOURCE,shape(&outcomes,id),pins["rows"][(id-1000)as usize]["volume"].as_f64());}
    println!("sdk witness executed: m6_bounded_volumes");
}
#[test]
fn m6_native_boxed_twin_outcomes_and_enclosure_never_read() {
    if worker().is_none(){return;}
    let plain=run(SOURCE,&[1008]);
    for id in [1007,1009] {
        let boxed=run(SOURCE,&[id]);assert_eq!(code(&boxed[0]),code(&plain[0]));
        if let (ProductOutcome::Published(a),ProductOutcome::Published(b))=(&boxed[0],&plain[0]) {
            assert_eq!(measure(a).volume.to_bits(),measure(b).volume.to_bits());
        }
    }
    let absent=SOURCE.lines().filter(|l|!l.contains("IFCBOUNDINGBOX(")).collect::<Vec<_>>().join("\n");
    let boxed=run(&absent,&[1007]);assert_eq!(code(&boxed[0]),code(&plain[0]));
    println!("sdk witness executed: m6_boxed_twin_outcomes");
}
#[test]
fn m6_native_refusals_are_atomic() {
    if worker().is_none(){return;}
    let outcomes=run(SOURCE,&[1006,1012,1013]);
    for o in &outcomes {assert_eq!(code(o),"operation_unsupported");}
    println!("sdk witness executed: m6_typed_refusals");
}
#[test]
fn m6_native_mixed_chain_and_boxed_publication() {
    if worker().is_none(){return;}
    let outcomes=run(SOURCE,&[1004,1007,1008,1009]);
    for id in [1007,1008,1009] {verify(SOURCE,shape(&outcomes,id),Some(32.));}
    let mixed=measure(shape(&outcomes,1004));assert!((mixed.volume-41.).abs()<=41e-6);assert_eq!(mixed.defects,0);
}
#[test]
fn m6_native_consumed_provenance() {
    if worker().is_none(){return;}
    // A valid later operand after the consumed first clip is never executed; the
    // consumed origin survives. (An undecodable later operand is rejected earlier,
    // by the source-only preflight traversal, as `source_invalid`; the live
    // consumed-host short-circuit is covered SDK-free in m6_mixed_and_boxed.)
    let chained=SOURCE.replace("#356=IFCBOOLEANRESULT(.DIFFERENCE.,#12,#314);",
        "#9356=IFCBOOLEANRESULT(.DIFFERENCE.,#12,#314);\n#356=IFCBOOLEANRESULT(.DIFFERENCE.,#9356,#315);");
    for (label,source) in [("plain",SOURCE),("chained",chained.as_str())] {
        let outcomes=run(source,&[1011]);
        let ProductOutcome::Refused{refusal,origin,..}=&outcomes[0] else{panic!("{label}: consumed host must refuse atomically");};
        // Attribution comes from M5's shared HalfSpaceClip hook.
        assert_eq!(refusal.code(),"empty_result","{label}: {refusal:?} {origin:?}");let origin=origin.unwrap();assert_eq!(origin.site,"halfspace_clip");assert_eq!(origin.cause,"consumed");
    }
    let invalid=SOURCE.replace("#356=IFCBOOLEANRESULT(.DIFFERENCE.,#12,#314);",
        "#9356=IFCBOOLEANRESULT(.DIFFERENCE.,#12,#314);\n#356=IFCBOOLEANRESULT(.DIFFERENCE.,#9356,#999999);");
    let outcomes=run(&invalid,&[1011]);
    let ProductOutcome::Refused{refusal,origin,..}=&outcomes[0] else{panic!("invalid later operand must refuse");};
    assert_eq!(refusal.code(),"source_invalid");assert_eq!(origin.unwrap().entity,Some(999999));
}
#[test]
fn m6_native_fzk_bounded_only_chains_publish() {
    if worker().is_none(){return;}
    let Some(text)=ifc_lite_testkit::fixture_text("ara3d/AC20-FZK-Haus.ifc") else {return;};
    let outcomes=run(&text,&[60012,67828]);
    let sources=ifc_lite_processing::extract_analytic_quantity_sources(text.as_bytes(),None);
    for id in [60012,67828] {
        let e=bounded::expected(text.as_bytes(),&sources,id).unwrap();
        assert!(e.section_volume.is_some(),"FZK #{id} requires the section oracle: {:?}",e.section_unavailable);
        verify(&text,shape(&outcomes,id),None);
    }
    println!("sdk witness executed: m6_fzk_bounded_chains");
}
#[test]
fn m6_native_stage_browser_reference() {
    if worker().is_none(){return;}
    let outcomes=run(SOURCE,&(1000..1016).filter(|id|![1004,1011].contains(id)).collect::<Vec<_>>());
    let rows=outcomes.iter().map(|o|match o {
        ProductOutcome::Published(s)=>serde_json::json!({"id":s.product_id,"code":"published","volume":measure(s).volume}),
        ProductOutcome::Refused{product_id,refusal,..}=>serde_json::json!({"id":product_id,"code":refusal.code(),"volume":null}),
    }).collect::<Vec<_>>();
    if let Some(path)=std::env::var_os("IFCLITE_M6_REFERENCE") {std::fs::write(path,serde_json::to_vec_pretty(&rows).unwrap()).unwrap();}
    println!("sdk witness executed: m6_native_reference");
}
// Inject only the transport status; all successful constructions/Booleans use
// NativeWorker and authenticated SDK receipts, never a geometry mock.
struct Observed {
    worker:ifc_lite_retained_native::NativeWorker,
    calls:std::rc::Rc<std::cell::Cell<usize>>,
    fail:Option<usize>,
    clips:std::rc::Rc<std::cell::RefCell<Vec<f64>>>,
}
use ifc_lite_processing::element::retained_runtime::{RetainedRuntime,AsyncRetainedExecutor,Invocation,NumericalLimits,RuntimeFault};
impl RetainedRuntime for Observed {
    type Receipt=ifc_lite_retained_native::NativeReceipt;
    fn domain(&self)->ifc_lite_retained_native::NativeDomain{self.worker.domain()}
    fn incarnation(&self)->u64{self.worker.incarnation()}
}
impl AsyncRetainedExecutor for Observed {
    async fn invoke(&mut self,call:Invocation<'_,Self::Receipt>,limits:NumericalLimits)->Result<Self::Receipt,RuntimeFault> {
        if matches!(call,Invocation::Boolean{..}) {
            self.calls.set(self.calls.get()+1);
            if self.fail==Some(self.calls.get()){return Err(RuntimeFault::kernel(7,"M6 second Boolean fault"));}
        }
        use ifc_lite_processing::element::retained_runtime::{NumericalReceipt,Operand,ReceiptEvidence};
        let clip=if let Invocation::Boolean{right,..}=&call {
            let receipt=match right {Operand::Source{receipt,..}|Operand::Placed{receipt,..}=>receipt};
            matches!(receipt.evidence(),ReceiptEvidence::Construction(c) if matches!(c.request().recipe(),
                ifc_lite_geometry::document::RetainedRecipe::Prism(p) if p.role==ifc_lite_geometry::document::PrismRole::BoundedHalfSpace))
        }else{false};
        let start=std::time::Instant::now();let result=self.worker.invoke(call,limits).await;
        if clip {self.clips.borrow_mut().push(start.elapsed().as_secs_f64()*1000.);}
        result
    }
}
fn observed_source(text:&str,ids:&[u32],fail:Option<usize>)->(Vec<ProductOutcome>,usize,Vec<f64>) {
    let calls=std::rc::Rc::new(std::cell::Cell::new(0));let mut outcomes=Vec::new();let path=worker().unwrap();
    let clips=std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
    ifc_lite_retained_native::block_on(ifc_lite_processing::element::retained_runtime::run_model(
        SourceBundle::new(text.as_bytes().to_vec()),&ModelOptions{ids:Some(ids.iter().copied().collect()),..Default::default()},
        ||ifc_lite_retained_native::NativeWorker::spawn(&path).map(|worker|Observed{worker,calls:calls.clone(),fail,clips:clips.clone()}),|o|outcomes.push(o))).unwrap();
    let times=clips.borrow().clone();(outcomes,calls.get(),times)
}
fn observed(ids:&[u32],fail:Option<usize>)->(Vec<ProductOutcome>,usize) {
    let (outcomes,calls,_)=observed_source(SOURCE,ids,fail);(outcomes,calls)
}
#[test]
fn m6_native_second_boolean_fault_is_atomic_and_next_product_succeeds() {
    if worker().is_none(){return;}
    // #1014 follows #1003 in canonical product order and performs a real Boolean.
    let (outcomes,calls)=observed(&[1003,1014],Some(2));assert_eq!(calls,3);assert_eq!(outcomes.len(),2);
    assert_eq!(code(&outcomes[0]),"kernel_failure");verify(SOURCE,shape(&outcomes,1014),Some(56.+6.*35f64.to_radians().tan()));
    let (refused,calls)=observed(&[1006,1012,1013],None);assert_eq!(calls,0);
    for o in refused {assert_eq!(code(&o),"operation_unsupported");}
    println!("sdk witness executed: m6_atomic_failure");
}

#[test]
fn m6_native_960_report_has_no_untyped_or_unverified_outcome() {
    if worker().is_none(){return;}
    let Some(text)=ifc_lite_testkit::fixture_text("issues/960_house_segmented_roof_clip.ifc") else {return;};
    let source=SourceBundle::new(text.as_bytes().to_vec());
    let ids=ifc_lite_processing::element::retained_runtime::canonical_element_jobs(&source).into_iter()
        .map(|(id,_)|id).filter(|id|bounded::applies(text.as_bytes(),*id)).collect::<Vec<_>>();
    assert!(!ids.is_empty(),"960 must exercise actual PBHS products");
    let (outcomes,_,mut clip_ms)=observed_source(&text,&ids,None);let mut counts=std::collections::BTreeMap::new();
    let mut rows=Vec::new();
    let sources=ifc_lite_processing::extract_analytic_quantity_sources(text.as_bytes(),None);
    for outcome in &outcomes {
        *counts.entry(code(outcome)).or_insert(0usize)+=1;
        match outcome {
            ProductOutcome::Published(s)=>{
                verify_sources(&text,s,None,&sources,true);rows.push(serde_json::json!({"id":s.product_id,"code":"published","volume":measure(s).volume}));},
            ProductOutcome::Refused{product_id,refusal,origin,..}=>{
                assert_ne!(refusal.code(),"contract_breach","960 #{product_id}: {refusal:?}");
                rows.push(serde_json::json!({"id":product_id,"code":refusal.code(),"origin":format!("{origin:?}")}));
            }
        }
    }
    clip_ms.sort_by(f64::total_cmp);
    let percentile=|q:f64|clip_ms.get(((clip_ms.len() as f64*q).ceil() as usize).saturating_sub(1)).copied();
    let report=serde_json::json!({"model":"issues/960_house_segmented_roof_clip.ifc","counts":counts,"rows":rows,
        "clipMs":{"count":clip_ms.len(),"p50":percentile(0.5),"p95":percentile(0.95)},
        "timingScope":"actual bounded-prism Boolean invokes; ordinary qualification diagnostics, not a performance claim"});
    if let Some(path)=std::env::var_os("IFCLITE_M6_960_REPORT") {std::fs::write(path,serde_json::to_vec_pretty(&report).unwrap()).unwrap();}
    println!("M6 960 report: {report}");
    println!("sdk witness executed: m6_960_bounded_report");
}

#[test]
fn m6_native_full_circle_boundary_hand_integral() {
    if worker().is_none(){return;}
    let text=SOURCE.replace("#36=IFCINDEXEDPOLYCURVE(#35,(IFCARCINDEX((1,2,3)),IFCLINEINDEX((3,4,1))),.F.);","#36=IFCCIRCLE(#9036,0.5);\n#9036=IFCAXIS2PLACEMENT2D(#9037,$);\n#9037=IFCCARTESIANPOINT((1.,1.));");
    let outcomes=run(&text,&[1005]);verify(&text,shape(&outcomes,1005),Some(64.-std::f64::consts::FRAC_PI_2));
    println!("sdk witness executed: m6_circle_boundary");
}

#[test]
fn m6_native_mapped_pbhs_products_receive_bounded_source_checks() {
    if worker().is_none(){return;}
    let text=include_str!("../../../tests/fixtures/synthetic-retained/f-e-mapped-booleans.ifc");
    let outcomes=run(text,&[173,231]);
    for id in [173,231] {
        assert!(bounded::applies(text.as_bytes(),id));
        verify(text,shape(&outcomes,id),Some(3.));
    }
    println!("sdk witness executed: m6_mapped_boundaries");
}

#[path="support/m6_affine.rs"]
mod m6_affine;
#[test]
fn m6_native_mirrored_bounded() {
    if worker().is_none(){return;}
    // Refs #7955: full source volume, clearance and closure gate on diag(-2,3,1).
    let text=m6_affine::affine_boxed();
    let outcomes=run(&text,&[1007]);
    verify(&text,shape(&outcomes,1007),Some(192.));
    println!("sdk witness executed: m6_mirrored_bounded");
}
