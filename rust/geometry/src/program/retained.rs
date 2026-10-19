// SPDX-License-Identifier: MPL-2.0
//! Logical admission in the reached common program. No runtime authority lives here.
use super::{GeometryProgram, ProgramError};
use crate::document::{RetainedConstruction, RetainedExtrusion, RetainedSweptDisk};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetainedContract {
    pub source_epoch: u64,
    pub source_revision: u64,
}

/// A common occurrence identity, unrelated to STEP ids, authored ordinals or SDK slots.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct LogicalRetainedSlot {
    program: u64,
    occurrence: u64,
}
#[derive(Debug, Clone, PartialEq)]
pub struct LogicalRetainedValue {
    slot: LogicalRetainedSlot,
    source_from_evaluation: [f64; 16],
    evaluation_from_source: [f64; 16],
}
impl LogicalRetainedValue {
    pub fn slot(&self) -> LogicalRetainedSlot {
        self.slot
    }
    pub fn source_from_evaluation(&self) -> &[f64; 16] {
        &self.source_from_evaluation
    }
    pub fn evaluation_from_source(&self) -> &[f64; 16] {
        &self.evaluation_from_source
    }
}
/// Immutable original source, captured before any sampled constructor is lowered.
#[derive(Debug, Clone)]
pub struct RetainedPlanOperation {
    pub(super) value: LogicalRetainedValue,
    pub(super) construction: RetainedConstruction,
}
impl RetainedPlanOperation {
    pub fn value(&self) -> &LogicalRetainedValue {
        &self.value
    }
    pub fn construction(&self) -> &RetainedConstruction {
        &self.construction
    }
}
/// Traversal completion is explicitly NOT final-net or runtime completion.
#[derive(Debug)]
pub struct RetainedProductPlan {
    pub values: Vec<LogicalRetainedValue>,
    pub remaining: Vec<RetainedRequirement>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetainedRequirement {
    ProductPlacement,
    OpeningClosure,
    MaterialLayers,
    IfcAppearance,
    PersistentFaces,
}

pub(crate) enum ItemValue {
    Mesh(crate::Mesh),
    Retained(LogicalRetainedValue),
}
impl ItemValue {
    pub(super) fn into_mesh(self) -> crate::Result<crate::Mesh> {
        match self {
            Self::Mesh(mesh) => Ok(mesh),
            Self::Retained(_) => Err(crate::Error::geometry(
                "retained value cannot enter exact mesh evaluation",
            )),
        }
    }
}
impl GeometryProgram {
    /// Explicit logical contract on the same product/representation admissions.
    /// Processing alone may bind sealed runtime results to its admitted slots.
    pub fn retained_parts(element: DecodedEntity, contract: RetainedContract) -> Self {
        let mut program = Self::parts(element);
        program.retained = Some(contract);
        program
            .product
            .as_mut()
            .expect("product root")
            .select_retained(contract);
        program
    }
    pub fn finish_retained(self) -> crate::Result<RetainedProductPlan> {
        if self.pending.is_some() {
            return Err(crate::Error::geometry("retained request outstanding"));
        }
        match self.outcome {
            Some(Ok(super::inner::GeometryOutput::Retained(values))) => Ok(RetainedProductPlan {
                values,
                remaining: vec![
                    RetainedRequirement::ProductPlacement,
                    RetainedRequirement::OpeningClosure,
                    RetainedRequirement::MaterialLayers,
                    RetainedRequirement::IfcAppearance,
                    RetainedRequirement::PersistentFaces,
                ],
            }),
            Some(Err(error)) => Err(error),
            _ => Err(crate::Error::geometry("retained product incomplete")),
        }
    }
    pub(super) fn retained_item(item: DecodedEntity, contract: RetainedContract) -> Self {
        let mut program = Self::item(item, (0., 0., 0.));
        program.retained = Some(contract);
        program
    }
}

pub(super) fn capture(
    item: &DecodedEntity,
    decoder: &mut EntityDecoder<'_>,
    scale: f64,
    contract: RetainedContract,
    program: u64,
) -> crate::Result<RetainedPlanOperation> {
    let construction = match item.ifc_type {
        IfcType::IfcExtrudedAreaSolid => {
            RetainedConstruction::Extrusion(Box::new(RetainedExtrusion {
                source: crate::analytic::extract_analytic_extrusion(item, decoder),
                length_unit_scale: scale,
                source_epoch: contract.source_epoch,
                source_revision: contract.source_revision,
            }))
        }
        IfcType::IfcSweptDiskSolid => {
            RetainedConstruction::SweptDisk(Box::new(RetainedSweptDisk {
                solid_id: item.id,
                source: crate::analytic::extract_swept_disk(item, decoder)?,
                length_unit_scale: scale,
                source_epoch: contract.source_epoch,
                source_revision: contract.source_revision,
            }))
        }
        _ => {
            return Err(crate::document::RetainedRefusal::UnsupportedSource(format!(
                "retained source contract: {}",
                item.ifc_type
            ))
            .into())
        }
    };
    let payload = construction.lower().map_err(crate::Error::from)?;
    Ok(RetainedPlanOperation {
        value: LogicalRetainedValue {
            slot: LogicalRetainedSlot {
                program,
                occurrence: 1,
            },
            source_from_evaluation: payload.source_from_evaluation,
            evaluation_from_source: payload.evaluation_from_source,
        },
        construction,
    })
}

pub(super) fn unsupported() -> ProgramError {
    ProgramError::UnsupportedRetained
}
