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
    fn buffer_bytes(&self) -> Result<u64, RetainedExecutionError> {
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
}
impl InertPeer {
    fn new(suspend: bool) -> Self {
        Self {
            domain: Domain(Rc::new(Cell::new(true))),
            suspend,
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
    ) -> Result<InertReceipt, RetainedExecutionError> {
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
            kind: RuntimeFaultKind::Transport,
            message: "inert peer closed".into(),
        }
        .into())
    }
}
fn limits() -> NumericalLimits {
    NumericalLimits {
        chord_metres: 0.001,
        angle_degrees: 5.,
        max_bytes: 16 * 1024 * 1024,
    }
}
fn with_execution(
    run: impl FnOnce(
        &mut RuntimeProductExecution<'_, InertReceipt>,
        &mut EntityDecoder<'_>,
        &GeometryRouter,
    ),
) {
    let source = ifc_lite_core::SourceBundle::new(SOURCE.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(SOURCE, &mut decoder);
    let context = ProductionModel::from_source(source.clone()).snapshot(Default::default());
    let entity = decoder.decode_by_id(10).unwrap();
    let metadata = metadata(10);
    let job = job(&entity, &metadata);
    let mut execution =
        RuntimeProductExecution::begin(&job, &context, &options(), &mut decoder, &router).unwrap();
    run(&mut execution, &mut decoder, &router);
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
        let mut future = Box::pin(issued.execute_async(&mut peer, limits()));
        let mut cx = Context::from_waker(Waker::noop());
        let Poll::Ready(Err(rejected)) = future.as_mut().poll(&mut cx) else {
            panic!("inert fault must settle")
        };
        assert_eq!(rejected.reason.refusal().0.code(), "worker_fault");
        assert!(rejected.issued.is_none());
        drop(future);
        assert!(peer.domain.incarnation().is_none());
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
        let mut future = Box::pin(issued.execute_async(&mut peer, limits()));
        assert!(future
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
            .is_pending());
        assert!(resource::current_account().is_none());
        drop(future);
        assert!(peer.domain.incarnation().is_none());
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
    let error = RuntimeProductExecution::<InertReceipt>::begin(
        &job,
        &context,
        &options(),
        &mut decoder,
        &router,
    )
    .err()
    .expect("layers require a separate retained strategy");
    assert_eq!(error.refusal().0.code(), "material_layer_strategy");
}

#[test]
fn issue_7955_real_opening_job_refuses_before_numerical_admission() {
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
    let error = RuntimeProductExecution::<InertReceipt>::begin(
        &job,
        &context,
        &options(),
        &mut decoder,
        &router,
    )
    .err()
    .expect("openings require a separate retained strategy");
    assert_eq!(error.refusal().0.code(), "opening_strategy");
}
