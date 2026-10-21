// SPDX-License-Identifier: MPL-2.0
//! Versioned IPC with the single-threaded owned-handle SMLib adapter.

use crate::process_control::ProcessControl;
use crate::protocol::{self, BooleanOperation, KernelCommand, KernelResponse, WireHandle, VERSION};
use std::collections::HashMap;
use std::ffi::OsStr;
use std::io::{Read, Write};
use std::process::{ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

#[path = "worker_error.rs"]
mod error;
pub use error::WorkerError;
#[path = "worker_mesh.rs"]
mod mesh;
pub use mesh::{MeshLimits, TessellatedMesh};
#[path = "worker_upload.rs"]
mod upload;
#[path = "worker_qualification.rs"]
mod qualification;
pub use qualification::RegionQualificationReport;
#[path = "worker_disk_qualification.rs"]
mod disk_qualification;
#[path = "worker_sweep.rs"]
mod sweep;
pub use sweep::RetainedRealization;

static NEXT_WORKER: AtomicU64 = AtomicU64::new(1);

/// Opaque BRep identity. Worker identity is host-local and never sent over IPC.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct BrepHandle {
    worker: u64,
    wire: WireHandle,
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
    /// Same-incarnation numerical witnesses; never set by capability bits.
    regions_qualified: bool,
    disks_qualified: bool,
    /// Live objects; each flag is shared with the receipts that name it and
    /// cleared before the object is released.
    objects: HashMap<WireHandle, Arc<AtomicBool>>,
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
            regions_qualified: false,
            disks_qualified: false,
            objects: HashMap::new(),
        })
    }

    pub(crate) fn is_live(&self) -> bool {
        self.healthy && self.process.is_live()
    }

    pub(crate) fn process_control(&self) -> ProcessControl {
        self.process.clone()
    }

    pub(crate) fn initialize(&mut self) -> Result<(), WorkerError> {
        if !self.is_live() {
            return Err(WorkerError::Protocol("worker requires restart"));
        }
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

    /// Host-local incarnation: nonzero while this exact process is live.
    pub fn incarnation(&self) -> u64 {
        if self.is_live() {
            self.identity
        } else {
            0
        }
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

    /// Copy before transforming; the input is never mutated. Matrices are
    /// column-major metres and must be proper rigid (finite, orthonormal).
    pub fn copy_transform(
        &mut self,
        solid: BrepHandle,
        column_major: [f64; 16],
    ) -> Result<BrepHandle, WorkerError> {
        rigid(column_major).map_err(WorkerError::InvalidArgument)?;
        let solid = self.wire(solid)?;
        let bytes = self.call(KernelCommand::CopyTransform {
            session: self.session,
            solid,
            column_major,
        })?;
        self.handle(bytes)
    }

    /// Release one live object. A reported kernel failure retires the process
    /// because the object's state is then unknown.
    pub fn release(&mut self, solid: BrepHandle) -> Result<(), WorkerError> {
        if solid.worker != self.identity || solid.wire.session != self.session {
            return Err(WorkerError::WrongWorker);
        }
        self.check(solid)?;
        if let Some(live) = self.objects.remove(&solid.wire) {
            live.store(false, Ordering::Release);
        }
        match self.exchange(&KernelCommand::Release {
            session: self.session,
            object: solid.wire,
        }) {
            Ok(bytes) if bytes.is_empty() => Ok(()),
            Ok(_) => Err(self.poison("release returned unexpected payload")),
            Err(error) => {
                self.retire();
                Err(error)
            }
        }
    }

    fn check_command_objects(&self, command: &KernelCommand) -> Result<(), WorkerError> {
        let check = |wire| {
            self.check(BrepHandle {
                worker: self.identity,
                wire,
            })
        };
        match command {
            KernelCommand::Boolean { left, right, .. } => {
                check(*left)?;
                check(*right)
            }
            KernelCommand::CopyTransform { solid, .. }
            | KernelCommand::Volume { solid, .. }
            | KernelCommand::Manifold { solid, .. }
            | KernelCommand::Tessellate { solid, .. } => check(*solid),
            KernelCommand::MeshInfo { mesh, .. } | KernelCommand::MeshRead { mesh, .. } => {
                check(*mesh)
            }
            _ => Ok(()),
        }
    }

    fn handle(&mut self, bytes: Vec<u8>) -> Result<BrepHandle, WorkerError> {
        let wire = WireHandle::from_bytes(&bytes).map_err(|error| self.poison(error.as_str()))?;
        if wire.session != self.session {
            return Err(self.poison("returned handle belongs to another session"));
        }
        if self.objects.contains_key(&wire) {
            return Err(self.poison("duplicate live object handle"));
        }
        self.objects.insert(wire, Arc::new(AtomicBool::new(true)));
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
        if !self.is_live() {
            return Err(WorkerError::Protocol("worker requires restart"));
        }
        if solid.worker != self.identity || solid.wire.session != self.session {
            return Err(WorkerError::WrongWorker);
        }
        if !self
            .objects
            .get(&solid.wire)
            .is_some_and(|live| live.load(Ordering::Acquire))
        {
            return Err(WorkerError::WrongWorker);
        }
        Ok(())
    }

    /// The shared liveness flag of one live object, for receipts naming it.
    fn object_liveness(&self, solid: BrepHandle) -> Result<Arc<AtomicBool>, WorkerError> {
        self.check(solid)?;
        self.objects
            .get(&solid.wire)
            .cloned()
            .ok_or(WorkerError::WrongWorker)
    }

    fn call(&mut self, command: KernelCommand) -> Result<Vec<u8>, WorkerError> {
        if !self.is_live() {
            return Err(WorkerError::Protocol("worker requires restart"));
        }
        self.check_command_objects(&command)?;
        let result = self.exchange(&command);
        // Only known synchronized statuses 1..7 guarantee transactional refusal.
        // Preserve the primary error while retiring any uncertain kernel domain.
        if matches!(&result, Err(WorkerError::Io(_) | WorkerError::Protocol(_)))
            || matches!(&result, Err(WorkerError::Kernel { status, .. }) if !(1..=7).contains(status))
        {
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
        if !(12..=protocol::MAX_RESPONSE_BYTES).contains(&size) {
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

/// Proper rigid check mirroring the adapter's admission: finite, bottom row
/// (0,0,0,1), orthonormal right-handed rotation.
fn rigid(m: [f64; 16]) -> Result<(), &'static str> {
    let valid = m.iter().all(|v| v.is_finite())
        && m[3] == 0.
        && m[7] == 0.
        && m[11] == 0.
        && m[15] == 1.
        && (0..3).all(|i| {
            (0..3).all(|j| {
                let dot: f64 = (0..3).map(|k| m[i * 4 + k] * m[j * 4 + k]).sum();
                (dot - if i == j { 1. } else { 0. }).abs() <= 1e-12
            })
        });
    let cross = [
        m[1] * m[6] - m[2] * m[5],
        m[2] * m[4] - m[0] * m[6],
        m[0] * m[5] - m[1] * m[4],
    ];
    if valid && (0..3).all(|i| (cross[i] - m[8 + i]).abs() <= 1e-12) {
        Ok(())
    } else {
        Err("transform must be a proper rigid metre frame")
    }
}
