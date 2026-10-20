// SPDX-License-Identifier: MPL-2.0
//! Claim linearization and destruction of undelivered resource results.
use super::*;
use crate::process_control::ProcessControl;
const PENDING: u8 = 0;
const CLAIMED: u8 = 1;
const CANCELLED: u8 = 2;

pub(super) struct Claim {
    state: AtomicU8,
    deadline: Instant,
}
impl Claim {
    pub(super) fn new(deadline: Instant) -> Self {
        Self {
            state: AtomicU8::new(PENDING),
            deadline,
        }
    }
    pub(super) fn cancel(&self) {
        let _ =
            self.state
                .compare_exchange(PENDING, CANCELLED, Ordering::AcqRel, Ordering::Acquire);
    }
    pub(super) fn is_cancelled(&self) -> bool {
        self.state.load(Ordering::Acquire) == CANCELLED
    }
}

/// Armed until a legitimate consumer claims the exact result. Both SendError
/// and an unread queued response destroy this guard and reap its actual Child.
pub(super) struct Envelope {
    result: Option<Result<WorkerResult, SupervisionError>>,
    undelivered: Option<ProcessControl>,
}
impl Envelope {
    pub(super) fn new(
        result: Result<WorkerResult, SupervisionError>,
        undelivered: Option<ProcessControl>,
    ) -> Self {
        Self {
            result: Some(result),
            undelivered,
        }
    }
    pub(super) fn claim(mut self, claim: &Claim) -> Result<WorkerResult, SupervisionError> {
        // Preserve controller errors, whose cleanup has already completed.
        if self.result.as_ref().is_some_and(Result::is_err) {
            return self.result.take().expect("owned response");
        }
        let expired = Instant::now() >= claim.deadline;
        if expired {
            claim.cancel();
        }
        if claim
            .state
            .compare_exchange(PENDING, CLAIMED, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            // Drop performs synchronous kill/reap before the terminal return.
            drop(self);
            return Err(if expired {
                SupervisionError::Deadline
            } else {
                SupervisionError::Cancelled
            });
        }
        if self
            .undelivered
            .as_ref()
            .is_some_and(|control| !control.is_live())
        {
            return Err(SupervisionError::Worker(WorkerError::Protocol(
                "result owner retired",
            )));
        }
        self.undelivered.take();
        self.result.take().expect("owned response")
    }
}
impl Drop for Envelope {
    fn drop(&mut self) {
        if let Some(control) = self.undelivered.take() {
            if let Err(error) = control.terminate() {
                eprintln!("undelivered geometry result retirement/reap failed: {error}");
            }
        }
    }
}
