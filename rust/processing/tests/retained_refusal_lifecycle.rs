// SPDX-License-Identifier: MPL-2.0
//! #7955: lifecycle invariants, not numerical SDK qualification. A counted
//! rectangle peer supplies box receipts; source admission/publication are real.
#![cfg(feature = "retained-runtime")]
use ifc_lite_processing::element::retained_runtime::*;
use ifc_lite_geometry::document::{RetainedCompletion, RetainedTessellation};
use std::{cell::Cell, future::Future, rc::Rc, task::{Context, Poll, Waker}};

const CASCADE: &str = include_str!("../../../tests/fixtures/synthetic-retained/refusal-cascade.ifc");
#[derive(Default)]
struct Counts { retired: Cell<usize>, live: Cell<usize>, calls: Cell<usize> }
#[derive(Clone)]
struct Domain(Rc<Counts>);
impl ReceiptDomain for Domain {
    fn incarnation(&self) -> Option<u64> { (self.0.retired.get() == 0).then_some(1) }
    fn retire(&self) { self.0.retired.set(self.0.retired.get() + 1); }
    fn same_domain(&self, other: &Self) -> bool { Rc::ptr_eq(&self.0, &other.0) }
}
struct Receipt {
    domain: Domain, completion: RetainedCompletion, id: usize, oversized: bool,
    validations: Cell<usize>, fail_on_reuse: bool,
}
impl Drop for Receipt {
    fn drop(&mut self) { self.domain.0.live.set(self.domain.0.live.get() - 1); }
}
impl NumericalReceipt for Receipt {
    type Object = usize;
    type Domain = Domain;
    type Error = RuntimeFault;
    fn heap_bytes() -> u64 { std::mem::size_of::<Self>() as u64 }
    fn buffer_bytes(&self) -> Result<u64, RuntimeFault> {
        if self.oversized { return Ok(u64::MAX); }
        let mesh = &self.completion.tessellation;
        Ok((mesh.positions.capacity() * 8 + mesh.indices.capacity() * 4
            + mesh.flat_corner_normals.capacity() * 8 + mesh.revision_local_faces.capacity() * 4) as u64)
    }
    fn object(&self) -> usize { self.id }
    fn evidence(&self) -> ReceiptEvidence<'_, usize> { ReceiptEvidence::Construction(&self.completion) }
    fn domain(&self) -> &Domain { &self.domain }
    fn validate_live(&self) -> Result<(), RuntimeFault> {
        self.validations.set(self.validations.get() + 1);
        // Seal and completion validation succeed; reading the accepted operand
        // for a later operation discovers a real receipt/transport fault.
        if self.fail_on_reuse && self.validations.get() > 2 {
            return Err(RuntimeFault::transport("receipt transport fault during input preparation"));
        }
        self.domain.incarnation().map(|_| ()).ok_or_else(|| RuntimeFault::retired("test peer retired"))
    }
    fn mesh(&self) -> Option<ReceiptMesh<'_>> {
        let m = &self.completion.tessellation;
        Some(ReceiptMesh { positions: &m.positions, indices: &m.indices, faces: &m.revision_local_faces })
    }
}
#[derive(Clone, Copy)]
enum LateReply { Transport, Kernel, DeadReceipt, HealthyReceipt, ResourceSettled, ResourceDead }
#[derive(Clone, Copy)]
enum ReplyFault { None, InputPreparation, ForeignAdmission }
struct Peer(Domain, usize, Option<LateReply>, ReplyFault);
impl RetainedRuntime for Peer {
    type Receipt = Receipt;
    fn domain(&self) -> Domain { self.0.clone() }
    fn incarnation(&self) -> u64 { self.0.incarnation().unwrap_or(0) }
}
impl AsyncRetainedExecutor for Peer {
    async fn invoke(&mut self, call: Invocation<'_, Receipt>, _: NumericalLimits) -> Result<Receipt, RuntimeFault> {
        if !matches!(self.3, ReplyFault::InputPreparation) {
            assert_eq!(self.0.0.live.get(), 0, "previous refused product released every receipt");
        }
        let Invocation::Construction(request) = call else { panic!("only host construction is admitted") };
        assert_eq!(request.recipe().solid_id(), 19);
        self.0.0.calls.set(self.0.0.calls.get() + 1);
        if let Some(reply @ (LateReply::ResourceSettled | LateReply::ResourceDead)) = self.2 {
            // A worker-side mesh budget refusal (e.g. "mesh exceeds max_bytes"):
            // the worker released its mesh and stays healthy unless it died.
            if matches!(reply, LateReply::ResourceDead) { self.0.retire(); }
            return Err(RuntimeFault::resource_limit("mesh exceeds max_bytes"));
        }
        if let Some(reply) = self.2 {
            // #7955: invoke has actually started before the product deadline.
            // A blocking native transport can return long after that deadline.
            std::thread::sleep(std::time::Duration::from_millis(1_100));
            if !matches!(reply, LateReply::HealthyReceipt) { self.0.retire(); }
            match reply {
                LateReply::Transport => return Err(RuntimeFault::transport("crash after deadline")),
                LateReply::Kernel => return Err(RuntimeFault::kernel(8, "trap after deadline")),
                LateReply::DeadReceipt | LateReply::HealthyReceipt
                    | LateReply::ResourceSettled | LateReply::ResourceDead => {}
            }
        }
        let frame = request.payload();
        let mesh = RetainedTessellation {
            positions: vec![0.,0.,0., 2.,0.,0., 2.,1.,0., 0.,1.,0.,
                0.,0.,3., 2.,0.,3., 2.,1.,3., 0.,1.,3.],
            indices: vec![0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,
                1,2,6,1,6,5,2,3,7,2,7,6,3,0,4,3,4,7],
            flat_corner_normals: [ [0.,0.,-1.], [0.,0.,1.], [0.,-1.,0.],
                [1.,0.,0.], [0.,1.,0.], [-1.,0.,0.] ].into_iter()
                .flat_map(|n| (0..6).flat_map(move |_| n)).collect(),
            revision_local_faces: (0..6).flat_map(|i| [i,i]).collect(),
            source_face_count: 6, boundary_edges: 0, spine_edges: 0,
        };
        let admission = if matches!(self.3, ReplyFault::ForeignAdmission) {
            let mut foreign = ifc_lite_geometry::document::GeometryDocument::new();
            let ifc_lite_geometry::document::RetainedRecipe::Extrusion(recipe) = request.recipe()
                else { panic!("rectangle fixture") };
            let definition = foreign.add_retained_extrusion(recipe.clone()).unwrap();
            foreign.prepare_retained(definition, 1).unwrap()
        } else { request.clone() };
        let completion = RetainedCompletion::new(admission, mesh,
            frame.source_from_evaluation, frame.evaluation_from_source);
        self.0.0.live.set(self.0.0.live.get() + 1);
        Ok(Receipt { domain: self.0.clone(), completion, id: self.0.0.calls.get(), oversized: self.0.0.calls.get() <= self.1,
            validations: Cell::new(0), fail_on_reuse: matches!(self.3, ReplyFault::InputPreparation) })
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
    let summary = ready(run_model_with_worker(ifc_lite_core::SourceBundle::new(text.into_bytes()),
        &ModelOptions { ids: Some((100..109).collect()), max_restarts: 0, ..Default::default() },
        &mut worker, || {
            acquisitions.set(acquisitions.get() + 1);
            Ok(Peer(domain.clone(), 0, None, ReplyFault::None))
        }, |outcome, _| {
            assert_eq!(domain.0.live.get(), 0, "sink sees no retained kernel leases");
            rows.push(outcome);
        })).unwrap();
    assert_eq!(summary.candidates, 9);
    assert_eq!(summary.published, 1, "valid product must publish after eight refusals");
    assert_eq!(summary.by_code.get("opening_unsupported"), Some(&8));
    assert_eq!((summary.restarts, acquisitions.get(), domain.0.retired.get()), (0,1,0));
    assert_eq!(domain.0.calls.get(), 9, "each refused host actually completed kernel work");
    assert!(rows[..8].iter().all(|row| matches!(row, ProductOutcome::Refused { .. })));
    let ProductOutcome::Published(reused) = rows.pop().unwrap() else { panic!("#104 must publish") };
    let fresh_domain = Domain(Rc::new(Counts::default()));
    let mut fresh = Vec::new();
    ready(run_model(ifc_lite_core::SourceBundle::new(CASCADE.as_bytes().to_vec()),
        &ModelOptions { ids: Some([104].into_iter().collect()), ..Default::default() },
        || Ok(Peer(fresh_domain.clone(), 0, None, ReplyFault::None)), |o| fresh.push(o))).unwrap();
    let ProductOutcome::Published(fresh) = fresh.pop().unwrap() else { panic!("fresh #104") };
    assert_eq!(reused.product_id, 104);
    assert_eq!(reused.parts.len(), 1);
    assert_eq!(reused.parts[0].positions, fresh.parts[0].positions);
    assert_eq!(reused.parts[0].indices, fresh.parts[0].indices);
    assert_eq!(reused.parts[0].world_from_object, fresh.parts[0].world_from_object);
}

fn unvoided_cascade() -> String {
    let mut text = CASCADE.lines().filter(|line| !line.contains("=IFCRELVOIDSELEMENT"))
        .collect::<Vec<_>>().join("\n");
    let extra: String = (105..109).map(|id| format!(
        "#{id}=IFCWALL('extra{id}',$,$,$,$,#24,#26,$,.NOTDEFINED.);\n")).collect();
    text = text.replace("#104=IFCWALL", &(extra + "#104=IFCWALL"));
    text
}

#[test]
fn issue_7955_eight_settled_resource_refusals_release_receipts_and_keep_worker() {
    // The reply has fully arrived; real controller buffer admission refuses it.
    // All eight temporary receipts must drop on the original healthy peer.
    let domain = Domain(Rc::new(Counts::default()));
    let acquisitions = Cell::new(0);
    let mut outcomes = Vec::new();
    let summary = ready(run_model(ifc_lite_core::SourceBundle::new(unvoided_cascade().into_bytes()),
        &ModelOptions { ids: Some((100..109).collect()), max_restarts: 0, ..Default::default() },
        || {
            acquisitions.set(acquisitions.get() + 1);
            Ok(Peer(domain.clone(), 8, None, ReplyFault::None))
        }, |o| outcomes.push(o))).unwrap();
    assert_eq!(summary.by_code.get("resource_exhausted"), Some(&8));
    assert_eq!((summary.published, summary.restarts, acquisitions.get()), (1,0,1));
    assert!(outcomes[..8].iter().all(|o| matches!(o, ProductOutcome::Refused { .. })));
    assert!(matches!(outcomes.last(), Some(ProductOutcome::Published(s)) if s.product_id == 104));
    assert_eq!(domain.0.live.get(), 0, "all temporary receipts released");
    assert_eq!(domain.0.calls.get(), 9, "no product replay");
    assert_eq!(domain.0.retired.get(), 0, "settled refusals never retire the peer");
}

fn late_reply_run(reply: LateReply) -> (ModelSummary, Vec<ProductOutcome>, Vec<Domain>) {
    let mut domains = Vec::new();
    let mut outcomes = Vec::new();
    let options = ModelOptions {
        ids: Some((100..109).collect()),
        product_budget: ProductBudgetSpec { deadline_ms: 1_000, ..Default::default() },
        ..Default::default()
    };
    let summary = ready(run_model(ifc_lite_core::SourceBundle::new(unvoided_cascade().into_bytes()),
        &options, || {
            let domain = Domain(Rc::new(Counts::default()));
            domains.push(domain.clone());
            Ok(Peer(domain, 0, Some(reply), ReplyFault::None))
        }, |o| outcomes.push(o))).unwrap();
    assert_eq!(summary.published, 0, "no partial publication after the deadline");
    assert!(domains.iter().all(|d| d.0.live.get() == 0), "every receipt released");
    (summary, outcomes, domains)
}

#[test]
fn issue_7955_fault_after_deadline_is_charged_and_three_restarts_exhaust_the_cap() {
    for (reply, expected) in [(LateReply::Transport, "worker_fault"), (LateReply::Kernel, "kernel_failure")] {
        let (summary, outcomes, domains) = late_reply_run(reply);
        assert_eq!(summary.restarts, 3);
        assert_eq!(domains.len(), 4, "initial worker plus exactly three replacements");
        assert!(domains.iter().all(|d| d.0.calls.get() == 1 && d.incarnation().is_none()));
        // The peer's own crash plus exactly one controller retirement per fault.
        assert!(domains.iter().all(|d| d.0.retired.get() == 2), "a fault retires its domain once");
        for outcome in &outcomes[..4] {
            let ProductOutcome::Refused { refusal, message, .. } = outcome else { panic!("fault must refuse") };
            assert_eq!(refusal.code(), expected, "invocation fault wins over deadline");
            assert!(message.contains("after deadline"));
        }
        assert_exhausted(&outcomes[4..]);
    }
}

#[test]
fn issue_7955_independently_dead_domain_is_charged_even_when_reported_as_deadline() {
    // Defense in depth: a peer returns a receipt after independently retiring.
    // The checkpoint reports a deadline, but that cannot make recovery free.
    let (summary, outcomes, domains) = late_reply_run(LateReply::DeadReceipt);
    assert_eq!((summary.restarts, domains.len()), (3,4));
    assert_eq!(summary.by_code.get("deadline_exceeded"), Some(&4));
    assert_exhausted(&outcomes[4..]);
}

#[test]
fn issue_7955_settled_reply_after_deadline_keeps_healthy_worker() {
    let (summary, _, domains) = late_reply_run(LateReply::HealthyReceipt);
    assert_eq!((summary.restarts, domains.len()), (0,1));
    assert_eq!(summary.by_code.get("deadline_exceeded"), Some(&9));
    assert_eq!(domains[0].0.calls.get(), 9);
    assert_eq!(domains[0].0.retired.get(), 0);
}

fn assert_exhausted(outcomes: &[ProductOutcome]) {
    assert_eq!(outcomes.len(), 5);
    for outcome in outcomes {
        let ProductOutcome::Refused { refusal, message, .. } = outcome else { panic!("cap must refuse") };
        assert_eq!(refusal.code(), "worker_fault");
        assert!(message.contains("worker restart budget exhausted"));
    }
}

#[test]
fn issue_7955_input_preparation_fault_retires_captured_domain_and_is_charged() {
    // copy_issued_operations only clones controller-owned values; it cannot
    // touch transport. The reachable fault window is prepare_operations reading
    // an already-accepted operand, before the next pending packet is installed.
    let text = unvoided_cascade().replace(
        "#25=IFCSHAPEREPRESENTATION(#4,'Body','SweptSolid',(#19));",
        "#50=IFCBOOLEANRESULT(.UNION.,#19,#19);\n#25=IFCSHAPEREPRESENTATION(#4,'Body','CSG',(#50));");
    let mut domains = Vec::new();
    let mut outcomes = Vec::new();
    let summary = ready(run_model(ifc_lite_core::SourceBundle::new(text.into_bytes()),
        &ModelOptions { ids: Some((100..109).collect()), ..Default::default() },
        || {
            let domain = Domain(Rc::new(Counts::default()));
            domains.push(domain.clone());
            Ok(Peer(domain, 0, None, ReplyFault::InputPreparation))
        }, |o| outcomes.push(o))).unwrap();
    assert_eq!((summary.published, summary.restarts, domains.len()), (0,3,4));
    for domain in domains {
        assert!(domain.incarnation().is_none(), "receipt fault retires its captured domain");
        assert_eq!(domain.0.live.get(), 0, "accepted input receipts are released");
        assert!(domain.0.calls.get() > 0, "input was produced before its later failure");
    }
    for outcome in &outcomes[..4] {
        let ProductOutcome::Refused { refusal, message, .. } = outcome else { panic!("must refuse") };
        assert_eq!(refusal.code(), "worker_fault");
        assert!(message.contains("receipt transport fault during input preparation"));
    }
    assert_exhausted(&outcomes[4..]);
}

#[test]
fn issue_7955_abandoned_foreign_receipt_is_a_fault_not_a_free_controller_cancel() {
    let mut domains = Vec::new();
    let mut outcomes = Vec::new();
    let summary = ready(run_model(ifc_lite_core::SourceBundle::new(unvoided_cascade().into_bytes()),
        &ModelOptions { ids: Some((100..109).collect()), ..Default::default() },
        || {
            let domain = Domain(Rc::new(Counts::default()));
            domains.push(domain.clone());
            Ok(Peer(domain, 0, None, ReplyFault::ForeignAdmission))
        }, |o| outcomes.push(o))).unwrap();
    assert_eq!((summary.published, summary.restarts, domains.len()), (0,3,4));
    assert_eq!(summary.by_code.get("contract_breach"), Some(&4));
    assert!(domains.iter().all(|d| d.incarnation().is_none() && d.0.live.get() == 0));
    assert_exhausted(&outcomes[4..]);
}

#[test]
fn issue_7955_settled_worker_resource_limits_keep_the_healthy_worker() {
    let (summary, outcomes, domains) = late_reply_run(LateReply::ResourceSettled);
    assert_eq!((summary.restarts, domains.len()), (0, 1), "a settled resource refusal is not a fault");
    assert_eq!(domains[0].0.retired.get(), 0);
    assert!(domains[0].incarnation().is_some());
    for outcome in &outcomes {
        let ProductOutcome::Refused { message, .. } = outcome else { panic!("over-budget mesh must refuse") };
        assert!(!message.contains("worker restart budget exhausted"));
    }
}

#[test]
fn issue_7955_worker_that_dies_on_a_resource_limit_is_still_charged() {
    let (summary, outcomes, domains) = late_reply_run(LateReply::ResourceDead);
    assert_eq!((summary.restarts, domains.len()), (3, 4), "an independently dead domain stays charged");
    assert_exhausted(&outcomes[4..]);
}
