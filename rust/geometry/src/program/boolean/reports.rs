// SPDX-License-Identifier: MPL-2.0
//! One owning handoff for already accepted source reports while numerical work
//! is detached. Cancellation and unwind race only to consume this diagnostic log.
use crate::construction::ConstructionReports;
use std::sync::{Arc,Mutex};
#[derive(Clone)]
pub(super) struct PendingReports(Arc<Mutex<Option<ConstructionReports>>>);
impl PendingReports{
    pub(super) fn new(reports:ConstructionReports)->Self{Self(Arc::new(Mutex::new(Some(reports))))}
    pub(super) fn take(&self)->ConstructionReports{
        self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take().unwrap_or_default()
    }
}
pub(super) struct UnwindReports(pub PendingReports);
impl Drop for UnwindReports{
    fn drop(&mut self){if std::thread::panicking(){crate::processors::diagnostic_capture::restore_before_current(&self.0.take());}}
}

#[cfg(test)]
#[path = "reports_tests.rs"]
mod tests;
