// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #7955: observe the real peer; only the explicit fault test injects a failure.
use ifc_lite_core::SourceBundle;
use ifc_lite_geometry::document::{PrismRole, RetainedRecipe};
use ifc_lite_processing::element::retained_runtime::*;
use ifc_lite_retained_native::{block_on,NativeDomain,NativeReceipt,NativeWorker};
use std::{cell::RefCell,rc::Rc,time::Instant};
#[allow(dead_code)]
#[path = "../examples/compare/metrics.rs"]
mod metrics;
const FIXTURE:&str=include_str!("../../../tests/fixtures/synthetic-retained/f-e-clips.ifc");
type Object=<NativeReceipt as NumericalReceipt>::Object;
#[derive(Default)]
struct Trace {booleans:usize,clips:Vec<serde_json::Value>,prisms:Vec<(Object,usize)>}
struct Observed {inner:NativeWorker,trace:Rc<RefCell<Trace>>,fail:Option<usize>}
impl RetainedRuntime for Observed {
    type Receipt=NativeReceipt;
    fn domain(&self)->NativeDomain{self.inner.domain()}
    fn incarnation(&self)->u64{self.inner.incarnation()}
}
fn object(operand:&Operand<'_,NativeReceipt>)->Object{
    match operand {Operand::Source{receipt,..}|Operand::Placed{receipt,..}=>receipt.object()}
}
impl AsyncRetainedExecutor for Observed {
    async fn invoke(&mut self,call:Invocation<'_,NativeReceipt>,limits:NumericalLimits)->Result<NativeReceipt,RuntimeFault>{
        let prism=match &call {
            Invocation::Construction(r)=>match r.recipe(){RetainedRecipe::Prism(p) if p.role==PrismRole::HalfSpace=>Some(p.source_id),_=>None},
            _=>None,
        };
        let mut clip=None;
        if let Invocation::Boolean{right,..}=&call {
            let mut trace=self.trace.borrow_mut();trace.booleans+=1;
            clip=trace.prisms.iter().find(|(key,_)|*key==object(right)).map(|(_,i)|*i);
            if self.fail==Some(trace.booleans){return Err(RuntimeFault::kernel(7,"M5 injected second Boolean failure"));}
        }
        let start=Instant::now();let result=self.inner.invoke(call,limits).await;
        let ms=start.elapsed().as_secs_f64()*1000.;let mut trace=self.trace.borrow_mut();
        if let Some(entity)=prism {
            let i=trace.clips.len();
            trace.clips.push(serde_json::json!({"halfspace":entity,"constructionMs":ms,"booleanMs":null,"clipMs":ms}));
            if let Ok(receipt)=&result{trace.prisms.push((receipt.object(),i));}
        }
        if let Some(i)=clip {
            trace.clips[i]["booleanMs"]=serde_json::json!(ms);
            let construction=trace.clips[i]["constructionMs"].as_f64().unwrap();
            trace.clips[i]["clipMs"]=serde_json::json!(construction+ms);
        }
        result
    }
}
fn observed(text:&str,ids:Option<Vec<u32>>,fail:Option<usize>)->Option<(Vec<ProductOutcome>,Vec<serde_json::Value>)>{
    let Some(worker)=std::env::var_os("IFCLITE_SMLIB_WORKER") else {
        assert!(std::env::var_os("IFCLITE_REQUIRE_SMLIB").is_none(),"real SMLib required");
        eprintln!("SKIP M5 observations: real SDK missing; not evidence");return None;
    };
    let trace=Rc::new(RefCell::new(Trace::default()));let mut outcomes=Vec::new();let mut rows=Vec::new();
    let mut previous=0;
    block_on(run_model(SourceBundle::new(text.as_bytes().to_vec()),&ModelOptions{ids:ids.map(|v|v.into_iter().collect()),..Default::default()},
        ||NativeWorker::spawn(&worker).map(|inner|Observed{inner,trace:trace.clone(),fail}),
        |outcome|{
            let (id,code)=match &outcome{ProductOutcome::Published(s)=>(s.product_id,"published"),ProductOutcome::Refused{product_id,refusal,..}=>(*product_id,refusal.code())};
            let mut t=trace.borrow_mut();let clips=std::mem::take(&mut t.clips);t.prisms.clear();
            let clip_ms: f64=clips.iter().map(|c|c["clipMs"].as_f64().unwrap()).sum();
            rows.push(serde_json::json!({"id":id,"code":code,"booleans":t.booleans-previous,"clips":clips.len(),"clipMs":clip_ms,"steps":clips}));
            previous=t.booleans;outcomes.push(outcome);
        })).unwrap();
    Some((outcomes,rows))
}
#[test]
fn issue_7955_m5_second_boolean_failure_is_atomic_and_next_product_succeeds(){
    let Some((outcomes,rows))=observed(FIXTURE,Some(vec![58,145]),Some(2)) else{return};
    assert_eq!(outcomes.len(),2);
    assert!(matches!(&outcomes[0],ProductOutcome::Refused{product_id:58,refusal:RetainedProductRefusal::KernelFailure{status:7},..}));
    assert!(matches!(&outcomes[1],ProductOutcome::Published(s) if s.product_id==145));
    assert_eq!(rows[0]["booleans"],2);assert_eq!(rows[1]["booleans"],0);
    println!("sdk witness executed: m5_kernel_failure");
}
#[test]
fn issue_7955_m5_real_clip_invocations_and_per_step_timings(){
    let Some((outcomes,rows))=observed(FIXTURE,None,None) else{return};
    assert_eq!(outcomes.len(),14);
    for (id,count) in [(58,3),(89,3),(111,2),(134,2),(145,0),(156,1),(167,0),(178,0),(189,0),(200,1),(216,1)] {
        let row=rows.iter().find(|r|r["id"]==id).unwrap();assert_eq!(row["clips"],count,"#{id}");
        if [145,167,178,189].contains(&id){assert_eq!(row["booleans"],0,"#{id}: no Boolean");}
    }
    let mut times:Vec<_>=rows.iter().flat_map(|r|r["steps"].as_array().unwrap()).map(|c|c["clipMs"].as_f64().unwrap()).collect();
    assert!(times.iter().all(|t|t.is_finite()&&*t>0.));times.sort_by(f64::total_cmp);
    let percentile=|p:f64|times[((times.len() as f64*p).ceil() as usize).saturating_sub(1)];
    let summary=serde_json::json!({"products":rows,"clipMs":{"p50":percentile(0.5),"p95":percentile(0.95)},"scope":"real SDK invocations; not an exclusive performance benchmark"});
    if let Some(path)=std::env::var_os("IFCLITE_M5_TIMINGS"){std::fs::write(path,serde_json::to_vec_pretty(&summary).unwrap()).unwrap();}
    println!("sdk witness executed: m5_clip_timings");
}
#[path = "../../../tests/fixtures/synthetic-retained/m5_chain_source.rs"]
mod chains;
#[test]
fn issue_7955_m5_lineage_boundary_and_atomic_refusal(){
    let mut reference=Vec::new();
    for count in [70,128,129] {
        let Some((outcomes,rows))=observed(&chains::chain(count),Some(vec![22,145]),None) else{return};
        assert_eq!(outcomes.len(),2);
        println!("{count}-chain observations: code={}, booleans={}, clips={}",rows[0]["code"],rows[0]["booleans"],rows[0]["clips"]);
        assert_eq!(rows[0]["booleans"],count);
        if count<=128 {
            assert!(matches!(&outcomes[0],ProductOutcome::Published(s) if s.product_id==22),"{count}: {}",rows[0]["code"]);
        } else {
            let ProductOutcome::Refused{refusal:RetainedProductRefusal::ResourceExhausted,message,..}=&outcomes[0]
                else {panic!("129-chain must refuse atomically: {}",rows[0]["code"])};
            assert!(message.contains("retained dependency depth"),"must identify runtime lineage limit: {message}");
        }
        assert!(matches!(&outcomes[1],ProductOutcome::Published(s) if s.product_id==145));
        reference.push(serde_json::json!({"count":count,"id":22,"code":rows[0]["code"]}));
    }
    if let Some(path)=std::env::var_os("IFCLITE_M5_LINEAGE_REFERENCE"){
        std::fs::write(path,serde_json::to_vec_pretty(&reference).unwrap()).unwrap();
    }
    println!("sdk witness executed: m5_lineage");
}
#[test]
fn issue_7955_m5_burkwil_beam_4548_two_clip_witness(){
    let Some(path)=std::env::var_os("IFCLITE_BURKWIL") else {
        assert!(std::env::var_os("IFCLITE_REQUIRE_BURKWIL").is_none(),"IFCLITE_REQUIRE_BURKWIL set: supply IFCLITE_BURKWIL");
        eprintln!("SKIP M5 BURKWIL #4548: supply local IFC; not corpus evidence");return;
    };
    let text=std::fs::read_to_string(path).unwrap();
    let Some((outcomes,rows))=observed(&text,Some(vec![4548]),None) else{return};
    assert_eq!(outcomes.len(),1);assert_eq!(rows[0]["clips"],2);
    let ProductOutcome::Published(shape)=&outcomes[0] else{panic!("BURKWIL refusal: {}",rows[0]["code"])};
    let mut measurement=metrics::Metrics::default();
    for part in &shape.parts {
        let points:Vec<_>=part.positions.chunks_exact(3).map(|p|metrics::transform(&part.world_from_object,[p[0],p[1],p[2]])).collect();
        measurement.add_mesh(&points,&part.indices).unwrap();
    }
    assert_eq!(measurement.defects,0);
    let sources=ifc_lite_processing::extract_analytic_quantity_sources(text.as_bytes(),None);
    let expected=ifc_lite_retained_native::oracle::clips::ClipOracle::new(&SourceBundle::new(text.as_bytes().to_vec()),&sources).expected(4548).unwrap().unwrap();
    let volume=expected.section_volume().expect("BURKWIL source integral required");
    assert!(metrics::relative(measurement.volume,volume)<1e-6,"{} vs {volume}",measurement.volume);
    println!("sdk witness executed: m5_burkwil");
}
#[test]
fn issue_7955_m5_issue1155_delta_requires_unclipped_profile_admission(){
    let text=include_str!("../../geometry/tests/fixtures/issue_1155_halfspace_flyaway.ifc");
    let uncut=text.replace("'Clipping',(#113212)","'SweptSolid',(#113155)");
    let Some((base,base_rows))=observed(&uncut,Some(vec![113218]),None) else{return};
    let Some((clipped,clip_rows))=observed(text,Some(vec![113218]),None) else{return};
    assert_eq!(base.len(),1);assert_eq!(clipped.len(),1);
    // Spec §2: this profile currently refuses before any Boolean. Pin BOTH
    // outcomes so a new M5 refusal cannot be hidden by a one-way implication.
    for (label,outcome) in [("unclipped",&base[0]),("clipped",&clipped[0])] {
        let ProductOutcome::Refused {refusal,origin,..}=outcome else {panic!("{label}: expected constructor refusal; update both expectations when profile admission lands")};
        assert_eq!(refusal.code(),"operation_unsupported","{label}");
        let origin=origin.as_ref().expect("constructor refusal must retain origin");
        assert_eq!(origin.site,"constructor","{label}");
        assert_eq!(origin.entity,Some(113155),"{label}");
        assert_eq!(origin.cause,"recipe","{label}");
    }
    println!("issue1155 unclipped={}, clipped={}",base_rows[0]["code"],clip_rows[0]["code"]);
    println!("sdk witness executed: m5_issue1155_profile");
}
#[test]
fn issue_7955_m5_clipped_opening_body_real_sdk(){
    let text=FIXTURE.replace("'SweptSolid',(#115)","'CSG',(#505)")
        .replace("ENDSEC;\nEND-ISO","#500=IFCCARTESIANPOINT((0.,0.,1.));#501=IFCAXIS2PLACEMENT3D(#500,$,$);#502=IFCPLANE(#501);#503=IFCHALFSPACESOLID(#502,.T.);#505=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#115,#503);ENDSEC;\nEND-ISO");
    let Some((outcomes,rows))=observed(&text,Some(vec![200]),None) else{return};
    assert_eq!(rows[0]["clips"],2);assert_eq!(rows[0]["booleans"],3);
    let ProductOutcome::Published(shape)=&outcomes[0] else{panic!("clipped opening: {}",rows[0]["code"])};
    let mut measured=metrics::Metrics::default();
    for part in &shape.parts {
        let points:Vec<_>=part.positions.chunks_exact(3).map(|p|metrics::transform(&part.world_from_object,[p[0],p[1],p[2]])).collect();
        measured.add_mesh(&points,&part.indices).unwrap();
    }
    assert_eq!(measured.defects,0);assert!(metrics::relative(measured.volume,35.)<1e-6);
    println!("sdk witness executed: m5_clipped_opening");
}
