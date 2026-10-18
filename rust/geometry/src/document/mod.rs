// SPDX-License-Identifier: MPL-2.0

//! Shared geometry document foundation. This is an opt-in internal
//! integration API; existing IFC production paths retain their current behavior.
//! Definitions contain object-local meshes; occurrence placements are never
//! silently baked into a boolean. Exact evaluation preserves the existing bridge.

mod types;
mod validation;
mod retained;
mod retained_display;
pub mod retained_sweep;
pub use retained::{RetainedCompletion, RetainedDefinitionHandle, RetainedExtrusion,
    RetainedRefusal, RetainedRequest, RetainedTessellation};

pub use types::{
    BooleanOperation, BooleanRequest, DefinitionHandle, DocumentError, DocumentId, EvaluatedMesh,
    EvaluationContract, Occurrence, OccurrenceHandle,
};

use crate::{
    kernel::{budget, mesh_bridge},
    Mesh,
};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_DOCUMENT: AtomicU64 = AtomicU64::new(1);

#[derive(Debug)]
struct Definition {
    generation: u64,
    source_entity_id: u32,
    mesh: Mesh,
}

/// Owns reusable definitions and placed occurrences for one loaded model.
/// Every mutation advances the document revision. In-flight requests are
/// conservatively invalidated even when an unrelated definition changed.
#[derive(Debug)]
pub struct GeometryDocument {
    id: DocumentId,
    revision: u64,
    definitions: Vec<Option<Definition>>,
    occurrences: Vec<Option<Occurrence>>,
    retained: Vec<Option<retained::RetainedDefinition>>,
}

impl Default for GeometryDocument {
    fn default() -> Self {
        Self::new()
    }
}

impl GeometryDocument {
    pub fn new() -> Self {
        let id = NEXT_DOCUMENT
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                value.checked_add(1)
            })
            .expect("geometry document identities exhausted");
        Self {
            id: DocumentId(id),
            revision: 0,
            definitions: Vec::new(),
            occurrences: Vec::new(),
            retained: Vec::new(),
        }
    }

    pub fn id(&self) -> DocumentId {
        self.id
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    /// Admits existing discrete geometry without claiming solid validity or
    /// exact source fidelity. Shape checks prevent malformed buffer access;
    /// topology qualification remains a separate responsibility.
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
            generation: 1,
        };
        self.definitions.push(Some(Definition {
            generation: 1,
            source_entity_id,
            mesh,
        }));
        self.revision = revision;
        Ok(handle)
    }

    pub fn mesh(&self, handle: DefinitionHandle) -> Result<&Mesh, DocumentError> {
        Ok(&self.definition(handle)?.mesh)
    }

    pub fn source_entity_id(&self, handle: DefinitionHandle) -> Result<u32, DocumentError> {
        Ok(self.definition(handle)?.source_entity_id)
    }

    /// Returns a new handle; occurrences referring to the old revision become stale.
    pub fn replace_mesh_definition(
        &mut self,
        handle: DefinitionHandle,
        mesh: Mesh,
    ) -> Result<DefinitionHandle, DocumentError> {
        validation::validate_mesh(&mesh)?;
        let old = self.definition(handle)?;
        let generation = old
            .generation
            .checked_add(1)
            .ok_or(DocumentError::RevisionExhausted)?;
        let source_entity_id = old.source_entity_id;
        let revision = self.next_revision()?;
        self.definitions[handle.slot] = Some(Definition {
            generation,
            source_entity_id,
            mesh,
        });
        self.revision = revision;
        Ok(DefinitionHandle {
            generation,
            ..handle
        })
    }

    pub fn remove_definition(&mut self, handle: DefinitionHandle) -> Result<(), DocumentError> {
        self.definition(handle)?;
        let revision = self.next_revision()?;
        self.definitions[handle.slot] = None;
        self.revision = revision;
        Ok(())
    }

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
        self.occurrences.push(Some(Occurrence {
            source_entity_id,
            definition,
            local_to_model,
        }));
        self.revision = revision;
        Ok(handle)
    }

    pub fn occurrence(&self, handle: OccurrenceHandle) -> Result<&Occurrence, DocumentError> {
        self.check_document(handle.document)?;
        let occurrence = self
            .occurrences
            .get(handle.slot)
            .and_then(Option::as_ref)
            .ok_or(DocumentError::StaleHandle)?;
        self.definition(occurrence.definition)?;
        Ok(occurrence)
    }

    pub fn remove_occurrence(&mut self, handle: OccurrenceHandle) -> Result<(), DocumentError> {
        self.check_document(handle.document)?;
        if self
            .occurrences
            .get(handle.slot)
            .and_then(Option::as_ref)
            .is_none()
        {
            return Err(DocumentError::StaleHandle);
        }
        let revision = self.next_revision()?;
        self.occurrences[handle.slot] = None;
        self.revision = revision;
        Ok(())
    }

    /// Both operands are already in the same local coordinate frame. Relative
    /// occurrence transforms must be resolved explicitly before admission.
    pub fn prepare_boolean(
        &self,
        operation: BooleanOperation,
        left: DefinitionHandle,
        right: DefinitionHandle,
        contract: EvaluationContract,
    ) -> Result<BooleanRequest, DocumentError> {
        self.definition(left)?;
        self.definition(right)?;
        Ok(BooleanRequest {
            document: self.id,
            revision: self.revision,
            left,
            right,
            operation,
            contract,
        })
    }

    pub fn evaluate_exact(&self, request: &BooleanRequest) -> Result<EvaluatedMesh, DocumentError> {
        self.validate_request(request)?;
        if request.contract != EvaluationContract::ExactPolyhedral {
            return Err(DocumentError::UnsupportedContract);
        }
        let left = self.mesh(request.left)?;
        let right = self.mesh(request.right)?;
        let mesh = match request.operation {
            BooleanOperation::Difference => mesh_bridge::subtract(left, right),
            BooleanOperation::Union => mesh_bridge::union(left, right),
            BooleanOperation::Intersection => mesh_bridge::intersection(left, right),
        };
        if budget::tripped() {
            return Err(DocumentError::BudgetExceeded);
        }
        validation::validate_mesh(&mesh)?;
        Ok(EvaluatedMesh {
            request: *request,
            mesh,
        })
    }

    pub fn validate_result(&self, result: &EvaluatedMesh) -> Result<(), DocumentError> {
        self.validate_request(&result.request)
    }

    pub fn result_mesh<'a>(&self, result: &'a EvaluatedMesh) -> Result<&'a Mesh, DocumentError> {
        self.validate_result(result)?;
        Ok(&result.mesh)
    }

    /// Publishes validated output as another immutable reusable definition.
    pub fn publish_result(
        &mut self,
        source_entity_id: u32,
        result: &EvaluatedMesh,
    ) -> Result<DefinitionHandle, DocumentError> {
        self.validate_result(result)?;
        self.add_mesh_definition(source_entity_id, result.mesh.clone())
    }

    fn definition(&self, handle: DefinitionHandle) -> Result<&Definition, DocumentError> {
        self.check_document(handle.document)?;
        self.definitions
            .get(handle.slot)
            .and_then(Option::as_ref)
            .filter(|definition| definition.generation == handle.generation)
            .ok_or(DocumentError::StaleHandle)
    }

    fn check_document(&self, id: DocumentId) -> Result<(), DocumentError> {
        if id == self.id {
            Ok(())
        } else {
            Err(DocumentError::WrongDocument)
        }
    }

    fn validate_request(&self, request: &BooleanRequest) -> Result<(), DocumentError> {
        self.check_document(request.document)?;
        if request.revision != self.revision {
            return Err(DocumentError::StaleRevision);
        }
        self.definition(request.left)?;
        self.definition(request.right)?;
        Ok(())
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
