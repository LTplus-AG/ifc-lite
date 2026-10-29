// SPDX-License-Identifier: MPL-2.0
//! #7955: real source admission with a peer that cannot fabricate geometry.
use super::super::session_tests::{job, metadata, options, SOURCE};
use super::runtime::{
    AsyncRetainedExecutor, Invocation, NumericalLimits, ReceiptEvidence, RuntimeFault,
    RuntimeFaultKind,
};
use super::*;
use std::{
    cell::Cell,
    future::Future,
    rc::Rc,
    task::{Context, Poll, Waker},
};

#[derive(Clone)]
struct Domain(Rc<Cell<bool>>);
impl ReceiptDomain for Domain {
    fn incarnation(&self) -> Option<u64> {
        self.0.get().then_some(1)
    }
    fn retire(&self) {
        self.0.set(false);
    }
    fn same_domain(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.0, &other.0)
    }
}
enum InertReceipt {}
impl NumericalReceipt for InertReceipt {
    type Object = ();
    type Domain = Domain;
    type Error = RuntimeFault;
    fn heap_bytes() -> u64 {
        0
    }
    fn buffer_bytes(&self) -> Result<u64, RuntimeFault> {
        match *self {}
    }
    fn object(&self) {
        match *self {}
    }
    fn evidence(&self) -> ReceiptEvidence<'_, ()> {
        match *self {}
    }
    fn domain(&self) -> &Domain {
        match *self {}
    }
    fn validate_live(&self) -> Result<(), RuntimeFault> {
        match *self {}
    }
}
struct InertPeer {
    domain: Domain,
    suspend: bool,
    fault: RuntimeFaultKind,
    invocations: usize,
}
impl InertPeer {
    fn new(suspend: bool) -> Self {
        Self {
            domain: Domain(Rc::new(Cell::new(true))),
            suspend,
            fault: RuntimeFaultKind::Transport,
            invocations: 0,
        }
    }
}
impl RetainedRuntime for InertPeer {
    type Receipt = InertReceipt;
    fn domain(&self) -> Domain {
        self.domain.clone()
    }
    fn incarnation(&self) -> u64 {
        1
    }
}
impl AsyncRetainedExecutor for InertPeer {
    async fn invoke(
        &mut self,
        call: Invocation<'_, InertReceipt>,
        _: NumericalLimits,
    ) -> Result<InertReceipt, RuntimeFault> {
        self.invocations += 1;
        assert!(
            matches!(call, Invocation::Construction(_)),
            "real extrusion admission"
        );
        assert!(
            resource::current_account().is_none(),
            "no resource TLS crosses await"
        );
        if self.suspend {
            std::future::pending::<()>().await;
        }
        Err(RuntimeFault {
            kind: self.fault,
            message: "inert peer closed".into(),
        })
    }
}
fn limits() -> NumericalLimits {
    NumericalLimits {
        chord_metres: 0.001,
        angle_degrees: 5.,
        max_bytes: 16 * 1024 * 1024,
    }
}
fn with_execution<T>(
    run: impl FnOnce(
        &mut RuntimeProductExecution<'_, InertReceipt>,
        &mut EntityDecoder<'_>,
        &GeometryRouter,
    ) -> T,
) -> T {
    let source = ifc_lite_core::SourceBundle::new(SOURCE.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(SOURCE, &mut decoder);
    let context = ProductionModel::from_source(source.clone()).snapshot(Default::default());
    let entity = decoder.decode_by_id(10).unwrap();
    let metadata = metadata(10);
    let job = job(&entity, &metadata);
    let mut execution =
        RuntimeProductExecution::begin(&job, &context, &options(), &[], None, &mut decoder, &router).unwrap();
    run(&mut execution, &mut decoder, &router)
}

#[test]
fn issue_7955_dispatch_fault_cannot_publish_and_retires_only_original_domain() {
    with_execution(|execution, decoder, router| {
        let mut peer = InertPeer::new(false);
        let foreign = InertPeer::new(false);
        let issued = execution
            .issue_next(decoder, router, &peer)
            .unwrap()
            .unwrap();
        let cancellation = issued.cancellation.clone();
        let mut future = Box::pin(issued.execute_async(&mut peer, limits()));
        let mut cx = Context::from_waker(Waker::noop());
        let Poll::Ready(Err(rejected)) = future.as_mut().poll(&mut cx) else {
            panic!("inert fault must settle")
        };
        assert_eq!(rejected.reason.refusal().0.code(), "worker_fault");
        assert!(rejected.issued.is_none());
        drop(future);
        assert!(peer.domain.incarnation().is_none());
        assert!(!cancellation.controller_retired(), "faults require charged recovery");
        assert!(foreign.domain.incarnation().is_some());
        assert_eq!(execution.discharged_count(), 0);
        assert!(execution.validate_witness().is_err());
    });
}

#[test]
fn issue_7955_abandoned_async_invocation_retires_domain_without_publishing() {
    with_execution(|execution, decoder, router| {
        let mut peer = InertPeer::new(true);
        let issued = execution
            .issue_next(decoder, router, &peer)
            .unwrap()
            .unwrap();
        let cancellation = issued.cancellation.clone();
        let mut future = Box::pin(issued.execute_async(&mut peer, limits()));
        assert!(future
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
            .is_pending());
        assert!(resource::current_account().is_none());
        drop(future);
        assert!(peer.domain.incarnation().is_none());
        assert!(cancellation.controller_retired(), "the controller retired in-flight work");
        assert_eq!(execution.discharged_count(), 0);
        assert!(execution.validate_witness().is_err());
    });
}

#[test]
fn issue_7955_invalid_limits_preserve_original_packet_until_drop() {
    with_execution(|execution, decoder, router| {
        let mut peer = InertPeer::new(false);
        let issued = execution
            .issue_next(decoder, router, &peer)
            .unwrap()
            .unwrap();
        let mut future = Box::pin(issued.execute_async(
            &mut peer,
            NumericalLimits {
                max_bytes: 0,
                ..limits()
            },
        ));
        let Poll::Ready(Err(rejected)) = future
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
        else {
            panic!("invalid limits must settle")
        };
        drop(future);
        assert_eq!(rejected.reason.refusal().0.code(), "contract_breach");
        assert!(rejected.issued.is_some());
        assert!(peer.domain.incarnation().is_some());
        drop(rejected);
        assert!(peer.domain.incarnation().is_none());
    });
}

#[test]
fn issue_7955_owned_storage_is_released_without_billing_foreign_account() {
    let account =
        resource::ExecutionAccount::new(resource::ExecutionPolicy::Bounded(Default::default()));
    let resources = account.scope(OwnedResourceContext::capture_current);
    let mut storage = Storage::default();
    let mut buffer = Vec::<u64>::new();
    storage.reserve(&resources, &mut buffer, 32).unwrap();
    assert!(account.usage().live_bytes >= 256);
    let foreign =
        resource::ExecutionAccount::new(resource::ExecutionPolicy::Bounded(Default::default()));
    foreign.scope(|| drop((buffer, storage)));
    assert_eq!(account.usage().live_bytes, 0);
    assert_eq!(foreign.usage(), resource::Usage::default());
}

#[test]
fn issue_7955_real_material_layer_job_refuses_before_numerical_admission() {
    let text = SOURCE.replace("ENDSEC;END-ISO-10303-21;", "#80=IFCMATERIALLAYER($,0.1,$);#81=IFCMATERIALLAYER($,0.2,$);#82=IFCMATERIALLAYERSET((#80,#81),'layers');#83=IFCMATERIALLAYERSETUSAGE(#82,.AXIS2.,.POSITIVE.,0.);#84=IFCRELASSOCIATESMATERIAL('m',$,$,$,(#10),#83);ENDSEC;END-ISO-10303-21;");
    let text=text.replace("(#12));","(#12,#9001));").replace("ENDSEC;END-ISO","#9000=IFCPOLYLINE((#4,#8,#4));#9001=IFCSHAPEREPRESENTATION(#2,'Axis','Curve2D',(#9000));ENDSEC;END-ISO");
    let source = ifc_lite_core::SourceBundle::new(text.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let mut router = GeometryRouter::with_units(&text, &mut decoder);
    router.set_material_layer_index(Arc::new(
        ifc_lite_geometry::MaterialLayerIndex::from_content(&text, &mut decoder),
    ));
    assert!(
        router.is_material_layer_sliceable(10),
        "fixture must reach the material-layer strategy"
    );
    let context = ProductionModel::from_source(source.clone()).snapshot(Default::default());
    let entity = decoder.decode_by_id(10).unwrap();
    let metadata = metadata(10);
    let job = job(&entity, &metadata);
    let usages = ifc_lite_geometry::program::transactions::LayerUsages::from_content(text.as_bytes(), &mut decoder);
    let layers = layers::admit(&entity, &router, &usages, &mut decoder).unwrap();
    let error = RuntimeProductExecution::<InertReceipt>::begin(
        &job,
        &context,
        &options(),
        &[],
        layers,
        &mut decoder,
        &router,
    )
    .err()
    .expect("unsupported Axis must refuse before a worker");
    assert_eq!(error.refusal().0.code(), "material_layer_strategy");
}

#[test]
fn issue_7955_real_opening_job_admits_host_before_opening_body() {
    let text = SOURCE.replace(
        "ENDSEC;END-ISO-10303-21;",
        "#30=IFCOPENINGELEMENT('o',$,$,$,$,#19,#21,$,$);ENDSEC;END-ISO-10303-21;",
    );
    let source = ifc_lite_core::SourceBundle::new(text.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(&text, &mut decoder);
    let context = ProductionModel::from_source(source.clone()).snapshot(OwnedMeshProductionData {
        void_index: Arc::new([(10, vec![30])].into_iter().collect()),
        ..Default::default()
    });
    let entity = decoder.decode_by_id(10).unwrap();
    let metadata = metadata(10);
    let job = job(&entity, &metadata);
    let openings = [decoder.decode_by_id(30).unwrap()];
    let mut execution = RuntimeProductExecution::<InertReceipt>::begin(
        &job,
        &context,
        &options(),
        &openings,
        None,
        &mut decoder,
        &router,
    )
    .unwrap();
    assert!(execution.advance_source(&mut decoder, &router).unwrap());
}

// #7955: a settled contract fault disarms a numerical packet.
#[test]
fn completed_contract_fault_keeps_worker_live_but_midflight_drop_retires_it() {
    for suspend in [false, true] {
        let domain = with_execution(|execution, decoder, router| {
            let mut peer = InertPeer::new(suspend);
            peer.fault = RuntimeFaultKind::Contract;
            let domain = peer.domain();
            let issued = execution
                .issue_next(decoder, router, &peer)
                .unwrap()
                .unwrap();
            let mut future = Box::pin(issued.execute_async(&mut peer, limits()));
            let result = future
                .as_mut()
                .poll(&mut Context::from_waker(Waker::noop()));
            if suspend {
                assert!(result.is_pending());
            } else {
                let Poll::Ready(Err(rejected)) = result else {
                    panic!("contract fault must settle");
                };
                assert_eq!(rejected.reason.refusal().0.code(), "contract_breach");
                assert!(rejected.issued.is_none());
            }
            drop(future);
            assert_eq!(domain.incarnation().is_some(), !suspend);
            assert_eq!(execution.discharged_count(), 0);
            assert!(execution.validate_witness().is_err());
            domain
        });
        // Dropping the refused product execution itself must not retire a
        // domain whose contract fault already settled.
        assert_eq!(
            domain.incarnation().is_some(),
            !suspend,
            "after the execution drops"
        );
    }
}

// #7955: a final affine has no mesh publication operation in M1. Even an
// earlier construction in this product must not reach the numerical peer.
#[test]
fn final_affine_refuses_before_invocation_and_preserves_the_existing_worker() {
    let text = include_str!("../../../../geometry/tests/fixtures/issue_1985_scaled_kinds.ifc");
    let source = ifc_lite_core::SourceBundle::new(text.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(text, &mut decoder);
    let context = ProductionModel::from_source(source.clone()).snapshot(Default::default());
    let entity = decoder.decode_by_id(74).unwrap();
    let metadata = metadata(74);
    let job = job(&entity, &metadata);
    let mut peer = InertPeer::new(false);
    let domain = peer.domain();
    let result = RuntimeProductExecution::<InertReceipt>::begin(
        &job,
        &context,
        &options(),
        &[],
        None,
        &mut decoder,
        &router,
    );
    let error = match result {
        Err(error) => error,
        Ok(mut execution) => {
            let issued = execution
                .issue_next(&mut decoder, &router, &peer)
                .unwrap()
                .unwrap();
            let mut future = Box::pin(issued.execute_async(&mut peer, limits()));
            let _ = future
                .as_mut()
                .poll(&mut Context::from_waker(Waker::noop()));
            panic!("affine final value reached dispatch");
        }
    };
    assert_eq!(error.refusal().0.code(), "incomplete");
    assert_eq!(peer.invocations, 0);
    assert!(peer.domain().same_domain(&domain));
    assert!(
        domain.incarnation().is_some(),
        "no retirement or restart needed"
    );
}

// #7955 / #8183: instanced type maps cannot borrow orphan placement authority.
#[test]
fn instanced_type_map_refuses_before_invocation_without_restarting_worker() {
    let source = ifc_lite_core::SourceBundle::new(SOURCE.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(SOURCE, &mut decoder);
    let context = ProductionModel::from_source(source.clone()).snapshot(Default::default());
    let entity = decoder.decode_by_id(60).unwrap();
    let metadata = metadata(60);
    let mut job = job(&entity, &metadata);
    job.kind = ElementJobKind::TypeProduct { rep_maps: vec![(61, 2), (71, 2)] };
    let peer = InertPeer::new(false);
    let domain = peer.domain();
    let mut worker = Some(peer);
    let acquired = Cell::new(0);
    let mut acquire = || {
        acquired.set(acquired.get() + 1);
        Ok(InertPeer::new(false))
    };
    let mut future = Box::pin(async {
        let execution = RuntimeProductExecution::<InertReceipt>::begin(
            &job,
            &context,
            &options(),
            &[],
            None,
            &mut decoder,
            &router,
        )?;
        super::drive::drive(
            execution,
            &mut decoder,
            &router,
            &mut worker,
            &mut acquire,
            limits(),
            &mut super::model::ProductObservation::new(60),
        )
        .await
    });
    let Poll::Ready(Err(error)) = future
        .as_mut()
        .poll(&mut Context::from_waker(Waker::noop()))
    else {
        panic!("instanced type geometry must refuse synchronously");
    };
    assert_eq!(error.refusal().0.code(), "incomplete");
    drop(future);
    let peer = worker.as_ref().expect("healthy worker stays available");
    assert_eq!(peer.invocations, 0);
    assert_eq!(acquired.get(), 0, "no restart");
    assert!(peer.domain().same_domain(&domain));
    assert!(domain.incarnation().is_some());
}

// #7955 M9: prove admission reaches transport without fabricating a receipt.
#[test]
fn orphan_type_map_reaches_its_first_invocation() {
    let source = ifc_lite_core::SourceBundle::new(SOURCE.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(SOURCE, &mut decoder);
    let context = ProductionModel::from_source(source.clone()).snapshot(Default::default());
    let job = super::super::session_tests::type_job(&mut decoder, &[61, 71]);
    let mut peer = InertPeer::new(true);
    let mut execution = RuntimeProductExecution::<InertReceipt>::begin(
        job, &context, &options(), &[], None, &mut decoder, &router).unwrap();
    let issued = execution.issue_next(&mut decoder, &router, &peer).unwrap().unwrap();
    let mut future = Box::pin(issued.execute_async(&mut peer, limits()));
    assert!(future.as_mut().poll(&mut Context::from_waker(Waker::noop())).is_pending());
    drop(future);
    assert_eq!(peer.invocations, 1);
}

#[test]
fn issue_7955_mismatched_opening_attributes_refuse_source_changed() {
    let text = SOURCE.replace(
        "ENDSEC;END-ISO-10303-21;",
        "#30=IFCOPENINGELEMENT('o',$,$,$,$,#19,#21,$,$);ENDSEC;END-ISO-10303-21;",
    );
    let source = ifc_lite_core::SourceBundle::new(text.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(&text, &mut decoder);
    let context = ProductionModel::from_source(source.clone()).snapshot(OwnedMeshProductionData {
        void_index: Arc::new([(10, vec![30])].into_iter().collect()),
        ..Default::default()
    });
    let entity = decoder.decode_by_id(10).unwrap();
    let metadata = metadata(10);
    let job = job(&entity, &metadata);
    let foreign = ifc_lite_core::SourceBundle::new(text.as_bytes().to_vec());
    let openings = [foreign.decoder().decode_by_id(30).unwrap()];
    let error = RuntimeProductExecution::<InertReceipt>::begin(
        &job,
        &context,
        &options(),
        &openings,
        None,
        &mut decoder,
        &router,
    )
    .err().expect("foreign opening source allocation");
    assert_eq!(error.refusal().0.code(), "source_changed");
}

// #7955: a completion's stage proves whether an operation can still be running.
// Exercise the shared acceptance rule for both source changes and resource stops.
#[test]
fn settled_completion_stops_preserve_worker_but_undelivered_stops_cancel() {
    for stage in [ISSUED, EXECUTING, DELIVERED, ACCEPTED] {
        for reason in [RetainedExecutionError::Source(RetainedContextError::Stale),
            RetainedExecutionError::Stopped(ProgramStop::Cancelled)] {
            let resources = OwnedResourceContext::capture_current();
            let peer = InertPeer::new(false);
            let foreign = InertPeer::new(false);
            let cancellation = RuntimeCancellation::<InertReceipt> {
                stage: Arc::new(batch::StageState::new(&resources).unwrap()),
                owner: peer.domain(),
            };
            cancellation.stage.store(stage, Ordering::Release);
            cancellation.refuse_completion(&reason);
            let settled = matches!(stage, DELIVERED | ACCEPTED);
            assert_eq!(peer.domain.incarnation().is_some(), settled);
            assert_eq!(cancellation.controller_retired(), !settled);
            assert!(foreign.domain.incarnation().is_some(), "never retire a foreign envelope");
        }
    }
}

#[test]
fn settled_completion_fault_is_charged_and_cancelled_program_is_not_a_source_stop() {
    with_execution(|execution, decoder, router| {
        let peer = InertPeer::new(false);
        let issued = execution.issue_next(decoder, router, &peer).unwrap().unwrap();
        let cancellation = issued.cancellation.clone();
        // The real common program's use-after-cancel is protocol misuse.
        let program = execution.program.as_mut().unwrap();
        program.cancel();
        let reason = common(program.request().unwrap_err());
        assert!(matches!(&reason, RetainedExecutionError::Common(error)
            if error.kind() == ifc_lite_geometry::program::transactions::TransactionFailureKind::Cancelled));
        assert!(!reason.controller_cancelled());
        cancellation.stage.store(ACCEPTED, Ordering::Release);
        cancellation.refuse_completion(&reason);
        assert!(peer.domain.incarnation().is_none());
        assert!(!cancellation.controller_retired(), "protocol faults stay charged");
        drop(issued);
        assert!(!cancellation.controller_retired(), "later packet drop cannot relabel a fault");
    });
}

// #7955: preserving settled M4 refusals must not change non-layer recovery.
#[test]
fn non_layer_kernel_refusals_still_retire_the_original_domain() {
    for status in [1,4,7,8] {
        with_execution(|execution, decoder, router| {
            let mut peer = InertPeer::new(false);
            peer.fault = RuntimeFaultKind::Kernel { status };
            let issued = execution.issue_next(decoder, router, &peer).unwrap().unwrap();
            let cancellation = issued.cancellation.clone();
            let mut future = Box::pin(issued.execute_async(&mut peer, limits()));
            let Poll::Ready(Err(rejected)) = future.as_mut().poll(&mut Context::from_waker(Waker::noop())) else {
                panic!("kernel refusal must settle");
            };
            assert_eq!(rejected.reason.refusal().0.code(), "kernel_failure");
            drop(future);
            assert!(peer.domain.incarnation().is_none());
            assert!(!cancellation.controller_retired());
            assert_eq!(execution.discharged_count(), 0);
            assert!(execution.validate_witness().is_err());
        });
    }
}
