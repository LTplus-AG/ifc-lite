// SPDX-License-Identifier: MPL-2.0
//! Geometry execution transports. Exact operations remain in Rust; retained
//! BRep operations use independent native worker processes.

pub mod protocol;

#[cfg(not(target_arch = "wasm32"))]
mod worker;
#[cfg(not(target_arch = "wasm32"))]
mod process_control;
#[cfg(not(target_arch = "wasm32"))]
mod supervision;
#[cfg(not(target_arch = "wasm32"))]
pub use supervision::{PendingCommand, SupervisedWorker, SupervisionError, WorkerCommand, WorkerResult};
#[cfg(not(target_arch = "wasm32"))]
pub use worker::{BrepHandle, MeshLimits, SmlibWorker, TessellatedMesh, WorkerError};
