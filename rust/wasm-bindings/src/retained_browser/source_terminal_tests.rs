// SPDX-License-Identifier: MPL-2.0
//! #7955 R2: owned-source terminal propagation from actual Worker affine copies.
use super::{receipt::BrowserReceipt, BrowserCancellation, BrowserWorker};
use ifc_lite_core::SourceBundle;
use ifc_lite_geometry::{
    resource::{
        self, Cost, ExecutionAccount, ExecutionPolicy, OwnedResourceContext, Reservation,
        ResourceLimits,
    },
    GeometryRouter,
};
use ifc_lite_processing::element::{
    runtime::{AsyncRetainedExecutor, Invocation, NumericalLimits, RetainedRuntime},
    ElementJobKind, ElementMeshJob, MeshProductionOptions, ProductionModel, RetainedExecutionError,
    RuntimeProductExecution,
};
use wasm_bindgen_test::*;
struct ExhaustOnAffine {
    worker: BrowserWorker,
    account: ExecutionAccount,
    held: Option<Reservation>,
    copy_limit: bool,
    tested: bool,
}
impl RetainedRuntime for ExhaustOnAffine {
    type Receipt = BrowserReceipt;
    fn source_face_binding(&self) -> bool {
        true
    }
    fn domain(&self) -> BrowserCancellation {
        self.worker.cancellation()
    }
    fn incarnation(&self) -> u64 {
        self.worker.incarnation()
    }
}
impl AsyncRetainedExecutor for ExhaustOnAffine {
    async fn invoke(
        &mut self,
        call: Invocation<'_, BrowserReceipt>,
        limits: NumericalLimits,
        resources: &OwnedResourceContext,
    ) -> Result<BrowserReceipt, RetainedExecutionError> {
        let affine = matches!(&call, Invocation::Affine { .. });
        if affine {
            let usage = self.account.usage();
            let cost = if self.copy_limit {
                Cost {
                    copy_bytes: 1_000_000 - usage.copy_bytes - 1024,
                    ..Default::default()
                }
            } else {
                Cost {
                    live_bytes: 1_000_000 - usage.live_bytes - 1024,
                    ..Default::default()
                }
            };
            self.held = Some(resources.charge(cost).unwrap());
        }
        let copies = super::mesh_admission::copy_count();
        let result = self.worker.invoke(call, limits, resources).await;
        if affine {
            self.tested = true;
            assert!(
                result.is_err(),
                "J5_R2 next affine refuses original allowance"
            );
            assert_eq!(
                super::mesh_admission::copy_count(),
                copies,
                "J5_R2 affine refusal precedes mesh copy"
            );
            let terminal = self.account.check().unwrap_err();
            assert_eq!(
                resources.check(),
                Err(terminal),
                "J5_R2 captured source terminal survives await"
            );
        }
        result
    }
}
#[wasm_bindgen_test(async)]
async fn retained_browser_j5_owned_affine_low_account_propagates_terminal() {
    for copy_limit in [false, true] {
        let source = SourceBundle::new(super::source_binding_tests::SOURCE.as_bytes().to_vec());
        let mut decoder = source.decoder();
        let router = GeometryRouter::with_units(source.bytes(), &mut decoder);
        let model = ProductionModel::from_source(source.clone());
        let context = model.snapshot(Default::default());
        let entity = decoder.decode_by_id(10).unwrap();
        let job = ElementMeshJob {
            id: 10,
            ifc_type: entity.ifc_type.clone(),
            entity: &entity,
            kind: ElementJobKind::Product,
            element_color: None,
            metadata: None,
        };
        let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits {
            live_bytes: Some(1_000_000),
            copy_bytes: Some(1_000_000),
            ..Default::default()
        }));
        let mut observed = ExhaustOnAffine {
            worker: BrowserWorker::new().unwrap(),
            account: account.clone(),
            held: None,
            copy_limit,
            tested: false,
        };
        observed.worker.require_source_faces();
        observed.worker.qualify_dependencies().await.unwrap();
        let mut execution = account
            .scope(|| {
                RuntimeProductExecution::<BrowserReceipt>::begin(
                    &job,
                    &context,
                    &MeshProductionOptions::default(),
                    &mut decoder,
                    &router,
                )
            })
            .unwrap();
        let limits = NumericalLimits {
            chord_metres: 0.001,
            angle_degrees: 5.,
            max_bytes: 16 << 20,
        };
        loop {
            let issued = execution
                .issue_next(&mut decoder, &router, &observed)
                .unwrap()
                .unwrap();
            match issued.execute_async(&mut observed, limits).await {
                Ok(receipt) => execution
                    .accept(receipt, &mut decoder, &router)
                    .unwrap_or_else(|e| panic!("{}", e.reason)),
                Err(rejected) => {
                    assert!(rejected.issued.is_none());
                    break;
                }
            }
        }
        assert!(observed.tested);
        let terminal = account.check().unwrap_err();
        assert!(matches!(
            terminal,
            resource::ProgramStop::ResourceRefused(_)
        ));
        assert_eq!(observed.worker.incarnation(), 0);
        // The original source/controller retains its first fault outside every
        // ambient account and after the actual Worker operation has retired.
        assert!(
            matches!(execution.issue_next(&mut decoder, &router, &observed),
            Err(RetainedExecutionError::Stopped(stop)) if stop == terminal)
        );
    }
}
