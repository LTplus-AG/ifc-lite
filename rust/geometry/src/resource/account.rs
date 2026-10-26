// SPDX-License-Identifier: MPL-2.0
use super::pool::PoolPermit;
use super::*;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Usage {
    pub work: u64,
    pub copy_bytes: u64,
    pub output_bytes: u64,
    pub occurrences: u64,
    pub live_bytes: u64,
    pub peak_live_bytes: u64,
}
#[derive(Debug, Default)]
struct State {
    usage: Usage,
    terminal: Option<ProgramStop>,
}
#[derive(Debug)]
struct Inner {
    limits: ResourceLimits,
    state: Mutex<State>,
    cancelled: AtomicBool,
    _model: Option<PoolPermit>,
}
/// Clone shares one deterministic request allowance, including reentered calls.
/// Holding an account retains all storage transferred with Reservation::retain.
#[derive(Debug, Clone, Default)]
pub struct ExecutionAccount(
    Option<Arc<Inner>>,
    #[cfg(feature = "retained-runtime")] pub(super) Option<Arc<super::budget::Allowance>>,
);
impl ExecutionAccount {
    pub fn new(policy: ExecutionPolicy) -> Self {
        match policy {
            ExecutionPolicy::Compatibility => Self::default(),
            ExecutionPolicy::Bounded(limits) => Self::bounded(limits, None),
            ExecutionPolicy::Strict(limits) => {
                let account = Self::bounded(limits, None);
                account.stop(ProgramStop::ResourceRefused(ResourceFailure {
                    dimension: Dimension::Coverage,
                    requested: 0,
                    remaining: 0,
                    reason: RefusalReason::UnsupportedCoverage,
                }));
                account
            }
        }
    }
    pub(super) fn bounded(limits: ResourceLimits, model: Option<PoolPermit>) -> Self {
        Self(Some(Arc::new(Inner {
            limits,
            state: Mutex::new(State::default()),
            cancelled: AtomicBool::new(false),
            _model: model,
        })), #[cfg(feature = "retained-runtime")] None)
    }
    pub(super) fn source_context(
        &self,
    ) -> Option<ifc_lite_core::execution_owner::SourceResourceContext> {
        #[cfg(feature = "retained-runtime")]
        if self.1.is_some() {
            return Some(ifc_lite_core::execution_owner::SourceResourceContext::new(Arc::new(self.clone())));
        }
        self.0.as_ref().map(|inner| {
            ifc_lite_core::execution_owner::SourceResourceContext::new(Arc::clone(inner))
        })
    }
    pub(super) fn from_source_context(
        context: &ifc_lite_core::execution_owner::SourceResourceContext,
    ) -> Option<Self> {
        #[cfg(feature = "retained-runtime")]
        if let Some(account) = context.downcast::<Self>() { return Some((*account).clone()); }
        context.downcast::<Inner>().map(|inner| Self(Some(inner), #[cfg(feature = "retained-runtime")] None))
    }
    pub fn usage(&self) -> Usage {
        self.0.as_ref().map_or(Usage::default(), |inner| {
            inner.state.lock().unwrap_or_else(|e| e.into_inner()).usage
        })
    }
    pub fn cancel(&self) {
        if let Some(inner) = &self.0 {
            inner.cancelled.store(true, Ordering::Release);
        }
    }
    pub fn check(&self) -> Result<(), ProgramStop> {
        let Some(inner) = &self.0 else { return Ok(()) };
        let mut state = inner.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.terminal.is_none() && inner.cancelled.load(Ordering::Acquire) {
            state.terminal = Some(ProgramStop::Cancelled);
        }
        state.terminal.map_or(Ok(()), Err)
    }
    pub fn stop(&self, error: ProgramStop) -> ProgramStop {
        #[cfg(feature = "retained-runtime")]
        if let Some(local) = self.overlay_stop() { return local; }
        let Some(inner) = &self.0 else { return error };
        let mut state = inner.state.lock().unwrap_or_else(|e| e.into_inner());
        *state.terminal.get_or_insert(error)
    }
    /// A lexical child inherits the active account; it cannot reset allowances.
    /// The guard restores TLS on errors and panic, and never crosses a reply.
    pub fn scope<T>(&self, run: impl FnOnce() -> T) -> T {
        let _terminal = terminal_scope();
        if is_active() || self.0.is_none() {
            return run();
        }
        struct Restore;
        impl Drop for Restore {
            fn drop(&mut self) {
                CURRENT.with(|slot| *slot.borrow_mut() = None);
            }
        }
        CURRENT.with(|slot| *slot.borrow_mut() = Some(self.clone()));
        let _restore = Restore;
        run()
    }
    /// Install the account attached to the actual validated source owner. A
    /// worker-local account cannot replace that owner's deterministic allowance.
    /// The caller first installs the matching source terminal capability.
    pub fn source_scope<T>(&self, run: impl FnOnce() -> T) -> T {
        if self.0.is_none() {
            return self.scope(run);
        }
        let _terminal = terminal_scope();
        struct Restore(Option<ExecutionAccount>);
        impl Drop for Restore {
            fn drop(&mut self) {
                CURRENT.with(|slot| *slot.borrow_mut() = self.0.take());
            }
        }
        let _restore = Restore(CURRENT.with(|slot| slot.borrow_mut().replace(self.clone())));
        // Select actual source authority before reading account/terminal state;
        // a stopped unrelated worker account cannot poison this source domain.
        let _ = super::check_current();
        let result = run();
        let _ = super::check_current();
        result
    }
    pub fn prepare(&self, cost: Cost) -> Result<Reservation, ProgramStop> {
        self.prepare_inner(cost).map_err(super::stop)
    }
    pub(super) fn prepare_inner(&self, cost: Cost) -> Result<Reservation, ProgramStop> {
        self.check()?;
        // The local allowance admits BEFORE either original accounting or growth.
        // This is an overlay on the same original Arc/pool, never a new owner.
        #[cfg(feature = "retained-runtime")]
        let allowance = self.1.as_ref().map(|allowance| allowance.account.prepare_inner(cost))
            .transpose()?.map(Box::new);
        let Some(inner) = &self.0 else {
            return Ok(Reservation::empty());
        };
        let mut state = inner.state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(stop) = state.terminal {
            return Err(stop);
        }
        let old = state.usage;
        let dimensions = [
            (Dimension::Work, old.work, cost.work, inner.limits.work),
            (
                Dimension::CopyBytes,
                old.copy_bytes,
                cost.copy_bytes,
                inner.limits.copy_bytes,
            ),
            (
                Dimension::OutputBytes,
                old.output_bytes,
                cost.output_bytes,
                inner.limits.output_bytes,
            ),
            (
                Dimension::Occurrences,
                old.occurrences,
                cost.occurrences,
                inner.limits.occurrences,
            ),
            (
                Dimension::LiveBytes,
                old.live_bytes,
                cost.live_bytes,
                inner.limits.live_bytes,
            ),
        ];
        for (dimension, used, requested, limit) in dimensions {
            let next = used.checked_add(requested);
            if next.is_none_or(|next| limit.is_some_and(|limit| next > limit)) {
                let failure = ProgramStop::ResourceRefused(ResourceFailure {
                    dimension,
                    requested,
                    remaining: limit.unwrap_or(u64::MAX).saturating_sub(used),
                    reason: if next.is_none() {
                        RefusalReason::Overflow
                    } else {
                        RefusalReason::Limit
                    },
                });
                state.terminal = Some(failure);
                return Err(failure);
            }
        }
        state.usage = Usage {
            work: old.work + cost.work,
            copy_bytes: old.copy_bytes + cost.copy_bytes,
            output_bytes: old.output_bytes + cost.output_bytes,
            occurrences: old.occurrences + cost.occurrences,
            live_bytes: old.live_bytes + cost.live_bytes,
            peak_live_bytes: old.peak_live_bytes.max(old.live_bytes + cost.live_bytes),
        };
        Ok(Reservation {
            account: self.clone(),
            bytes: cost.live_bytes,
            #[cfg(feature = "retained-runtime")]
            allowance,
        })
    }
}
/// Unique live-storage ownership. Dropping refunds live bytes only; cumulative
/// work/copy/output/occurrences are never refunded, including failed work.
#[derive(Debug)]
pub struct Reservation {
    account: ExecutionAccount,
    bytes: u64,
    #[cfg(feature = "retained-runtime")]
    allowance: Option<Box<Reservation>>,
}
impl Reservation {
    pub(super) fn empty() -> Self {
        Self {
            account: ExecutionAccount::default(),
            bytes: 0,
            #[cfg(feature = "retained-runtime")]
            allowance: None,
        }
    }
    /// Transfer storage to the account's output/cache lifetime. The storage owner
    /// MUST keep an account clone until that payload is destroyed.
    pub fn retain(mut self) {
        self.bytes = 0;
        #[cfg(feature = "retained-runtime")]
        if let Some(allowance) = self.allowance.take() { allowance.retain(); }
    }
}
impl Drop for Reservation {
    fn drop(&mut self) {
        if let Some(inner) = &self.account.0 {
            let mut state = inner.state.lock().unwrap_or_else(|e| e.into_inner());
            state.usage.live_bytes = state.usage.live_bytes.saturating_sub(self.bytes);
        }
    }
}
