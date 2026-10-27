// SPDX-License-Identifier: MPL-2.0
//! Explicit admission for audited allocations. This is not an allocator or RSS bound.
mod account;
#[cfg(feature = "retained-runtime")]
mod budget;
#[cfg(all(feature = "retained-runtime", test))]
pub use budget::test_clock as budget_test_clock;
#[cfg(feature = "retained-runtime")]
pub use budget::{budget_checkpoint, budget_deadline_fired, BudgetStart, ProductBudget};
// Refs #7955: private dormant resource owner.
#[cfg(any(
    all(
        test,
        any(not(target_arch = "wasm32"), feature = "wasm_source_capture")
    ),
    feature = "retained-runtime"
))]
#[cfg_attr(not(test), allow(dead_code))]
mod owned;
#[cfg(feature = "retained-runtime")]
pub(crate) use owned::OwnedResourceContext;
mod pool;
mod storage;
pub(crate) use storage::reserve_headers;
pub mod mesh;
pub use account::{ExecutionAccount, Reservation, Usage};
pub use pool::{ModelResourcePool, RequestAdmission};
use std::cell::{Cell, RefCell};

/// No new resource limits are imposed unless the caller explicitly opts in.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum ExecutionPolicy {
    #[default]
    Compatibility,
    Bounded(ResourceLimits),
    /// Refuses before invocation until all opaque allocation families are covered.
    Strict(ResourceLimits),
}
/// None means explicitly unlimited; Some(0) admits zero, in every dimension.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ResourceLimits {
    pub work: Option<u64>,
    pub copy_bytes: Option<u64>,
    pub output_bytes: Option<u64>,
    pub occurrences: Option<u64>,
    pub live_bytes: Option<u64>,
}
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Cost {
    pub work: u64,
    pub copy_bytes: u64,
    pub output_bytes: u64,
    pub occurrences: u64,
    pub live_bytes: u64,
}
pub use ifc_lite_core::resource_stop::{Dimension, ProgramStop, RefusalReason, ResourceFailure};
thread_local! {
    static CURRENT: RefCell<Option<ExecutionAccount>> = const { RefCell::new(None) };
    static SOURCE_STOP: RefCell<Option<ifc_lite_core::execution_owner::SourceStopHandle>> = const { RefCell::new(None) };
    static TERMINAL: Cell<Option<Option<ProgramStop>>> = const { Cell::new(None) };
}
struct TerminalScope;
impl Drop for TerminalScope {
    fn drop(&mut self) {
        TERMINAL.with(|slot| slot.set(None));
    }
}
fn terminal_scope() -> Option<TerminalScope> {
    TERMINAL.with(|slot| {
        if slot.get().is_some() {
            None
        } else {
            slot.set(Some(None));
            Some(TerminalScope)
        }
    })
}

/// Keep terminal stops visible for a complete consumer operation, including
/// compatibility callers without an execution account. Nested calls share the
/// existing terminal domain; a fresh domain is restored on return or unwind.
pub fn with_terminal_scope<T>(
    operation: impl FnOnce() -> Result<T, ProgramStop>,
) -> Result<T, ProgramStop> {
    let _terminal = terminal_scope();
    check_current()?;
    let result = operation();
    check_current()?;
    result
}

pub fn current_account() -> Option<ExecutionAccount> {
    CURRENT.with(|slot| slot.borrow().clone())
}
pub fn is_active() -> bool {
    CURRENT.with(|slot| slot.borrow().is_some())
}
pub fn check_current() -> Result<(), ProgramStop> {
    let source = SOURCE_STOP.with(|slot| {
        slot.borrow()
            .as_ref()
            .map_or(Ok(()), |source| source.check())
    });
    if let Err(error) = source {
        return Err(stop(error));
    }
    let account = CURRENT.with(|slot| match slot.borrow().as_ref() {
        Some(a) => a.check(),
        None => Ok(()),
    });
    if let Err(error) = account {
        return Err(stop(error));
    }
    if let Some(error) = current_terminal() {
        return Err(error);
    }
    #[cfg(feature = "retained-runtime")]
    if let Some(account) = current_account() {
        account.check_allowance().map_err(stop)?;
    }
    Ok(())
}
fn current_terminal() -> Option<ProgramStop> {
    TERMINAL.with(|slot| slot.get().flatten())
}

/// Poll live stop state without constructing an aggregate result when no
/// authorities are installed. Presence is observed afresh on every call.
pub fn is_stopped() -> bool {
    if SOURCE_STOP.with(|slot| slot.borrow().is_none())
        && CURRENT.with(|slot| slot.borrow().is_none())
    {
        current_terminal().is_some()
    } else {
        check_active_stop()
    }
}

#[cold]
#[inline(never)]
fn check_active_stop() -> bool {
    check_current().is_err()
}

/// Check controlled source iterations under the opt-in retained budget.
/// Default builds keep their existing loops unchanged: this is a no-op there,
/// with no stop, thread-local or account check added.
#[cfg(feature = "retained-runtime")]
pub(crate) fn source_step() -> crate::Result<()> {
    budget::source_step()
}

pub fn charge(cost: Cost) -> Result<Reservation, ProgramStop> {
    check_current()?;
    match current_account() {
        Some(account) => account.prepare(cost).map_err(stop),
        None => Ok(Reservation::empty()),
    }
}
pub fn stop(error: ProgramStop) -> ProgramStop {
    // A deadline is local to the product. Do not poison source, account, owned
    // or lexical terminal channels when a callback echoes its Cancelled value.
    #[cfg(feature = "retained-runtime")]
    if error == ProgramStop::Cancelled && budget_deadline_fired() {
        return error;
    }
    let prior_source = SOURCE_STOP.with(|slot| {
        slot.borrow()
            .as_ref()
            .and_then(|source| source.check().err())
    });
    let error = prior_source.unwrap_or(error);
    let error = current_account().map_or(error, |account| account.stop(error));
    let source = SOURCE_STOP.with(|slot| slot.borrow().as_ref().map(|source| source.stop(error)));
    let error = source.unwrap_or(error);
    #[cfg(any(
        all(
            test,
            any(not(target_arch = "wasm32"), feature = "wasm_source_capture")
        ),
        feature = "retained-runtime"
    ))]
    let error = owned::record_stop(error);
    TERMINAL.with(|slot| match (source, slot.get()) {
        // A validated source chain is authoritative for this lexical domain;
        // unrelated ambient terminal state is restored by with_source_stop.
        (Some(_), Some(_)) => {
            slot.set(Some(Some(error)));
            error
        }
        (_, Some(Some(first))) => first,
        (_, Some(None)) => {
            slot.set(Some(Some(error)));
            error
        }
        (_, None) => error,
    })
}
pub fn refused(
    dimension: Dimension,
    requested: u64,
    remaining: u64,
    reason: RefusalReason,
) -> ProgramStop {
    stop(ProgramStop::ResourceRefused(ResourceFailure {
        dimension,
        requested,
        remaining,
        reason,
    }))
}
pub fn overflow() -> ProgramStop {
    refused(
        Dimension::Representation,
        u64::MAX,
        0,
        RefusalReason::Overflow,
    )
}
pub fn allocation_failure() -> ProgramStop {
    refused(Dimension::LiveBytes, 0, 0, RefusalReason::Allocation)
}

#[cfg(test)]
mod boolean_tests;
#[cfg(test)]
mod tests;

/// Translate the typed legacy callback error at the first audited boundary.
/// Source faults (including identical diagnostic text) retain ordinary recovery.
pub(crate) fn observe<T>(result: crate::Result<T>) -> crate::Result<T> {
    if let Err(crate::Error::ProgramStopped(error)) = &result {
        stop(*error);
    }
    check_current()?;
    result
}

/// Resource-only capability transport for joined source-borrow workers. Cloning
/// the existing account Arc allocates nothing and transfers no unrelated TLS.
pub fn current_source_context() -> Option<ifc_lite_core::execution_owner::SourceResourceContext> {
    current_account().and_then(|account| account.source_context())
}
pub fn account_from_source_context(
    context: &ifc_lite_core::execution_owner::SourceResourceContext,
) -> Result<ExecutionAccount, ProgramStop> {
    ExecutionAccount::from_source_context(context).ok_or_else(|| {
        refused(
            Dimension::Coverage,
            0,
            0,
            RefusalReason::UnsupportedCoverage,
        )
    })
}

/// Run `operation` with none of this thread's lexical resource state: no
/// account, source stop, terminal or owned stop observer.
///
/// A rayon wait (`join`, `par_iter`) may run an unrelated queued job on the
/// waiting thread before it returns, such as another element's whole product.
/// That job is not part of the caller's work: it must not bill the caller's
/// account, observe the caller's source stop or terminal, or record its own
/// stop into them. Wrap every rayon wait inside product work in this; the
/// caller's state is restored on return and on unwind. `operation` itself
/// must not need the caller's resource state.
///
/// This hides RESOURCE state only (including the owned stop observer). Other
/// per-thread diagnostic capture, such as geometry telemetry transactions and
/// the CSG census sink, is not scoped by it.
pub fn detached<T>(operation: impl FnOnce() -> T) -> T {
    struct Restore {
        account: Option<ExecutionAccount>,
        source: Option<ifc_lite_core::execution_owner::SourceStopHandle>,
        terminal: Option<Option<ProgramStop>>,
        #[cfg(any(
            all(
                test,
                any(not(target_arch = "wasm32"), feature = "wasm_source_capture")
            ),
            feature = "retained-runtime"
        ))]
        owned: Option<owned::OwnedResourceContext>,
    }
    impl Drop for Restore {
        fn drop(&mut self) {
            CURRENT.with(|slot| *slot.borrow_mut() = self.account.take());
            SOURCE_STOP.with(|slot| *slot.borrow_mut() = self.source.take());
            TERMINAL.with(|slot| slot.set(self.terminal));
            #[cfg(any(
                all(
                    test,
                    any(not(target_arch = "wasm32"), feature = "wasm_source_capture")
                ),
                feature = "retained-runtime"
            ))]
            owned::OWNED.with(|slot| *slot.borrow_mut() = self.owned.take());
        }
    }
    let _restore = Restore {
        account: CURRENT.with(|slot| slot.borrow_mut().take()),
        source: SOURCE_STOP.with(|slot| slot.borrow_mut().take()),
        terminal: TERMINAL.with(Cell::take),
        #[cfg(any(
            all(
                test,
                any(not(target_arch = "wasm32"), feature = "wasm_source_capture")
            ),
            feature = "retained-runtime"
        ))]
        owned: owned::OWNED.with(|slot| slot.borrow_mut().take()),
    };
    operation()
}

/// Install only a validated source capability's shared terminal handle. The
/// lexical guard restores the previous handle on return and unwind.
pub fn with_source_stop<T>(
    source: ifc_lite_core::execution_owner::SourceStopHandle,
    operation: impl FnOnce() -> T,
) -> T {
    struct Restore {
        source: Option<ifc_lite_core::execution_owner::SourceStopHandle>,
        terminal: Option<Option<ProgramStop>>,
    }
    impl Drop for Restore {
        fn drop(&mut self) {
            SOURCE_STOP.with(|slot| *slot.borrow_mut() = self.source.take());
            TERMINAL.with(|slot| slot.set(self.terminal));
        }
    }
    let _restore = Restore {
        source: SOURCE_STOP.with(|slot| slot.borrow_mut().replace(source)),
        terminal: TERMINAL.with(|slot| slot.replace(Some(None))),
    };
    // Do not inspect CURRENT after operation: a source-account scope may already
    // have restored an unrelated worker's account. The actual source chain owns
    // its stops; consumers capture them before leaving their work epoch.
    operation()
}

#[cfg(all(feature = "retained-runtime", any(target_arch = "wasm32", test)))]
mod budget_monotonic;
