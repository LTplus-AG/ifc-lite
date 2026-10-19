// SPDX-License-Identifier: MPL-2.0
//! Replayable source ownership, separate from meshes, occurrences and worker tokens.
use super::{DocumentError, DocumentId, EvaluationContract, GeometryDocument, RetainedConstruction};
use crate::analytic::{AnalyticExtrusion, AnalyticStatus, ProfileLoopKind};
use std::sync::Arc;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetainedDefinitionHandle {
    document: DocumentId,
    slot: usize,
    generation: u64,
}

#[derive(Debug, Clone)]
pub struct RetainedExtrusion {
    /// Owned source coefficients and separate interpreted geometry in raw IFC
    /// length units; never sampled. Decoded values do not preserve STEP lexemes.
    pub source: AnalyticExtrusion,
    pub length_unit_scale: f64,
    pub source_epoch: u64,
    pub source_revision: u64,
}

impl RetainedExtrusion {
    /// Required execution evidence, independent of source storage/validity.
    /// A runtime must check its explicit qualification capability before evaluation.
    pub fn qualification_requirement(
        &self,
    ) -> Result<super::retained_sweep::RegionQualification, RetainedRefusal> {
        Ok(super::retained_sweep::lower(self)?.qualification)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum RetainedRefusal {
    Contract,
    InvalidSource(&'static str),
    UnsupportedSource(String),
    UnqualifiedRegion,
    UnqualifiedOccurrenceTransform,
    OriginalTrimConventionUnavailable,
    PersistentFaceProvenanceUnavailable,
    AnalyticNormalsUnavailable,
    IfcAppearanceUnavailable,
    InvalidRuntime,
    Document(DocumentError),
}
impl From<DocumentError> for RetainedRefusal {
    fn from(value: DocumentError) -> Self {
        Self::Document(value)
    }
}
impl std::fmt::Display for RetainedRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for RetainedRefusal {}

#[derive(Debug)]
pub(super) struct RetainedDefinition {
    generation: u64,
    recipe: Arc<RetainedConstruction>,
}

/// Source-only construction. This does not certify enclosing CSG/opening coverage.
#[derive(Debug, Clone)]
pub struct RetainedRequest {
    document: DocumentId,
    revision: u64,
    definition: RetainedDefinitionHandle,
    worker_incarnation: u64,
    recipe: Arc<RetainedConstruction>,
}
impl RetainedRequest {
    pub fn recipe(&self) -> &RetainedConstruction {
        &self.recipe
    }
    pub fn worker_incarnation(&self) -> u64 {
        self.worker_incarnation
    }
    pub fn definition(&self) -> RetainedDefinitionHandle {
        self.definition
    }
}

/// Owned numerical result. Flat corner normals and revision-local faces remain
/// distinct from smooth analytic shading and persistent IFC surface provenance.
#[derive(Debug)]
pub struct RetainedTessellation {
    pub positions: Vec<f64>,
    pub indices: Vec<u32>,
    pub flat_corner_normals: Vec<f64>,
    pub revision_local_faces: Vec<u32>,
    pub source_face_count: u32,
    pub boundary_edges: u32,
    pub spine_edges: u32,
}

#[derive(Debug)]
pub struct RetainedCompletion {
    request: RetainedRequest,
    pub tessellation: RetainedTessellation,
    /// Column-major evaluation metres -> original solid-local file units.
    pub source_from_evaluation: [f64; 16],
    pub evaluation_from_source: [f64; 16],
}
impl RetainedCompletion {
    /// Host-trusted assembly adapter. This constructor does not authenticate
    /// numerical buffers or runtime origin; canonical owners must seal results.
    pub fn new(
        request: RetainedRequest,
        tessellation: RetainedTessellation,
        source_from_evaluation: [f64; 16],
        evaluation_from_source: [f64; 16],
    ) -> Self {
        Self {
            request,
            tessellation,
            source_from_evaluation,
            evaluation_from_source,
        }
    }
    pub fn request(&self) -> &RetainedRequest {
        &self.request
    }
}

impl GeometryDocument {
    /// Atomic explicit display conversion: validate everything and reserve both
    /// revisions before changing document state. The f64 packet stays borrowed.
    pub fn publish_retained_display(
        &mut self,
        packet: &RetainedCompletion,
        live: u64,
        occurrences: &[(u32, [f64; 16])],
    ) -> Result<(super::DefinitionHandle, Vec<super::OccurrenceHandle>), RetainedRefusal> {
        self.validate_retained_completion(packet, live)?;
        let mesh = super::retained_display::display_mesh(packet)?;
        super::validation::validate_mesh(&mesh)?;
        for (_, transform) in occurrences {
            super::validation::validate_transform(transform)?;
        }
        let count = u64::try_from(occurrences.len())
            .ok()
            .and_then(|v| v.checked_add(1))
            .ok_or(DocumentError::RevisionExhausted)?;
        self.revision
            .checked_add(count)
            .ok_or(DocumentError::RevisionExhausted)?;
        let definition = self.add_mesh_definition(packet.request.recipe.solid_id(), mesh)?;
        let mut handles = Vec::with_capacity(occurrences.len());
        for &(product_id, transform) in occurrences {
            handles.push(self.add_occurrence(definition, product_id, transform)?);
        }
        Ok((definition, handles))
    }

    /// Host-trusted standalone snapshot admission, not model lifecycle authority.
    pub fn add_retained_extrusion(
        &mut self,
        recipe: RetainedExtrusion,
    ) -> Result<RetainedDefinitionHandle, RetainedRefusal> {
        self.add_retained_construction(RetainedConstruction::Extrusion(Box::new(recipe)))
    }

    pub fn add_retained_construction(&mut self, recipe: RetainedConstruction)
        -> Result<RetainedDefinitionHandle, RetainedRefusal>
    {
        recipe.lower()?;
        let revision = self.next_revision()?;
        let handle = RetainedDefinitionHandle {
            document: self.id,
            slot: self.retained.len(),
            generation: 1,
        };
        self.retained.push(Some(RetainedDefinition {
            generation: 1,
            recipe: Arc::new(recipe),
        }));
        self.revision = revision;
        Ok(handle)
    }

    pub fn retained_extrusion(
        &self,
        handle: RetainedDefinitionHandle,
    ) -> Result<&RetainedExtrusion, RetainedRefusal> {
        self.retained_construction(handle)?.extrusion()
            .ok_or(RetainedRefusal::InvalidSource("construction is not extrusion"))
    }

    pub fn retained_construction(&self, handle: RetainedDefinitionHandle)
        -> Result<&RetainedConstruction, RetainedRefusal>
    {
        Ok(self.retained_definition(handle)?.recipe.as_ref())
    }

    fn retained_definition(&self, handle: RetainedDefinitionHandle)
        -> Result<&RetainedDefinition, RetainedRefusal>
    {
        self.check_document(handle.document)?;
        self.retained.get(handle.slot).and_then(Option::as_ref)
            .filter(|definition| definition.generation == handle.generation)
            .ok_or(RetainedRefusal::Document(DocumentError::StaleHandle))
    }

    pub fn remove_retained_extrusion(
        &mut self,
        handle: RetainedDefinitionHandle,
    ) -> Result<(), RetainedRefusal> {
        self.retained_construction(handle)?;
        let revision = self.next_revision()?;
        self.retained[handle.slot] = None;
        self.revision = revision;
        Ok(())
    }

    pub fn prepare_retained_extrusion(
        &self,
        definition: RetainedDefinitionHandle,
        contract: EvaluationContract,
        worker_incarnation: u64,
    ) -> Result<RetainedRequest, RetainedRefusal> {
        if contract != EvaluationContract::RetainedBrep {
            return Err(RetainedRefusal::Contract);
        }
        if worker_incarnation == 0 {
            return Err(RetainedRefusal::InvalidRuntime);
        }
        Ok(RetainedRequest {
            document: self.id,
            revision: self.revision,
            definition,
            worker_incarnation,
            recipe: Arc::clone(&self.retained_definition(definition)?.recipe),
        })
    }

    /// Host-trusted bookkeeping check; neither origin authentication nor liveness
    /// observation. Caller supplies observed liveness and keeps rejected packets.
    /// A restart supplies a different live incarnation; no replay is implicit.
    pub fn validate_retained_completion(
        &self,
        packet: &RetainedCompletion,
        live_worker_incarnation: u64,
    ) -> Result<(), RetainedRefusal> {
        let request = &packet.request;
        self.check_document(request.document)?;
        if request.worker_incarnation != live_worker_incarnation || live_worker_incarnation == 0 {
            return Err(RetainedRefusal::InvalidRuntime);
        }
        if request.revision != self.revision {
            return Err(DocumentError::StaleRevision.into());
        }
        let current = self.retained_construction(request.definition)?;
        if current.revision() != request.recipe.revision()
        {
            return Err(DocumentError::StaleRevision.into());
        }
        let expected = current.lower()?;
        if packet.source_from_evaluation != expected.source_from_evaluation
            || packet.evaluation_from_source != expected.evaluation_from_source
        {
            return Err(RetainedRefusal::InvalidSource("completion frame mismatch"));
        }
        Ok(())
    }
}

pub(super) fn validate_source(recipe: &RetainedExtrusion) -> Result<(), RetainedRefusal> {
    if !recipe.length_unit_scale.is_finite() || recipe.length_unit_scale <= 0.0 {
        return Err(RetainedRefusal::InvalidSource(
            "invalid source length units",
        ));
    }
    let source = &recipe.source;
    if let AnalyticStatus::Unsupported(reason) = &source.status {
        return Err(RetainedRefusal::UnsupportedSource(reason.clone()));
    }
    let original = source.source.as_ref()
        .ok_or(RetainedRefusal::OriginalTrimConventionUnavailable)?;
    if let AnalyticStatus::Unsupported(reason) = &original.capture_status {
        return Err(RetainedRefusal::UnsupportedSource(format!("original solid capture: {reason}")));
    }
    if original.root_entity_id != source.solid_id || !original.records.contains_key(&source.solid_id) {
        return Err(RetainedRefusal::InvalidSource("invalid original solid metadata"));
    }
    let profile = source
        .profile
        .as_ref()
        .ok_or(RetainedRefusal::InvalidSource("missing profile"))?;
    if let AnalyticStatus::Unsupported(reason) = &profile.status {
        return Err(RetainedRefusal::UnsupportedSource(reason.clone()));
    }
    if profile.loops.is_empty() || profile.loops.len() > 128 {
        return Err(RetainedRefusal::InvalidSource("invalid bounded region loop count"));
    }
    let mut count = 0;
    for (index, boundary) in profile.loops.iter().enumerate() {
        let expected = if index == 0 { ProfileLoopKind::Outer } else { ProfileLoopKind::Inner };
        if boundary.kind != expected {
            return Err(RetainedRefusal::InvalidSource("expected outer then inner boundaries"));
        }
        if boundary.segments.is_empty() || boundary.segments.len() > 8192 - count {
            return Err(RetainedRefusal::InvalidSource("curve count exceeds bounded recipe"));
        }
        count += boundary.segments.len();
        let original = boundary.source.as_ref()
            .ok_or(RetainedRefusal::OriginalTrimConventionUnavailable)?;
        if let AnalyticStatus::Unsupported(reason) = &original.capture_status {
            return Err(RetainedRefusal::UnsupportedSource(format!("original boundary capture: {reason}")));
        }
        if !original.plane_angle_to_radians.is_finite()
            || original.plane_angle_to_radians <= 0.0
            || !original.records.contains_key(&original.root_entity_id)
        {
            return Err(RetainedRefusal::InvalidSource("invalid original boundary metadata"));
        }
    }
    Ok(())
}
