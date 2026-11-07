// SPDX-License-Identifier: MPL-2.0
//! #7955, SMLib-free: a typed kernel refusal retires its worker but is that product's own
//! outcome. With the restart budget already at zero the next products still get a worker;
//! lost transport still spends the budget, so a real crash loop still stops.
#![cfg(feature = "retained-runtime")]
use ifc_lite_geometry::document::RetainedCompletion;
use ifc_lite_processing::element::retained_runtime::*;
use std::{cell::Cell, future::Future, rc::Rc, task::{Context, Poll, Waker}};

fn model(products: u32) -> String {
    let mut text = String::from("ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;
#1=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);#6=IFCUNITASSIGNMENT((#1));
#7=IFCPROJECT('0000000000000000000000',$,'SYNTHETIC',$,$,$,$,$,#6);
#10=IFCCARTESIANPOINT((0.,0.,0.));#11=IFCAXIS2PLACEMENT3D(#10,$,$);#12=IFCDIRECTION((0.,0.,1.));#13=IFCLOCALPLACEMENT($,#11);
#14=IFCCARTESIANPOINT((1.,1.));#15=IFCAXIS2PLACEMENT2D(#14,$);#16=IFCRECTANGLEPROFILEDEF(.AREA.,$,#15,2.,2.);
#17=IFCEXTRUDEDAREASOLID(#16,#11,#12,1.);#18=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#17));#19=IFCPRODUCTDEFINITIONSHAPE($,$,(#18));\n");
    for i in 0..products { text += &format!("#{}=IFCMEMBER('{:0>22}',$,$,$,$,#13,#19,$,$);\n", 100 + i, 100 + i); }
    text + "ENDSEC;END-ISO-10303-21;"
}

#[derive(Clone)]
struct Domain(Rc<Cell<usize>>, Rc<Cell<bool>>);
impl ReceiptDomain for Domain {
    fn incarnation(&self) -> Option<u64> { (!self.1.get()).then_some(1) }
    fn retire(&self) { self.0.set(self.0.get() + 1); self.1.set(true); }
    fn same_domain(&self, other: &Self) -> bool { Rc::ptr_eq(&self.1, &other.1) }
}
struct Receipt(Domain, RetainedCompletion);
impl NumericalReceipt for Receipt {
    type Object = usize;
    type Domain = Domain;
    type Error = RuntimeFault;
    fn heap_bytes() -> u64 { std::mem::size_of::<Self>() as u64 }
    fn buffer_bytes(&self) -> Result<u64, RuntimeFault> { Ok(0) }
    fn object(&self) -> usize { 1 }
    fn evidence(&self) -> ReceiptEvidence<'_, usize> { ReceiptEvidence::Construction(&self.1) }
    fn domain(&self) -> &Domain { &self.0 }
    fn validate_live(&self) -> Result<(), RuntimeFault> { Ok(()) }
    fn mesh(&self) -> Option<ReceiptMesh<'_>> { None }
}
struct Peer(Domain, fn() -> RuntimeFault);
impl RetainedRuntime for Peer {
    type Receipt = Receipt;
    fn domain(&self) -> Domain { self.0.clone() }
    fn incarnation(&self) -> u64 { 1 }
}
impl AsyncRetainedExecutor for Peer {
    async fn invoke(&mut self, _: Invocation<'_, Receipt>, _: NumericalLimits) -> Result<Receipt, RuntimeFault> { Err((self.1)()) }
}
fn ready<T>(future: impl Future<Output = T>) -> T {
    let Poll::Ready(value) = std::pin::pin!(future).as_mut().poll(&mut Context::from_waker(Waker::noop()))
        else { panic!("synchronous test peer must settle") };
    value
}
fn codes(fault: fn() -> RuntimeFault, products: u32, max_restarts: u8) -> (Vec<String>, u8) {
    let retired = Rc::new(Cell::new(0));
    let mut outcomes = Vec::new();
    let summary = ready(run_model(ifc_lite_core::SourceBundle::new(model(products).into_bytes()),
        &ModelOptions { max_restarts, ..Default::default() },
        || Ok(Peer(Domain(retired.clone(), Rc::new(Cell::new(false))), fault)),
        |o| outcomes.push(o))).unwrap();
    let codes = outcomes.iter().map(|o| match o {
        ProductOutcome::Refused { refusal, .. } => refusal.code().to_owned(),
        ProductOutcome::Published(_) => "published".to_owned(),
    }).collect();
    (codes, summary.restarts)
}

#[test]
fn typed_kernel_refusals_leave_later_products_a_worker() {
    let (codes, restarts) = codes(|| RuntimeFault::kernel(4, "SMLib status"), 6, 0);
    assert_eq!(codes, vec!["kernel_failure"; 6], "each product its own outcome, none refused unbuilt");
    assert_eq!(restarts, 0);
}

#[test]
fn an_unknown_status_and_lost_transport_still_spend_the_budget() {
    for fault in [(|| RuntimeFault::transport("worker exited")) as fn() -> RuntimeFault, || RuntimeFault::kernel(99, "undefined status")] {
        let (codes, restarts) = codes(fault, 6, 1);
        assert_eq!(restarts, 1, "{codes:?}");
        assert!(codes[2..].iter().all(|c| c == "worker_fault"), "the crash loop stops: {codes:?}");
    }
}
