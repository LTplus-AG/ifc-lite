// SPDX-License-Identifier: MPL-2.0
//! A scoped decoder borrow transports the caller's resource account and stop
//! authority into a real canonical worker child, and nothing else.
use super::session_tests::{assert_same, canonical, leaked_job, options, router, Context, SOURCE};
use super::*;
use ifc_lite_core::IfcSchema;
use ifc_lite_geometry::resource::{self, Cost, ExecutionAccount, ExecutionPolicy, ProgramStop, ResourceLimits};
use ifc_lite_geometry::{ExtrudedAreaSolidProcessor, GeometryProcessor, TessellationQuality};
use std::{
    cell::RefCell,
    rc::{Rc, Weak},
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        Arc,
    },
};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Charge,
    Cancel,
}
#[derive(Default)]
struct Evidence {
    calls: AtomicUsize,
    charged: AtomicU64,
}
struct Worker {
    mode: Mode,
    evidence: Arc<Evidence>,
}
impl GeometryProcessor for Worker {
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
        self.evidence.calls.fetch_add(1, Ordering::SeqCst);
        let account = resource::current_account().expect("the worker child inherits the caller's account");
        let before = account.usage().work;
        resource::charge(Cost { work: 7, ..Cost::default() })?;
        self.evidence.charged.fetch_add(account.usage().work - before, Ordering::SeqCst);
        if self.mode == Mode::Cancel {
            // A legacy extension swallows its own stop and still returns geometry.
            let _caught = resource::stop(ProgramStop::Cancelled);
        }
        ExtrudedAreaSolidProcessor::new(schema.clone()).process(entity, decoder, schema, quality)
    }
}
struct Threaded {
    router: Weak<GeometryRouter>,
    mode: Mode,
    child: Rc<RefCell<Option<ProducedElementMeshes>>>,
    evidence: Arc<Evidence>,
}
impl GeometryProcessor for Threaded {
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
        if entity.id == 13 {
            assert!(self.router.upgrade().unwrap().try_execution_lease().is_err());
            let (mode, evidence) = (self.mode, self.evidence.clone());
            let child = std::thread::scope(|scope| {
                let decoder = &mut *decoder;
                scope
                    .spawn(move || {
                        assert!(resource::current_account().is_none(), "no account crosses the thread by itself");
                        let mut child_router = router(decoder);
                        child_router.disable_content_dedup();
                        child_router.register(Box::new(Worker { mode, evidence }));
                        let job = leaked_job(decoder, 20);
                        let child = produce_element_meshes(job, &Context::default().borrowed(), &options(), decoder, &child_router);
                        assert!(resource::current_account().is_none(), "worker resource TLS restored");
                        child
                    })
                    .join()
                    .unwrap()
            });
            *self.child.borrow_mut() = Some(child);
        }
        ExtrudedAreaSolidProcessor::new(schema.clone()).process(entity, decoder, schema, quality)
    }
}

fn produce(mode: Mode) -> (ExecutionAccount, ProducedElementMeshes, Option<ProducedElementMeshes>, Arc<Evidence>) {
    let mut decoder = EntityDecoder::new(SOURCE);
    let mut base = router(&mut decoder);
    base.disable_content_dedup();
    let child = Rc::new(RefCell::new(None));
    let evidence = Arc::new(Evidence::default());
    let router = Rc::new_cyclic(|router| {
        base.register(Box::new(Threaded { router: router.clone(), mode, child: child.clone(), evidence: evidence.clone() }));
        base
    });
    let job = leaked_job(&mut decoder, 10);
    let context = ProductionModel::new().snapshot(OwnedMeshProductionData::default());
    let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
    let output =
        account.scope(|| produce_element_meshes_owned(job, &context, &options(), &mut decoder, &router)).unwrap();
    assert!(decoder.try_source_execution_lease().unwrap().is_none(), "source authority ends with the callback");
    assert!(decoder.try_execution_lease().is_ok() && router.try_execution_lease().is_ok());
    assert!(resource::current_account().is_none());
    let child = child.borrow_mut().take();
    (account, output, child, evidence)
}

#[test]
fn scoped_worker_child_bills_the_caller_account_and_keeps_complete_geometry() {
    let (account, wall, child, evidence) = produce(Mode::Charge);
    assert_same(&wall, &canonical(10, false));
    assert_same(&child.expect("the worker child published"), &canonical(20, false));
    assert_eq!(evidence.calls.load(Ordering::SeqCst), 1);
    assert_eq!(evidence.charged.load(Ordering::SeqCst), 7, "the worker's work lands on the caller's request");
    assert!(account.usage().work >= 7);
    assert_eq!(account.check(), Ok(()));
}

#[test]
fn swallowed_worker_cancellation_is_sticky_at_the_outer_owned_producer() {
    let (account, wall, child, evidence) = produce(Mode::Cancel);
    assert_eq!(evidence.calls.load(Ordering::SeqCst), 1);
    assert!(child.expect("the stopped worker child returned").meshes.is_empty(), "a stopped child publishes nothing");
    assert!(wall.meshes.is_empty() && wall.geometry_hash.is_none(), "the outer product cannot publish after the stop");
    assert_eq!(account.check(), Err(ProgramStop::Cancelled));
    assert!(resource::check_current().is_ok(), "the stop does not leak past the caller's account scope");
}
