// SPDX-License-Identifier: MPL-2.0
//! Explicit resource-only context carried by an active source-borrow capability.
//! Core does not install TLS or transfer numerical/diagnostic execution state.
use std::{any::Any, fmt, sync::{Arc, Weak}};
use super::WorkEpoch;

/// Opaque shared resource account. The resource implementation supplies and
/// recovers its concrete account; source authority is validated independently.
#[derive(Clone)]
pub struct SourceResourceContext(Arc<dyn Any + Send + Sync>);
impl SourceResourceContext {
    pub fn new<T: Any + Send + Sync>(value: Arc<T>) -> Self { Self(value) }
    pub fn downcast<T: Any + Send + Sync>(&self) -> Option<Arc<T>> {
        Arc::clone(&self.0).downcast().ok()
    }
}
impl fmt::Debug for SourceResourceContext {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str("SourceResourceContext") }
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
    pub(super) fn new(epoch: Arc<WorkEpoch>) -> Self { Self(epoch) }
    pub fn check(&self) -> Result<(), crate::resource_stop::ProgramStop> {
        // Iterative oldest-ancestor precedence: a fresh descendant epoch must
        // never hide a stop established before its scoped worker entered.
        let mut first = None;
        let mut cursor = Some(self.0.as_ref());
        while let Some(epoch) = cursor {
            if let Some(stop) = *epoch.resource_stop.lock().unwrap_or_else(|e| e.into_inner()) {
                first = Some(stop);
            }
            cursor = epoch.parent.as_deref();
        }
        first.map_or(Ok(()), Err)
    }
    pub fn stop(&self, stop: crate::resource_stop::ProgramStop) -> crate::resource_stop::ProgramStop {
        let stop = self.check().err().unwrap_or(stop);
        let mut cursor = Some(self.0.as_ref());
        while let Some(epoch) = cursor {
            epoch.resource_stop.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert(stop);
            cursor = epoch.parent.as_deref();
        }
        self.check().err().unwrap_or(stop)
    }
}
