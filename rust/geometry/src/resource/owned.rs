// SPDX-License-Identifier: MPL-2.0
//! Resource-only ownership across dormant work; never an execution/TLS guard.
use super::{ExecutionAccount, ProgramStop, Reservation, CURRENT, SOURCE_STOP, TERMINAL};
use ifc_lite_core::execution_owner::SourceStopHandle;
use std::{
    cell::RefCell,
    sync::{Arc, Mutex},
};

thread_local! {
    pub(super) static OWNED: RefCell<Option<OwnedResourceContext>> = const { RefCell::new(None) };
}

/// Captured account, actual source stop ancestry and persistent first fault.
/// Call capture only inside independently authenticated synchronous source work;
/// this type grants no decoder/router lease or model/source authority. None is
/// an explicit unaccounted domain, not permission to inherit a later account.
#[derive(Clone)]
pub(crate) struct OwnedResourceContext {
    account: Option<ExecutionAccount>,
    source: Option<SourceStopHandle>,
    terminal: OwnedTerminal,
}
#[derive(Clone)]
enum OwnedTerminal {
    Raw(Arc<Mutex<Option<ProgramStop>>>),
}
impl OwnedResourceContext {
    #[cfg(feature = "retained-runtime")]
    pub(super) fn with_account(account: ExecutionAccount) -> Self {
        Self {
            account: Some(account),
            ..Self::capture_current()
        }
    }
    pub(crate) fn capture_current() -> Self {
        Self {
            account: super::current_account(),
            source: SOURCE_STOP.with(|slot| slot.borrow().clone()),
            terminal: OwnedTerminal::Raw(Arc::new(Mutex::new(
                TERMINAL.with(|slot| slot.get().flatten()),
            ))),
        }
    }
    pub(crate) fn check(&self) -> Result<(), ProgramStop> {
        match &self.terminal {
            OwnedTerminal::Raw(terminal) => {
                check_channels(self.account.as_ref(), self.source.as_ref(), terminal)
            }
        }
    }
    fn remember(&self, stop: ProgramStop) -> ProgramStop {
        match &self.terminal {
            OwnedTerminal::Raw(terminal) => {
                remember_channels(self.account.as_ref(), self.source.as_ref(), terminal, stop)
            }
        }
    }
    /// Install exact captured channels only for this synchronous call. Ambient
    /// state is restored on errors and unwind; no guard escapes into a packet.
    pub(crate) fn with_scope<T>(&self, work: impl FnOnce() -> T) -> T {
        self.scoped(true, work)
    }
    // An entry allowance can precede source authentication. Do not install it
    // as an observer of a later, more authoritative source epoch. Actual owned
    // work captures that epoch itself; this scope only carries resource limits.
    #[cfg(feature = "retained-runtime")]
    pub(super) fn with_allowance_scope<T>(&self, work: impl FnOnce() -> T) -> T {
        self.scoped(false, work)
    }
    fn scoped<T>(&self, observe: bool, work: impl FnOnce() -> T) -> T {
        let _restore = Restore {
            context: self.clone(),
            account: CURRENT.with(|slot| slot.replace(self.account.clone())),
            source: SOURCE_STOP.with(|slot| slot.replace(self.source.clone())),
            terminal: TERMINAL.with(|slot| slot.replace(Some(self.check().err()))),
            owned: OWNED.with(|slot| slot.replace(observe.then(|| self.clone()))),
        };
        work()
    }
    /// Admit actual retained Vec backing before growth. The returned permit must
    /// follow its storage owner, or be retained while this context owns the Vec.
    /// This covers requested backing, not allocator overhead or opaque SDK work.
    pub(crate) fn reserve_headers<T>(
        &self,
        values: &mut Vec<T>,
        additional: usize,
    ) -> Result<Reservation, ProgramStop> {
        self.with_scope(|| {
            self.check()?;
            if !super::is_active() {
                values
                    .try_reserve_exact(additional)
                    .map_err(|_| super::allocation_failure())?;
                return Ok(Reservation::empty());
            }
            super::reserve_headers(values, additional)
        })
    }
}
fn check_channels(
    account: Option<&ExecutionAccount>,
    source: Option<&SourceStopHandle>,
    terminal: &Mutex<Option<ProgramStop>>,
) -> Result<(), ProgramStop> {
    let prior_source = source.and_then(|source| source.check().err());
    let prior_account = account.and_then(|account| account.check().err());
    let cached = *terminal.lock().unwrap_or_else(|e| e.into_inner());
    match prior_source.or(prior_account).or(cached) {
        Some(stop) => Err(remember_channels(account, source, terminal, stop)),
        None => {
            #[cfg(feature = "retained-runtime")]
            if let Some(account) = account {
                account
                    .check_allowance()
                    .map_err(|stop| remember_channels(Some(account), source, terminal, stop))?;
            }
            Ok(())
        }
    }
}
fn remember_channels(
    account: Option<&ExecutionAccount>,
    source: Option<&SourceStopHandle>,
    terminal: &Mutex<Option<ProgramStop>>,
    stop: ProgramStop,
) -> ProgramStop {
    // Snapshot, release, consult other channels, then commit. Never nest channel
    // locks or destroy a retained resource owner under the terminal lock.
    let snapshot = *terminal.lock().unwrap_or_else(|e| e.into_inner());
    let prior = source
        .and_then(|source| source.check().err())
        .or_else(|| account.and_then(|account| account.check().err()));
    let first = prior.or(snapshot).unwrap_or(stop);
    #[cfg(feature = "retained-runtime")]
    if prior.is_none()
        && snapshot.is_none()
        && first == ProgramStop::Cancelled
        && account.is_some_and(|account| account.overlay_stop() == Some(first))
    {
        // The allowance owns the deadline; retain its cause without writing a
        // cancel into the captured source or original account.
        return first;
    }
    let source = source.map(|source| source.stop(first));
    let account = account.map_or(first, |account| account.stop(source.unwrap_or(first)));
    let mut terminal = terminal.lock().unwrap_or_else(|e| e.into_inner());
    match source {
        Some(first) => {
            *terminal = Some(first);
            first
        }
        None => *terminal.get_or_insert(account),
    }
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
        if let Err(stop) = super::check_current() {
            self.context.remember(stop);
        }
        CURRENT.with(|slot| {
            slot.replace(self.account.take());
        });
        SOURCE_STOP.with(|slot| {
            slot.replace(self.source.take());
        });
        TERMINAL.with(|slot| slot.set(self.terminal));
        OWNED.with(|slot| {
            slot.replace(self.owned.take());
        });
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
