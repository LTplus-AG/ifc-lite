// SPDX-License-Identifier: MPL-2.0
//! Real canonical child production through a scoped mutable-decoder borrow.
//! The non-Send outer router stays on its thread; child routers are independent.
use super::*;
use super::session::ProductState;
use super::session_protocol::WorkError;
use super::session_tests::{Context,SOURCE,assert_same,canonical,job,metadata,options,router};
use ifc_lite_core::IfcSchema;
use ifc_lite_geometry::{ExtrudedAreaSolidProcessor,GeometryProcessor,TessellationQuality};
use std::{cell::{Cell,RefCell},panic::{catch_unwind,AssertUnwindSafe},rc::{Rc,Weak},
    sync::{Arc,atomic::{AtomicBool,AtomicUsize,Ordering}}};

#[derive(Clone,Copy,PartialEq,Eq)]
enum Mode { Success, BusyRouter, PanicChild }
#[derive(Default)]
struct Evidence {
    worker_calls:AtomicUsize,
    strict_sibling_refused:AtomicBool,
    parent_stayed_reserved:AtomicBool,
    child_router_released:AtomicBool,
}
struct WorkerExtrusion { mode:Mode,evidence:Arc<Evidence> }
impl GeometryProcessor for WorkerExtrusion {
    fn supported_types(&self)->Vec<IfcType> {vec![IfcType::IfcExtrudedAreaSolid]}
    fn process(&self,entity:&DecodedEntity,decoder:&mut EntityDecoder,schema:&IfcSchema,
        quality:TessellationQuality)->ifc_lite_geometry::Result<Mesh> {
        self.evidence.worker_calls.fetch_add(1,Ordering::SeqCst);
        // These legal callback mutations change decoder generation on the
        // child thread. Both child and enclosing parent work must commit it.
        decoder.clear_entity_cache();
        let scale=decoder.length_unit_scale();
        decoder.seed_unit_scales(scale,1.);
        let mesh=ExtrudedAreaSolidProcessor::new(schema.clone()).process(entity,decoder,schema,quality)?;
        assert!(!mesh.is_empty(),"panic mode still reaches actual geometry");
        if self.mode==Mode::PanicChild {panic!("child worker interrupted after real extrusion");}
        Ok(mesh)
    }
}
struct ThreadedExtrusion {
    router:Weak<GeometryRouter>,
    mode:Rc<Cell<Mode>>,
    child:Rc<RefCell<Option<ProducedElementMeshes>>>,
    evidence:Arc<Evidence>,
}
impl GeometryProcessor for ThreadedExtrusion {
    fn supported_types(&self)->Vec<IfcType> {vec![IfcType::IfcExtrudedAreaSolid]}
    fn process(&self,entity:&DecodedEntity,decoder:&mut EntityDecoder,schema:&IfcSchema,
        quality:TessellationQuality)->ifc_lite_geometry::Result<Mesh> {
        if entity.id==13 {
            let ancestor=self.router.upgrade().unwrap();
            assert!(ancestor.try_execution_lease().is_err());
            let mode=self.mode.get();
            let evidence=self.evidence.clone();
            let parent_thread=std::thread::current().id();
            let (child,worker_thread)=std::thread::scope(|scope| {
                // Only the exclusively reborrowed Send decoder crosses this
                // edge. Rc router/counters and the processor remain here.
                let decoder=&mut *decoder;
                scope.spawn(move|| {
                    let worker_thread=std::thread::current().id();
                    let mut child_router=router(decoder);
                    child_router.register(Box::new(WorkerExtrusion {mode,evidence:evidence.clone()}));
                    let child_entity=decoder.decode_by_id(20).unwrap();
                    let child_metadata=metadata(20);
                    let child_job=job(&child_entity,&child_metadata);
                    let context=Context::default();
                    // An active source borrow authorizes only the canonical
                    // lexical path; ordinary private sibling planning stays strict.
                    let sibling=catch_unwind(AssertUnwindSafe(|| ProductState::new(
                        &child_job,&context.borrowed(),&options(),decoder,&child_router)));
                    assert!(sibling.is_err(),"private sibling must not inherit source authority");
                    assert_eq!(evidence.worker_calls.load(Ordering::SeqCst),0);
                    evidence.strict_sibling_refused.store(true,Ordering::SeqCst);
                    let busy=(mode==Mode::BusyRouter).then(||child_router.try_execution_lease().unwrap());
                    let outcome=catch_unwind(AssertUnwindSafe(||produce_element_meshes(
                        &child_job,&context.borrowed(),&options(),decoder,&child_router)));
                    assert!(decoder.try_execution_lease().is_err(),"child never unlocks ancestor decoder");
                    evidence.parent_stayed_reserved.store(true,Ordering::SeqCst);
                    match (mode,outcome) {
                        (Mode::Success,Ok(child))=>(Some(child),worker_thread),
                        (Mode::BusyRouter,Err(panic))=> {
                            let message=panic_message(panic.as_ref());
                            assert!(message.contains("OwnerBusy"),"{message}");
                            assert_eq!(evidence.worker_calls.load(Ordering::SeqCst),0);
                            assert!(child_router.try_execution_lease().is_err(),"independent occupied router remains reserved");
                            drop(busy);
                            child_router.try_execution_lease().expect("only owner drop releases the fresh router");
                            (None,worker_thread)
                        }
                        (Mode::PanicChild,Err(panic))=> {
                            child_router.try_execution_lease().expect("child panic releases its independent router");
                            evidence.child_router_released.store(true,Ordering::SeqCst);
                            // The caller's still-active source scope survives a
                            // caught child unwind until the parent itself unwinds.
                            let inherited=decoder.try_source_execution_lease().unwrap().expect("ancestor source scope remains live");
                            inherited.validate(decoder.execution_identity()).unwrap();
                            drop(inherited);
                            std::panic::resume_unwind(panic)
                        }
                        (_,Ok(_))=>panic!("expected child failure was incorrectly accepted"),
                        (_,Err(panic))=>std::panic::resume_unwind(panic),
                    }
                }).join().expect("scoped canonical worker completed")
            });
            assert_ne!(parent_thread,worker_thread,"fixture must cross an actual thread");
            assert!(ancestor.try_execution_lease().is_err(),"worker cannot release parent router");
            *self.child.borrow_mut()=child;
        }
        ExtrudedAreaSolidProcessor::new(schema.clone()).process(entity,decoder,schema,quality)
    }
}
fn panic_message(panic:&(dyn std::any::Any+Send))->&str {
    panic.downcast_ref::<String>().map(String::as_str)
        .or_else(||panic.downcast_ref::<&str>().copied()).expect("textual failure")
}
struct Fixture {
    decoder:EntityDecoder<'static>,
    router:Rc<GeometryRouter>,
    mode:Rc<Cell<Mode>>,
    child:Rc<RefCell<Option<ProducedElementMeshes>>>,
    evidence:Arc<Evidence>,
}
impl Fixture {
    fn new(mode:Mode)->Self {
        let mut decoder=EntityDecoder::new(SOURCE);
        let mut base=router(&mut decoder);
        let mode=Rc::new(Cell::new(mode));
        let child=Rc::new(RefCell::new(None));
        let evidence=Arc::new(Evidence::default());
        let router=Rc::new_cyclic(|router| {
            base.register(Box::new(ThreadedExtrusion {router:router.clone(),mode:mode.clone(),
                child:child.clone(),evidence:evidence.clone()}));
            base
        });
        Self {decoder,router,mode,child,evidence}
    }
    fn session(&mut self,id:u32)->ProductState {
        let entity=self.decoder.decode_by_id(id).unwrap();
        ProductState::new(&job(&entity,&metadata(id)),&Context::default().borrowed(),
            &options(),&mut self.decoder,&self.router)
    }
    fn produce(&mut self)->ProducedElementMeshes {
        let entity=self.decoder.decode_by_id(10).unwrap();
        produce_element_meshes(&job(&entity,&metadata(10)),&Context::default().borrowed(),
            &options(),&mut self.decoder,&self.router)
    }
}

#[test]
fn scoped_decoder_worker_child_preserves_complete_output_and_commits_reached_generation_mutations() {
    let mut fixture=Fixture::new(Mode::Success);
    let before=fixture.decoder.execution_identity();
    let wall=fixture.produce();
    assert_ne!(fixture.decoder.execution_identity(),before,"worker really performed decoder maintenance");
    let child=fixture.child.borrow_mut().take().expect("canonical worker child published");
    assert_same(&wall,&canonical(10,false));
    assert_same(&child,&canonical(20,false));
    assert!((wall.geometry_volume.unwrap()-24.).abs()<1e-5);
    assert!((child.geometry_volume.unwrap()-4.).abs()<1e-5);
    assert_eq!(fixture.evidence.worker_calls.load(Ordering::SeqCst),1);
    assert!(fixture.evidence.strict_sibling_refused.load(Ordering::SeqCst));
    assert!(fixture.evidence.parent_stayed_reserved.load(Ordering::SeqCst));
    assert!(fixture.decoder.try_source_execution_lease().unwrap().is_none(),"source authority ends at joined work");
    fixture.decoder.try_execution_lease().expect("publication releases root decoder");
    fixture.router.try_execution_lease().expect("publication releases root router");
}

#[test]
fn waiting_reply_carries_no_source_borrow_authority_and_private_sibling_cannot_steal_owners() {
    let mut fixture=Fixture::new(Mode::Success);
    let mut outer=fixture.session(10);
    let mut sibling=fixture.session(50);
    let sibling_request=sibling.request().unwrap().unwrap();
    let request=outer.request().unwrap().unwrap();
    let context=Context::default();
    let reply=outer.execute(request,&context.borrowed(),&mut fixture.decoder,&fixture.router).unwrap();
    assert!(fixture.decoder.try_source_execution_lease().unwrap().is_none());
    assert_eq!(sibling.execute(sibling_request,&context.borrowed(),&mut fixture.decoder,&fixture.router).err(),Some(WorkError::OwnerBusy));
    assert!(outer.meshes.is_empty()&&sibling.meshes.is_empty(),"waiting or rejected work cannot assemble");
    assert!(fixture.decoder.try_execution_lease().is_err());
    outer.accept(reply,&context.borrowed(),&mut fixture.decoder,&fixture.router).unwrap();
    while outer.advance(&context.borrowed(),&mut fixture.decoder,&fixture.router) {}
    assert_same(&outer.finish(&fixture.decoder,&fixture.router),&canonical(10,false));
    // Refusal consumes neither the independent sibling request nor its geometry.
    let reply=sibling.execute(sibling_request,&context.borrowed(),&mut fixture.decoder,&fixture.router).unwrap();
    sibling.accept(reply,&context.borrowed(),&mut fixture.decoder,&fixture.router).unwrap();
    while sibling.advance(&context.borrowed(),&mut fixture.decoder,&fixture.router) {}
    assert_same(&sibling.finish(&fixture.decoder,&fixture.router),&canonical(50,false));
}

#[test]
fn source_borrow_cannot_unlock_an_independently_reserved_fresh_worker_router() {
    let mut fixture=Fixture::new(Mode::BusyRouter);
    let wall=fixture.produce();
    assert_same(&wall,&canonical(10,false));
    assert!(fixture.child.borrow().is_none());
    assert_eq!(fixture.evidence.worker_calls.load(Ordering::SeqCst),0,"refused child never executes geometry");
    assert!(fixture.evidence.parent_stayed_reserved.load(Ordering::SeqCst));
    fixture.decoder.try_execution_lease().expect("ancestor releases only at its own publication");
}

#[test]
fn scoped_worker_panic_releases_child_router_preserves_parent_until_unwind_and_expires_source_authority() {
    let mut fixture=Fixture::new(Mode::PanicChild);
    let mut session=fixture.session(10);
    let request=session.request().unwrap().unwrap();
    let panic=catch_unwind(AssertUnwindSafe(|| {
        let _=session.execute(request,&Context::default().borrowed(),&mut fixture.decoder,&fixture.router);
    }));
    assert!(panic.is_err());
    assert!(fixture.evidence.child_router_released.load(Ordering::SeqCst));
    assert!(fixture.evidence.parent_stayed_reserved.load(Ordering::SeqCst));
    assert_eq!(fixture.evidence.worker_calls.load(Ordering::SeqCst),1);
    assert!(session.scopes.is_none(),"interrupted parent cannot resume or publish");
    assert!(fixture.child.borrow().is_none());
    assert!(fixture.decoder.try_source_execution_lease().unwrap().is_none());
    fixture.decoder.try_execution_lease().expect("parent unwind releases decoder root");
    fixture.router.try_execution_lease().expect("parent unwind releases router root");
    assert!(catch_unwind(AssertUnwindSafe(||session.request())).is_err());
    // A new canonical root uses the same warm owners after expired authority
    // and abandoned geometry have been removed.
    drop(session);
    fixture.mode.set(Mode::Success);
    fixture.evidence.worker_calls.store(0,Ordering::SeqCst);
    let wall=fixture.produce();
    assert_same(&wall,&canonical(10,false));
    assert_same(&fixture.child.borrow_mut().take().unwrap(),&canonical(20,false));
}
