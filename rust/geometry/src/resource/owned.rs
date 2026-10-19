// SPDX-License-Identifier: MPL-2.0
//! Resource-only ownership across dormant work; never an execution/TLS guard.
use super::{ExecutionAccount, ProgramStop, Reservation, CURRENT, SOURCE_STOP, TERMINAL};
use ifc_lite_core::execution_owner::SourceStopHandle;
#[cfg(feature = "source-resource-tracking")]
use ifc_lite_core::execution_owner::{AccountedArc, AllocationObserverHandle, SourceResourceContext, AllocationObserver};
use std::{cell::RefCell, sync::{Arc, Mutex}};

thread_local! {
    static OWNED: RefCell<Option<OwnedResourceContext>> = const { RefCell::new(None) };
}

/// Captured account, actual source stop ancestry and persistent first fault.
/// Call capture only inside independently authenticated synchronous source work;
/// this type grants no decoder/router lease or model/source authority. None is
/// an explicit unaccounted domain, not permission to inherit a later account.
#[derive(Clone)]
pub struct OwnedResourceContext {
    account: Option<ExecutionAccount>, source: Option<SourceStopHandle>, terminal: OwnedTerminal,
}
#[derive(Clone)]
enum OwnedTerminal {
    Raw(Arc<Mutex<Option<ProgramStop>>>),
    #[cfg(feature = "source-resource-tracking")]
    Accounted(AccountedArc<OwnedState>),
}
#[cfg(feature = "source-resource-tracking")]
struct OwnedState {
    account: Option<ExecutionAccount>, source: Option<SourceStopHandle>,
    terminal: Mutex<Option<ProgramStop>>,
}
impl OwnedResourceContext {
    pub fn capture_current() -> Self {
        Self { account: super::current_account(),
            source: SOURCE_STOP.with(|slot| slot.borrow().clone()),
            terminal: OwnedTerminal::Raw(Arc::new(Mutex::new(TERMINAL.with(|slot| slot.get().flatten())))) }
    }
    /// Explicit resource-only capture. The caller separately authenticates actual
    /// source work. No ambient account is consulted and no decoder right is granted.
    /// The existing context payload must be this geometry account's private Inner.
    #[cfg(feature = "source-resource-tracking")]
    pub fn try_capture_accounted(context: &SourceResourceContext, source: SourceStopHandle)
        -> Result<Self, ProgramStop> {
        let account = ExecutionAccount::from_source_context(context).ok_or_else(|| {
            source.stop(ProgramStop::ResourceRefused(super::ResourceFailure {
                dimension: super::Dimension::Coverage, requested: 0, remaining: 0,
                reason: super::RefusalReason::UnsupportedCoverage }))
        })?;
        let state = OwnedState { account: Some(account.clone()), source: Some(source.clone()), terminal: Mutex::new(None) };
        state.check()?;
        let state = AccountedArc::try_new(state, context, Some(source.clone()))?;
        Ok(Self { account: Some(account), source: Some(source), terminal: OwnedTerminal::Accounted(state) })
    }
    /// Allocation-free sharing of the already funded captured terminal backing.
    #[cfg(feature = "source-resource-tracking")]
    pub fn allocation_observer(&self) -> Option<AllocationObserverHandle> {
        match &self.terminal {
            OwnedTerminal::Raw(_) => None,
            OwnedTerminal::Accounted(state) => Some(state.observer()),
        }
    }
    pub fn check(&self) -> Result<(), ProgramStop> {
        match &self.terminal {
            OwnedTerminal::Raw(terminal) => check_channels(self.account.as_ref(), self.source.as_ref(), terminal),
            #[cfg(feature = "source-resource-tracking")]
            OwnedTerminal::Accounted(state) => state.check(),
        }
    }
    fn remember(&self, stop: ProgramStop) -> ProgramStop {
        match &self.terminal {
            OwnedTerminal::Raw(terminal) => remember_channels(self.account.as_ref(), self.source.as_ref(), terminal, stop),
            #[cfg(feature = "source-resource-tracking")]
            OwnedTerminal::Accounted(state) => state.remember(stop),
        }
    }
    /// Install exact captured channels only for this synchronous call. Ambient
    /// state is restored on errors and unwind; no guard escapes into a packet.
    pub fn with_scope<T>(&self, work: impl FnOnce() -> T) -> T {
        let _restore = Restore {
            context: self.clone(),
            account: CURRENT.with(|slot| slot.replace(self.account.clone())),
            source: SOURCE_STOP.with(|slot| slot.replace(self.source.clone())),
            terminal: TERMINAL.with(|slot| slot.replace(Some(self.check().err()))),
            owned: OWNED.with(|slot| slot.replace(Some(self.clone()))),
        };
        work()
    }
    /// Admit actual retained Vec backing before growth. The returned permit must
    /// follow its storage owner, or be retained while this context owns the Vec.
    /// This covers requested backing, not allocator overhead or opaque SDK work.
    pub fn reserve_headers<T>(&self, values: &mut Vec<T>, additional: usize)
        -> Result<Reservation, ProgramStop> {
        self.with_scope(|| {
            self.check()?;
            if !super::is_active() {
                values.try_reserve_exact(additional).map_err(|_| super::allocation_failure())?;
                return Ok(Reservation::empty());
            }
            super::reserve_headers(values, additional)
        })
    }
}
fn check_channels(account: Option<&ExecutionAccount>, source: Option<&SourceStopHandle>,
    terminal: &Mutex<Option<ProgramStop>>) -> Result<(), ProgramStop> {
    let prior_source = source.and_then(|source| source.check().err());
    let prior_account = account.and_then(|account| account.check().err());
    let cached = *terminal.lock().unwrap_or_else(|e| e.into_inner());
    match prior_source.or(prior_account).or(cached) {
        Some(stop) => Err(remember_channels(account, source, terminal, stop)), None => Ok(()),
    }
}
fn remember_channels(account: Option<&ExecutionAccount>, source: Option<&SourceStopHandle>,
    terminal: &Mutex<Option<ProgramStop>>, stop: ProgramStop) -> ProgramStop {
    // Snapshot, release, consult other channels, then commit. Never nest channel
    // locks or destroy a retained resource owner under the terminal lock.
    let snapshot = *terminal.lock().unwrap_or_else(|e| e.into_inner());
    let prior = source.and_then(|source| source.check().err())
        .or_else(|| account.and_then(|account| account.check().err()));
    let first = prior.or(snapshot).unwrap_or(stop);
    let source = source.map(|source| source.stop(first));
    let account = account.map_or(first, |account| account.stop(source.unwrap_or(first)));
    let mut terminal = terminal.lock().unwrap_or_else(|e| e.into_inner());
    match source {
        Some(first) => { *terminal = Some(first); first }
        None => *terminal.get_or_insert(account),
    }
}
#[cfg(feature = "source-resource-tracking")]
impl OwnedState {
    fn check(&self) -> Result<(), ProgramStop> {
        check_channels(self.account.as_ref(), self.source.as_ref(), &self.terminal)
    }
    fn remember(&self, stop: ProgramStop) -> ProgramStop {
        remember_channels(self.account.as_ref(), self.source.as_ref(), &self.terminal, stop)
    }
}
#[cfg(feature = "source-resource-tracking")]
impl AllocationObserver for OwnedState {
    fn account_context(&self) -> Option<SourceResourceContext> {
        self.account.as_ref().and_then(ExecutionAccount::source_context)
    }
    fn check(&self) -> Result<(), ProgramStop> { OwnedState::check(self) }
    fn record(&self, stop: ProgramStop) -> ProgramStop { self.remember(stop) }
}

struct Restore {
    context: OwnedResourceContext,
    account: Option<ExecutionAccount>,
    source: Option<SourceStopHandle>,
    terminal: Option<Option<ProgramStop>>,
    owned: Option<OwnedResourceContext>,
}
impl Drop for Restore {
    fn drop(&mut self) {
        if let Err(stop) = super::check_current() { self.context.remember(stop); }
        CURRENT.with(|slot| { slot.replace(self.account.take()); });
        SOURCE_STOP.with(|slot| { slot.replace(self.source.take()); });
        TERMINAL.with(|slot| slot.set(self.terminal));
        OWNED.with(|slot| { slot.replace(self.owned.take()); });
    }
}
// A ProductOwner work slice installs a fresh actual source epoch. Observe its
// stops before that short scope restores TLS, keeping the dormant first fault.
// Ordinary borrowed work has no observer and retains its existing semantics.
pub(super) fn record_stop(stop: ProgramStop) -> ProgramStop {
    let context = OWNED.with(|slot| slot.borrow().clone());
    context.map_or(stop, |context| context.remember(stop))
}

#[cfg(test)]
#[path = "owned_tests.rs"]
mod tests;
