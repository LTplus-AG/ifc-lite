// SPDX-License-Identifier: MPL-2.0
//! Geometry execution transports. Exact operations remain in Rust; retained
//! BRep operations use independent native worker processes.

pub mod protocol;
pub mod browser;
mod retained_values;
mod affine;
pub use affine::AffineCertificate;
pub use retained_values::{RetainedLineage, NumericalOutcome};

#[cfg(not(target_arch = "wasm32"))]
mod worker;
#[cfg(not(target_arch = "wasm32"))]
mod process_control;
#[cfg(not(target_arch = "wasm32"))]
mod supervision;
#[cfg(not(target_arch = "wasm32"))]
pub use supervision::{PendingCommand, SupervisedWorker, SupervisionError, WorkerCommand, WorkerResult};
#[cfg(not(target_arch = "wasm32"))]
pub use worker::{AffineCopyIdentity, RetainedAffineCopy, RegionQualificationReport, RetainedDependency, RetainedDependencyResult, RetainedOperationIdentity, BrepHandle, MeshLimits, RetainedRealization, SmlibWorker, TessellatedMesh, WorkerError};
#[cfg(not(target_arch = "wasm32"))]
mod runtime_owner;
#[cfg(not(target_arch = "wasm32"))]
pub use runtime_owner::RuntimeOwner;
