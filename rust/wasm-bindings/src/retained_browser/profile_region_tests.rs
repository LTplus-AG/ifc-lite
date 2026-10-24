// SPDX-License-Identifier: MPL-2.0
use super::{BrowserWorker, BrowserCancellation, receipt::BrowserReceipt};
use ifc_lite_core::SourceBundle;
use ifc_lite_geometry::GeometryRouter;
use ifc_lite_processing::element::{ElementJobKind, ElementMeshJob, MeshProductionOptions,
    ProductionModel, RuntimeProductExecution, RetainedExecutionError, runtime::{NumericalLimits,
        AsyncRetainedExecutor, RetainedRuntime, Invocation}};
use wasm_bindgen_test::*;
#[path = "../../../processing/tests/support/profile_region_witness.rs"]
mod oracle;

struct Observed { worker: BrowserWorker, checked: usize }
impl RetainedRuntime for Observed {
    type Receipt = BrowserReceipt;
    fn domain(&self) -> BrowserCancellation { self.worker.cancellation() }
    fn incarnation(&self) -> u64 { self.worker.incarnation() }
}
impl AsyncRetainedExecutor for Observed {
    async fn invoke(&mut self, call: Invocation<'_, Self::Receipt>, limits: NumericalLimits,
        resources: &ifc_lite_geometry::resource::OwnedResourceContext) -> Result<Self::Receipt, RetainedExecutionError> {
        let result = self.worker.invoke(call, limits, resources).await?;
        if let BrowserReceipt::Construction(value) = &result {
            oracle::check(value.completion());
            self.checked += 1;
        }
        Ok(result)
    }
}

#[wasm_bindgen_test(async)]
async fn retained_browser_issue_3641_original_source_construction_oracle() {
    for rtc in [(0.,0.,0.), (1e6,-2e6,3e6)] {
        let source = SourceBundle::new(oracle::FIXTURE.to_vec());
        let mut decoder = source.decoder().with_strict_reals();
        let mut router = GeometryRouter::with_units(source.bytes(), &mut decoder);
        router.set_rtc_offset(rtc);
        let model = ProductionModel::from_source(source.clone());
        let context = model.snapshot(Default::default());
        let entity = decoder.decode_by_id(72245).unwrap();
        let job = ElementMeshJob { id: entity.id, ifc_type: entity.ifc_type.clone(), entity: &entity,
            kind: ElementJobKind::Product, element_color: None, metadata: None };
        let mut worker = Observed { worker: BrowserWorker::new().unwrap(), checked: 0 };
        worker.worker.qualify().await.unwrap();
        let mut execution = RuntimeProductExecution::<BrowserReceipt>::begin(&job,&context,
            &MeshProductionOptions::default(),&mut decoder,&router).unwrap();
        let issued = execution.issue_next(&mut decoder,&router,&worker).unwrap().unwrap();
        let completed = issued.execute_async(&mut worker, NumericalLimits {
            chord_metres: 0.001, angle_degrees: 5., max_bytes: 16 << 20,
        }).await.unwrap();
        assert_eq!(worker.checked, 1);
        execution.accept(completed,&mut decoder,&router).unwrap_or_else(|e| panic!("{}",e.reason));
        assert!(execution.issue_next(&mut decoder,&router,&worker).unwrap().is_none());
        let witness = execution.into_witness().unwrap();
        witness.validate().unwrap();
        assert!(!witness.plan().remaining.is_empty());
        model.invalidate_source();
        assert!(witness.validate().is_err());
    }
}
