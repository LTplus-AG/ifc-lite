// SPDX-License-Identifier: MPL-2.0
//! Retained authored-source requests, kept apart from display meshes.
//!
//! A retained definition owns one captured authored extrusion plus its encoded
//! numerical request ([`SweepPayload`]). It is never a mesh and never enters
//! [`GeometryDocument::mesh`]. The only way from a retained definition to a
//! mesh is [`GeometryDocument::publish_retained_display`], which admits a
//! worker's tessellation as an ordinary display-approximation definition.

use super::retained_sweep::{self, SweepPayload};
use super::{
    validation, DefinitionHandle, DocumentError, DocumentId, GeometryDocument, OccurrenceHandle,
};
use crate::analytic::{AnalyticExtrusion, AnalyticStatus, ProfileLoopKind};
use std::sync::Arc;

/// A retained source definition owned by exactly one [`GeometryDocument`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct RetainedDefinitionHandle {
    document: DocumentId,
    slot: usize,
}

/// One authored `IfcExtrudedAreaSolid`, extracted inside
/// [`crate::analytic::with_source_capture`] so its original records survive.
/// Coefficients stay in raw IFC file length units; nothing is sampled.
#[derive(Debug, Clone, PartialEq)]
pub struct RetainedExtrusion {
    pub source: AnalyticExtrusion,
    /// Raw IFC file length unit -> metres.
    pub length_unit_scale: f64,
}

/// Every refusal of the retained contract. A refused call leaves the document
/// and its revision unchanged; a refused completion is never published.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[non_exhaustive]
pub enum RetainedRefusal {
    /// The source is outside the encodable numerical domain or inconsistent.
    #[error("invalid retained source: {0}")]
    InvalidSource(&'static str),
    /// The analytic extractor already refused this source family or record.
    #[error("unsupported retained source: {0}")]
    UnsupportedSource(String),
    /// Extracted without [`crate::analytic::with_source_capture`]: the original
    /// trim, sense and placement records are unavailable, so nothing is retained.
    #[error("original authored source records were not captured")]
    SourceNotCaptured,
    /// Worker incarnation 0, or a completion from a worker other than the live one.
    #[error("completion does not belong to the live worker incarnation")]
    WrongWorker,
    /// The completion's evaluation frame differs from the request's frame.
    #[error("completion frame does not match the request")]
    FrameMismatch,
    #[error("invalid retained tessellation: {0}")]
    InvalidTessellation(&'static str),
    /// Revision-local worker faces are not persistent IFC face identities.
    #[error("persistent IFC face provenance is unavailable")]
    PersistentFaceProvenanceUnavailable,
    /// Flat corner normals are not smooth analytic surface normals.
    #[error("analytic surface normals are unavailable")]
    AnalyticNormalsUnavailable,
    /// No style, material or texture is attributed to a retained display.
    #[error("IFC appearance is unavailable")]
    IfcAppearanceUnavailable,
    #[error(transparent)]
    Document(#[from] DocumentError),
}

/// What a caller wants a retained display mesh to mean. Only
/// [`Self::UnstyledFlatSourceOnly`] is supported; every other claim is refused
/// with its own [`RetainedRefusal`] rather than silently downgraded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum RetainedDisplayContract {
    /// Flat-shaded, unstyled tessellation of the raw authored solid only. No
    /// enclosing boolean, opening, style or persistent face identity applies.
    UnstyledFlatSourceOnly,
    PersistentIfcFaces,
    AnalyticSurfaceNormals,
    IfcAppearance,
}

#[derive(Debug)]
pub(super) struct RetainedEntry {
    recipe: RetainedExtrusion,
    payload: SweepPayload,
}

/// An immutable snapshot of one retained definition for one worker.
///
/// It is valid only while the document stays at the revision it was prepared
/// at and only for the worker incarnation it names: any document mutation, or
/// a worker restart, makes its completion unpublishable. Nothing replays it
/// implicitly. It describes the raw authored solid only, never enclosing CSG
/// or openings.
#[derive(Debug, Clone)]
pub struct RetainedRequest {
    document: DocumentId,
    revision: u64,
    definition: RetainedDefinitionHandle,
    worker_incarnation: u64,
    entry: Arc<RetainedEntry>,
}

impl RetainedRequest {
    pub fn definition(&self) -> RetainedDefinitionHandle {
        self.definition
    }
    /// Document revision this request was prepared at.
    pub fn document_revision(&self) -> u64 {
        self.revision
    }
    pub fn worker_incarnation(&self) -> u64 {
        self.worker_incarnation
    }
    pub fn recipe(&self) -> &RetainedExtrusion {
        &self.entry.recipe
    }
    /// The encoded request a worker evaluates.
    pub fn payload(&self) -> &SweepPayload {
        &self.entry.payload
    }
}

/// A worker's owned f64 result. Flat corner normals and revision-local faces
/// stay distinct from smooth analytic shading and persistent IFC faces.
/// Positions are in the request's evaluation frame (metres).
#[derive(Debug, Clone)]
pub struct RetainedTessellation {
    pub positions: Vec<f64>,
    pub indices: Vec<u32>,
    /// Three components per triangle corner, not per vertex.
    pub flat_corner_normals: Vec<f64>,
    /// One worker-local face index per triangle, below `source_face_count`.
    pub revision_local_faces: Vec<u32>,
    pub source_face_count: u32,
    /// Open boundary and non-manifold spine edge counts; both must be zero.
    pub boundary_edges: u32,
    pub spine_edges: u32,
}

/// A worker completion for one request, with the frame the worker used.
#[derive(Debug)]
pub struct RetainedCompletion {
    request: RetainedRequest,
    pub tessellation: RetainedTessellation,
    /// Column-major evaluation metres -> raw solid-local file units.
    pub source_from_evaluation: [f64; 16],
    pub evaluation_from_source: [f64; 16],
}

impl RetainedCompletion {
    /// Host-trusted assembly: this does not authenticate the buffers or the
    /// runtime that produced them; the document only checks identity and shape.
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
    /// Encodes and retains one captured authored extrusion. Refuses every
    /// source the request encoding cannot represent exactly; see
    /// [`RetainedRefusal`] and [`SweepPayload`] for the supported families.
    pub fn add_retained_extrusion(
        &mut self,
        recipe: RetainedExtrusion,
    ) -> Result<RetainedDefinitionHandle, RetainedRefusal> {
        let payload = retained_sweep::lower(&recipe)?;
        let revision = self.next_revision()?;
        let handle = RetainedDefinitionHandle {
            document: self.id,
            slot: self.retained.len(),
        };
        self.retained
            .push(Arc::new(RetainedEntry { recipe, payload }));
        self.revision = revision;
        Ok(handle)
    }

    pub fn retained_extrusion(
        &self,
        handle: RetainedDefinitionHandle,
    ) -> Result<&RetainedExtrusion, DocumentError> {
        Ok(&self.retained_entry(handle)?.recipe)
    }

    pub fn retained_payload(
        &self,
        handle: RetainedDefinitionHandle,
    ) -> Result<&SweepPayload, DocumentError> {
        Ok(&self.retained_entry(handle)?.payload)
    }

    /// Snapshots `definition` for the worker incarnation the caller selected.
    pub fn prepare_retained_extrusion(
        &self,
        definition: RetainedDefinitionHandle,
        worker_incarnation: u64,
    ) -> Result<RetainedRequest, RetainedRefusal> {
        if worker_incarnation == 0 {
            return Err(RetainedRefusal::WrongWorker);
        }
        Ok(RetainedRequest {
            document: self.id,
            revision: self.revision,
            definition,
            worker_incarnation,
            entry: Arc::clone(self.retained_entry(definition)?),
        })
    }

    /// Host-trusted bookkeeping check, not origin authentication: the caller
    /// states which worker incarnation it observes as live.
    pub fn validate_retained_completion(
        &self,
        packet: &RetainedCompletion,
        live_worker_incarnation: u64,
    ) -> Result<(), RetainedRefusal> {
        let request = &packet.request;
        self.check_document(request.document)?;
        if live_worker_incarnation == 0 || request.worker_incarnation != live_worker_incarnation {
            return Err(RetainedRefusal::WrongWorker);
        }
        if request.revision != self.revision {
            return Err(DocumentError::StaleRevision.into());
        }
        // Retained entries are immutable, so the revision check above also
        // pins the request's recipe and payload.
        let current = self.retained_entry(request.definition)?;
        if packet.source_from_evaluation != current.payload.source_from_evaluation
            || packet.evaluation_from_source != current.payload.evaluation_from_source
        {
            return Err(RetainedRefusal::FrameMismatch);
        }
        Ok(())
    }

    /// Deliberate, atomic retained -> display conversion. Validates the
    /// completion, the display claim, the narrowed mesh, every occurrence
    /// (row-major, evaluation frame -> caller's model frame) and the revision
    /// budget before changing anything. The result is an ordinary display
    /// definition attributed to the solid: a display approximation, never
    /// authored geometry. Publishing advances the revision, so every other
    /// outstanding request of this document becomes stale.
    pub fn publish_retained_display(
        &mut self,
        packet: &RetainedCompletion,
        live_worker_incarnation: u64,
        contract: RetainedDisplayContract,
        occurrences: &[(u32, [f64; 16])],
    ) -> Result<(DefinitionHandle, Vec<OccurrenceHandle>), RetainedRefusal> {
        match contract {
            RetainedDisplayContract::UnstyledFlatSourceOnly => {}
            RetainedDisplayContract::PersistentIfcFaces => {
                return Err(RetainedRefusal::PersistentFaceProvenanceUnavailable)
            }
            RetainedDisplayContract::AnalyticSurfaceNormals => {
                return Err(RetainedRefusal::AnalyticNormalsUnavailable)
            }
            RetainedDisplayContract::IfcAppearance => {
                return Err(RetainedRefusal::IfcAppearanceUnavailable)
            }
        }
        self.validate_retained_completion(packet, live_worker_incarnation)?;
        let mesh = super::retained_display::display_mesh(&packet.tessellation)?;
        validation::validate_mesh(&mesh)?;
        for (_, transform) in occurrences {
            validation::validate_transform(transform)?;
        }
        let additions = u64::try_from(occurrences.len())
            .ok()
            .and_then(|count| count.checked_add(1))
            .ok_or(DocumentError::RevisionExhausted)?;
        self.revision
            .checked_add(additions)
            .ok_or(DocumentError::RevisionExhausted)?;
        let solid_id = packet.request.entry.recipe.source.solid_id;
        let definition = self.add_mesh_definition(solid_id, mesh)?;
        let mut handles = Vec::with_capacity(occurrences.len());
        for &(entity_id, transform) in occurrences {
            handles.push(self.add_occurrence(definition, entity_id, transform)?);
        }
        Ok((definition, handles))
    }

    fn retained_entry(
        &self,
        handle: RetainedDefinitionHandle,
    ) -> Result<&Arc<RetainedEntry>, DocumentError> {
        self.check_document(handle.document)?;
        self.retained
            .get(handle.slot)
            .ok_or(DocumentError::WrongDocument)
    }
}

/// Strict source admission: complete extraction, captured original records,
/// outer-then-inner loops and bounded size. Numerical checks follow in lowering.
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
    let original = source
        .source
        .as_ref()
        .ok_or(RetainedRefusal::SourceNotCaptured)?;
    if let AnalyticStatus::Unsupported(reason) = &original.capture_status {
        return Err(RetainedRefusal::UnsupportedSource(format!(
            "original solid capture: {reason}"
        )));
    }
    if original.root_entity_id != source.solid_id
        || !original.records.contains_key(&source.solid_id)
    {
        return Err(RetainedRefusal::InvalidSource(
            "invalid original solid metadata",
        ));
    }
    let profile = source
        .profile
        .as_ref()
        .ok_or(RetainedRefusal::InvalidSource("missing profile"))?;
    if let AnalyticStatus::Unsupported(reason) = &profile.status {
        return Err(RetainedRefusal::UnsupportedSource(reason.clone()));
    }
    if profile.loops.is_empty() || profile.loops.len() > retained_sweep::MAX_LOOPS {
        return Err(RetainedRefusal::InvalidSource(
            "invalid bounded region loop count",
        ));
    }
    let mut count = 0;
    for (index, boundary) in profile.loops.iter().enumerate() {
        let expected = if index == 0 {
            ProfileLoopKind::Outer
        } else {
            ProfileLoopKind::Inner
        };
        if boundary.kind != expected {
            return Err(RetainedRefusal::InvalidSource(
                "expected outer then inner boundaries",
            ));
        }
        if boundary.segments.is_empty()
            || boundary.segments.len() > retained_sweep::MAX_SEGMENTS - count
        {
            return Err(RetainedRefusal::InvalidSource(
                "curve count exceeds bounded recipe",
            ));
        }
        count += boundary.segments.len();
        let original = boundary
            .source
            .as_ref()
            .ok_or(RetainedRefusal::SourceNotCaptured)?;
        if let AnalyticStatus::Unsupported(reason) = &original.capture_status {
            return Err(RetainedRefusal::UnsupportedSource(format!(
                "original boundary capture: {reason}"
            )));
        }
        if !original.plane_angle_to_radians.is_finite()
            || original.plane_angle_to_radians <= 0.0
            || !original.records.contains_key(&original.root_entity_id)
        {
            return Err(RetainedRefusal::InvalidSource(
                "invalid original boundary metadata",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "retained_tests.rs"]
mod tests;
