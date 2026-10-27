// SPDX-License-Identifier: MPL-2.0
//! Shared ownership of the actual Child prevents PID reuse cancellation races.
use std::process::Child;
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub(crate) struct ProcessControl(Arc<Mutex<ProcessState>>, u32);

struct ProcessState {
    child: Child,
    retired: bool,
}

impl ProcessControl {
    #[cfg(feature = "retained-runtime")]
    pub(crate) fn same_domain(&self, other: &Self) -> bool { Arc::ptr_eq(&self.0, &other.0) }
    pub(crate) fn new(child: Child) -> Self {
        let id = child.id();
        Self(
            Arc::new(Mutex::new(ProcessState {
                child,
                retired: false,
            })),
            id,
        )
    }

    pub(crate) fn id(&self) -> u32 {
        self.1
    }

    /// Observing an exit reaps it and permanently invalidates this authority.
    pub(crate) fn is_live(&self) -> bool {
        let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if state.retired {
            return false;
        }
        match state.child.try_wait() {
            Ok(None) => true,
            Ok(Some(_)) => {
                state.retired = true;
                false
            }
            Err(error) => {
                state.retired = true;
                eprintln!("geometry worker health query failed: {error}");
                false
            }
        }
    }

    pub(crate) fn terminate(&self) -> std::io::Result<()> {
        let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        state.retired = true;
        let child = &mut state.child;
        if child.try_wait()?.is_none() {
            if let Err(error) = child.kill() {
                // A spontaneous exit can race the termination request. Reap
                // that child normally; never reinterpret its PID as authority.
                if child.try_wait()?.is_none() {
                    return Err(error);
                }
            }
            child.wait()?;
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "process_control_tests.rs"]
mod tests;
