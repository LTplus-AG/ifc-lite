// SPDX-License-Identifier: MPL-2.0
use super::*;
use std::collections::VecDeque;
const POLL: Duration = Duration::from_millis(5);

struct Controller {
    executable: OsString,
    receiver: mpsc::Receiver<Request>,
    stopping: Arc<AtomicBool>,
    pid: Arc<AtomicU32>,
    queued: VecDeque<Request>,
    available: Option<SmlibWorker>,
}

pub(super) fn run(
    executable: OsString,
    receiver: mpsc::Receiver<Request>,
    stopping: Arc<AtomicBool>,
    pid: Arc<AtomicU32>,
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
                Some(error) => Err(error),
                None => self.perform(&request),
            };
            respond(request, result);
        }
        drop(self.available.take());
        self.pid.store(0, Ordering::Release);
        self.maintain_queue();
    }

    fn maintain_queue(&mut self) {
        self.queued.extend(self.receiver.try_iter());
        for _ in 0..self.queued.len() {
            let request = self.queued.pop_front().expect("fixed queue length");
            if let Some(error) = interrupted(&request, &self.stopping) {
                respond(request, Err(error));
            } else {
                self.queued.push_back(request);
            }
        }
    }

    fn perform(&mut self, request: &Request) -> Result<WorkerResult, SupervisionError> {
        let mut worker = match self.available.take() {
            Some(worker) => worker,
            None => SmlibWorker::spawn_uninitialized(&self.executable)
                .map_err(SupervisionError::Worker)?,
        };
        let control = worker.process_control();
        self.pid.store(control.id(), Ordering::Release);
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
                self.pid.store(0, Ordering::Release);
                SupervisionError::Worker(WorkerError::Io(error))
            })?;
        loop {
            self.maintain_queue();
            if let Some(error) = interrupted(request, &self.stopping) {
                let terminated = control.terminate();
                let joined = transport.join();
                self.pid.store(0, Ordering::Release);
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
                        self.pid.store(0, Ordering::Release);
                        terminated
                            .map_err(|error| SupervisionError::Worker(WorkerError::Io(error)))?;
                        return Err(error);
                    }
                    if matches!(result, Err(WorkerError::Io(_) | WorkerError::Protocol(_))) {
                        drop(worker);
                        self.pid.store(0, Ordering::Release);
                    } else {
                        self.available = Some(worker);
                    }
                    return result.map_err(SupervisionError::Worker);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => (),
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    let terminated = control.terminate();
                    let joined = transport.join();
                    self.pid.store(0, Ordering::Release);
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
    } else if request.cancelled.load(Ordering::Acquire) {
        Some(SupervisionError::Cancelled)
    } else if Instant::now() >= request.deadline {
        Some(SupervisionError::Deadline)
    } else {
        None
    }
}

fn respond(request: Request, result: Result<WorkerResult, SupervisionError>) {
    let Request {
        _admission,
        response,
        ..
    } = request;
    // Release the slot before waking the caller so immediate resubmission works.
    drop(_admission);
    let _ = response.send(result);
}
