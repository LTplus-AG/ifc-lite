// SPDX-License-Identifier: MPL-2.0
//! Opt-in retained authored-source requests for a model.
//!
//! Re-reads the model's authored `IfcExtrudedAreaSolid` or `IfcSweptDiskSolid`
//! sources with original records captured, admits each supported source into
//! its own [`GeometryDocument`] and keeps the placed occurrences that can host
//! it. Ordinary loads never call this; its walk and memory cost are opt-in.
//!
//! Strictly source-only: a request describes the raw authored solid. Openings,
//! enclosing booleans, styles and other representation items are never
//! applied, so a published retained display is not final product geometry.
//! Every source or occurrence outside the supported family is listed in
//! [`RetainedSources::refused`] with its reason, never dropped
//! silently or replaced by a tessellated mesh.

use crate::{
    extract_extrusion_definitions, extract_swept_disk_definitions, AnalyticSourceKey,
    ExtrusionInstance, SweptDiskDefinition,
};
use ifc_lite_geometry::analytic::{with_source_capture, AnalyticStatus, AnalyticSweptDisk};
use ifc_lite_geometry::document::{
    DefinitionHandle, GeometryDocument, OccurrenceHandle, RegionQualification, RetainedCompletion,
    RetainedDefinitionHandle, RetainedDisplayContract, RetainedExtrusion, RetainedRefusal,
    RetainedRequest, RetainedSweptDisk,
};
use nalgebra::Matrix4;
use std::collections::{BTreeMap, HashSet};

/// Orthonormality and unit-determinant budget for a composed world placement.
/// Unit: dimensionless. Mapping operators with scale are refused, not absorbed.
const WORLD_RIGID_EPS: f64 = 1e-9;

/// Why a source or one of its occurrences is outside the retained family.
#[derive(Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum RetainedSourceRefusal {
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
pub struct RefusedSource {
    pub key: AnalyticSourceKey,
    pub product_id: Option<u32>,
    pub refusal: RetainedSourceRefusal,
}

/// One admitted placement of a retained source.
#[derive(Debug, Clone)]
pub struct RetainedOccurrence {
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
    /// `(product_id, occurrence)` in [`RetainedSource::occurrences`] order.
    pub occurrences: Vec<(u32, OccurrenceHandle)>,
}

/// One supported authored source, its own document and its admitted placements.
#[derive(Debug)]
pub struct RetainedSource {
    key: AnalyticSourceKey,
    document: GeometryDocument,
    definition: RetainedDefinitionHandle,
    occurrences: Vec<RetainedOccurrence>,
}

impl RetainedSource {
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
    pub fn occurrences(&self) -> &[RetainedOccurrence] {
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
            .prepare_retained(self.definition, worker_incarnation)
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
pub struct RetainedSources {
    pub model_sha256: String,
    /// Raw IFC file length unit -> metres.
    pub length_unit_scale: f64,
    pub admitted: Vec<RetainedSource>,
    pub refused: Vec<RefusedSource>,
    /// Representation walk diagnostics; affected products have no sources.
    pub diagnostics: Vec<String>,
}

impl RetainedSources {
    /// Walk the model's authored extrusions, optionally only for the given
    /// product STEP IDs (`Some(empty)` returns nothing). No geometry is
    /// evaluated and nothing is tessellated.
    pub fn extrusions(content: &[u8], ids: Option<&HashSet<u32>>) -> Self {
        let definitions = with_source_capture(|| extract_extrusion_definitions(content, ids));
        let mut sources = Self::new(
            definitions.model_sha256,
            definitions.length_unit_scale,
            definitions.diagnostics,
        );
        let mut placements = by_source(definitions.instances.into_values().flatten());
        for definition in definitions.sources {
            let recipe = RetainedExtrusion {
                source: definition.source,
                length_unit_scale: sources.length_unit_scale,
            };
            let placements = placements.remove(&definition.key).unwrap_or_default();
            let status = recipe.source.status.clone();
            sources.admit(definition.key, &status, placements, |document| {
                document.add_retained_extrusion(recipe)
            });
        }
        sources
    }

    /// Walk the model's authored swept disks, as [`Self::extrusions`] does.
    /// Only solid disks along one rational B-spline, line or partial arc are
    /// admitted (wire format 2); every other directrix is refused by name.
    pub fn swept_disks(content: &[u8], ids: Option<&HashSet<u32>>) -> Self {
        let definitions = with_source_capture(|| extract_swept_disk_definitions(content, ids));
        let mut sources = Self::new(
            definitions.model_sha256,
            definitions.length_unit_scale,
            definitions.diagnostics,
        );
        let mut placements = by_source(definitions.instances.into_values().flatten());
        for definition in definitions.sources {
            let recipe = swept_disk_recipe(&definition, sources.length_unit_scale);
            let placements = placements.remove(&definition.key).unwrap_or_default();
            sources.admit(definition.key, &definition.status, placements, |document| {
                document.add_retained_swept_disk(recipe)
            });
        }
        sources
    }

    fn new(model_sha256: String, length_unit_scale: f64, diagnostics: Vec<String>) -> Self {
        Self {
            model_sha256,
            length_unit_scale,
            admitted: Vec::new(),
            refused: Vec::new(),
            diagnostics,
        }
    }

    /// `source_status` is the source's line/arc interpretation status, which
    /// every occurrence inherits; only occurrence-specific failures refuse one.
    fn admit(
        &mut self,
        key: AnalyticSourceKey,
        source_status: &AnalyticStatus,
        placements: Vec<ExtrusionInstance>,
        retain: impl FnOnce(&mut GeometryDocument) -> Result<RetainedDefinitionHandle, RetainedRefusal>,
    ) {
        let mut document = GeometryDocument::new();
        let admitted = retain(&mut document).and_then(|definition| {
            let frame = document
                .retained_payload(definition)?
                .source_from_evaluation;
            Ok((definition, frame))
        });
        let (definition, source_from_evaluation) = match admitted {
            Ok(admitted) => admitted,
            Err(refusal) => {
                self.refused.push(RefusedSource {
                    key,
                    product_id: None,
                    refusal: RetainedSourceRefusal::Source(refusal),
                });
                return;
            }
        };
        let mut occurrences = Vec::with_capacity(placements.len());
        for placement in placements {
            match occurrence(&placement, source_status, &source_from_evaluation) {
                Ok(world_from_evaluation) => occurrences.push(RetainedOccurrence {
                    product_id: placement.product_id,
                    ordinal: placement.ordinal,
                    world_from_evaluation,
                }),
                Err(refusal) => self.refused.push(RefusedSource {
                    key: key.clone(),
                    product_id: Some(placement.product_id),
                    refusal,
                }),
            }
        }
        // A source with no placeable occurrence has nothing to publish; its
        // occurrence refusals above already explain why.
        if !occurrences.is_empty() {
            self.admitted.push(RetainedSource {
                key,
                document,
                definition,
                occurrences,
            });
        }
    }
}

/// Extrusion and swept-disk occurrences share one instance type.
fn by_source(
    instances: impl Iterator<Item = ExtrusionInstance>,
) -> BTreeMap<AnalyticSourceKey, Vec<ExtrusionInstance>> {
    let mut placements = BTreeMap::<AnalyticSourceKey, Vec<ExtrusionInstance>>::new();
    for instance in instances {
        placements
            .entry(instance.source.clone())
            .or_default()
            .push(instance);
    }
    placements
}

/// The definition carries every captured field of the extracted disk.
fn swept_disk_recipe(
    definition: &SweptDiskDefinition,
    length_unit_scale: f64,
) -> RetainedSweptDisk {
    RetainedSweptDisk {
        solid_id: definition.key.solid_id,
        source: AnalyticSweptDisk {
            directrix_id: definition.directrix_id,
            start_param: definition.start_param,
            end_param: definition.end_param,
            source: definition.source.clone(),
            owned_directrix: definition.owned_directrix.clone(),
            radius: definition.radius,
            inner_radius: definition.inner_radius,
            segments: definition.directrix.clone(),
            status: definition.status.clone(),
        },
        length_unit_scale,
    }
}

fn occurrence(
    instance: &ExtrusionInstance,
    source_status: &AnalyticStatus,
    source_from_evaluation: &[f64; 16],
) -> Result<[f64; 16], RetainedSourceRefusal> {
    // A rational disk directrix has no line/arc interpretation; the request
    // encodes its owned coefficients instead, so that inherited status is no
    // reason to refuse the placement.
    if let AnalyticStatus::Unsupported(reason) = &instance.status {
        if instance.status != *source_status {
            return Err(RetainedSourceRefusal::OccurrenceUnsupported(reason.clone()));
        }
    }
    if instance.source_modified {
        return Err(RetainedSourceRefusal::EnclosingBooleanUnevaluated);
    }
    let world_from_source = instance.world_from_source.ok_or_else(|| {
        RetainedSourceRefusal::OccurrenceUnsupported("occurrence placement unavailable".into())
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
        return Err(RetainedSourceRefusal::UnqualifiedOccurrenceTransform);
    }
    Ok(std::array::from_fn(|i| world[(i / 4, i % 4)]))
}
