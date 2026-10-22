// SPDX-License-Identifier: MPL-2.0
//! Explicit resource-only context carried by an active source-borrow capability.
//! Core does not install TLS or transfer numerical/diagnostic execution state.
use super::WorkEpoch;
use std::{
    any::Any,
    fmt,
    sync::{Arc, Weak},
};

/// Opaque shared resource account. The resource implementation supplies and
/// recovers its concrete account; source authority is validated independently.
#[derive(Clone)]
pub struct SourceResourceContext {
    payload: Arc<dyn Any + Send + Sync>,
    account: Option<Arc<dyn super::AllocationAccount>>,
}
impl SourceResourceContext {
    pub fn new<T: Any + Send + Sync>(value: Arc<T>) -> Self {
        Self {
            payload: value,
            account: None,
        }
    }
    /// Both views derive from one allocation. Resource capability alone never
    /// authenticates a source or authorizes decoder work.
    pub fn new_accounted<T: Any + Send + Sync + super::AllocationAccount>(value: Arc<T>) -> Self {
        Self {
            payload: value.clone(),
            account: Some(value),
        }
    }
    pub fn downcast<T: Any + Send + Sync>(&self) -> Option<Arc<T>> {
        Arc::clone(&self.payload).downcast().ok()
    }
    /// Reports a resource projection, never source authentication or active work.
    pub fn is_accounted(&self) -> bool {
        self.account.is_some()
    }
}
impl fmt::Debug for SourceResourceContext {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SourceResourceContext")
    }
}

#[derive(Debug, Clone, Default)]
pub(super) struct ActiveSource {
    pub epoch: Weak<WorkEpoch>,
    pub resources: Option<SourceResourceContext>,
}

/// Resource-only stop propagation along the actual active source-owner chain.
/// Reuses existing work-epoch storage; no ambient kernel or diagnostic TLS moves.
#[derive(Debug, Clone)]
pub struct SourceStopHandle(Arc<WorkEpoch>);
impl SourceStopHandle {
    pub(super) fn new(epoch: Arc<WorkEpoch>) -> Self {
        Self(epoch)
    }
    #[inline]
    pub fn check(&self) -> Result<(), crate::resource_stop::ProgramStop> {
        // The common case, checked on every geometry step: a root epoch that
        // nothing has stopped is one atomic load.
        if self.0.parent.is_none() && !self.0.stopped.load(std::sync::atomic::Ordering::Acquire) {
            return Ok(());
        }
        self.check_chain()
    }
    #[cold]
    #[inline(never)]
    fn check_chain(&self) -> Result<(), crate::resource_stop::ProgramStop> {
        // Iterative oldest-ancestor precedence: a fresh descendant epoch must
        // never hide a stop established before its scoped worker entered.
        let mut first = None;
        let mut cursor = Some(self.0.as_ref());
        while let Some(epoch) = cursor {
            if epoch.stopped.load(std::sync::atomic::Ordering::Acquire) {
                if let Some(stop) = *epoch
                    .resource_stop
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                {
                    first = Some(stop);
                }
            }
            cursor = epoch.parent.as_deref();
        }
        first.map_or(Ok(()), Err)
    }
    pub fn stop(
        &self,
        stop: crate::resource_stop::ProgramStop,
    ) -> crate::resource_stop::ProgramStop {
        let stop = self.check().err().unwrap_or(stop);
        let mut cursor = Some(self.0.as_ref());
        while let Some(epoch) = cursor {
            epoch
                .resource_stop
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get_or_insert(stop);
            epoch.stopped.store(true, std::sync::atomic::Ordering::Release);
            cursor = epoch.parent.as_deref();
        }
        self.check().err().unwrap_or(stop)
    }
}
