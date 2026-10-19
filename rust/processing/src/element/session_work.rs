// SPDX-License-Identifier: MPL-2.0
//! Coarse attempt outcomes. Only a completed inner program reaches this boundary.
use super::*;
pub(super) enum PrimaryOutcome {
    Candidate(SubMeshCollection),
    Retry,
    RefusedAnnotation,
}
pub(super) enum PartsOutcome {
    Geometry(Vec<Mesh>),
    ConsumedByOpening,
    Retry,
}
