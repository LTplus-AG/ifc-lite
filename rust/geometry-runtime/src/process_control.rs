// SPDX-License-Identifier: MPL-2.0
//! Shared ownership of the actual Child prevents PID reuse cancellation races.
use std::process::Child;
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub(crate) struct ProcessControl(Arc<Mutex<Child>>, u32);

impl ProcessControl {
    pub(crate) fn new(child: Child) -> Self {
        let id = child.id();
        Self(Arc::new(Mutex::new(child)), id)
    }

    pub(crate) fn id(&self) -> u32 {
        self.1
    }

    pub(crate) fn terminate(&self) -> std::io::Result<()> {
        let mut child = self.0.lock().unwrap_or_else(|error| error.into_inner());
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
