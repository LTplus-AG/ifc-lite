// SPDX-License-Identifier: MPL-2.0

/// Process-local session identity; never an IFC entity or federation ID.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct DocumentId(pub(super) u64);

/// A mesh definition owned by exactly one [`super::GeometryDocument`].
///
/// Only the owning document can mint or resolve it; a handle from another
/// document is refused with [`DocumentError::WrongDocument`], never aliased to
/// the same slot.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct DefinitionHandle {
    pub(super) document: DocumentId,
    pub(super) slot: usize,
}

/// A placed occurrence owned by exactly one [`super::GeometryDocument`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct OccurrenceHandle {
    pub(super) document: DocumentId,
    pub(super) slot: usize,
}

/// One placement of an object-local definition.
///
/// `local_to_model` is row-major, affine and f64; the document never bakes it
/// into the definition's f32 buffers. The model frame is whatever frame the
/// admitting caller states (for processing output: `ProcessingResult::frame`).
#[derive(Debug, Clone)]
pub struct Occurrence {
    pub source_entity_id: u32,
    pub definition: DefinitionHandle,
    pub local_to_model: [f64; 16],
}

/// Every refusal of the document contract. A refused call leaves the document
/// and its revision unchanged.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[non_exhaustive]
pub enum DocumentError {
    #[error("handle belongs to another geometry document")]
    WrongDocument,
    #[error("invalid mesh: {0}")]
    InvalidMesh(&'static str),
    #[error("definition must be object-local; remove placement and origin explicitly")]
    UnsupportedFrame,
    #[error("occurrence transform must be finite, affine and invertible")]
    InvalidTransform,
    #[error("geometry document revision space exhausted")]
    RevisionExhausted,
}
