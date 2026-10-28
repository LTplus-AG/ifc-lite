// SPDX-License-Identifier: MPL-2.0
//! #7955: lifecycle invariants, not numerical SDK qualification. A counted
//! rectangle peer supplies box receipts; source admission/publication are real.
use super::*;
use super::runtime::*;
use ifc_lite_geometry::document::{RetainedCompletion, RetainedTessellation};
use std::{cell::Cell, future::Future, rc::Rc, task::{Context, Poll, Waker}};

const CASCADE: &str = include_str!("../../../../../tests/fixtures/synthetic-retained/refusal-cascade.ifc");
#[derive(Default)]
struct Counts { retired: Cell<usize>, live: Cell<usize>, calls: Cell<usize> }
#[derive(Clone)]
struct Domain(Rc<Counts>);
impl ReceiptDomain for Domain {
    fn incarnation(&self) -> Option<u64> { (self.0.retired.get() == 0).then_some(1) }
    fn retire(&self) { self.0.retired.set(self.0.retired.get() + 1); }
    fn same_domain(&self, other: &Self) -> bool { Rc::ptr_eq(&self.0, &other.0) }
}
struct Receipt { domain: Domain, completion: RetainedCompletion, id: usize, oversized: bool }
impl Drop for Receipt {
    fn drop(&mut self) { self.domain.0.live.set(self.domain.0.live.get() - 1); }
}
impl NumericalReceipt for Receipt {
    type Object = usize;
    type Domain = Domain;
    type Error = RuntimeFault;
    fn heap_bytes() -> u64 { std::mem::size_of::<Self>() as u64 }
    fn buffer_bytes(&self) -> Result<u64, RuntimeFault> { Ok(if self.oversized { u64::MAX } else { 1024 }) }
    fn object(&self) -> usize { self.id }
    fn evidence(&self) -> ReceiptEvidence<'_, usize> { ReceiptEvidence::Construction(&self.completion) }
    fn domain(&self) -> &Domain { &self.domain }
    fn validate_live(&self) -> Result<(), RuntimeFault> {
        self.domain.incarnation().map(|_| ()).ok_or_else(|| RuntimeFault::retired("test peer retired"))
    }
    fn mesh(&self) -> Option<ReceiptMesh<'_>> {
        let m = &self.completion.tessellation;
        Some(ReceiptMesh { positions: &m.positions, indices: &m.indices, faces: &m.revision_local_faces })
    }
}
struct Peer(Domain, bool);
impl RetainedRuntime for Peer {
    type Receipt = Receipt;
    fn domain(&self) -> Domain { self.0.clone() }
    fn incarnation(&self) -> u64 { self.0.incarnation().unwrap_or(0) }
}
impl AsyncRetainedExecutor for Peer {
    async fn invoke(&mut self, call: Invocation<'_, Receipt>, _: NumericalLimits) -> Result<Receipt, RuntimeFault> {
        assert_eq!(self.0.0.live.get(), 0, "previous refused product released every receipt");
        let Invocation::Construction(request) = call else { panic!("only host construction is admitted") };
        assert_eq!(request.recipe().solid_id(), 19);
        let frame = request.payload();
        let mesh = RetainedTessellation {
            positions: vec![-1.,-0.5,0., 1.,-0.5,0., 1.,0.5,0., -1.,0.5,0.,
                -1.,-0.5,3., 1.,-0.5,3., 1.,0.5,3., -1.,0.5,3.],
            indices: vec![0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,
                1,2,6,1,6,5,2,3,7,2,7,6,3,0,4,3,4,7],
            flat_corner_normals: [ [0.,0.,-1.], [0.,0.,1.], [0.,-1.,0.],
                [1.,0.,0.], [0.,1.,0.], [-1.,0.,0.] ].into_iter()
                .flat_map(|n| (0..6).flat_map(move |_| n)).collect(),
            revision_local_faces: (0..6).flat_map(|i| [i,i]).collect(),
            source_face_count: 6, boundary_edges: 0, spine_edges: 0,
        };
        let completion = RetainedCompletion::new(request.clone(), mesh,
            frame.source_from_evaluation, frame.evaluation_from_source);
        self.0.0.calls.set(self.0.0.calls.get() + 1);
        self.0.0.live.set(self.0.0.live.get() + 1);
        Ok(Receipt { domain: self.0.clone(), completion, id: self.0.0.calls.get(), oversized: self.1 })
    }
}
fn ready<T>(future: impl Future<Output = T>) -> T {
    let Poll::Ready(value) = std::pin::pin!(future).as_mut().poll(&mut Context::from_waker(Waker::noop()))
        else { panic!("synchronous test peer must settle") };
    value
}

#[test]
fn issue_7955_eight_terminal_refusals_then_publication_without_retirement_or_leaks() {
    let mut text = CASCADE.to_owned();
    let mut extra = String::new();
    for id in 105..109 {
        extra.push_str(&format!("#{id}=IFCWALL('extra{id}',$,$,$,$,#24,#26,$,.NOTDEFINED.);\n#{}=IFCRELVOIDSELEMENT('v{id}',$,$,$,#{id},#200);\n", id+400));
    }
    text = text.replace("#104=IFCWALL", &(extra + "#104=IFCWALL"));
    let domain = Domain(Rc::new(Counts::default()));
    let acquisitions = Cell::new(0);
    let mut worker = None;
    let mut rows = Vec::new();
    let summary = ready(model::run_model_with_worker(ifc_lite_core::SourceBundle::new(text.into_bytes()),
        &model::ModelOptions { ids: Some((100..109).collect()), max_restarts: 0, ..Default::default() },
        &mut worker, || {
            acquisitions.set(acquisitions.get() + 1);
            Ok(Peer(domain.clone(), false))
        }, |outcome, _| {
            assert_eq!(domain.0.live.get(), 0, "sink sees no retained kernel leases");
            rows.push(outcome);
        })).unwrap();
    assert_eq!(summary.candidates, 9);
    assert_eq!(summary.published, 1, "valid product must publish after eight refusals");
    assert_eq!(summary.by_code.get("opening_unsupported"), Some(&8));
    assert_eq!((summary.restarts, acquisitions.get(), domain.0.retired.get()), (0,1,0));
    assert_eq!(domain.0.calls.get(), 9, "each refused host actually completed kernel work");
    assert!(rows[..8].iter().all(|row| matches!(row, model::ProductOutcome::Refused { .. })));
    let model::ProductOutcome::Published(reused) = rows.pop().unwrap() else { panic!("#104 must publish") };
    let fresh_domain = Domain(Rc::new(Counts::default()));
    let mut fresh = Vec::new();
    ready(model::run_model(ifc_lite_core::SourceBundle::new(CASCADE.as_bytes().to_vec()),
        &model::ModelOptions { ids: Some([104].into_iter().collect()), ..Default::default() },
        || Ok(Peer(fresh_domain.clone(), false)), |o| fresh.push(o))).unwrap();
    let model::ProductOutcome::Published(fresh) = fresh.pop().unwrap() else { panic!("fresh #104") };
    assert_eq!(reused.product_id, 104);
    assert_eq!(reused.parts.len(), 1);
    assert_eq!(reused.parts[0].positions, fresh.parts[0].positions);
    assert_eq!(reused.parts[0].indices, fresh.parts[0].indices);
    assert_eq!(reused.parts[0].world_from_object, fresh.parts[0].world_from_object);
}

#[test]
fn issue_7955_unsettled_resource_cancellations_retire_without_spending_fault_budget() {
    // Real controller buffer admission fails after invoke, while its packet is
    // still armed. Retirement must stay conservative; only accounting changes.
    let mut text = CASCADE.lines().filter(|line| !line.contains("=IFCRELVOIDSELEMENT"))
        .collect::<Vec<_>>().join("\n");
    let extra: String = (105..109).map(|id| format!(
        "#{id}=IFCWALL('extra{id}',$,$,$,$,#24,#26,$,.NOTDEFINED.);\n")).collect();
    text = text.replace("#104=IFCWALL", &(extra + "#104=IFCWALL"));
    let mut domains = Vec::new();
    let mut outcomes = Vec::new();
    let summary = ready(model::run_model(ifc_lite_core::SourceBundle::new(text.into_bytes()),
        &model::ModelOptions { ids: Some((100..109).collect()), max_restarts: 0, ..Default::default() },
        || {
            let domain = Domain(Rc::new(Counts::default()));
            domains.push(domain.clone());
            Ok(Peer(domain, domains.len() <= 8))
        }, |o| outcomes.push(o))).unwrap();
    assert_eq!(summary.by_code.get("resource_exhausted"), Some(&8));
    assert_eq!((summary.published, summary.restarts, domains.len()), (1,0,9));
    assert!(outcomes[..8].iter().all(|o| matches!(o, model::ProductOutcome::Refused { .. })));
    assert!(matches!(outcomes.last(), Some(model::ProductOutcome::Published(s)) if s.product_id == 104));
    for (i, domain) in domains.iter().enumerate() {
        assert_eq!(domain.0.live.get(), 0, "all temporary receipts released");
        assert_eq!(domain.0.calls.get(), 1, "no product replay");
        assert_eq!(domain.incarnation().is_some(), i == 8, "unsettled cancellations still retire");
    }
}
