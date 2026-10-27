// SPDX-License-Identifier: MPL-2.0
//! Opt-in local limits layered onto the original account and pool identity.
#[cfg(target_arch = "wasm32")]
use super::budget_monotonic::Instant;
use super::*;
#[cfg(not(target_arch = "wasm32"))]
use std::time::Instant;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

/// Captured once at the public bounded entry, before option/source work.
#[derive(Clone, Debug)]
pub struct BudgetStart {
    instant: Instant,
    #[cfg(test)]
    clock: Option<(Arc<test_clock::Clock>, u64)>,
}
impl BudgetStart {
    pub fn now() -> Self {
        // A nested budget reuses the original monotonic domain. Its own
        // allowance may tighten duration, but cannot restart the earlier clock.
        if let Some(account) = current_account() {
            if let Some(allowance) = account.1 {
                return allowance.start.clone();
            }
        }
        Self {
            instant: Instant::now(),
            #[cfg(test)]
            clock: test_clock::capture(),
        }
    }
    /// Elapsed time in the same monotonic domain used for retained deadlines.
    pub fn elapsed(&self) -> Duration {
        #[cfg(test)]
        if let Some((clock, start)) = &self.clock {
            return Duration::from_millis(clock.elapsed().saturating_sub(*start));
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            self.instant.elapsed()
        }
        #[cfg(target_arch = "wasm32")]
        {
            self.instant.elapsed().unwrap_or(Duration::MAX)
        }
    }
}

#[derive(Debug)]
pub(super) struct Allowance {
    pub(super) account: ExecutionAccount,
    start: BudgetStart,
    duration: Duration,
    /// Internal cause record: the public error for an expired deadline is the
    /// existing `ProgramStop::Cancelled`, so the true cause lives here.
    fired: AtomicBool,
}
impl Allowance {
    fn fired(&self) -> bool {
        self.fired.load(Ordering::Acquire)
            || self.account.1.as_ref().is_some_and(|parent| parent.fired())
    }
    fn check(&self) -> Result<(), ProgramStop> {
        self.account.check()?;
        self.account.check_allowance()
    }
    fn deadline(&self) -> crate::Result<()> {
        if let Some(parent) = &self.account.1 {
            parent.deadline()?;
        }
        if self.start.elapsed() >= self.duration {
            self.fired.store(true, Ordering::Release);
            return Err(crate::Error::ProgramStopped(ProgramStop::Cancelled));
        }
        Ok(())
    }
}

/// Additional per-budget work/live backing allowance. It shares the actual
/// original account Arc (including pool permit and cumulative usage). Creating
/// it never resets or widens that account. Captures and source contexts carry
/// the overlay; detached work hides it with the rest of the resource domain.
pub struct ProductBudget {
    resources: OwnedResourceContext,
}
impl ProductBudget {
    pub fn new(start: BudgetStart, work: u64, bytes: u64, deadline_ms: u64) -> Self {
        let mut account = current_account().unwrap_or_else(|| {
            ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()))
        });
        let mut local = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits {
            work: Some(work),
            live_bytes: Some(bytes),
            ..Default::default()
        }));
        local.1 = account.1.clone();
        account.1 = Some(Arc::new(Allowance {
            account: local,
            start,
            duration: Duration::from_millis(deadline_ms),
            fired: AtomicBool::new(false),
        }));
        Self {
            resources: OwnedResourceContext::with_account(account),
        }
    }
    /// Inspect this product after its lexical scope has returned.
    pub fn deadline_fired(&self) -> bool {
        self.scope(budget_deadline_fired)
    }
    pub fn scope<T>(&self, run: impl FnOnce() -> T) -> T {
        self.resources.with_allowance_scope(run)
    }
}

impl ExecutionAccount {
    pub(super) fn check_allowance(&self) -> Result<(), ProgramStop> {
        self.1
            .as_ref()
            .map_or(Ok(()), |allowance| allowance.check())
    }
    /// A refusal of the local allowance is already recorded on that allowance
    /// (see `prepare_inner`). While the original account itself is not
    /// terminal, later stops in the overlay domain return that first local
    /// refusal and leave the caller's original account usable. Deadlines are
    /// recorded on the allowance too, never on the shared original account.
    pub(super) fn overlay_stop(&self) -> Option<ProgramStop> {
        self.1.as_ref()?;
        if self.check().is_err() {
            return None;
        }
        self.check_allowance().err().or_else(|| {
            self.1
                .as_ref()
                .filter(|allowance| allowance.fired())
                .map(|_| ProgramStop::Cancelled)
        })
    }
}

/// Cooperative checkpoint. Stop precedence stays source -> original account ->
/// terminal -> local allowance -> deadline. The protocol has no deadline
/// reason and the public error enum must not grow one, so an expired deadline
/// is returned as `ProgramStop::Cancelled` and recorded internally; see
/// [`budget_deadline_fired`].
pub fn budget_checkpoint() -> crate::Result<()> {
    check_current()?;
    if let Some(account) = current_account() {
        if let Some(allowance) = &account.1 {
            allowance.deadline()?;
        }
    }
    Ok(())
}

/// True when the current budget allowance's deadline expired and no
/// independent stop (source, account, terminal) is present. The deadline is
/// reported publicly as `ProgramStop::Cancelled`; callers that just received
/// that stop from an budget checkpoint use this to tell a deadline from a
/// genuine cancel. An independently existing stop always takes priority.
///
/// Internal to the retained budget path; not a supported public API.
#[doc(hidden)]
pub fn budget_deadline_fired() -> bool {
    current_account().is_some_and(|account| account.1.as_ref().is_some_and(|a| a.fired()))
        // Inspect independent channels without `check_current`: that helper
        // records stops and would recurse through `stop`'s deadline check.
        && SOURCE_STOP.with(|slot| slot.borrow().as_ref().is_none_or(|source| source.check().is_ok()))
        && current_account().is_none_or(|account| account.check().is_ok() && account.check_allowance().is_ok())
        && TERMINAL.with(|slot| slot.get().flatten().is_none())
}

/// Source iteration is additional work only for this opt-in budget path.
/// Ordinary/default numeric paths retain their existing accounting semantics.
pub(crate) fn source_step() -> crate::Result<()> {
    #[cfg(test)]
    test_clock::point("source_step");
    budget_checkpoint()?;
    if current_account().is_some_and(|account| account.1.is_some()) {
        charge(Cost {
            work: 1,
            ..Default::default()
        })?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "budget_clock.rs"]
pub mod test_clock;

#[cfg(test)]
#[path = "budget_tests.rs"]
mod tests;
