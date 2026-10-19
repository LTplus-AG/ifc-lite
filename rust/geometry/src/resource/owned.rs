// SPDX-License-Identifier: MPL-2.0
//! Resource-only ownership across dormant work; never an execution/TLS guard.
use super::{ExecutionAccount, ProgramStop, Reservation, CURRENT, SOURCE_STOP, TERMINAL};
use ifc_lite_core::execution_owner::SourceStopHandle;
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
    account: Option<ExecutionAccount>,
    source: Option<SourceStopHandle>,
    terminal: Arc<Mutex<Option<ProgramStop>>>,
}
impl OwnedResourceContext {
    pub fn capture_current() -> Self {
        Self { account: super::current_account(),
            source: SOURCE_STOP.with(|slot| slot.borrow().clone()),
            terminal: Arc::new(Mutex::new(TERMINAL.with(|slot| slot.get().flatten()))) }
    }
    /// Check only the captured authority, never the caller's ambient account.
    pub fn check(&self) -> Result<(), ProgramStop> {
        let source = self.source.as_ref().and_then(|source| source.check().err());
        let account = self.account.as_ref().and_then(|account| account.check().err());
        let terminal = *self.terminal.lock().unwrap_or_else(|e| e.into_inner());
        match source.or(account).or(terminal) {
            Some(stop) => Err(self.remember(stop)), None => Ok(()),
        }
    }
    fn remember(&self, stop: ProgramStop) -> ProgramStop {
        let mut terminal = self.terminal.lock().unwrap_or_else(|e| e.into_inner());
        let prior = self.source.as_ref().and_then(|source| source.check().err())
            .or_else(|| self.account.as_ref().and_then(|account| account.check().err()));
        let first = prior.or(*terminal).unwrap_or(stop);
        // Source ancestry is authoritative even when an older local fault was
        // observed before an ancestor stopped. Keep the account's own first
        // fault, but do not let it or the cached terminal hide that ancestor.
        let source = self.source.as_ref().map(|source| source.stop(first));
        let account = self.account.as_ref().map_or(first, |account| account.stop(source.unwrap_or(first)));
        match source {
            Some(first) => { *terminal = Some(first); first }
            None => *terminal.get_or_insert(account),
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
