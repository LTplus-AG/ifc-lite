// SPDX-License-Identifier: MPL-2.0
//! Bounded native execution with cancellation independent of blocking IPC.
//! Limits bound queue depth and elapsed time. They do not impose process RAM
//! limits; deployment OS job/cgroup limits are a separate responsibility.
use crate::{BrepHandle, MeshLimits, SmlibWorker, TessellatedMesh, WorkerError};
use ifc_lite_geometry::document::BooleanOperation;
use std::ffi::OsString;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

mod controller;

/// Owned operations only: callers cannot run arbitrary code on the IO thread.
#[derive(Debug, Clone)]
pub enum WorkerCommand {
    CreateBox {
        origin: [f64; 3],
        size: [f64; 3],
    },
    CreateCylinder {
        origin: [f64; 3],
        radius: f64,
        height: f64,
    },
    Boolean {
        left: BrepHandle,
        right: BrepHandle,
        operation: BooleanOperation,
    },
    Volume {
        solid: BrepHandle,
        relative_accuracy: f64,
    },
    IsManifold {
        solid: BrepHandle,
    },
    Release {
        solid: BrepHandle,
    },
    Tessellate {
        solid: BrepHandle,
        chord_metres: f64,
        angle_degrees: f64,
        limits: MeshLimits,
    },
}

#[derive(Debug)]
pub enum WorkerResult {
    Solid(BrepHandle),
    Volume(f64),
    Manifold(bool),
    Released,
    Mesh(TessellatedMesh),
}

#[derive(Debug)]
pub enum SupervisionError {
    Worker(WorkerError),
    Deadline,
    Cancelled,
    QueueFull,
    Stopped,
    TransportPanicked,
}

impl std::fmt::Display for SupervisionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Worker(error) => error.fmt(f),
            Self::Deadline => write!(f, "geometry worker deadline exceeded"),
            Self::Cancelled => write!(f, "geometry worker command cancelled"),
            Self::QueueFull => write!(f, "geometry worker queue is full"),
            Self::Stopped => write!(f, "geometry worker supervisor stopped"),
            Self::TransportPanicked => write!(f, "geometry worker transport panicked"),
        }
    }
}
impl std::error::Error for SupervisionError {}

struct Admission(Arc<AtomicUsize>);
impl Drop for Admission {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

struct Request {
    _admission: Admission,
    command: WorkerCommand,
    deadline: Instant,
    cancelled: Arc<AtomicBool>,
    response: mpsc::Sender<Result<WorkerResult, SupervisionError>>,
}

/// Cancelling or dropping a pending request retires an executing session. Its
/// completion is sent only after the process has been killed and reaped.
pub struct PendingCommand {
    cancelled: Arc<AtomicBool>,
    response: mpsc::Receiver<Result<WorkerResult, SupervisionError>>,
}
impl PendingCommand {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }

    pub fn wait(self) -> Result<WorkerResult, SupervisionError> {
        self.response
            .recv()
            .unwrap_or(Err(SupervisionError::Stopped))
    }
}
impl Drop for PendingCommand {
    fn drop(&mut self) {
        self.cancel();
    }
}

/// One active process plus at most `queue_capacity` waiting owned commands.
/// Deadlines include queue wait and session startup. Restart is lazy after a
/// transport failure, timeout or cancellation; all previous handles are stale.
/// Drop cancels work, kills/reaps the owned process and joins transport threads.
pub struct SupervisedWorker {
    sender: Option<mpsc::SyncSender<Request>>,
    admitted: Arc<AtomicUsize>,
    capacity: usize,
    stopping: Arc<AtomicBool>,
    process_id: Arc<AtomicU32>,
    controller: Option<JoinHandle<()>>,
}
impl SupervisedWorker {
    pub fn new(executable: impl Into<OsString>, queue_capacity: usize) -> std::io::Result<Self> {
        let capacity = queue_capacity.checked_add(1).ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidInput, "queue capacity overflow")
        })?;
        let (sender, receiver) = mpsc::sync_channel(capacity);
        let admitted = Arc::new(AtomicUsize::new(0));
        let stopping = Arc::new(AtomicBool::new(false));
        let process_id = Arc::new(AtomicU32::new(0));
        let stop = Arc::clone(&stopping);
        let pid = Arc::clone(&process_id);
        let executable = executable.into();
        let controller = std::thread::Builder::new()
            .name("smlib-supervisor".into())
            .spawn(move || controller::run(executable, receiver, stop, pid))?;
        Ok(Self {
            sender: Some(sender),
            admitted,
            capacity,
            stopping,
            process_id,
            controller: Some(controller),
        })
    }

    /// Nonblocking admission provides backpressure instead of growing a queue.
    pub fn submit(
        &self,
        command: WorkerCommand,
        timeout: Duration,
    ) -> Result<PendingCommand, SupervisionError> {
        let deadline = Instant::now()
            .checked_add(timeout)
            .ok_or(SupervisionError::Deadline)?;
        self.admitted
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                (count < self.capacity).then_some(count + 1)
            })
            .map_err(|_| SupervisionError::QueueFull)?;
        let admission = Admission(Arc::clone(&self.admitted));
        let cancelled = Arc::new(AtomicBool::new(false));
        let (response, receiver) = mpsc::channel();
        let request = Request {
            _admission: admission,
            command,
            deadline,
            cancelled: Arc::clone(&cancelled),
            response,
        };
        self.sender
            .as_ref()
            .ok_or(SupervisionError::Stopped)?
            .try_send(request)
            .map_err(|error| match error {
                mpsc::TrySendError::Full(_) => SupervisionError::QueueFull,
                mpsc::TrySendError::Disconnected(_) => SupervisionError::Stopped,
            })?;
        Ok(PendingCommand {
            cancelled,
            response: receiver,
        })
    }

    /// Diagnostic identity only. Cancellation uses the owned Child, never a PID.
    pub fn process_id(&self) -> Option<u32> {
        match self.process_id.load(Ordering::Acquire) {
            0 => None,
            id => Some(id),
        }
    }
}
impl Drop for SupervisedWorker {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::Release);
        self.sender.take();
        if let Some(controller) = self.controller.take() {
            if controller.join().is_err() {
                eprintln!("geometry worker controller panicked");
            }
        }
    }
}

fn execute(worker: &mut SmlibWorker, command: WorkerCommand) -> Result<WorkerResult, WorkerError> {
    worker.initialize()?;
    match command {
        WorkerCommand::CreateBox { origin, size } => {
            worker.create_box(origin, size).map(WorkerResult::Solid)
        }
        WorkerCommand::CreateCylinder {
            origin,
            radius,
            height,
        } => worker
            .create_cylinder(origin, radius, height)
            .map(WorkerResult::Solid),
        WorkerCommand::Boolean {
            left,
            right,
            operation,
        } => worker
            .boolean(left, right, operation)
            .map(WorkerResult::Solid),
        WorkerCommand::Volume {
            solid,
            relative_accuracy,
        } => worker
            .volume(solid, relative_accuracy)
            .map(WorkerResult::Volume),
        WorkerCommand::IsManifold { solid } => {
            worker.is_manifold(solid).map(WorkerResult::Manifold)
        }
        WorkerCommand::Release { solid } => worker.release(solid).map(|()| WorkerResult::Released),
        WorkerCommand::Tessellate {
            solid,
            chord_metres,
            angle_degrees,
            limits,
        } => worker
            .tessellate(solid, chord_metres, angle_degrees, limits)
            .map(WorkerResult::Mesh),
    }
}
