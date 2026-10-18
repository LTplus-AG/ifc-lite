// SPDX-License-Identifier: MPL-2.0
//! Lexical child admission is confined to the synchronous canonical producer.
//! Private resumable products continue to acquire exclusive owner leases.
use super::*;
use super::session::ProductState;
use super::session_owner::ProductOwner;
use super::session_protocol::WorkError;
use ifc_lite_core::execution_owner::{ExecutionChildCapability,ExecutionIdentity,ExecutionLease,ExecutionLeaseError};
use std::{cell::RefCell,marker::PhantomData,rc::Rc};

struct ActiveOwner {
    router:ExecutionChildCapability,
    decoder:ExecutionChildCapability,
}
thread_local! {
    static ACTIVE:RefCell<Vec<ActiveOwner>>=const {RefCell::new(Vec::new())};
}
struct ActiveScope {
    previous_len:usize,
    _thread_bound:PhantomData<Rc<()>>,
}
impl Drop for ActiveScope {
    fn drop(&mut self) { ACTIVE.with(|active|active.borrow_mut().truncate(self.previous_len)); }
}

pub(super) fn with_active_owner<T>(router_cap:ExecutionChildCapability,
    decoder_cap:ExecutionChildCapability,operation:impl FnOnce()->T)->T {
    let previous_len=ACTIVE.with(|active| {
        let mut active=active.borrow_mut();
        let previous_len=active.len();
        active.push(ActiveOwner {router:router_cap,decoder:decoder_cap});
        previous_len
    });
    let _scope=ActiveScope {previous_len,_thread_bound:PhantomData};
    operation()
}

fn inherited_half(identity:ExecutionIdentity,router:bool)
    ->std::result::Result<Option<ExecutionLease>,WorkError> {
    ACTIVE.with(|active| {
        // Fully independent canonical children must not hide still-live
        // ancestor owners from a later synchronous grandchild. Search each
        // actual supplied half independently, preferring the innermost frame.
        for owner in active.borrow().iter().rev() {
            let capability=if router {&owner.router}else{&owner.decoder};
            match capability.try_lease(identity) {
                Ok(lease)=>return Ok(Some(lease)),
                Err(ExecutionLeaseError::WrongOwner)=>continue,
                Err(_)=>return Err(WorkError::WrongOwner),
            }
        }
        Ok(None)
    })
}

pub(super) fn inherited_owner(decoder:&mut EntityDecoder,router:&GeometryRouter)
    ->std::result::Result<Option<ProductOwner>,WorkError> {
    let router_lease=inherited_half(router.execution_identity(),true)?;
    let decoder_lease=match inherited_half(decoder.execution_identity(),false)? {
        Some(lease)=>Some(lease),
        // A scoped thread can borrow the actual mutable decoder while the
        // parent's synchronous callback waits. Its explicit source-work scope
        // authorizes this child; an ordinary reserved owner grants nothing.
        None=>decoder.try_source_execution_lease().map_err(|_|WorkError::WrongOwner)?,
    };
    if router_lease.is_none()&&decoder_lease.is_none() {return Ok(None)}
    // Each unmatched half is independently and exclusively reserved. A matched
    // half remains bound to its original live ancestor epoch. Only an explicit
    // source borrow may cross threads; router capabilities remain thread-bound.
    // Dropping a child never releases an ancestor's root reservation.
    let router_lease=match router_lease {
        Some(lease)=>lease,
        None=>router.try_execution_lease().map_err(|_|WorkError::OwnerBusy)?,
    };
    let decoder_lease=match decoder_lease {
        Some(lease)=>lease,
        None=>decoder.try_execution_lease().map_err(|_|WorkError::OwnerBusy)?,
    };
    Ok(Some(ProductOwner::from_child_leases(router_lease,decoder_lease)))
}

/// A joined worker recovers resource state from its actual mutable source borrow.
/// Source authority takes precedence over unrelated worker-local accounts.
/// No other TLS moves.
pub(super) fn with_source_resources<T>(decoder: &mut EntityDecoder,
    operation: impl FnOnce(&mut EntityDecoder) -> T) -> T {
    use ifc_lite_geometry::resource;
    let transport = decoder.try_source_execution_lease().ok().flatten().map(|lease| {
        (lease.source_resource_context(), lease.source_stop_handle())
    });
    let Some((Ok(context), Ok(Some(stop)))) = transport else { return operation(decoder) };
    resource::with_source_stop(stop, || {
        if let Some(context) = context {
            let account = resource::account_from_source_context(&context)
                .unwrap_or_else(|stop| { resource::stop(stop); Default::default() });
            account.source_scope(|| operation(decoder))
        } else { operation(decoder) }
    })
}

pub(super) fn produce(job:&ElementMeshJob<'_>,ctx:&MeshProductionContext<'_>,
    opts:&MeshProductionOptions,decoder:&mut EntityDecoder,router:&GeometryRouter)->ProducedElementMeshes {
    // This child continuation never crosses a scheduling yield, publication
    // boundary or thread. Unwinding drops it before the ancestor scope exits.
    with_source_resources(decoder, |decoder| {
    if ifc_lite_geometry::resource::check_current().is_err() { return stopped_output() }
    let mut execution=ProductState::new_canonical(job,ctx,opts,decoder,router);
    while execution.advance(ctx,decoder,router) {}
    execution.finish(decoder,router)
    })
}

// Borrowed APIs remain infallible. The actual source-owned terminal survives
// this empty child return and is reported by the outer accounted adapter.
// No plan, numerical callback, final hook or cache publication is admitted.
pub(super) fn stopped_output() -> ProducedElementMeshes {
    ProducedElementMeshes { meshes: Vec::new(), instance_occurrences: Vec::new(),
        geometry_hash: None, geometry_aabb: None, geometry_volume: None,
        geometry_closure: None, csg_failures: FxHashMap::default(),
        degenerate_triangles_dropped: 0 }
}
