// SPDX-License-Identifier: MPL-2.0
//! Small live process capability; contains no source/model or numerical data.
use crate::process_control::ProcessControl;

#[derive(Clone)]
pub struct RuntimeOwner {
    control: ProcessControl,
    incarnation: u64,
}
impl RuntimeOwner {
    pub(crate) fn new(control: ProcessControl, incarnation: u64) -> Self {
        Self {
            control,
            incarnation,
        }
    }
    /// Retire and reap this captured process, invalidating every shared handle.
    /// Safe after a replacement starts: authority never resolves a numeric PID.
    pub fn retire(&self) {
        if let Err(error) = self.control.terminate() {
            eprintln!("geometry runtime owner retirement/reap failed: {error}");
        }
    }
    /// Observes actual Child exit and shared retirement; never trusts a PID.
    pub fn incarnation(&self) -> Option<u64> {
        self.control.is_live().then_some(self.incarnation)
    }
}
impl std::fmt::Debug for RuntimeOwner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RuntimeOwner")
            .field("incarnation", &self.incarnation())
            .finish()
    }
}
