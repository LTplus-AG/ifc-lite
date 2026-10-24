// SPDX-License-Identifier: MPL-2.0
//! #8091 / #7955: a final callback's reports outlive rejected publication.
use super::*;
use super::owned_session::OwnedProductExecution;
use super::session_protocol::WorkError;
use super::session_tests::{leaked_job, options, router, Context, SOURCE};
use ifc_lite_core::IfcSchema;
use ifc_lite_geometry::{BooleanClippingProcessor, BoolFailure, ExtrudedAreaSolidProcessor,
    GeometryProcessor, TessellationQuality};
use std::{cell::{Cell, RefCell}, rc::Rc};

struct FinalInvalidation {
    pending: RefCell<Vec<BoolFailure>>,
    action: RefCell<Option<Box<dyn FnOnce()>>>,
    hooks: Rc<Cell<usize>>,
    constructions: Rc<Cell<usize>>,
}
impl GeometryProcessor for FinalInvalidation {
    fn supported_types(&self) -> Vec<IfcType> { vec![IfcType::IfcExtrudedAreaSolid] }
    fn process(&self, entity: &DecodedEntity, decoder: &mut EntityDecoder,
        schema: &IfcSchema, quality: TessellationQuality) -> ifc_lite_geometry::Result<Mesh> {
        self.constructions.set(self.constructions.get() + 1);
        let mesh = ExtrudedAreaSolidProcessor::new(schema.clone()).process(entity, decoder, schema, quality)?;
        assert!(!mesh.is_empty(), "the rejected product must have actual geometry to withhold");
        if entity.id == 13 {
            let recorder = BooleanClippingProcessor::new();
            let boolean = decoder.decode_by_id(87).unwrap();
            recorder.process(&boolean, decoder, schema, quality)?;
            self.pending.borrow_mut().extend(recorder.take_failures());
        }
        Ok(mesh)
    }
    fn take_bool_failures(&self) -> Vec<BoolFailure> {
        self.hooks.set(self.hooks.get() + 1);
        if let Some(action) = self.action.borrow_mut().take() { action(); }
        std::mem::take(&mut *self.pending.borrow_mut())
    }
}

fn source() -> String {
    SOURCE.replace("ENDSEC;END-ISO-10303-21;",
        "#87=IFCBOOLEANRESULT(.XOR.,#13,$);ENDSEC;END-ISO-10303-21;")
}
fn install(router: &mut GeometryRouter, action: impl FnOnce() + 'static)
    -> (Rc<Cell<usize>>, Rc<Cell<usize>>) {
    let hooks = Rc::new(Cell::new(0));
    let constructions = Rc::new(Cell::new(0));
    router.disable_content_dedup();
    router.register(Box::new(FinalInvalidation {
        pending: RefCell::new(Vec::new()), action: RefCell::new(Some(Box::new(action))),
        hooks: hooks.clone(), constructions: constructions.clone(),
    }));
    (hooks, constructions)
}
fn check_successor(decoder: &mut EntityDecoder, router: &GeometryRouter, hooks: &Cell<usize>) {
    let before = hooks.get();
    let fresh = leaked_job(decoder, 20);
    let output = produce_element_meshes(fresh, &Context::default().borrowed(), &options(), decoder, router);
    assert!(!output.meshes.is_empty());
    assert!(output.csg_failures.is_empty(), "fresh product stole rejected publication reports");
    assert_eq!(hooks.get(), before + 1, "successor runs its final hook exactly once");
    let reports = router.take_csg_failures();
    assert_eq!(reports.len(), 1, "rejected final publication lost its diagnostic bucket");
    let failures = reports.get(&ifc_lite_geometry::UNATTRIBUTED_PRODUCT_ID)
        .expect("processor evidence must retain its original unattributed key");
    assert_eq!(failures.len(), 1, "rejected final publication lost or duplicated its report");
    assert_eq!(failures[0].product_id, None);
    assert!(matches!(&failures[0].reason, ifc_lite_geometry::BoolFailureReason::UnknownBooleanOperator(op) if op == "XOR"));
    assert_eq!(hooks.get(), before + 2);
    assert!(router.take_csg_failures().is_empty(), "explicit retrieval must be exactly once");
    assert_eq!(hooks.get(), before + 3);
}
fn stale_final_publication(resumable: bool) {
    let source = source();
    let model = Rc::new(ProductionModel::new());
    let context = model.snapshot(OwnedMeshProductionData::default());
    let mut decoder = EntityDecoder::new(&source);
    let mut router = router(&mut decoder);
    let (hooks, constructions) = install(&mut router, move || model.invalidate_source());
    let job = leaked_job(&mut decoder, 10);
    if resumable {
        let mut execution = OwnedProductExecution::new(job, &context, &options(), &mut decoder, &router).unwrap();
        while execution.advance(&mut decoder, &router).unwrap() {}
        assert_eq!(hooks.get(), 0, "no final callback before finalization");
        assert_eq!(execution.finish(&decoder, &router).err(), Some(WorkError::StaleSource));
    } else {
        assert_eq!(produce_element_meshes_owned(job, &context, &options(), &mut decoder, &router).err(),
            Some(ProductionContextError::StaleSource));
    }
    assert_eq!(constructions.get(), 1);
    assert_eq!(hooks.get(), 1, "rejection must not replay the final hook");
    check_successor(&mut decoder, &router, &hooks);
}
#[test]
fn issue_8091_owned_final_source_rejection_retains_drained_reports() { stale_final_publication(false); }
#[test]
fn issue_8091_resumable_final_source_rejection_retains_drained_reports() { stale_final_publication(true); }

// A lexical parent's work capability can expire during a final callback.
// This reaches the common driver's post-body owner refusal after draining.
fn final_owner_commit_rejection(resumable: bool) {
    let source = source();
    let mut decoder = EntityDecoder::new(&source);
    let mut router = router(&mut decoder);
    let parent = Rc::new(RefCell::new(None));
    let expire = parent.clone();
    let (hooks, _) = install(&mut router, move || { expire.borrow_mut().take(); });
    let lease = Box::leak(Box::new(decoder.try_execution_lease().unwrap()));
    let work = lease.begin_synchronous_work(decoder.execution_identity()).unwrap();
    let decoder_child = work.child_capability();
    *parent.borrow_mut() = Some(work);
    let mut router_lease = router.try_execution_lease().unwrap();
    let router_work = router_lease.begin_synchronous_work(router.execution_identity()).unwrap();
    let job = leaked_job(&mut decoder, 10);
    super::session_canonical::with_active_owner(router_work.child_capability(), decoder_child, || {
        if resumable {
            let inherited = super::session_canonical::inherited_owner(&mut decoder, &router).unwrap();
            let ctx = Context::default();
            let mut state = super::session::ProductState::plan(job, &ctx.borrowed(), &options(),
                &mut decoder, &router, super::session_resumable::Admission { inherited, context: None }).unwrap();
            while state.advance(&ctx.borrowed(), &mut decoder, &router).unwrap() {}
            assert_eq!(state.finish(&decoder, &router).err(), Some(WorkError::WrongOwner));
        } else {
            let output = produce_element_meshes(job, &Context::default().borrowed(), &options(), &mut decoder, &router);
            assert!(output.meshes.is_empty() && output.instance_occurrences.is_empty());
            assert!(output.geometry_hash.is_none() && output.csg_failures.is_empty());
        }
    });
    assert_eq!(hooks.get(), 1, "owner rejection occurs after the final callback");
    drop(router_work);
    drop(router_lease);
    // The intentionally leaked decoder lease is no longer used. A fresh
    // source owner exercises the same warm router and its retained reports.
    let mut fresh_decoder = EntityDecoder::new(&source);
    fresh_decoder.seed_unit_scales(router.unit_scale(), 1.);
    check_successor(&mut fresh_decoder, &router, &hooks);
}

#[test]
fn issue_8091_final_owner_commit_rejection_retains_drained_reports() { final_owner_commit_rejection(false); }
#[test]
fn issue_8091_resumable_owner_commit_rejection_retains_drained_reports() { final_owner_commit_rejection(true); }
