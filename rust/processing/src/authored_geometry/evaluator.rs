// SPDX-License-Identifier: MPL-2.0
//! Opt-in, source-only authored execution and explicit geometry document consumer.
//! No loader, style resolver or default geometry emitter is replaced.
use super::{AuthoredDefinition, AuthoredGeometryPlan, AuthoredRecipe};
use crate::AnalyticSourceKey;
use ifc_lite_geometry::document::{
    DefinitionHandle, EvaluationContract, GeometryDocument, OccurrenceHandle, RetainedCompletion,
    RetainedDefinitionHandle, RetainedExtrusion, RetainedRefusal, RetainedRequest, RetainedConstruction, RetainedSweptDisk,
};
use nalgebra::Matrix4;
use std::collections::BTreeMap;

pub struct AuthoredRetainedDocument {
    document: GeometryDocument,
    definitions: BTreeMap<AnalyticSourceKey, RetainedDefinitionHandle>,
    occurrences: Vec<AuthoredRecipe>,
}

/// This display conversion has no IFC appearance attribution. A consumer needing
/// persistent surfaces, UVs, materials or smooth shading must use the canonical
/// production output until its provenance contract is qualified.
#[derive(Debug, Clone, Copy)]
pub enum RetainedDisplayContract {
    UnstyledFlatSourceOnly,
    PersistentIfcFaces,
    AnalyticSurfaceNormals,
    IfcAppearance,
}

type SourceTransforms = Vec<(u32, [f64; 16])>;

pub(super) struct DisplayPublication {
    pub definition: DefinitionHandle,
    pub occurrences: Vec<OccurrenceHandle>,
    pub transforms: SourceTransforms,
    pub product_id: u32,
}

pub struct PublishedAuthoredSource {
    pub product_id: u32,
    pub definition: DefinitionHandle,
    pub occurrence: OccurrenceHandle,
    /// Every mapped occurrence shares this one display definition.
    pub mapped_occurrences: Vec<(u32, OccurrenceHandle)>,
    /// Original f64 packet survives deliberate display narrowing.
    pub packet: RetainedCompletion,
}

#[derive(Debug)]
pub struct RejectedAuthoredSource {
    pub reason: RetainedRefusal,
    pub completion: Box<RetainedCompletion>,
}

impl AuthoredRetainedDocument {
    /// Host-trusted standalone adapter: the caller owns the plan and lifecycle
    /// bookkeeping. This does not authenticate model admission or runtime origin.
    /// Select one reached source key from an authored plan.
    /// Refused sources are errors, never an empty evaluated product. This owns
    /// every occurrence of the selected definition, but makes no final-net claim.
    pub fn admit_source(
        plan: &AuthoredGeometryPlan,
        key: &AnalyticSourceKey,
        source_epoch: u64,
        source_revision: u64,
    ) -> Result<Self, RetainedRefusal> {
        if key.model_sha256 != plan.model_sha256 {
            return Err(RetainedRefusal::InvalidSource("model identity mismatch"));
        }
        let source = plan
            .definitions
            .iter()
            .find(|definition| definition.key() == key)
            .ok_or(RetainedRefusal::InvalidSource(
                "authored definition unavailable",
            ))?;
        if key.length_unit_scale_bits != format!("{:016x}", plan.length_unit_scale.to_bits()) {
            return Err(RetainedRefusal::InvalidSource("source identity/unit mismatch"));
        }
        let recipe = match source {
            AuthoredDefinition::Extrusion(source) => {
                if source.source.solid_id != key.solid_id { return Err(RetainedRefusal::InvalidSource("solid identity mismatch")); }
                RetainedConstruction::Extrusion(Box::new(RetainedExtrusion { source:source.source.clone(),
                    length_unit_scale:plan.length_unit_scale, source_epoch, source_revision }))
            }
            AuthoredDefinition::SweptDisk(source) => RetainedConstruction::SweptDisk(Box::new(RetainedSweptDisk {
                solid_id:key.solid_id, source:source.owned_source(), length_unit_scale:plan.length_unit_scale,
                source_epoch, source_revision,
            })),
        };
        let mut document = GeometryDocument::new();
        let handle = document.add_retained_construction(recipe)?;
        let occurrences: Vec<_> = plan
            .recipes
            .iter()
            .filter(|recipe| &recipe.source == key)
            .cloned()
            .collect();
        if occurrences.is_empty() {
            return Err(RetainedRefusal::InvalidSource("no admitted occurrence"));
        }
        let frame = document.retained_construction(handle)?.lower()?;
        for occurrence in &occurrences {
            occurrence_frame(occurrence, &frame.source_from_evaluation)?;
        }
        Ok(Self {
            document,
            definitions: BTreeMap::from([(key.clone(), handle)]),
            occurrences,
        })
    }
    pub fn document(&self) -> &GeometryDocument {
        &self.document
    }
    pub fn document_mut(&mut self) -> &mut GeometryDocument {
        &mut self.document
    }
    pub fn prepare(
        &self,
        key: &AnalyticSourceKey,
        contract: EvaluationContract,
        incarnation: u64,
    ) -> Result<RetainedRequest, RetainedRefusal> {
        let handle = *self
            .definitions
            .get(key)
            .ok_or(RetainedRefusal::InvalidSource("source unavailable"))?;
        self.document
            .prepare_retained_extrusion(handle, contract, incarnation)
    }

    /// Host-trusted standalone publication, not a runtime-origin seal.
    /// Validation and all buffer conversion precede publication. Rejection gives
    /// the complete packet back. The caller retains the independent worker handle.
    pub fn publish_source(
        &mut self,
        completion: RetainedCompletion,
        occurrence_index: usize,
        live_incarnation: u64,
        contract: RetainedDisplayContract,
    ) -> Result<PublishedAuthoredSource, RejectedAuthoredSource> {
        let DisplayPublication { definition, occurrences, transforms, product_id } = match self.publish_borrowed(
            &completion, occurrence_index, live_incarnation, contract) {
            Ok(value) => value,
            Err(reason) => return Err(RejectedAuthoredSource { reason, completion: Box::new(completion) }),
        };
        Ok(PublishedAuthoredSource {
            product_id,
            definition,
            occurrence: occurrences[occurrence_index],
            mapped_occurrences: transforms
                .iter()
                .zip(occurrences)
                .map(|((id, _), handle)| (*id, handle))
                .collect(),
            packet: completion,
        })
    }
    pub(super) fn publish_borrowed(
        &mut self, completion: &RetainedCompletion, occurrence_index: usize,
        live_incarnation: u64, contract: RetainedDisplayContract,
    ) -> Result<DisplayPublication, RetainedRefusal> {
        let refusal = match contract {
            RetainedDisplayContract::UnstyledFlatSourceOnly => None,
            RetainedDisplayContract::PersistentIfcFaces => {
                Some(RetainedRefusal::PersistentFaceProvenanceUnavailable)
            }
            RetainedDisplayContract::AnalyticSurfaceNormals => {
                Some(RetainedRefusal::AnalyticNormalsUnavailable)
            }
            RetainedDisplayContract::IfcAppearance => {
                Some(RetainedRefusal::IfcAppearanceUnavailable)
            }
        };
        if let Some(reason) = refusal {
            return Err(reason);
        }
        let (transforms, product_id) = self.prepare_display(completion, occurrence_index, live_incarnation)?;
        let (definition, occurrences) = self.document
            .publish_retained_display(completion, live_incarnation, &transforms)?;
        Ok(DisplayPublication { definition, occurrences, transforms, product_id })
    }
    fn prepare_display(
        &self,
        packet: &RetainedCompletion,
        index: usize,
        live: u64,
    ) -> Result<(SourceTransforms, u32), RetainedRefusal> {
        self.document.validate_retained_completion(packet, live)?;
        let occurrence = self
            .occurrences
            .get(index)
            .ok_or(RetainedRefusal::InvalidSource("occurrence unavailable"))?;
        if self.definitions.get(&occurrence.source) != Some(&packet.request().definition()) {
            return Err(RetainedRefusal::InvalidSource("completion source mismatch"));
        }
        let mut transforms = Vec::with_capacity(self.occurrences.len());
        for occurrence in &self.occurrences {
            if self.definitions.get(&occurrence.source) != Some(&packet.request().definition()) {
                return Err(RetainedRefusal::InvalidSource(
                    "mapped completion source mismatch",
                ));
            }
            let transform = occurrence_frame(occurrence, &packet.source_from_evaluation)?;
            transforms.push((occurrence.product_id, transform));
        }
        Ok((transforms, occurrence.product_id))
    }
}

fn occurrence_frame(
    occurrence: &AuthoredRecipe,
    source_from_evaluation: &[f64; 16],
) -> Result<[f64; 16], RetainedRefusal> {
    let world = Matrix4::from_column_slice(&occurrence.world_from_source)
        * Matrix4::from_column_slice(source_from_evaluation);
    let rigid = (0..3).all(|i| {
        (0..3).all(|j| {
            let dot = (0..3).map(|k| world[(k, i)] * world[(k, j)]).sum::<f64>();
            (dot - if i == j { 1.0 } else { 0.0 }).abs() < 1e-9
        })
    });
    if world.iter().any(|value| !value.is_finite())
        || !rigid
        || (world.fixed_view::<3, 3>(0, 0).determinant() - 1.0).abs() > 1e-9
        || world[(3, 0)] != 0.0
        || world[(3, 1)] != 0.0
        || world[(3, 2)] != 0.0
        || world[(3, 3)] != 1.0
    {
        return Err(RetainedRefusal::UnqualifiedOccurrenceTransform);
    }
    Ok(std::array::from_fn(|i| world[(i / 4, i % 4)]))
}
