// SPDX-License-Identifier: MPL-2.0
//! A scoped decoder borrow transports request accounting into real worker children.
use super::*;
use super::accounted_session_tests::admitted_router;
use super::session_tests::{Context,SOURCE,assert_same,canonical,job,metadata,options};
use ifc_lite_core::IfcSchema;
use ifc_lite_geometry::{ExtrudedAreaSolidProcessor,GeometryProcessor,TessellationQuality};
use ifc_lite_geometry::resource::{self,Cost,Dimension,ExecutionAccount,ExecutionPolicy,
    ProgramStop,ResourceFailure,ResourceLimits};
use std::{cell::{Cell,RefCell},panic::{catch_unwind,AssertUnwindSafe},rc::{Rc,Weak},
    sync::{Arc,atomic::{AtomicBool,AtomicU64,AtomicUsize,Ordering}}};

const WORK_LIMIT:u64=10_000;
#[derive(Clone,Copy,PartialEq,Eq)]
enum Mode { Success, Cancel, RefuseWork, Panic, CompatibilityCancel, PreCancelled, PreRefused, UnboundedSuccess }
#[derive(Clone,Copy)]
enum Entry { Borrowed, FreshAccount }
#[derive(Default)]
struct Evidence {
    cache:ifc_lite_geometry::SharedMappedItemCache,
    calls:AtomicUsize,
    charged_work:AtomicU64,
    fresh_account_work:AtomicU64,
    foreign_work:AtomicU64,
    foreign_restored:AtomicBool,
    worker_tls_restored:AtomicBool,
    child_router_released:AtomicBool,
    source_live_after_child:AtomicBool,
    parent_decoder_reserved:AtomicBool,
    different_thread:AtomicBool,
    foreign_stop:std::sync::Mutex<Option<ProgramStop>>,
    child_stop:std::sync::Mutex<Option<ProgramStop>>,
    foreign_terminal_restored:AtomicBool,
}
struct Worker {mode:Mode,entry:Entry,foreign:bool,evidence:Arc<Evidence>}
impl GeometryProcessor for Worker {
    fn supported_types(&self)->Vec<IfcType> {vec![IfcType::IfcExtrudedAreaSolid]}
    fn process(&self,entity:&DecodedEntity,decoder:&mut EntityDecoder,schema:&IfcSchema,
        quality:TessellationQuality)->ifc_lite_geometry::Result<Mesh> {
        self.evidence.calls.fetch_add(1,Ordering::SeqCst);
        if self.mode==Mode::UnboundedSuccess {
            assert!(resource::current_account().is_none());
            return ExtrudedAreaSolidProcessor::new(schema.clone()).process(entity,decoder,schema,quality);
        }
        if self.mode==Mode::CompatibilityCancel {
            if matches!(self.entry,Entry::Borrowed) && !self.foreign {
                assert!(resource::current_account().is_none(),"compatibility worker carries only source-stop authority");
            }
            let _caught=resource::stop(ProgramStop::Cancelled);
            return ExtrudedAreaSolidProcessor::new(schema.clone()).process(entity,decoder,schema,quality);
        }
        let account=resource::current_account().expect("canonical worker inherits the source owner's account");
        let before=account.usage().work;
        resource::charge(Cost {work:7,..Cost::default()})?;
        self.evidence.charged_work.fetch_add(account.usage().work-before,Ordering::SeqCst);
        match self.mode {
            Mode::Cancel=> {let _caught=resource::stop(ProgramStop::Cancelled);}
            Mode::RefuseWork=> {
                let remaining=WORK_LIMIT.checked_sub(account.usage().work).expect("fixture's finite work allowance");
                let caught=resource::charge(Cost {work:remaining+1,..Cost::default()});
                assert!(matches!(caught,Err(ProgramStop::ResourceRefused(ResourceFailure {dimension:Dimension::Work,..}))));
            }
            _=> {}
        }
        // A legacy extension deliberately ignores its stop and still delegates
        // to the real canonical extrusion implementation. Return barriers decide.
        let mesh=ExtrudedAreaSolidProcessor::new(schema.clone()).process(entity,decoder,schema,quality)?;
        if self.mode==Mode::Panic {
            assert!(!mesh.is_empty(),"the worker panic follows actual extrusion");
            panic!("deliberate accounted worker unwind");
        }
        Ok(mesh)
    }
}

enum ChildValue { Borrowed(ProducedElementMeshes), Accounted(AccountedElementMeshes) }
impl ChildValue {
    fn output(&self)->&ProducedElementMeshes {
        match self {Self::Borrowed(output)=>output,Self::Accounted(output)=>output.output()}
    }
}
struct Threaded {
    router:Weak<GeometryRouter>,mode:Mode,entry:Entry,foreign:bool,
    child:Rc<RefCell<Option<ChildValue>>>,evidence:Arc<Evidence>,
}
impl GeometryProcessor for Threaded {
    fn supported_types(&self)->Vec<IfcType> {vec![IfcType::IfcExtrudedAreaSolid]}
    fn process(&self,entity:&DecodedEntity,decoder:&mut EntityDecoder,schema:&IfcSchema,
        quality:TessellationQuality)->ifc_lite_geometry::Result<Mesh> {
        if entity.id==13 {
            let ancestor=self.router.upgrade().unwrap();
            assert!(ancestor.try_execution_lease().is_err());
            let mode=self.mode;let entry=self.entry;let foreign=self.foreign;let evidence=self.evidence.clone();
            // Round 2 regression: stop BEFORE lending the actual decoder to
            // a fresh worker (same-thread TERMINAL would mask the defect).
            match mode {
                Mode::PreCancelled => { resource::stop(ProgramStop::Cancelled); }
                Mode::PreRefused => { resource::refused(Dimension::Work, 2, 1, resource::RefusalReason::Limit); }
                _ => {}
            }
            let parent_thread=std::thread::current().id();
            let child=std::thread::scope(|scope| {
                let decoder=&mut *decoder;
                let joined=scope.spawn(move||run_child(decoder,mode,entry,foreign,evidence,parent_thread)).join();
                match joined {Ok(child)=>child,Err(panic)=>std::panic::resume_unwind(panic)}
            });
            assert!(ancestor.try_execution_lease().is_err(),"worker cannot release the parent router");
            *self.child.borrow_mut()=child;
        }
        ExtrudedAreaSolidProcessor::new(schema.clone()).process(entity,decoder,schema,quality)
    }
}
fn run_child(decoder:&mut EntityDecoder,mode:Mode,entry:Entry,foreign:bool,evidence:Arc<Evidence>,
    parent_thread:std::thread::ThreadId)->Option<ChildValue> {
    evidence.different_thread.store(std::thread::current().id()!=parent_thread,Ordering::SeqCst);
    assert!(resource::current_account().is_none(),"source authority installs resources only for canonical child execution");
    let mut router=admitted_router(decoder);
    if matches!(mode, Mode::PreCancelled | Mode::PreRefused) {
        router.enable_shared_mapped_item_cache(evidence.cache.clone());
    }
    router.register(Box::new(Worker {mode,entry,foreign,evidence:evidence.clone()}));
    let entity=decoder.decode_by_id(20).unwrap();
    let child_metadata=metadata(20);let child_job=job(&entity,&child_metadata);
    let fresh=ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
    let mut invoke=||catch_unwind(AssertUnwindSafe(||match entry {
        Entry::Borrowed=>Some(ChildValue::Borrowed(produce_element_meshes(&child_job,
            &Context::default().borrowed(),&options(),decoder,&router))),
        Entry::FreshAccount=> {
            let context=ProductionModel::new().snapshot(OwnedMeshProductionData::default());
            match produce_element_meshes_owned_accounted(&child_job,&context,&options(),decoder,&router,&fresh) {
                Ok(output)=>Some(ChildValue::Accounted(output)),
                Err(AccountedProductionError::Stopped(stop))=> {
                    *evidence.child_stop.lock().unwrap() = Some(stop);
                    None
                },
                Err(error)=>panic!("unexpected worker source error: {error}"),
            }
        }
    }));
    let unrelated=ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
    let outcome=if foreign {
        unrelated.scope(|| {
            assert!(resource::current_account().is_some(),"foreign worker account precedes canonical entry");
            let foreign_stop = *evidence.foreign_stop.lock().unwrap();
            if let Some(stop) = foreign_stop { assert_eq!(resource::stop(stop), stop); }
            let outcome=invoke();
            if let Some(stop) = foreign_stop {
                assert_eq!(unrelated.check(), Err(stop), "actual source must not rewrite the unrelated account");
                assert_eq!(resource::check_current(), Err(stop), "restore the foreign terminal domain too");
                evidence.foreign_terminal_restored.store(true, Ordering::SeqCst);
            }
            let restored=resource::current_account().expect("canonical source scope restores foreign account");
            assert_eq!(restored.usage(),unrelated.usage(),"restore the actual prior account after return or unwind");
            evidence.foreign_restored.store(true,Ordering::SeqCst);
            outcome
        })
    } else {invoke()};
    evidence.foreign_work.store(unrelated.usage().work,Ordering::SeqCst);
    evidence.fresh_account_work.store(fresh.usage().work,Ordering::SeqCst);
    assert!(resource::current_account().is_none(),"worker resource TLS restores after return and unwind");
    evidence.worker_tls_restored.store(true,Ordering::SeqCst);
    assert!(router.try_execution_lease().is_ok(),"child releases its independent router");
    evidence.child_router_released.store(true,Ordering::SeqCst);
    assert!(decoder.try_execution_lease().is_err(),"child never releases ancestor decoder");
    evidence.parent_decoder_reserved.store(true,Ordering::SeqCst);
    assert!(decoder.try_source_execution_lease().unwrap().is_some(),"source authority stays live until the parent callback ends");
    evidence.source_live_after_child.store(true,Ordering::SeqCst);
    match outcome {Ok(output)=>output,Err(panic)=>std::panic::resume_unwind(panic)}
}
struct Fixture {
    decoder:EntityDecoder<'static>,router:Rc<GeometryRouter>,mode:Mode,entry:Entry,foreign:bool,
    child:Rc<RefCell<Option<ChildValue>>>,evidence:Arc<Evidence>,
}
impl Fixture {
    fn for_scoped_worker(mode:Mode,entry:Entry)->Self {Self::with_foreign_account(mode,entry,false)}
    fn with_foreign_account(mode:Mode,entry:Entry,foreign:bool)->Self {
        // Add an uncached mapped real slab plus a separate wall-map occurrence
        // used to establish an independent completed cache before cancellation.
        static MAPPED_SOURCE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
        let source = if matches!(mode, Mode::PreCancelled | Mode::PreRefused) {
            MAPPED_SOURCE.get_or_init(|| SOURCE.replace(
                "#22=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#23));",
                "#22=IFCSHAPEREPRESENTATION(#2,'Body','MappedRepresentation',(#24));\n\
                 #24=IFCMAPPEDITEM(#25,#26);#25=IFCREPRESENTATIONMAP(#5,#27);\n\
                 #26=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#4,1.,$);\n\
                 #27=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#23));\n\
                 #28=IFCMAPPEDITEM(#29,#26);#29=IFCREPRESENTATIONMAP(#5,#30);\n\
                 #30=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#13,#4));"
            )).as_str()
        } else { SOURCE };
        let mut decoder=EntityDecoder::new(source);
        let mut base=admitted_router(&mut decoder);
        let child=Rc::new(RefCell::new(None));let evidence=Arc::new(Evidence::default());
        if matches!(mode, Mode::PreCancelled | Mode::PreRefused) {
            base.enable_shared_mapped_item_cache(evidence.cache.clone());
            let prior = decoder.decode_by_id(28).unwrap();
            let mesh = base.process_representation_item(&prior, &mut decoder).unwrap();
            assert!(!mesh.is_empty(), "cache evidence comes from actual wall extrusion");
            assert!(evidence.cache.lock().unwrap().contains_key(&29));
        }
        let router=Rc::new_cyclic(|router| {
            base.register(Box::new(Threaded {router:router.clone(),mode,entry,foreign,
                child:child.clone(),evidence:evidence.clone()}));base
        });
        Self {decoder,router,mode,entry,foreign,child,evidence}
    }
    fn produce(&mut self,account:&ExecutionAccount)->Result<AccountedElementMeshes,AccountedProductionError> {
        let entity=self.decoder.decode_by_id(10).unwrap();
        let context=ProductionModel::new().snapshot(OwnedMeshProductionData::default());
        produce_element_meshes_owned_accounted(&job(&entity,&metadata(10)),&context,
            &options(),&mut self.decoder,&self.router,account)
    }
    fn assert_released(&mut self) {self.assert_released_with_work(7)}
    fn assert_released_with_work(&mut self,charged_work:u64) {
        assert_eq!(self.evidence.calls.load(Ordering::SeqCst),1);
        assert_eq!(self.evidence.charged_work.load(Ordering::SeqCst),charged_work,
            "actual worker work is billed to the inherited parent request");
        let fresh_work=self.evidence.fresh_account_work.load(Ordering::SeqCst);
        if self.mode==Mode::CompatibilityCancel && matches!(self.entry,Entry::FreshAccount) && !self.foreign {
            assert!(fresh_work>0,"compatibility permits an explicit bounded child while sharing terminal source authority");
        } else {
            assert_eq!(fresh_work,0,"a fresh worker-supplied account cannot replace an inherited bounded request");
        }
        if self.foreign {
            assert!(self.evidence.foreign_restored.load(Ordering::SeqCst));
            if self.mode!=Mode::CompatibilityCancel {
                assert_eq!(self.evidence.foreign_work.load(Ordering::SeqCst),0,
                    "a pre-existing foreign worker account cannot receive bounded parent work");
            }
        }
        assert!(self.evidence.different_thread.load(Ordering::SeqCst));
        assert!(self.evidence.worker_tls_restored.load(Ordering::SeqCst));
        assert!(self.evidence.child_router_released.load(Ordering::SeqCst));
        assert!(self.evidence.parent_decoder_reserved.load(Ordering::SeqCst));
        assert!(self.evidence.source_live_after_child.load(Ordering::SeqCst));
        assert!(self.decoder.try_source_execution_lease().unwrap().is_none(),"joined callback source authority expires");
        assert!(self.decoder.try_execution_lease().is_ok());
        assert!(self.router.try_execution_lease().is_ok());
        assert!(resource::current_account().is_none(),"parent resource TLS restores");
    }
}
fn account(mode:Mode)->ExecutionAccount {
    ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits {
        work:(mode==Mode::RefuseWork).then_some(WORK_LIMIT),..ResourceLimits::default()
    }))
}

#[test]
fn canonical_scoped_worker_success_preserves_both_complete_meshes_and_inherits_parent_work() {
    for entry in [Entry::Borrowed,Entry::FreshAccount] {
        let mut fixture=Fixture::for_scoped_worker(Mode::Success,entry);let account=account(Mode::Success);
        let output=fixture.produce(&account).unwrap();
        assert_same(output.output(),&canonical(10,false));
        let child=fixture.child.borrow_mut().take().expect("actual worker child completed");
        assert_same(child.output(),&canonical(20,false));
        assert!(account.usage().work>=7);
        fixture.assert_released();
    }
}
#[test]
fn swallowed_worker_cancellation_is_sticky_at_actual_outer_owned_producer() {
    for entry in [Entry::Borrowed,Entry::FreshAccount] {
        let mut fixture=Fixture::for_scoped_worker(Mode::Cancel,entry);let account=account(Mode::Cancel);
        let result=fixture.produce(&account);
        assert!(matches!(result,Err(AccountedProductionError::Stopped(ProgramStop::Cancelled))));
        assert_eq!(account.check(),Err(ProgramStop::Cancelled));
        fixture.assert_released();
    }
}
#[test]
fn worker_work_refusal_uses_parent_quota_even_with_fresh_supplied_account() {
    for entry in [Entry::Borrowed,Entry::FreshAccount] {
        let mut fixture=Fixture::for_scoped_worker(Mode::RefuseWork,entry);let account=account(Mode::RefuseWork);
        let result=fixture.produce(&account);
        assert!(matches!(result,Err(AccountedProductionError::Stopped(ProgramStop::ResourceRefused(
            ResourceFailure {dimension:Dimension::Work,..})))));
        assert!(account.usage().work>=7&&account.usage().work<=WORK_LIMIT);
        fixture.assert_released();
    }
}
#[test]
fn accounted_scoped_worker_unwind_restores_tls_owners_and_expires_source_authority() {
    for entry in [Entry::Borrowed,Entry::FreshAccount] {
        let mut fixture=Fixture::for_scoped_worker(Mode::Panic,entry);let account=account(Mode::Panic);
        let result=catch_unwind(AssertUnwindSafe(||fixture.produce(&account)));
        assert!(result.is_err(),"actual worker panic reaches the owning canonical call");
        fixture.assert_released();
    }
}


struct CompatibilityNested {
    direct_prepare:bool,calls:Rc<Cell<usize>>,delegated:Rc<Cell<bool>>,
    nested:Rc<RefCell<Option<ExecutionAccount>>>,
}
impl GeometryProcessor for CompatibilityNested {
    fn supported_types(&self)->Vec<IfcType> {vec![IfcType::IfcExtrudedAreaSolid]}
    fn process(&self,entity:&DecodedEntity,decoder:&mut EntityDecoder,schema:&IfcSchema,
        quality:TessellationQuality)->ifc_lite_geometry::Result<Mesh> {
        self.calls.set(self.calls.get()+1);
        assert!(resource::current_account().is_none(),"outer compatibility has no bounded account");
        let fresh=ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits {
            work:Some(0),..ResourceLimits::default()
        }));
        let caught=fresh.scope(|| {
            let cost=Cost {work:1,..Cost::default()};
            if self.direct_prepare {fresh.prepare(cost)} else {resource::charge(cost)}
        });
        assert!(matches!(caught,Err(ProgramStop::ResourceRefused(ResourceFailure {
            dimension:Dimension::Work,requested:1,remaining:0,..
        }))));
        *self.nested.borrow_mut()=Some(fresh);
        assert!(resource::current_account().is_none(),"fresh child account TLS restored to compatibility");
        // The extension catches the refusal, exits the bounded scope, and still
        // invokes the actual extrusion. The enclosing canonical terminal owns it.
        self.delegated.set(true);
        ExtrudedAreaSolidProcessor::new(schema.clone()).process(entity,decoder,schema,quality)
    }
}
#[test]
fn compatibility_outer_canonical_call_cannot_swallow_a_nested_fresh_bounded_refusal() {
    for direct_prepare in [false,true] {
        let mut decoder=EntityDecoder::new(SOURCE);
        let mut router=admitted_router(&mut decoder);
        let calls=Rc::new(Cell::new(0));let delegated=Rc::new(Cell::new(false));
        let nested=Rc::new(RefCell::new(None));
        router.register(Box::new(CompatibilityNested {direct_prepare,calls:calls.clone(),
            delegated:delegated.clone(),nested:nested.clone()}));
        let entity=decoder.decode_by_id(10).unwrap();
        let context=ProductionModel::new().snapshot(OwnedMeshProductionData::default());
        let compatibility=ExecutionAccount::new(ExecutionPolicy::Compatibility);
        let result=produce_element_meshes_owned_accounted(&job(&entity,&metadata(10)),&context,
            &options(),&mut decoder,&router,&compatibility);
        assert!(matches!(result,Err(AccountedProductionError::Stopped(ProgramStop::ResourceRefused(
            ResourceFailure {dimension:Dimension::Work,requested:1,remaining:0,..}
        )))),"exiting a bounded child scope cannot convert its stop into outer compatibility success");
        assert_eq!(calls.get(),1,"terminal nested refusal cannot enter geometry retries");
        assert!(delegated.get(),"the extension continued into the real extrusion after catching refusal");
        assert_eq!(compatibility.usage(),resource::Usage::default());
        assert!(matches!(nested.borrow().as_ref().unwrap().check(),Err(ProgramStop::ResourceRefused(
            ResourceFailure {dimension:Dimension::Work,..}
        ))));
        assert!(resource::current_account().is_none());
        assert!(resource::check_current().is_ok(),"terminal scope expires after the owning canonical call");
        assert!(decoder.try_source_execution_lease().unwrap().is_none());
        assert!(decoder.try_execution_lease().is_ok());
        assert!(router.try_execution_lease().is_ok());
    }
}


#[test]
fn compatibility_outer_receives_explicit_worker_cancellation_through_source_stop_authority() {
    for entry in [Entry::Borrowed,Entry::FreshAccount] {
        let mut fixture=Fixture::for_scoped_worker(Mode::CompatibilityCancel,entry);
        let compatibility=ExecutionAccount::new(ExecutionPolicy::Compatibility);
        let result=fixture.produce(&compatibility);
        assert!(matches!(result,Err(AccountedProductionError::Stopped(ProgramStop::Cancelled))),
            "absence of a bounded account cannot discard a joined worker's source-owned terminal stop");
        assert_eq!(compatibility.usage(),resource::Usage::default());
        fixture.assert_released_with_work(0);
        assert!(resource::check_current().is_ok(),"source-stop terminal authority expires after outer return");
    }
}


#[test]
fn validated_source_scope_overrides_foreign_worker_account_and_restores_it_after_actual_child() {
    for mode in [Mode::Success,Mode::Cancel,Mode::RefuseWork,Mode::Panic,Mode::CompatibilityCancel] {
        for entry in [Entry::Borrowed,Entry::FreshAccount] {
            let mut fixture=Fixture::with_foreign_account(mode,entry,true);
            let account=if mode==Mode::CompatibilityCancel {
                ExecutionAccount::new(ExecutionPolicy::Compatibility)
            } else {account(mode)};
            let result=catch_unwind(AssertUnwindSafe(||fixture.produce(&account)));
            match (mode,result) {
                (Mode::Success,Ok(Ok(output)))=> {
                    assert_same(output.output(),&canonical(10,false));
                    let child=fixture.child.borrow_mut().take().expect("actual foreign-scope worker child completed");
                    assert_same(child.output(),&canonical(20,false));
                    assert!(account.usage().work>=7);
                }
                (Mode::Cancel|Mode::CompatibilityCancel,Ok(Err(AccountedProductionError::Stopped(ProgramStop::Cancelled))))=> {}
                (Mode::RefuseWork,Ok(Err(AccountedProductionError::Stopped(ProgramStop::ResourceRefused(
                    ResourceFailure {dimension:Dimension::Work,..})))))=> {}
                (Mode::Panic,Err(_))=> {}
                _=>panic!("foreign worker scope changed the canonical success or terminal contract"),
            }
            fixture.assert_released_with_work(if mode==Mode::CompatibilityCancel {0}else{7});
            assert!(resource::check_current().is_ok(),"completed source and foreign scopes leave no ambient stop");
        }
    }
}


// Round 2: a real slab producer must be refused before its numerical callback
// and before publishing output when the Compatibility source already stopped.
#[test]
fn compatibility_preexisting_ancestor_stop_admits_no_scoped_child_geometry() {
    for mode in [Mode::PreCancelled, Mode::PreRefused] {
        for entry in [Entry::Borrowed, Entry::FreshAccount] {
            let mut fixture = Fixture::for_scoped_worker(mode, entry);
            let compatibility = ExecutionAccount::new(ExecutionPolicy::Compatibility);
            let prior = fixture.evidence.cache.lock().unwrap().get(&29).unwrap().clone();
            let result = fixture.produce(&compatibility);
            let expected = if mode == Mode::PreCancelled { ProgramStop::Cancelled } else {
                ProgramStop::ResourceRefused(ResourceFailure { dimension: Dimension::Work,
                    requested: 2, remaining: 1, reason: resource::RefusalReason::Limit })
            };
            assert!(matches!(result, Err(AccountedProductionError::Stopped(stop)) if stop == expected));
            assert_eq!(fixture.evidence.calls.load(Ordering::SeqCst), 0,
                "pre-stopped source cannot enter the actual child extrusion callback");
            assert_eq!(fixture.evidence.fresh_account_work.load(Ordering::SeqCst), 0,
                "pre-stopped child cannot begin planning or issue accounted work");
            if let Some(child) = fixture.child.borrow_mut().take() {
                assert!(child.output().meshes.is_empty());
                assert!(child.output().instance_occurrences.is_empty());
                assert!(child.output().csg_failures.is_empty());
            } else { assert!(matches!(entry, Entry::FreshAccount)); }
            let cache = fixture.evidence.cache.lock().unwrap();
            assert_eq!(cache.len(), 1, "no descendant mapped source may be published");
            assert!(Arc::ptr_eq(cache.get(&29).unwrap(), &prior),
                "independent completed cache payload retains its original owner");
            assert!(!cache.contains_key(&25), "unadmitted slab source was never cached");
            drop(cache);
            let reports = fixture.router.take_unsupported_items();
            assert_eq!(reports.get("IfcCartesianPoint"), Some(&1),
                "earlier actual source-fault evidence survives terminal child refusal");
            assert!(fixture.evidence.different_thread.load(Ordering::SeqCst));
            assert!(fixture.evidence.child_router_released.load(Ordering::SeqCst));
            assert!(fixture.evidence.parent_decoder_reserved.load(Ordering::SeqCst));
            assert!(fixture.decoder.try_source_execution_lease().unwrap().is_none());
            assert!(fixture.decoder.try_execution_lease().is_ok());
            assert!(fixture.router.try_execution_lease().is_ok());
            assert!(resource::check_current().is_ok());
        }
    }
}


#[test]
fn default_borrowed_scoped_worker_keeps_unbounded_real_geometry() {
    let mut fixture = Fixture::for_scoped_worker(Mode::UnboundedSuccess, Entry::Borrowed);
    let entity = fixture.decoder.decode_by_id(10).unwrap();
    let output = produce_element_meshes(&job(&entity, &metadata(10)),
        &Context::default().borrowed(), &options(), &mut fixture.decoder, &fixture.router);
    assert_same(&output, &canonical(10, false));
    let child = fixture.child.borrow_mut().take().expect("real unbounded worker slab");
    assert_same(child.output(), &canonical(20, false));
    fixture.assert_released_with_work(0);
    assert!(resource::check_current().is_ok());
}


#[test]
fn scoped_source_ancestor_fault_wins_over_distinct_foreign_terminal_and_restores_it() {
    for bounded in [false, true] {
        for mode in [Mode::PreCancelled, Mode::PreRefused] {
            let mut fixture = Fixture::with_foreign_account(mode, Entry::FreshAccount, true);
            let refusal = ProgramStop::ResourceRefused(ResourceFailure { dimension: Dimension::Work,
                requested: 2, remaining: 1, reason: resource::RefusalReason::Limit });
            let source_stop = if mode == Mode::PreCancelled { ProgramStop::Cancelled } else { refusal };
            let foreign_stop = if mode == Mode::PreCancelled { refusal } else { ProgramStop::Cancelled };
            *fixture.evidence.foreign_stop.lock().unwrap() = Some(foreign_stop);
            let account = ExecutionAccount::new(if bounded {
                ExecutionPolicy::Bounded(ResourceLimits::default())
            } else { ExecutionPolicy::Compatibility });
            let result = fixture.produce(&account);
            assert!(matches!(result, Err(AccountedProductionError::Stopped(stop)) if stop == source_stop));
            assert_eq!(*fixture.evidence.child_stop.lock().unwrap(), Some(source_stop),
                "the actual child result must report its source ancestor, not worker ambient state");
            assert!(fixture.evidence.foreign_terminal_restored.load(Ordering::SeqCst));
            assert_eq!(fixture.evidence.calls.load(Ordering::SeqCst), 0,
                "the pre-stopped actual source admits no worker geometry");
            assert!(fixture.child.borrow().is_none());
            assert!(fixture.decoder.try_execution_lease().is_ok());
            assert!(fixture.router.try_execution_lease().is_ok());
            assert!(resource::check_current().is_ok());
        }
    }
}

#[test]
fn healthy_bounded_source_does_not_inherit_foreign_worker_fault_on_scope_exit() {
    let mut fixture = Fixture::with_foreign_account(Mode::Success, Entry::FreshAccount, true);
    *fixture.evidence.foreign_stop.lock().unwrap() = Some(ProgramStop::Cancelled);
    let account = account(Mode::Success);
    let output = fixture.produce(&account).unwrap();
    assert_same(output.output(), &canonical(10, false));
    let child = fixture.child.borrow_mut().take().expect("actual child survives unrelated stopped scope");
    assert_same(child.output(), &canonical(20, false));
    assert_eq!(account.check(), Ok(()));
    assert!(fixture.evidence.foreign_terminal_restored.load(Ordering::SeqCst));
    fixture.assert_released();
}

// Reply backing is admitted before the existing reached source/processor call.
struct ReplyAdmissionExtrusion(Rc<Cell<usize>>);
impl GeometryProcessor for ReplyAdmissionExtrusion {
    fn supported_types(&self) -> Vec<IfcType> {vec![IfcType::IfcExtrudedAreaSolid]}
    fn process(&self, entity:&DecodedEntity, decoder:&mut EntityDecoder, schema:&IfcSchema,
        quality:TessellationQuality) -> ifc_lite_geometry::Result<Mesh> {
        self.0.set(self.0.get()+1);
        ExtrudedAreaSolidProcessor::new(schema.clone()).process(entity,decoder,schema,quality)
    }
}
fn reply_admission_fixture() -> (EntityDecoder<'static>,GeometryRouter,Rc<Cell<usize>>) {
    let mut decoder=EntityDecoder::new(SOURCE);
    let mut router=admitted_router(&mut decoder);
    let calls=Rc::new(Cell::new(0));
    router.register(Box::new(ReplyAdmissionExtrusion(calls.clone())));
    (decoder,router,calls)
}
fn reached_extrusion_reply_step() -> usize {
    let (mut decoder,router,calls)=reply_admission_fixture();
    let entity=decoder.decode_by_id(10).unwrap();let metadata=metadata(10);let context=Context::default();
    let mut state=super::session::ProductState::new(&job(&entity,&metadata),&context.borrowed(),
        &options(),&mut decoder,&router);
    let mut steps=0;
    while calls.get()==0 {
        let request=state.request().unwrap().expect("real extrusion callback remains pending");
        let reply=state.execute(request,&context.borrowed(),&mut decoder,&router).unwrap();
        steps+=1;
        state.accept(reply,&context.borrowed(),&mut decoder,&router).unwrap();
    }
    while state.advance(&context.borrowed(),&mut decoder,&router) {}
    assert_same(&state.finish(&decoder,&router),&canonical(10,false));
    assert_eq!(calls.get(),1,"the witness reaches the original real processor once");
    steps
}
#[test]
fn zero_reply_backing_allowance_stops_before_the_reached_real_processor() {
    let callback_step=reached_extrusion_reply_step();
    let (mut decoder,router,calls)=reply_admission_fixture();
    let entity=decoder.decode_by_id(10).unwrap();let metadata=metadata(10);let context=Context::default();
    let mut state=super::session::ProductState::new(&job(&entity,&metadata),&context.borrowed(),
        &options(),&mut decoder,&router);
    let limit=1_048_576;
    let account=ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits {
        live_bytes:Some(limit),..ResourceLimits::default() }));
    account.scope(|| {
        for _ in 1..callback_step {
            let request=state.request().unwrap().unwrap();
            let reply=state.execute(request,&context.borrowed(),&mut decoder,&router).unwrap();
            state.accept(reply,&context.borrowed(),&mut decoder,&router).unwrap();
        }
        assert_eq!(calls.get(),0);
        let request=state.request().unwrap().unwrap();assert!(request.inner.is_some());
        // A still-live reservation for other work consumes the remaining
        // allowance before this exact callback is admitted, without a new stop.
        let held=resource::charge(Cost {live_bytes:limit-account.usage().live_bytes,..Cost::default()}).unwrap();
        let cache=decoder.cache_size();let usage=account.usage();
        let reply=state.execute(request,&context.borrowed(),&mut decoder,&router).unwrap();
        assert!(matches!(&reply.payload,super::session_protocol::WorkPayload::Stopped(
            ProgramStop::ResourceRefused(f)) if f.dimension==Dimension::LiveBytes && f.remaining==0
                && f.requested==std::mem::size_of::<ifc_lite_geometry::program::ProgramReply>() as u64));
        assert_eq!(reply.request,request);assert!(reply.registry_emitters.is_empty());
        assert!(state.pending_geometry.is_some(),"terminal diagnostics retain the original dormant engine");
        assert_eq!(calls.get(),0,"no new processor runs before reply storage admission");
        assert_eq!(decoder.cache_size(),cache,"the refused work performs no source decode");
        assert_eq!(account.usage(),usage,"a refused header creates no new allocation charge");
        state.accept(reply,&context.borrowed(),&mut decoder,&router).unwrap();
        assert!(state.request().unwrap().is_none());
        let stopped=state.finish(&decoder,&router);
        assert!(stopped.meshes.is_empty());assert!(stopped.instance_occurrences.is_empty());
        drop(held);
    });
    assert!(decoder.try_execution_lease().is_ok());assert!(router.try_execution_lease().is_ok());
    assert!(resource::current_account().is_none());
}

#[test]
fn rejected_real_inner_reply_retains_its_admitted_box_until_packet_drop() {
    use super::session_protocol::{WorkEmitter,WorkError};
    let (mut decoder,router,calls)=reply_admission_fixture();
    let entity=decoder.decode_by_id(10).unwrap();let metadata=metadata(10);let context=Context::default();
    let mut state=super::session::ProductState::new(&job(&entity,&metadata),&context.borrowed(),
        &options(),&mut decoder,&router);
    let account=ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
    account.scope(|| {
        let request=state.request().unwrap().unwrap();assert!(request.inner.is_some());
        let before=account.usage().live_bytes;
        let mut reply=state.execute(request,&context.borrowed(),&mut decoder,&router).unwrap();
        assert!(matches!(&reply.payload,super::session_protocol::WorkPayload::GeometryStep(_,_)));
        let resident=account.usage().live_bytes;
        let header=std::mem::size_of::<ifc_lite_geometry::program::ProgramReply>() as u64;
        assert!(resident>=before+header);
        reply.emitter=match reply.emitter {WorkEmitter::PlainParts=>WorkEmitter::TexturedProduct,_=>WorkEmitter::PlainParts};
        let rejected=state.accept(reply,&context.borrowed(),&mut decoder,&router).unwrap_err();
        assert_eq!(rejected.error,WorkError::WrongEmitter);
        assert_eq!(account.usage().live_bytes,resident,"rejection returns actual reply storage intact");
        drop(rejected.reply);
        assert!(account.usage().live_bytes<=resident-header,"dropping the packet refunds its owned box backing");
        assert_eq!(calls.get(),0,"this real source admission precedes the constructor");
        state.remember_stop(ProgramStop::Cancelled);
        let stopped=state.finish(&decoder,&router);assert!(stopped.meshes.is_empty());
    });
    assert!(decoder.try_execution_lease().is_ok());assert!(router.try_execution_lease().is_ok());
}
