// SPDX-License-Identifier: MPL-2.0

use crate::Mesh;

/// Process-local session identity; never an IFC entity or federation ID.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct DocumentId(pub(super) u64);

/// A reusable definition at one revision. Edits invalidate older handles.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct DefinitionHandle {
    pub(super) document: DocumentId,
    pub(super) slot: usize,
    pub(super) generation: u64,
}

/// An occurrence belongs to one document and is never reused after removal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct OccurrenceHandle {
    pub(super) document: DocumentId,
    pub(super) slot: usize,
}

/// Numerical meaning is chosen before execution, including failed execution.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EvaluationContract {
    /// Existing f32 mesh bridge, including its snapping/reconciliation policy.
    /// Predicates are exact; inputs and reconstructed mesh are still discrete.
    ExactPolyhedral,
    /// Tolerance-based retained surfaces. The exact executor refuses this.
    RetainedBrep,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BooleanOperation {
    Difference,
    Union,
    Intersection,
}

/// Snapshot of ordered dependencies; two different cutters remain distinct.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BooleanRequest {
    pub(super) document: DocumentId,
    pub(super) revision: u64,
    pub(super) left: DefinitionHandle,
    pub(super) right: DefinitionHandle,
    pub(super) operation: BooleanOperation,
    pub(super) contract: EvaluationContract,
}

/// An unpublished result. Access requires document revision validation.
#[derive(Debug)]
pub struct EvaluatedMesh {
    pub(super) request: BooleanRequest,
    pub(super) mesh: Mesh,
}

impl EvaluatedMesh {
    pub fn request(&self) -> BooleanRequest {
        self.request
    }
}

/// Object-local definition placement; matrix is row-major, affine, f64.
#[derive(Debug, Clone)]
pub struct Occurrence {
    pub source_entity_id: u32,
    pub definition: DefinitionHandle,
    pub local_to_model: [f64; 16],
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum DocumentError {
    #[error("handle belongs to another geometry document")]
    WrongDocument,
    #[error("definition or occurrence no longer exists at this revision")]
    StaleHandle,
    #[error("geometry document changed since this request was prepared")]
    StaleRevision,
    #[error("exact executor does not support the requested evaluation contract")]
    UnsupportedContract,
    #[error("invalid mesh: {0}")]
    InvalidMesh(&'static str),
    #[error("definition must be object-local; remove placement and origin explicitly")]
    UnsupportedFrame,
    #[error("occurrence transform must be finite, affine and invertible")]
    InvalidTransform,
    #[error("exact kernel exhausted its deterministic work budget")]
    BudgetExceeded,
    #[error("geometry document revision space exhausted")]
    RevisionExhausted,
}
