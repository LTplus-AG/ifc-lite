// SPDX-License-Identifier: MPL-2.0
//! The synchronous canonical driver and its lexical child admission.
//!
//! While a product's work runs, its owner capabilities sit on a thread-local
//! stack. A canonical product started from inside that work (a registered
//! processor producing a nested element) inherits the matching live ancestor
//! half instead of being refused as busy; each unmatched half is reserved
//! exclusively, and an independent sibling never inherits anything. Private
//! resumable products always acquire exclusive owner leases.
use super::session::ProductState;
use super::session_owner::ProductOwner;
use super::session_protocol::WorkError;
use super::*;
use ifc_lite_core::execution_owner::{ExecutionChildCapability, ExecutionIdentity, ExecutionLease, ExecutionLeaseError};
use std::{cell::RefCell, marker::PhantomData, rc::Rc};

struct ActiveOwner {
    router: ExecutionChildCapability,
    decoder: ExecutionChildCapability,
}
thread_local! {
    static ACTIVE: RefCell<Vec<ActiveOwner>> = const { RefCell::new(Vec::new()) };
}
struct ActiveScope {
    previous_len: usize,
    _thread_bound: PhantomData<Rc<()>>,
}
impl Drop for ActiveScope {
    fn drop(&mut self) {
        ACTIVE.with(|active| active.borrow_mut().truncate(self.previous_len));
    }
}

/// Publish a product's live capabilities for its synchronous descendants,
/// removed on return and on unwind.
pub(super) fn with_active_owner<T>(
    router: ExecutionChildCapability,
    decoder: ExecutionChildCapability,
    operation: impl FnOnce() -> T,
) -> T {
    let previous_len = ACTIVE.with(|active| {
        let mut active = active.borrow_mut();
        let previous_len = active.len();
        active.push(ActiveOwner { router, decoder });
        previous_len
    });
    let _scope = ActiveScope { previous_len, _thread_bound: PhantomData };
    operation()
}

fn inherited_half(identity: ExecutionIdentity, router: bool) -> Result<Option<ExecutionLease>, WorkError> {
    ACTIVE.with(|active| {
        // Fully independent canonical children must not hide still-live
        // ancestor owners from a later synchronous grandchild. Search each
        // actual supplied half independently, preferring the innermost frame.
        for owner in active.borrow().iter().rev() {
            let capability = if router { &owner.router } else { &owner.decoder };
            match capability.try_lease(identity) {
                Ok(lease) => return Ok(Some(lease)),
                Err(ExecutionLeaseError::WrongOwner) => continue,
                Err(_) => return Err(WorkError::WrongOwner),
            }
        }
        Ok(None)
    })
}

pub(super) fn inherited_owner(
    decoder: &mut EntityDecoder,
    router: &GeometryRouter,
) -> Result<Option<ProductOwner>, WorkError> {
    let router_lease = inherited_half(router.execution_identity(), true)?;
    let decoder_lease = match inherited_half(decoder.execution_identity(), false)? {
        Some(lease) => Some(lease),
        // A scoped thread can borrow the actual mutable decoder while the
        // parent's synchronous callback waits. Its explicit source-work scope
        // authorizes this child; an ordinary reserved owner grants nothing.
        None => decoder.try_source_execution_lease().map_err(|_| WorkError::WrongOwner)?,
    };
    if router_lease.is_none() && decoder_lease.is_none() {
        return Ok(None);
    }
    // Each unmatched half is independently and exclusively reserved. A matched
    // half remains bound to its original live ancestor epoch. Only an explicit
    // source borrow may cross threads; router capabilities remain thread-bound.
    // Dropping a child never releases an ancestor's root reservation.
    let router_lease = match router_lease {
        Some(lease) => lease,
        None => router.try_execution_lease().map_err(|_| WorkError::OwnerBusy)?,
    };
    let decoder_lease = match decoder_lease {
        Some(lease) => lease,
        None => decoder.try_execution_lease().map_err(|_| WorkError::OwnerBusy)?,
    };
    Ok(Some(ProductOwner::from_child_leases(router_lease, decoder_lease)))
}

/// A joined worker recovers resource state from its actual mutable source
/// borrow. Source authority takes precedence over unrelated worker-local
/// accounts. No other thread-local state moves.
pub(super) fn with_source_resources<T>(
    decoder: &mut EntityDecoder,
    operation: impl FnOnce(&mut EntityDecoder) -> T,
) -> T {
    let transport = decoder
        .try_source_execution_lease()
        .ok()
        .flatten()
        .map(|lease| (lease.source_resource_context(), lease.source_stop_handle()));
    match transport {
        Some((Ok(context), Ok(Some(stop)))) => source_scoped(context, stop, decoder, operation),
        _ => operation(decoder),
    }
}

#[cold]
#[inline(never)]
fn source_scoped<T>(
    context: Option<ifc_lite_core::execution_owner::SourceResourceContext>,
    stop: ifc_lite_core::execution_owner::SourceStopHandle,
    decoder: &mut EntityDecoder,
    operation: impl FnOnce(&mut EntityDecoder) -> T,
) -> T {
    use ifc_lite_geometry::resource;
    resource::with_source_stop(stop, || match context {
        Some(context) => match resource::account_from_source_context(&context) {
            Ok(account) => account.source_scope(|| operation(decoder)),
            Err(stop) => {
                resource::stop(stop);
                operation(decoder)
            }
        },
        None => operation(decoder),
    })
}

/// The borrowed canonical producer. This continuation never crosses a
/// scheduling yield, publication boundary or thread; unwinding drops it
/// before the ancestor scope exits.
pub(super) fn produce(
    job: &ElementMeshJob<'_>,
    ctx: &MeshProductionContext<'_>,
    opts: &MeshProductionOptions,
    decoder: &mut EntityDecoder,
    router: &GeometryRouter,
) -> ProducedElementMeshes {
    with_source_resources(decoder, |decoder| {
        if ifc_lite_geometry::resource::check_current().is_err() {
            return stopped_output();
        }
        // Borrowed APIs stay infallible: a product whose owner cannot be
        // admitted or kept (another live product holds it, or a callback
        // replaced it) publishes nothing rather than unowned output.
        drive(job, ctx, opts, decoder, router).unwrap_or_else(|_| stopped_output())
    })
}

/// Plan, advance every ticket and publish, inside one owner epoch.
fn drive(
    job: &ElementMeshJob<'_>,
    ctx: &MeshProductionContext<'_>,
    opts: &MeshProductionOptions,
    decoder: &mut EntityDecoder,
    router: &GeometryRouter,
) -> Result<ProducedElementMeshes, WorkError> {
    let mut output = None;
    session_run::run_epoch(decoder, router, None, |decoder, router, live| {
        let mut state = ProductState::plan_live(job, ctx, opts, decoder, router, live);
        while state.step_live(ctx, decoder, router)? {}
        state.finish_live(router, &mut output)
    })?;
    output.ok_or(WorkError::Aborted)
}

// The actual source-owned terminal survives this empty child return and is
// reported through the caller's resource account. No plan, numerical callback, final
// hook or cache publication is admitted.
pub(super) fn stopped_output() -> ProducedElementMeshes {
    ProducedElementMeshes {
        meshes: Vec::new(),
        instance_occurrences: Vec::new(),
        geometry_hash: None,
        geometry_aabb: None,
        geometry_volume: None,
        geometry_closure: None,
        csg_failures: FxHashMap::default(),
        degenerate_triangles_dropped: 0,
    }
}
