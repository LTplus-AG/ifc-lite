// SPDX-License-Identifier: MPL-2.0
use super::*;
use std::collections::VecDeque;
const POLL: Duration = Duration::from_millis(5);

struct Controller {
    executable: OsString,
    receiver: mpsc::Receiver<Request>,
    stopping: Arc<AtomicBool>,
    pid: Arc<Mutex<Option<crate::process_control::ProcessControl>>>,
    queued: VecDeque<Request>,
    available: Option<SmlibWorker>,
}

pub(super) fn run(
    executable: OsString,
    receiver: mpsc::Receiver<Request>,
    stopping: Arc<AtomicBool>,
    pid: Arc<Mutex<Option<crate::process_control::ProcessControl>>>,
) {
    let mut controller = Controller {
        executable,
        receiver,
        stopping,
        pid,
        queued: VecDeque::new(),
        available: None,
    };
    controller.run();
}

impl Controller {
    fn run(&mut self) {
        while !self.stopping.load(Ordering::Acquire) {
            self.maintain_queue();
            let request = match self.queued.pop_front() {
                Some(request) => request,
                None => match self.receiver.recv_timeout(POLL) {
                    Ok(request) => request,
                    Err(mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                },
            };
            let result = match interrupted(&request, &self.stopping) {
                Some(error) => Envelope::new(Err(error), None),
                None => self.perform(&request),
            };
            respond(request, result);
        }
        drop(self.available.take());
        *self.pid.lock().unwrap_or_else(|e| e.into_inner()) = None;
        self.maintain_queue();
    }

    fn maintain_queue(&mut self) {
        self.queued.extend(self.receiver.try_iter());
        for _ in 0..self.queued.len() {
            let request = self.queued.pop_front().expect("fixed queue length");
            if let Some(error) = interrupted(&request, &self.stopping) {
                respond(request, Envelope::new(Err(error), None));
            } else {
                self.queued.push_back(request);
            }
        }
    }

    fn perform(&mut self, request: &Request) -> Envelope {
        // Drop retired/observably exited cached sessions before lazy spawn.
        if self
            .available
            .as_ref()
            .is_some_and(|worker| !worker.is_live())
        {
            drop(self.available.take());
        }
        match self.perform_inner(request) {
            Ok(envelope) => envelope,
            Err(error) => Envelope::new(Err(error), None),
        }
    }

    fn perform_inner(&mut self, request: &Request) -> Result<Envelope, SupervisionError> {
        let mut worker = match self.available.take() {
            Some(worker) => worker,
            None => SmlibWorker::spawn_uninitialized(&self.executable)
                .map_err(SupervisionError::Worker)?,
        };
        let control = worker.process_control();
        *self.pid.lock().unwrap_or_else(|e| e.into_inner()) = Some(control.clone());
        let (finished, completion) = mpsc::channel();
        // Commands contain small owned values; caller closures cannot execute.
        let command = request.command.clone();
        let transport = std::thread::Builder::new()
            .name("smlib-transport".into())
            .spawn(move || {
                let result = execute(&mut worker, command);
                let _ = finished.send((worker, result));
            })
            .map_err(|error| {
                *self.pid.lock().unwrap_or_else(|e| e.into_inner()) = None;
                SupervisionError::Worker(WorkerError::Io(error))
            })?;
        loop {
            self.maintain_queue();
            if let Some(error) = interrupted(request, &self.stopping) {
                let terminated = control.terminate();
                let joined = transport.join();
                *self.pid.lock().unwrap_or_else(|e| e.into_inner()) = None;
                terminated.map_err(|error| SupervisionError::Worker(WorkerError::Io(error)))?;
                joined.map_err(|_| SupervisionError::TransportPanicked)?;
                return Err(error);
            }
            let wait = POLL.min(request.deadline.saturating_duration_since(Instant::now()));
            match completion.recv_timeout(wait) {
                Ok((worker, result)) => {
                    transport
                        .join()
                        .map_err(|_| SupervisionError::TransportPanicked)?;
                    if let Some(error) = interrupted(request, &self.stopping) {
                        let terminated = control.terminate();
                        drop(worker);
                        *self.pid.lock().unwrap_or_else(|e| e.into_inner()) = None;
                        terminated
                            .map_err(|error| SupervisionError::Worker(WorkerError::Io(error)))?;
                        return Err(error);
                    }
                    if !worker.is_live()
                        || matches!(result, Err(WorkerError::Io(_) | WorkerError::Protocol(_)))
                    {
                        drop(worker);
                        *self.pid.lock().unwrap_or_else(|e| e.into_inner()) = None;
                    } else {
                        self.available = Some(worker);
                    }
                    let owned = matches!(result, Ok(WorkerResult::Solid(_))).then_some(control);
                    return Ok(Envelope::new(
                        result.map_err(SupervisionError::Worker),
                        owned,
                    ));
                }
                Err(mpsc::RecvTimeoutError::Timeout) => (),
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    let terminated = control.terminate();
                    let joined = transport.join();
                    *self.pid.lock().unwrap_or_else(|e| e.into_inner()) = None;
                    terminated.map_err(|error| SupervisionError::Worker(WorkerError::Io(error)))?;
                    joined.map_err(|_| SupervisionError::TransportPanicked)?;
                    return Err(SupervisionError::Stopped);
                }
            }
        }
    }
}

fn interrupted(request: &Request, stopping: &AtomicBool) -> Option<SupervisionError> {
    if stopping.load(Ordering::Acquire) {
        Some(SupervisionError::Stopped)
    } else if request.claim.is_cancelled() {
        Some(SupervisionError::Cancelled)
    } else if Instant::now() >= request.deadline {
        Some(SupervisionError::Deadline)
    } else {
        None
    }
}

fn respond(request: Request, result: Envelope) {
    let Request {
        _admission,
        response,
        ..
    } = request;
    // Release the slot before waking the caller so immediate resubmission works.
    drop(_admission);
    let _ = response.send(result);
}

#[cfg(test)]
#[path = "controller_tests.rs"]
mod tests;
