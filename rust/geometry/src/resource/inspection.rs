// SPDX-License-Identifier: MPL-2.0
//! Opt-in local limits layered onto the original account and pool identity.
use super::*;
use std::{sync::{atomic::{AtomicBool, Ordering}, Arc}, time::{Duration, Instant}};

/// Captured once at the public bounded entry, before option/source work.
#[derive(Clone, Debug)]
pub struct InspectionStart {
    instant: Instant,
    #[cfg(any(test, feature = "test-support"))]
    clock: Option<(Arc<test_clock::Clock>, u64)>,
}
impl InspectionStart {
    pub fn now() -> Self {
        // A nested inspection reuses the original monotonic domain. Its own
        // allowance may tighten duration, but cannot restart the earlier clock.
        if let Some(account) = current_account() {
            if let Some(allowance) = account.1 { return allowance.start.clone(); }
        }
        Self {
            instant: Instant::now(),
            #[cfg(any(test, feature = "test-support"))]
            clock: test_clock::capture(),
        }
    }
    fn elapsed(&self) -> Duration {
        #[cfg(any(test, feature = "test-support"))]
        if let Some((clock, start)) = &self.clock {
            return Duration::from_millis(clock.elapsed().saturating_sub(*start));
        }
        self.instant.elapsed()
    }
}

#[derive(Debug)]
pub(super) struct Allowance {
    pub(super) account: ExecutionAccount,
    start: InspectionStart,
    duration: Duration,
    /// Internal cause record: the public error for an expired deadline is the
    /// existing `ProgramStop::Cancelled`, so the true cause lives here.
    fired: AtomicBool,
}
impl Allowance {
    fn fired(&self) -> bool {
        self.fired.load(Ordering::Acquire) || self.account.1.as_ref().is_some_and(|parent| parent.fired())
    }
    fn check(&self) -> Result<(), ProgramStop> {
        self.account.check()?;
        self.account.check_allowance()
    }
    fn deadline(&self) -> crate::Result<()> {
        if let Some(parent) = &self.account.1 { parent.deadline()?; }
        if self.start.elapsed() >= self.duration {
            self.fired.store(true, Ordering::Release);
            return Err(crate::Error::ProgramStopped(ProgramStop::Cancelled));
        }
        Ok(())
    }
}

/// Additional per-inspection work/live backing allowance. It shares the actual
/// original account Arc (including pool permit and cumulative usage). Creating
/// it never resets or widens that account. Captures and source contexts carry
/// the overlay; detached work hides it with the rest of the resource domain.
pub struct InspectionBudget { resources: OwnedResourceContext }
impl InspectionBudget {
    pub fn new(start: InspectionStart, work: u64, bytes: u64, deadline_ms: u64) -> Self {
        let mut account = current_account().unwrap_or_else(||
            ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default())));
        let mut local = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits {
            work: Some(work), live_bytes: Some(bytes), ..Default::default()
        }));
        local.1 = account.1.clone();
        account.1 = Some(Arc::new(Allowance {
            account: local, start, duration: Duration::from_millis(deadline_ms),
            fired: AtomicBool::new(false),
        }));
        Self { resources: OwnedResourceContext::with_account(account) }
    }
    pub fn scope<T>(&self, run: impl FnOnce() -> T) -> T { self.resources.with_allowance_scope(run) }
}

impl ExecutionAccount {
    pub(super) fn check_allowance(&self) -> Result<(), ProgramStop> {
        self.1.as_ref().map_or(Ok(()), |allowance| allowance.check())
    }
    /// A refusal of the local allowance is already recorded on that allowance
    /// (see `prepare_inner`). While the original account itself is not
    /// terminal, later stops in the overlay domain return that first local
    /// refusal and leave the caller's original account usable.
    pub(super) fn overlay_stop(&self) -> Option<ProgramStop> {
        self.1.as_ref()?;
        if self.check().is_err() { return None; }
        self.check_allowance().err()
    }
}

/// Cooperative checkpoint. Stop precedence stays source -> original account ->
/// terminal -> local allowance -> deadline. The protocol has no deadline
/// reason and the public error enum must not grow one, so an expired deadline
/// is returned as `ProgramStop::Cancelled` and recorded internally; see
/// [`inspection_deadline_fired`].
pub fn inspection_checkpoint() -> crate::Result<()> {
    check_current()?;
    if let Some(account) = current_account() {
        if let Some(allowance) = &account.1 { allowance.deadline()?; }
    }
    Ok(())
}

/// True when the current inspection allowance's deadline expired and no
/// independent stop (source, account, terminal) is present. The deadline is
/// reported publicly as `ProgramStop::Cancelled`; callers that just received
/// that stop from an inspection checkpoint use this to tell a deadline from a
/// genuine cancel. An independently existing stop always takes priority.
///
/// Internal to the retained inspection path; not a supported public API.
#[doc(hidden)]
pub fn inspection_deadline_fired() -> bool {
    current_account().is_some_and(|account| account.1.as_ref().is_some_and(|a| a.fired()))
        && check_current().is_ok()
}

/// Source iteration is additional work only for this opt-in inspection path.
/// Ordinary/default numeric paths retain their existing accounting semantics.
pub(crate) fn source_step() -> crate::Result<()> {
    #[cfg(any(test, feature = "test-support"))]
    test_clock::point("source_step");
    inspection_checkpoint()?;
    if current_account().is_some_and(|account| account.1.is_some()) {
        charge(Cost { work: 1, ..Default::default() })?;
    }
    Ok(())
}

#[cfg(any(test, feature = "test-support"))]
#[path = "inspection_clock.rs"]
pub mod test_clock;

#[cfg(test)]
#[path = "inspection_tests.rs"]
mod tests;
