// SPDX-License-Identifier: MPL-2.0
//! The strategy-retry drain runs every registered processor's drain hook, so
//! it executes inside the product's owner epoch: a hook that produces a
//! canonical child on the same router keeps its child's geometry.
use super::session_tests::{assert_same, canonical, leaked_job, options, router, Context, SOURCE};
use super::*;
use ifc_lite_core::IfcSchema;
use ifc_lite_geometry::{BoolFailure, ExtrudedAreaSolidProcessor, GeometryProcessor, TessellationQuality};
use std::{
    cell::{Cell, RefCell},
    rc::{Rc, Weak},
};

/// Fails the wall's first extrusion so the primary strategy is abandoned for
/// the voids fallback, and produces slab 20 from its first drain hook.
struct RetryThenChild {
    router: Weak<GeometryRouter>,
    calls: Rc<Cell<usize>>,
    calls_at_drain: Rc<Cell<Option<usize>>>,
    child: Rc<RefCell<Option<ProducedElementMeshes>>>,
}
impl GeometryProcessor for RetryThenChild {
    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcExtrudedAreaSolid]
    }
    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        schema: &IfcSchema,
        quality: TessellationQuality,
    ) -> ifc_lite_geometry::Result<Mesh> {
        self.calls.set(self.calls.get() + 1);
        if self.calls.get() == 1 {
            return Err(ifc_lite_geometry::Error::geometry("first attempt refused"));
        }
        ExtrudedAreaSolidProcessor::new(schema.clone()).process(entity, decoder, schema, quality)
    }
    fn take_bool_failures(&self) -> Vec<BoolFailure> {
        // Only the first drain that happens after the failed attempt produces
        // a child, as a real once-only extension can.
        if self.calls.get() == 0 || self.calls_at_drain.get().is_some() {
            return Vec::new();
        }
        self.calls_at_drain.set(Some(self.calls.get()));
        let router = self.router.upgrade().unwrap();
        let mut decoder = EntityDecoder::new(SOURCE);
        decoder.seed_unit_scales(router.unit_scale(), 1.);
        let job = leaked_job(&mut decoder, 20);
        let child = produce_element_meshes(job, &Context::default().borrowed(), &options(), &mut decoder, &router);
        *self.child.borrow_mut() = Some(child);
        Vec::new()
    }
}

#[test]
fn retry_drain_hook_keeps_a_nested_child_on_the_same_router() {
    let mut decoder = EntityDecoder::new(SOURCE);
    let mut base = router(&mut decoder);
    let calls = Rc::new(Cell::new(0));
    let calls_at_drain = Rc::new(Cell::new(None));
    let child = Rc::new(RefCell::new(None));
    let router = Rc::new_cyclic(|weak| {
        base.register(Box::new(RetryThenChild {
            router: weak.clone(),
            calls: calls.clone(),
            calls_at_drain: calls_at_drain.clone(),
            child: child.clone(),
        }));
        base
    });
    let job = leaked_job(&mut decoder, 10);
    let wall = produce_element_meshes(job, &Context::default().borrowed(), &options(), &mut decoder, &router);
    assert!(calls.get() >= 2, "the first attempt was refused and the product retried");
    assert_eq!(
        calls_at_drain.get(),
        Some(1),
        "the hook ran at the retry drain, after the refused attempt and before the next strategy"
    );
    let child = child.borrow_mut().take().expect("the drain hook produced its child");
    assert_same(&child, &canonical(20, false));
    assert!((child.geometry_volume.unwrap() - 4.).abs() < 1e-5);
    assert!(!wall.meshes.is_empty(), "the retried wall still publishes");
    assert!(decoder.try_execution_lease().is_ok() && router.try_execution_lease().is_ok());
}

// #8091 / #7955: cancelling a retry drain must prevent the next strategy
// from starting, not merely discard geometry after its constructors ran.
struct RetryDrainStop {
    calls: Rc<Cell<usize>>,
    hooks: Rc<Cell<usize>>,
    pending: RefCell<Vec<BoolFailure>>,
    cancel: bool,
}
impl GeometryProcessor for RetryDrainStop {
    fn supported_types(&self) -> Vec<IfcType> { vec![IfcType::IfcExtrudedAreaSolid] }
    fn process(&self, entity: &DecodedEntity, decoder: &mut EntityDecoder,
        schema: &IfcSchema, quality: TessellationQuality) -> ifc_lite_geometry::Result<Mesh> {
        self.calls.set(self.calls.get() + 1);
        if self.calls.get() == 1 {
            let recorder = ifc_lite_geometry::BooleanClippingProcessor::new();
            let boolean = decoder.decode_by_id(87).unwrap();
            assert!(!recorder.process(&boolean, decoder, schema, quality)?.is_empty());
            let reports = recorder.take_failures();
            assert_eq!(reports.len(), 1, "the refused attempt produced real XOR evidence");
            self.pending.borrow_mut().extend(reports);
            return Err(ifc_lite_geometry::Error::geometry("first attempt refused"));
        }
        ExtrudedAreaSolidProcessor::new(schema.clone()).process(entity, decoder, schema, quality)
    }
    fn take_bool_failures(&self) -> Vec<BoolFailure> {
        self.hooks.set(self.hooks.get() + 1);
        if self.hooks.get() == 1 {
            assert_eq!(self.calls.get(), 1, "first drain is between the two strategies");
            if self.cancel {
                ifc_lite_geometry::resource::stop(ifc_lite_geometry::resource::ProgramStop::Cancelled);
            }
        }
        std::mem::take(&mut *self.pending.borrow_mut())
    }
}

#[derive(Clone, Copy)]
enum RetryEntry { Borrowed, Owned, BorrowedResumable, OwnedResumable }

fn retry_drain_stop(entry: RetryEntry, cancel: bool) {
    let source = SOURCE.replace("ENDSEC;END-ISO-10303-21;",
        "#87=IFCBOOLEANRESULT(.XOR.,#13,$);
#90=IFCSLAB('empty',$,'Empty',$,$,#19,#91,$,.FLOOR.);
#91=IFCPRODUCTDEFINITIONSHAPE($,$,(#92));
#92=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#4));
ENDSEC;END-ISO-10303-21;");
    let mut decoder = EntityDecoder::new(&source);
    let mut router = router(&mut decoder);
    router.disable_content_dedup();
    let calls = Rc::new(Cell::new(0));
    let hooks = Rc::new(Cell::new(0));
    router.register(Box::new(RetryDrainStop { calls: calls.clone(), hooks: hooks.clone(),
        pending: RefCell::new(Vec::new()), cancel }));
    let job = leaked_job(&mut decoder, 10);
    let ctx = Context::default();
    let owned = ProductionModel::new().snapshot(OwnedMeshProductionData::default());
    let output = match entry {
        RetryEntry::Borrowed => produce_element_meshes(job, &ctx.borrowed(), &options(), &mut decoder, &router),
        RetryEntry::Owned => produce_element_meshes_owned(job, &owned, &options(), &mut decoder, &router).unwrap(),
        RetryEntry::BorrowedResumable => {
            let state = super::session::ProductState::new(job, &ctx.borrowed(), &options(), &mut decoder, &router).unwrap();
            super::session_tests::complete(state, &ctx.borrowed(), &mut decoder, &router)
        }
        RetryEntry::OwnedResumable => {
            let mut execution = super::owned_session::OwnedProductExecution::new(
                job, &owned, &options(), &mut decoder, &router).unwrap();
            while execution.advance(&mut decoder, &router).unwrap() {}
            execution.finish(&decoder, &router).unwrap()
        }
    };
    if cancel {
        assert_eq!(calls.get(), 1, "terminal retry drain started the next strategy");
        assert_eq!(hooks.get(), 1, "terminal retry must not run final hooks");
        assert!(output.meshes.is_empty() && output.instance_occurrences.is_empty());
        assert!(output.geometry_hash.is_none() && output.geometry_volume.is_none());
        assert!(output.geometry_aabb.is_none() && output.geometry_closure.is_none());
        assert!(output.csg_failures.is_empty());
    } else {
        assert_eq!(calls.get(), 2, "ordinary exact retry must still run the next strategy once");
        assert_eq!(hooks.get(), 2, "successful retry runs retry and final drains");
        let mut expected = canonical(10, false);
        assert_eq!(expected.meshes.len(), 1);
        assert_eq!(expected.meshes[0].geometry_item_id, Some(13));
        // #8091: the primary styled route identifies item 13, while the
        // existing voids-to-parts retry publishes an unattributed Mesh.
        // Preserve that distinction and compare every other output field.
        expected.meshes[0].geometry_item_id = None;
        assert_same(&output, &expected);
    }
    assert!(decoder.try_execution_lease().is_ok() && router.try_execution_lease().is_ok());
    assert!(ifc_lite_geometry::resource::check_current().is_ok(), "stop leaked outside the product");
    let slab = leaked_job(&mut decoder, 20);
    let next = produce_element_meshes(slab, &ctx.borrowed(), &options(), &mut decoder, &router);
    assert_same(&next, &canonical(20, false));
    // Exercise another retry drain before explicit retrieval: it must neither
    // adopt nor erase the cancelled attempt's quarantined diagnostic.
    let before = hooks.get();
    let empty = leaked_job(&mut decoder, 90);
    let next = produce_element_meshes(empty, &ctx.borrowed(), &options(), &mut decoder, &router);
    assert!(next.meshes.is_empty() && next.csg_failures.is_empty());
    assert_eq!(hooks.get(), before + 2, "successor reached retry and final drains");
    let reports = router.take_csg_failures();
    if cancel {
        assert_eq!(reports.len(), 1);
        assert_eq!(reports.get(&ifc_lite_geometry::UNATTRIBUTED_PRODUCT_ID),
            Some(&vec![BoolFailure::new(ifc_lite_geometry::BoolOp::Unknown,
                ifc_lite_geometry::BoolFailureReason::UnknownBooleanOperator("XOR".into()))]),
            "cancelled retry lost, duplicated or reassigned its original report");
    } else {
        assert!(reports.is_empty(), "nonterminal superseded attempt reports must still be discarded");
    }
    assert!(router.take_csg_failures().is_empty(), "explicit retrieval must be exactly once");
}

#[test]
fn issue_8091_borrowed_retry_drain_stop_prevents_next_strategy() { retry_drain_stop(RetryEntry::Borrowed, true); }
#[test]
fn issue_8091_owned_retry_drain_stop_prevents_next_strategy() { retry_drain_stop(RetryEntry::Owned, true); }
#[test]
fn issue_8091_borrowed_resumable_retry_drain_stop_prevents_next_strategy() {
    retry_drain_stop(RetryEntry::BorrowedResumable, true);
}
#[test]
fn issue_8091_owned_resumable_retry_drain_stop_prevents_next_strategy() {
    retry_drain_stop(RetryEntry::OwnedResumable, true);
}
#[test]
fn issue_8091_nonterminal_retry_drain_preserves_exact_retry_policy() {
    for entry in [RetryEntry::Borrowed, RetryEntry::Owned, RetryEntry::BorrowedResumable, RetryEntry::OwnedResumable] {
        retry_drain_stop(entry, false);
    }
}
