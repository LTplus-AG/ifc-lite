// SPDX-License-Identifier: MPL-2.0
//! Opt-in local limits layered onto the original account and pool identity.
use super::*;
use std::{sync::Arc, time::Duration};
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
use std::time::Instant;
#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
#[path = "inspection_monotonic.rs"]
mod monotonic;
#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
use monotonic::Instant;

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
    fn elapsed(&self) -> Option<Duration> {
        #[cfg(any(test, feature = "test-support"))]
        if let Some((clock, start)) = &self.clock {
            return Some(Duration::from_millis(clock.elapsed().saturating_sub(*start)));
        }
        #[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
        { self.instant.elapsed() }
        #[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
        { Some(self.instant.elapsed()) }
    }
}

#[derive(Debug)]
pub(super) struct Allowance {
    pub(super) account: ExecutionAccount,
    start: InspectionStart,
    duration: Duration,
}
impl Allowance {
    fn check(&self) -> Result<(), ProgramStop> {
        self.account.check()?;
        self.account.check_allowance()
    }
    fn deadline(&self) -> crate::Result<()> {
        if let Some(parent) = &self.account.1 { parent.deadline()?; }
        // Missing, throwing, nonfinite, or regressing host clocks fail closed.
        // The captured start is still shared by every nested/resumed allowance.
        if self.start.elapsed().is_none_or(|elapsed| elapsed >= self.duration) {
            return Err(crate::Error::InspectionDeadlineExceeded);
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
        }));
        Self { resources: OwnedResourceContext::with_account(account) }
    }
    pub fn scope<T>(&self, run: impl FnOnce() -> T) -> T { self.resources.with_allowance_scope(run) }
}

impl ExecutionAccount {
    pub(super) fn check_allowance(&self) -> Result<(), ProgramStop> {
        self.1.as_ref().map_or(Ok(()), |allowance| allowance.check())
    }
}

/// Cooperative checkpoint. Stop precedence stays source -> original account ->
/// terminal -> local allowance -> deadline. No deadline is fabricated as a
/// ProgramStop: that protocol currently has no deadline reason.
pub fn inspection_checkpoint() -> crate::Result<()> {
    check_current()?;
    if let Some(account) = current_account() {
        if let Some(allowance) = &account.1 { allowance.deadline()?; }
    }
    Ok(())
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
