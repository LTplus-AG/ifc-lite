// SPDX-License-Identifier: MPL-2.0

//! Minimal geometry document: typed identity, revision and placed instances.
//!
//! Opt-in and off every default path: ordinary loads never construct a
//! [`GeometryDocument`], and no existing IFC production output depends on it.
//!
//! What this contract is, exactly:
//! - Definitions are object-local discrete meshes. Every admitted mesh is a
//!   display approximation of whatever produced it, never authored geometry:
//!   admission makes no claim of solid validity, exact source fidelity or
//!   analytic provenance.
//! - Occurrences place a definition with an f64 affine transform. Placements
//!   are never baked into the definition's f32 buffers.
//! - Handles resolve only in the document that minted them.
//!
//! - Retained definitions are captured authored extrusions plus their encoded
//!   worker request ([`RetainedRequest`]), kept apart from display meshes. A
//!   worker completion becomes a mesh only through
//!   [`GeometryDocument::publish_retained_display`], and then as an ordinary
//!   display approximation. The swept-disk family and any execution runtime
//!   are not part of this contract yet.
//!
//! Operations over definitions land with their first caller.

mod retained;
mod retained_display;
mod retained_sweep;
mod types;
mod validation;

pub use retained::{
    RetainedCompletion, RetainedDefinitionHandle, RetainedDisplayContract, RetainedExtrusion,
    RetainedRefusal, RetainedRequest, RetainedTessellation,
};
pub use retained_sweep::{RegionQualification, SweepPayload};
pub use types::{DefinitionHandle, DocumentError, DocumentId, Occurrence, OccurrenceHandle};

use crate::Mesh;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

static NEXT_DOCUMENT: AtomicU64 = AtomicU64::new(1);

#[derive(Debug)]
struct Definition {
    source_entity_id: u32,
    mesh: Mesh,
}

/// Owns object-local mesh definitions and their placed occurrences for one
/// loaded model. Every successful admission advances [`Self::revision`];
/// every refusal leaves the document unchanged.
#[derive(Debug)]
pub struct GeometryDocument {
    id: DocumentId,
    revision: u64,
    definitions: Vec<Definition>,
    occurrences: Vec<Occurrence>,
    retained: Vec<Arc<retained::RetainedEntry>>,
}

impl Default for GeometryDocument {
    fn default() -> Self {
        Self::new()
    }
}

impl GeometryDocument {
    /// A fresh empty document at revision 0 with a process-unique identity
    /// (unique for the first 2^64 documents of a process).
    pub fn new() -> Self {
        Self {
            id: DocumentId(NEXT_DOCUMENT.fetch_add(1, Ordering::Relaxed)),
            revision: 0,
            definitions: Vec::new(),
            occurrences: Vec::new(),
            retained: Vec::new(),
        }
    }

    pub fn id(&self) -> DocumentId {
        self.id
    }

    /// Number of successful admissions so far.
    pub fn revision(&self) -> u64 {
        self.revision
    }

    /// Takes ownership of an existing discrete mesh as an object-local display
    /// approximation, attributed to `source_entity_id`.
    ///
    /// Refuses [`DocumentError::InvalidMesh`] for incomplete triples, non-finite
    /// values, mismatched normals or out-of-range indices, and
    /// [`DocumentError::UnsupportedFrame`] for a mesh carrying a non-zero
    /// origin, an applied RTC offset, a placement or instancing metadata: the
    /// caller must move that frame into an occurrence explicitly. Shape checks
    /// only prevent malformed buffer access; no topology is qualified.
    pub fn add_mesh_definition(
        &mut self,
        source_entity_id: u32,
        mesh: Mesh,
    ) -> Result<DefinitionHandle, DocumentError> {
        validation::validate_mesh(&mesh)?;
        let revision = self.next_revision()?;
        let handle = DefinitionHandle {
            document: self.id,
            slot: self.definitions.len(),
        };
        self.definitions.push(Definition {
            source_entity_id,
            mesh,
        });
        self.revision = revision;
        Ok(handle)
    }

    /// The admitted display mesh, borrowed from the document.
    pub fn mesh(&self, handle: DefinitionHandle) -> Result<&Mesh, DocumentError> {
        Ok(&self.definition(handle)?.mesh)
    }

    pub fn source_entity_id(&self, handle: DefinitionHandle) -> Result<u32, DocumentError> {
        Ok(self.definition(handle)?.source_entity_id)
    }

    /// Places `definition` into the caller's model frame.
    ///
    /// Refuses [`DocumentError::WrongDocument`] for a foreign definition and
    /// [`DocumentError::InvalidTransform`] for a non-finite, projective or
    /// singular `local_to_model` (row-major).
    pub fn add_occurrence(
        &mut self,
        definition: DefinitionHandle,
        source_entity_id: u32,
        local_to_model: [f64; 16],
    ) -> Result<OccurrenceHandle, DocumentError> {
        self.definition(definition)?;
        validation::validate_transform(&local_to_model)?;
        let revision = self.next_revision()?;
        let handle = OccurrenceHandle {
            document: self.id,
            slot: self.occurrences.len(),
        };
        self.occurrences.push(Occurrence {
            source_entity_id,
            definition,
            local_to_model,
        });
        self.revision = revision;
        Ok(handle)
    }

    pub fn occurrence(&self, handle: OccurrenceHandle) -> Result<&Occurrence, DocumentError> {
        self.check_document(handle.document)?;
        // Same-document handles are minted in range and nothing is removed.
        self.occurrences
            .get(handle.slot)
            .ok_or(DocumentError::WrongDocument)
    }

    fn definition(&self, handle: DefinitionHandle) -> Result<&Definition, DocumentError> {
        self.check_document(handle.document)?;
        self.definitions
            .get(handle.slot)
            .ok_or(DocumentError::WrongDocument)
    }

    fn check_document(&self, id: DocumentId) -> Result<(), DocumentError> {
        if id == self.id {
            Ok(())
        } else {
            Err(DocumentError::WrongDocument)
        }
    }

    fn next_revision(&self) -> Result<u64, DocumentError> {
        self.revision
            .checked_add(1)
            .ok_or(DocumentError::RevisionExhausted)
    }
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
