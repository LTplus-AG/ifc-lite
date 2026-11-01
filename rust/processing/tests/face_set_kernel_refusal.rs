// SPDX-License-Identifier: MPL-2.0
//! #8291: a kernel refusal on a face-set operation is that product's refusal. Real tessellated
//! coverings produce these, and retiring the worker for each would spend the restart budget
//! and refuse every unrelated product after them. A peer supplies the receipts; source
//! admission and the controller's retirement policy are real.
#![cfg(feature = "retained-runtime")]
use ifc_lite_core::SourceBundle;
use ifc_lite_geometry::document::{RetainedCompletion, RetainedRecipe, RetainedTessellation};
use ifc_lite_processing::element::retained_runtime::*;
use std::{cell::Cell, future::Future, rc::Rc, task::{Context, Poll, Waker}};

#[derive(Clone)]
struct Domain(Rc<Cell<usize>>);
impl ReceiptDomain for Domain {
    fn incarnation(&self) -> Option<u64> { (self.0.get() == 0).then_some(1) }
    fn retire(&self) { self.0.set(self.0.get() + 1); }
    fn same_domain(&self, other: &Self) -> bool { Rc::ptr_eq(&self.0, &other.0) }
}
struct Receipt { domain: Domain, completion: RetainedCompletion }
impl NumericalReceipt for Receipt {
    type Object = usize;
    type Domain = Domain;
    type Error = RuntimeFault;
    fn heap_bytes() -> u64 { 0 }
    fn buffer_bytes(&self) -> Result<u64, RuntimeFault> { Ok(0) }
    fn object(&self) -> usize { 1 }
    fn evidence(&self) -> ReceiptEvidence<'_, usize> { ReceiptEvidence::Construction(&self.completion) }
    fn domain(&self) -> &Domain { &self.domain }
    fn validate_live(&self) -> Result<(), RuntimeFault> { Ok(()) }
    fn mesh(&self) -> Option<ReceiptMesh<'_>> {
        let m = &self.completion.tessellation;
        Some(ReceiptMesh { positions: &m.positions, indices: &m.indices, faces: &m.revision_local_faces })
    }
}
struct Peer { domain: Domain, status: i32 }
impl RetainedRuntime for Peer {
    type Receipt = Receipt;
    fn domain(&self) -> Domain { self.domain.clone() }
    fn incarnation(&self) -> u64 { self.domain.incarnation().unwrap_or(0) }
}
impl AsyncRetainedExecutor for Peer {
    async fn invoke(&mut self, call: Invocation<'_, Receipt>, _: NumericalLimits) -> Result<Receipt, RuntimeFault> {
        let Invocation::Construction(request) = call else { return Err(RuntimeFault::kernel(self.status, "kernel refused the cut")) };
        let payload = request.payload();
        let completion = request.source_exact_completion().unwrap_or_else(|| RetainedCompletion::new(request.clone(),
            RetainedTessellation { positions: vec![0., 0., 0., 1., 0., 0., 0., 1., 0.], indices: vec![0, 1, 2],
                flat_corner_normals: [0f64, 0., 1.].repeat(3), revision_local_faces: vec![0], source_face_count: 1,
                boundary_edges: 0, spine_edges: 0 },
            payload.source_from_evaluation, payload.evaluation_from_source));
        assert!(matches!(request.recipe(), RetainedRecipe::FaceSet(_) | RetainedRecipe::Prism(_) | RetainedRecipe::Extrusion(_)));
        Ok(Receipt { domain: self.domain.clone(), completion })
    }
}
fn ready<T>(future: impl Future<Output = T>) -> T {
    let Poll::Ready(value) = std::pin::pin!(future).as_mut().poll(&mut Context::from_waker(Waker::noop()))
        else { panic!("synchronous test peer must settle") };
    value
}
/// One product: `operand` clipped by a half-space.
fn model(operand: &str) -> String {
    format!("ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4X1'));ENDSEC;DATA;
#1=IFCPROJECT('p',$,$,$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#9=IFCLOCALPLACEMENT($,#5);
#20=IFCBUILDINGELEMENTPROXY('s',$,'Cut',$,$,#9,#21,$,.NOTDEFINED.);
#21=IFCPRODUCTDEFINITIONSHAPE($,$,(#22));#22=IFCSHAPEREPRESENTATION(#2,'Body','Clipping',(#50));
{operand}
#40=IFCCARTESIANPOINT((0.,0.,0.25));#41=IFCDIRECTION((0.,0.,1.));#42=IFCAXIS2PLACEMENT3D(#40,#41,$);
#43=IFCPLANE(#42);#44=IFCHALFSPACESOLID(#43,.F.);
#50=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#33,#44);
ENDSEC;END-ISO-10303-21;")
}
const FACE_SET: &str = "#30=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(0.,0.,1.)));
#33=IFCTRIANGULATEDFACESET(#30,$,.T.,((1,3,2),(1,2,4),(2,3,4),(3,1,4)),$);";
const EXTRUSION: &str = "#33=IFCEXTRUDEDAREASOLID(#34,#5,#35,1.);#34=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,1.,1.);#35=IFCDIRECTION((0.,0.,1.));";

fn run(operand: &str, status: i32) -> (usize, Vec<ProductOutcome>) {
    let retired = Rc::new(Cell::new(0));
    let domain = Domain(retired.clone());
    let source = SourceBundle::new(model(operand).into_bytes());
    let mut outcomes = Vec::new();
    ready(run_model(source, &Default::default(), || Ok(Peer { domain: domain.clone(), status }),
        |outcome| outcomes.push(outcome))).unwrap();
    (retired.get(), outcomes)
}
fn code(outcomes: &[ProductOutcome]) -> &'static str {
    match &outcomes[0] { ProductOutcome::Refused { refusal, .. } => refusal.code(), _ => "published" }
}

#[test]
fn issue_8291_a_known_kernel_refusal_on_a_face_set_keeps_the_worker() {
    let (retired, outcomes) = run(FACE_SET, 4);
    assert_eq!(code(&outcomes), "kernel_failure");
    assert_eq!(retired, 0, "this product's refusal must not spend a restart");
}

#[test]
fn issue_8291_an_unknown_kernel_status_on_a_face_set_still_retires() {
    let (retired, outcomes) = run(FACE_SET, 8);
    assert_eq!(code(&outcomes), "kernel_failure");
    assert!(retired > 0, "an unknown status may have corrupted the process");
}

#[test]
fn issue_8291_other_operands_keep_their_fault_recovery_policy() {
    let (retired, outcomes) = run(EXTRUSION, 4);
    assert_eq!(code(&outcomes), "kernel_failure");
    assert!(retired > 0, "no face set in the operation: existing recovery accounting applies");
}
