// SPDX-License-Identifier: MPL-2.0
//! Opt-in retained authored-extrusion requests for a model.
//!
//! Re-reads the model's authored `IfcExtrudedAreaSolid` sources with original
//! records captured, admits each supported source into its own
//! [`GeometryDocument`] and keeps the placed occurrences that can host it.
//! Ordinary loads never call this; its walk and memory cost are opt-in.
//!
//! Strictly source-only: a request describes the raw authored solid. Openings,
//! enclosing booleans, styles and other representation items are never
//! applied, so a published retained display is not final product geometry.
//! Every source or occurrence outside the supported family is listed in
//! [`RetainedExtrusionSources::refused`] with its reason, never dropped
//! silently or replaced by a tessellated mesh.

use crate::{extract_extrusion_definitions, AnalyticSourceKey, ExtrusionInstance};
use ifc_lite_geometry::analytic::{with_source_capture, AnalyticStatus};
use ifc_lite_geometry::document::{
    DefinitionHandle, GeometryDocument, OccurrenceHandle, RegionQualification, RetainedCompletion,
    RetainedDefinitionHandle, RetainedDisplayContract, RetainedExtrusion, RetainedRefusal,
    RetainedRequest,
};
use nalgebra::Matrix4;
use std::collections::{BTreeMap, HashSet};

/// Orthonormality and unit-determinant budget for a composed world placement.
/// Unit: dimensionless. Mapping operators with scale are refused, not absorbed.
const WORLD_RIGID_EPS: f64 = 1e-9;

/// Why a source or one of its occurrences is outside the retained family.
#[derive(Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum RetainedExtrusionRefusal {
    /// The geometry document refused the authored source itself.
    Source(RetainedRefusal),
    /// The solid is an operand of an enclosing boolean; publishing the raw
    /// operand as the product's shape would be false.
    EnclosingBooleanUnevaluated,
    /// The analytic walk could not resolve this occurrence or its placement.
    OccurrenceUnsupported(String),
    /// The composed world placement is not a proper rigid motion.
    UnqualifiedOccurrenceTransform,
}

/// A refused source (`product_id` is `None`) or a refused occurrence of it.
#[derive(Debug)]
pub struct RefusedExtrusion {
    pub key: AnalyticSourceKey,
    pub product_id: Option<u32>,
    pub refusal: RetainedExtrusionRefusal,
}

/// One admitted placement of a retained source.
#[derive(Debug, Clone)]
pub struct RetainedExtrusionOccurrence {
    pub product_id: u32,
    /// Family-local ordinal from [`ExtrusionInstance::ordinal`].
    pub ordinal: usize,
    /// Row-major evaluation metres -> absolute IFC Z-up world metres. This is
    /// not [`crate::ProcessingResult::frame`].
    pub world_from_evaluation: [f64; 16],
}

/// A display mesh published from one completion, placed at every occurrence.
#[derive(Debug)]
pub struct PublishedRetainedDisplay {
    pub definition: DefinitionHandle,
    /// `(product_id, occurrence)` in [`RetainedExtrusionSource::occurrences`] order.
    pub occurrences: Vec<(u32, OccurrenceHandle)>,
}

/// One supported authored source, its own document and its admitted placements.
#[derive(Debug)]
pub struct RetainedExtrusionSource {
    key: AnalyticSourceKey,
    document: GeometryDocument,
    definition: RetainedDefinitionHandle,
    occurrences: Vec<RetainedExtrusionOccurrence>,
}

impl RetainedExtrusionSource {
    pub fn key(&self) -> &AnalyticSourceKey {
        &self.key
    }
    /// Retained source, encoded request and any published display meshes.
    pub fn document(&self) -> &GeometryDocument {
        &self.document
    }
    pub fn definition(&self) -> RetainedDefinitionHandle {
        self.definition
    }
    pub fn occurrences(&self) -> &[RetainedExtrusionOccurrence] {
        &self.occurrences
    }

    /// The runtime capability needed to evaluate this source.
    pub fn qualification(&self) -> Result<RegionQualification, RetainedRefusal> {
        Ok(self
            .document
            .retained_payload(self.definition)?
            .qualification)
    }

    /// Request for the worker incarnation the caller selected (never 0).
    pub fn prepare(&self, worker_incarnation: u64) -> Result<RetainedRequest, RetainedRefusal> {
        self.document
            .prepare_retained_extrusion(self.definition, worker_incarnation)
    }

    /// Publishes a completion as one display definition placed at every
    /// admitted occurrence. Atomic: a refusal changes nothing and the caller
    /// keeps the completion. Publication makes other outstanding requests of
    /// this source stale.
    pub fn publish_display(
        &mut self,
        completion: &RetainedCompletion,
        live_worker_incarnation: u64,
        contract: RetainedDisplayContract,
    ) -> Result<PublishedRetainedDisplay, RetainedRefusal> {
        let placements: Vec<_> = self
            .occurrences
            .iter()
            .map(|occurrence| (occurrence.product_id, occurrence.world_from_evaluation))
            .collect();
        let (definition, handles) = self.document.publish_retained_display(
            completion,
            live_worker_incarnation,
            contract,
            &placements,
        )?;
        let occurrences = placements
            .iter()
            .zip(handles)
            .map(|(&(product_id, _), handle)| (product_id, handle))
            .collect();
        Ok(PublishedRetainedDisplay {
            definition,
            occurrences,
        })
    }
}

/// Every retained request source of one model, admitted or refused.
#[derive(Debug)]
pub struct RetainedExtrusionSources {
    pub model_sha256: String,
    /// Raw IFC file length unit -> metres.
    pub length_unit_scale: f64,
    pub admitted: Vec<RetainedExtrusionSource>,
    pub refused: Vec<RefusedExtrusion>,
    /// Representation walk diagnostics; affected products have no sources.
    pub diagnostics: Vec<String>,
}

impl RetainedExtrusionSources {
    /// Walk the model's authored extrusions, optionally only for the given
    /// product STEP IDs (`Some(empty)` returns nothing). No geometry is
    /// evaluated and nothing is tessellated.
    pub fn extract(content: &[u8], ids: Option<&HashSet<u32>>) -> Self {
        let definitions = with_source_capture(|| extract_extrusion_definitions(content, ids));
        let mut by_source: BTreeMap<AnalyticSourceKey, Vec<ExtrusionInstance>> = BTreeMap::new();
        for instance in definitions.instances.into_values().flatten() {
            by_source
                .entry(instance.source.clone())
                .or_default()
                .push(instance);
        }
        let mut sources = Self {
            model_sha256: definitions.model_sha256,
            length_unit_scale: definitions.length_unit_scale,
            admitted: Vec::new(),
            refused: Vec::new(),
            diagnostics: definitions.diagnostics,
        };
        for definition in definitions.sources {
            let instances = by_source.remove(&definition.key).unwrap_or_default();
            let recipe = RetainedExtrusion {
                source: definition.source,
                length_unit_scale: sources.length_unit_scale,
            };
            sources.admit(definition.key, recipe, instances);
        }
        sources
    }

    fn admit(
        &mut self,
        key: AnalyticSourceKey,
        recipe: RetainedExtrusion,
        instances: Vec<ExtrusionInstance>,
    ) {
        let mut document = GeometryDocument::new();
        let admitted = document
            .add_retained_extrusion(recipe)
            .map_err(RetainedRefusal::from)
            .and_then(|definition| Ok((definition, document.retained_payload(definition)?)));
        let (definition, source_from_evaluation) = match admitted {
            Ok((definition, payload)) => (definition, payload.source_from_evaluation),
            Err(refusal) => {
                self.refused.push(RefusedExtrusion {
                    key,
                    product_id: None,
                    refusal: RetainedExtrusionRefusal::Source(refusal),
                });
                return;
            }
        };
        let mut occurrences = Vec::with_capacity(instances.len());
        for instance in instances {
            match occurrence(&instance, &source_from_evaluation) {
                Ok(world_from_evaluation) => occurrences.push(RetainedExtrusionOccurrence {
                    product_id: instance.product_id,
                    ordinal: instance.ordinal,
                    world_from_evaluation,
                }),
                Err(refusal) => self.refused.push(RefusedExtrusion {
                    key: key.clone(),
                    product_id: Some(instance.product_id),
                    refusal,
                }),
            }
        }
        // A source with no placeable occurrence has nothing to publish; its
        // occurrence refusals above already explain why.
        if !occurrences.is_empty() {
            self.admitted.push(RetainedExtrusionSource {
                key,
                document,
                definition,
                occurrences,
            });
        }
    }
}

fn occurrence(
    instance: &ExtrusionInstance,
    source_from_evaluation: &[f64; 16],
) -> Result<[f64; 16], RetainedExtrusionRefusal> {
    if let AnalyticStatus::Unsupported(reason) = &instance.status {
        return Err(RetainedExtrusionRefusal::OccurrenceUnsupported(
            reason.clone(),
        ));
    }
    if instance.source_modified {
        return Err(RetainedExtrusionRefusal::EnclosingBooleanUnevaluated);
    }
    let world_from_source = instance.world_from_source.ok_or_else(|| {
        RetainedExtrusionRefusal::OccurrenceUnsupported("occurrence placement unavailable".into())
    })?;
    let world = Matrix4::from_column_slice(&world_from_source)
        * Matrix4::from_column_slice(source_from_evaluation);
    let orthonormal = (0..3).all(|i| {
        (0..3).all(|j| {
            let dot = (0..3).map(|k| world[(k, i)] * world[(k, j)]).sum::<f64>();
            (dot - if i == j { 1.0 } else { 0.0 }).abs() < WORLD_RIGID_EPS
        })
    });
    if world.iter().any(|value| !value.is_finite())
        || !orthonormal
        || (world.fixed_view::<3, 3>(0, 0).determinant() - 1.0).abs() > WORLD_RIGID_EPS
        || world.fixed_view::<1, 4>(3, 0) != nalgebra::RowVector4::new(0.0, 0.0, 0.0, 1.0)
    {
        return Err(RetainedExtrusionRefusal::UnqualifiedOccurrenceTransform);
    }
    Ok(std::array::from_fn(|i| world[(i / 4, i % 4)]))
}
