// SPDX-License-Identifier: MPL-2.0
//! Versioned IPC with the single-threaded owned-handle SMLib adapter.

use crate::process_control::ProcessControl;
use crate::protocol::{
    self, KernelCommand, KernelResponse, WireHandle, MAX_PAYLOAD_BYTES, VERSION,
};
use ifc_lite_geometry::document::BooleanOperation;
use std::ffi::OsStr;
use std::io::{Read, Write};
use std::process::{ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};

#[path = "worker_mesh.rs"]
mod mesh;
pub use mesh::{MeshLimits, TessellatedMesh};

static NEXT_WORKER: AtomicU64 = AtomicU64::new(1);

/// Opaque BRep identity. Worker identity is host-local and never sent over IPC.
#[derive(Debug, Clone, Copy)]
pub struct BrepHandle {
    worker: u64,
    wire: WireHandle,
}

#[derive(Debug)]
pub enum WorkerError {
    Io(std::io::Error),
    Protocol(&'static str),
    Kernel { status: i32, message: String },
    WrongWorker,
    ResourceLimit(&'static str),
}

impl std::fmt::Display for WorkerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(f, "geometry worker IO: {error}"),
            Self::Protocol(message) => write!(f, "geometry worker protocol: {message}"),
            Self::Kernel { status, message } => {
                write!(f, "geometry worker status {status}: {message}")
            }
            Self::WrongWorker => write!(f, "BRep handle belongs to another worker"),
            Self::ResourceLimit(message) => write!(f, "geometry worker resource limit: {message}"),
        }
    }
}
impl std::error::Error for WorkerError {}
impl From<std::io::Error> for WorkerError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

/// Owns one isolated serial SMLib process and session. A mutable receiver
/// serializes requests; handles are rejected across workers even if their wire
/// session IDs happen to coincide. Dropping the client kills/reaps its process.
///
/// Operations block. Use `SupervisedWorker` for bounded deadlines, cancellation
/// and restart. This low-level client remains useful for serial tools.
pub struct SmlibWorker {
    process: ProcessControl,
    input: ChildStdin,
    output: ChildStdout,
    identity: u64,
    session: u64,
    sequence: u32,
    healthy: bool,
}

impl SmlibWorker {
    pub fn spawn(executable: impl AsRef<OsStr>) -> Result<Self, WorkerError> {
        let mut worker = Self::spawn_uninitialized(executable)?;
        worker.initialize()?;
        Ok(worker)
    }

    pub(crate) fn spawn_uninitialized(executable: impl AsRef<OsStr>) -> Result<Self, WorkerError> {
        let identity = NEXT_WORKER
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                value.checked_add(1)
            })
            .map_err(|_| WorkerError::Protocol("worker IDs exhausted"))?;
        let mut child = Command::new(executable)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()?;
        // Piped handles are guaranteed by the std::process configuration above.
        let input = child.stdin.take().expect("piped worker stdin");
        let output = child.stdout.take().expect("piped worker stdout");
        Ok(Self {
            process: ProcessControl::new(child),
            input,
            output,
            identity,
            session: 0,
            sequence: 0,
            healthy: true,
        })
    }

    pub(crate) fn process_control(&self) -> ProcessControl {
        self.process.clone()
    }

    pub(crate) fn initialize(&mut self) -> Result<(), WorkerError> {
        if self.session != 0 {
            return Ok(());
        }
        let abi = self.call(KernelCommand::AbiVersion)?;
        if abi.as_slice() != VERSION.to_le_bytes() {
            return Err(WorkerError::Protocol("unsupported SMLib ABI"));
        }
        let bytes = self.call(KernelCommand::CreateSession)?;
        self.session = u64::from_le_bytes(self.fixed(bytes)?);
        if self.session == 0 {
            return Err(self.poison("zero session"));
        }
        Ok(())
    }

    /// OS process identity for supervisor diagnostics. Handles remain private.
    pub fn process_id(&self) -> u32 {
        self.process.id()
    }

    /// Terminate and reap this worker, invalidating its session and handles.
    /// Idempotent after success. This cannot interrupt a concurrent blocking call
    /// holding `&mut self`; a deadline supervisor must own process cancellation.
    pub fn terminate(&mut self) -> Result<(), WorkerError> {
        self.healthy = false;
        self.process.terminate()?;
        Ok(())
    }

    /// Create a positive-dimension box, with minimum corner in evaluation metres.
    pub fn create_box(
        &mut self,
        origin: [f64; 3],
        size: [f64; 3],
    ) -> Result<BrepHandle, WorkerError> {
        let bytes = self.call(KernelCommand::Box {
            session: self.session,
            origin,
            size,
        })?;
        self.handle(bytes)
    }

    /// Create a positive-Z cylinder in evaluation metres.
    pub fn create_cylinder(
        &mut self,
        origin: [f64; 3],
        radius: f64,
        height: f64,
    ) -> Result<BrepHandle, WorkerError> {
        let bytes = self.call(KernelCommand::Cylinder {
            session: self.session,
            origin,
            radius,
            height,
        })?;
        self.handle(bytes)
    }

    /// Tolerance-based retained-BRep operation. Exact-polyhedral callers use
    /// GeometryDocument::evaluate_exact; this API never substitutes for it.
    pub fn boolean(
        &mut self,
        left: BrepHandle,
        right: BrepHandle,
        operation: BooleanOperation,
    ) -> Result<BrepHandle, WorkerError> {
        let left = self.wire(left)?;
        let right = self.wire(right)?;
        let bytes = self.call(KernelCommand::Boolean {
            session: self.session,
            left,
            right,
            operation,
        })?;
        self.handle(bytes)
    }

    pub fn volume(
        &mut self,
        solid: BrepHandle,
        relative_accuracy: f64,
    ) -> Result<f64, WorkerError> {
        let solid = self.wire(solid)?;
        let bytes = self.call(KernelCommand::Volume {
            session: self.session,
            solid,
            relative_accuracy,
        })?;
        let volume = f64::from_le_bytes(self.fixed(bytes)?);
        if !volume.is_finite() {
            return Err(self.poison("nonfinite volume"));
        }
        Ok(volume)
    }

    pub fn is_manifold(&mut self, solid: BrepHandle) -> Result<bool, WorkerError> {
        let solid = self.wire(solid)?;
        let bytes = self.call(KernelCommand::Manifold {
            session: self.session,
            solid,
        })?;
        match u32::from_le_bytes(self.fixed(bytes)?) {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err(self.poison("invalid manifold result")),
        }
    }

    pub fn release(&mut self, solid: BrepHandle) -> Result<(), WorkerError> {
        let object = self.wire(solid)?;
        let bytes = self.call(KernelCommand::Release {
            session: self.session,
            object,
        })?;
        if !bytes.is_empty() {
            return Err(self.poison("release returned unexpected payload"));
        }
        Ok(())
    }

    fn handle(&mut self, bytes: Vec<u8>) -> Result<BrepHandle, WorkerError> {
        let wire = WireHandle::from_bytes(&bytes).map_err(|error| self.poison(error.as_str()))?;
        if wire.session != self.session {
            return Err(self.poison("returned handle belongs to another session"));
        }
        Ok(BrepHandle {
            worker: self.identity,
            wire,
        })
    }

    fn wire(&self, solid: BrepHandle) -> Result<WireHandle, WorkerError> {
        self.check(solid)?;
        Ok(solid.wire)
    }

    fn check(&self, solid: BrepHandle) -> Result<(), WorkerError> {
        if solid.worker == self.identity {
            Ok(())
        } else {
            Err(WorkerError::WrongWorker)
        }
    }

    fn call(&mut self, command: KernelCommand) -> Result<Vec<u8>, WorkerError> {
        if !self.healthy {
            return Err(WorkerError::Protocol("worker requires restart"));
        }
        let result = self.exchange(&command);
        if matches!(result, Err(WorkerError::Io(_) | WorkerError::Protocol(_))) {
            self.retire();
        }
        result
    }

    fn exchange(&mut self, command: &KernelCommand) -> Result<Vec<u8>, WorkerError> {
        self.sequence = self
            .sequence
            .checked_add(1)
            .ok_or(WorkerError::Protocol("request IDs exhausted"))?;
        let payload = protocol::encode_request(self.sequence, command)
            .map_err(|error| WorkerError::Protocol(error.as_str()))?;
        self.input
            .write_all(&(payload.len() as u32).to_le_bytes())?;
        self.input.write_all(&payload)?;
        self.input.flush()?;
        let mut size = [0; 4];
        self.output.read_exact(&mut size)?;
        let size = u32::from_le_bytes(size) as usize;
        if !(12..=MAX_PAYLOAD_BYTES).contains(&size) {
            return Err(WorkerError::Protocol("invalid response length"));
        }
        let mut body = vec![0; size];
        self.output.read_exact(&mut body)?;
        match protocol::decode_response(self.sequence, &body)
            .map_err(|error| WorkerError::Protocol(error.as_str()))?
        {
            KernelResponse::Success(data) => Ok(data.to_vec()),
            KernelResponse::Failure { status, message } => Err(WorkerError::Kernel {
                status,
                message: message.to_owned(),
            }),
        }
    }

    fn fixed<const N: usize>(&mut self, bytes: Vec<u8>) -> Result<[u8; N], WorkerError> {
        bytes
            .try_into()
            .map_err(|_| self.poison("unexpected result length"))
    }

    fn poison(&mut self, message: &'static str) -> WorkerError {
        self.retire();
        WorkerError::Protocol(message)
    }

    fn retire(&mut self) {
        if let Err(error) = self.terminate() {
            eprintln!("geometry worker termination/reap failed: {error}");
        }
    }
}

impl Drop for SmlibWorker {
    fn drop(&mut self) {
        if let Err(error) = self.terminate() {
            eprintln!("geometry worker termination/reap failed: {error}");
        }
    }
}
