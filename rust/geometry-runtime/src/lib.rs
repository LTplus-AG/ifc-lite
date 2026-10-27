// SPDX-License-Identifier: MPL-2.0
//! Explicit, opt-in geometry execution transport. Retained BRep operations run
//! in independent native SMLib worker processes (see `native/smlib-adapter`).
//! Nothing in IFC-Lite's default geometry pipeline depends on this crate.

pub mod protocol;

#[cfg(not(target_arch = "wasm32"))]
mod process_control;
#[cfg(not(target_arch = "wasm32"))]
mod runtime_owner;
#[cfg(not(target_arch = "wasm32"))]
mod supervision;
#[cfg(not(target_arch = "wasm32"))]
mod worker;

#[cfg(not(target_arch = "wasm32"))]
pub use supervision::{
    PendingCommand, SupervisedWorker, SupervisionError, WorkerCommand, WorkerResult,
};
#[cfg(not(target_arch = "wasm32"))]
pub use runtime_owner::RuntimeOwner;
#[cfg(not(target_arch = "wasm32"))]
pub use worker::{
    AffineCertificate, AffineCopyIdentity, BrepHandle, MeshLimits, NumericalOutcome, RegionQualificationReport, RetainedDependency,
    RetainedAffineCopy, RetainedDependencyResult, RetainedLineage, RetainedRealization,
    RetainedTransformInput, SmlibWorker, TessellatedMesh, WorkerError,
};

#[cfg(all(feature = "retained-runtime", not(target_arch = "wasm32")))]
pub use worker::RetainedBooleanIdentity;
