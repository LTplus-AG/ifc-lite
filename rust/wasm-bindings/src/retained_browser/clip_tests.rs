// SPDX-License-Identifier: MPL-2.0
//! #7955 actual module Worker through RuntimeProductExecution (UNRUN until parent qualification).
use super::{BrowserWorker, BrowserCancellation};
use super::receipt::BrowserReceipt;
use ifc_lite_core::SourceBundle;
use ifc_lite_geometry::{GeometryRouter, resource::OwnedResourceContext};
use ifc_lite_processing::element::{ElementJobKind, ElementMeshJob, MeshProductionOptions,
    ProductionModel, RetainedExecutionError, RuntimeProductExecution, runtime::{
    AsyncRetainedExecutor, Invocation, NumericalLimits, RetainedRuntime}};
use wasm_bindgen_test::*;
struct Observed {
    worker: BrowserWorker,
    last: Option<(Vec<f64>,Vec<u32>,[f64;16])>,
    stop: Option<std::sync::Arc<ifc_lite_geometry::resource::ExecutionAccount>>,
}
impl RetainedRuntime for Observed {
    type Receipt=BrowserReceipt;
    fn domain(&self)->BrowserCancellation {self.worker.cancellation()}
    fn incarnation(&self)->u64 {self.worker.incarnation()}
}
impl AsyncRetainedExecutor for Observed {
    async fn invoke(&mut self, call: Invocation<'_,BrowserReceipt>, limits: NumericalLimits,
        resources: &OwnedResourceContext)->Result<BrowserReceipt,RetainedExecutionError> {
        let receipt=self.worker.invoke(call,limits,resources).await?;
        match &receipt {
            BrowserReceipt::UnaryClip(value)=>self.last=Some((value.mesh.positions.clone(),value.mesh.indices.clone(),value.frame)),
            BrowserReceipt::Boolean(value)=>self.last=Some((value.mesh.positions.clone(),value.mesh.indices.clone(),value.world_from_left)),
            _=>{}
        }
        if matches!(receipt, BrowserReceipt::UnaryClip(_)) {
            if let Some(account)=&self.stop {account.cancel();}
        }
        Ok(receipt)
    }
}
#[wasm_bindgen_test(async)]
async fn j1_worker_shared_clip_cases_volume_bounds_centroid() {
    for case in ifc_lite_testkit::retained_clip::cases() {
        let text = if case.name == "affine_of_clip" {
            case.source.replace("'CSG',(#314)","'CSG',(#413)")
                .replace("ENDSEC;END-ISO", "#413=IFCBOOLEANRESULT(.UNION.,#314,#414);#414=IFCBOOLEANRESULT(.DIFFERENCE.,#113,#113);ENDSEC;END-ISO")
        } else {case.source.clone()};
        let source=SourceBundle::new(text.into_bytes());
        let mut decoder=source.decoder().with_strict_reals();
        let router=GeometryRouter::with_units(source.bytes(),&mut decoder);
        let model=ProductionModel::from_source(source.clone());
        let context=model.snapshot(Default::default());
        let entity=decoder.decode_by_id(10).unwrap();
        let job=ElementMeshJob {id:10,ifc_type:entity.ifc_type.clone(),entity:&entity,
            kind:ElementJobKind::Product,element_color:None,metadata:None};
        let mut observed=Observed {worker:BrowserWorker::new().unwrap(),last:None,stop:None};
        observed.worker.qualify_dependencies().await.unwrap();
        let mut execution=RuntimeProductExecution::<BrowserReceipt>::begin(&job,&context,
            &MeshProductionOptions::default(),&mut decoder,&router).unwrap();
        let limits=NumericalLimits {chord_metres:0.001,angle_degrees:5.,max_bytes:16<<20};
        while let Some(issued)=execution.issue_next(&mut decoder,&router,&observed).unwrap() {
            let completed=issued.execute_async(&mut observed,limits).await.unwrap();
            execution.accept(completed,&mut decoder,&router).unwrap_or_else(|e|panic!("{}",e.reason));
        }
        let witness=execution.into_witness().unwrap(); witness.validate().unwrap();
        let (positions,indices,frame)=observed.last.as_ref().unwrap();
        ifc_lite_testkit::retained_clip::assert_geometry(&case,positions,indices,frame);
        assert!(witness.require_final_product().is_err());
        model.invalidate_source(); assert!(witness.validate().is_err());
    }
}

#[wasm_bindgen_test(async)]
async fn j1_worker_shared_clip_empty_and_post_await_stop() {
    use ifc_lite_geometry::resource::{ExecutionAccount,ExecutionPolicy};
    for cancel in [false,true] {
        let text=ifc_lite_testkit::retained_clip::SOURCE.replace("((0.,0.,1.));#201","((0.,0.,4.));#201");
        let source=SourceBundle::new(text.into_bytes());let mut decoder=source.decoder();
        let router=GeometryRouter::with_units(source.bytes(),&mut decoder);
        let model=ProductionModel::from_source(source.clone());let context=model.snapshot(Default::default());
        let entity=decoder.decode_by_id(10).unwrap();
        let job=ElementMeshJob {id:10,ifc_type:entity.ifc_type.clone(),entity:&entity,
            kind:ElementJobKind::Product,element_color:None,metadata:None};
        let account=std::sync::Arc::new(ExecutionAccount::new(ExecutionPolicy::Bounded(Default::default())));
        let mut observed=Observed {worker:BrowserWorker::new().unwrap(),last:None,stop:cancel.then(||account.clone())};
        observed.worker.qualify_dependencies().await.unwrap();
        let other=BrowserWorker::new().unwrap();let owner=observed.worker.cancellation();
        let mut execution=account.scope(||RuntimeProductExecution::<BrowserReceipt>::begin(&job,&context,
            &MeshProductionOptions::default(),&mut decoder,&router)).unwrap();
        let limits=NumericalLimits {chord_metres:0.001,angle_degrees:5.,max_bytes:16<<20};
        let first=execution.issue_next(&mut decoder,&router,&observed).unwrap().unwrap().execute_async(&mut observed,limits).await.unwrap();
        execution.accept(first,&mut decoder,&router).unwrap_or_else(|e|panic!("{}",e.reason));
        let second=execution.issue_next(&mut decoder,&router,&observed).unwrap().unwrap().execute_async(&mut observed,limits).await;
        if cancel {
            let rejected=second.err().expect("actual Worker clip stop must refuse delivery");
            assert!(rejected.issued.is_none());assert!(owner.incarnation().is_none());
            assert!(other.cancellation().incarnation().is_some());assert_eq!(execution.discharged_count(),1);
        } else {
            let completed=second.unwrap();assert!(completed.realizations()[0].is_empty());
            execution.accept(completed,&mut decoder,&router).unwrap_or_else(|e|panic!("{}",e.reason));
            assert!(execution.issue_next(&mut decoder,&router,&observed).unwrap().is_none());
            let witness=execution.into_witness().unwrap();assert!(witness.plan().values[0].is_empty());
            assert!(witness.require_final_product().is_err());
        }
    }
}
