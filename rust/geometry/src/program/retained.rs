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
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct LogicalRetainedDefinition {
    program: u64,
    source_epoch: u64,
    source_revision: u64,
    source_id: u32,
}
/// Ordered immutable source-free operation lineage. Matrices are column-major,
/// object-local metres -> output-local metres; source file units stay separate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetainedPlacementStage { Mapping { source_id: u32 }, Product { product_id: u32 } }
#[derive(Debug, Clone, PartialEq)]
pub struct RetainedPlacement {
    pub input: LogicalRetainedSlot,
    pub output: LogicalRetainedSlot,
    pub stage: RetainedPlacementStage,
    pub matrix: [f64; 16],
}
#[derive(Debug, Clone, PartialEq)]
pub struct LogicalRetainedValue {
    definition: LogicalRetainedDefinition,
    length_unit_scale: f64,
    /// Inner-to-outer metre-domain mappings, followed by reached product placement.
    placements: Vec<RetainedPlacement>,
    product_placed: bool,
    slot: LogicalRetainedSlot,
    source_from_evaluation: [f64; 16],
    evaluation_from_source: [f64; 16],
}
impl LogicalRetainedValue {
    pub fn definition(&self) -> &LogicalRetainedDefinition { &self.definition }
    pub fn placements(&self) -> &[RetainedPlacement] { &self.placements }
    pub fn is_product_placed(&self) -> bool { self.product_placed }
    /// Evaluation metres -> file local -> metres -> ordered maps -> product world.
    /// This f64 analytic frame does not certify exact display rounding or RTC assembly.
    pub fn world_from_evaluation(&self) -> nalgebra::Matrix4<f64> {
        let mut frame = nalgebra::Matrix4::new_nonuniform_scaling(
            &nalgebra::Vector3::repeat(self.length_unit_scale))
            * nalgebra::Matrix4::from_column_slice(&self.source_from_evaluation);
        for placement in &self.placements {
            frame = nalgebra::Matrix4::from_column_slice(&placement.matrix) * frame;
        }
        frame
    }
    pub(super) fn placed(mut self, transform: &nalgebra::Matrix4<f64>, program: u64,
        stage: RetainedPlacementStage) -> crate::Result<Self> {
        proper_rigid(transform)?;
        crate::resource::charge(crate::resource::Cost { work: 1, occurrences: 1,
            ..Default::default() })?.retain();
        crate::resource::reserve_headers(&mut self.placements, 1)?.retain();
        let input=self.slot;
        {
            use std::sync::atomic::{AtomicU64, Ordering};
            static NEXT: AtomicU64 = AtomicU64::new(1);
            let occurrence = NEXT.fetch_update(Ordering::Relaxed, Ordering::Relaxed,
                |value| value.checked_add(1)).map_err(|_| crate::resource::overflow())?;
            self.slot = LogicalRetainedSlot { program, occurrence };
        }
        self.placements.push(RetainedPlacement { input, output:self.slot, stage,
            matrix:crate::math::mat4::col_major_array(transform) });
        self.product_placed |= matches!(stage,RetainedPlacementStage::Product {..});
        Ok(self)
    }

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
            Some(Ok(super::inner::GeometryOutput::Retained(values))) if values.iter().all(|v| v.product_placed) => Ok(RetainedProductPlan {
                values,
                remaining: vec![

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
    pub(super) fn retained_mapped(item: &DecodedEntity, contract: RetainedContract,
        router: &crate::GeometryRouter, cache: super::mapping::SharedRetainedCache) -> crate::Result<Self> {
        let mut program=Self::mapped_merged(item,router)?;
        program.retained=Some(contract);
        program.mapping.as_mut().expect("mapped root").select_retained(contract,cache);
        Ok(program)
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
            definition: LogicalRetainedDefinition { program, source_epoch: contract.source_epoch,
                source_revision: contract.source_revision, source_id: item.id },
            length_unit_scale: scale, placements: Vec::new(), product_placed: false,
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

/// Typed refusal until affine BRep and display frame semantics are qualified.
/// A logical occurrence never silently invokes mesh evaluation.
pub(super) fn proper_rigid(matrix: &nalgebra::Matrix4<f64>) -> crate::Result<()> {
    let linear = matrix.fixed_view::<3, 3>(0, 0);
    // Both residuals are dimensionless. The Frobenius norm bounds the WHOLE
    // Gram-matrix error (stricter than testing each dot product separately);
    // the determinant residual additionally excludes orthogonal reflections.
    // Reuse the retained source-placement rounding budget, not a length epsilon.
    let rounding = crate::math::tol::RETAINED_RIGID_DOT_EPS;
    if matrix.iter().any(|v| !v.is_finite())
        || matrix.row(3).iter().zip([0., 0., 0., 1.]).any(|(a,b)| *a != b)
        || (linear.transpose() * linear - nalgebra::Matrix3::identity()).norm() > rounding
        || (linear.determinant() - 1.).abs() > rounding {
        return Err(crate::document::RetainedRefusal::UnsupportedSource(
            "retained nonrigid placement requires qualified affine capability".into()).into());
    }
    Ok(())
}

/// A bounded copy of logical references; no runtime receipt or object is cloned.
pub(super) fn copy_values(values: &[LogicalRetainedValue]) -> crate::Result<Vec<LogicalRetainedValue>> {
    let mut output = Vec::new();
    crate::resource::reserve_headers(&mut output, values.len())?.retain();
    for value in values {
        crate::resource::charge(crate::resource::Cost { work: 1,
            copy_bytes: std::mem::size_of_val(value.placements.as_slice()) as u64,
            ..Default::default() })?.retain();
        let mut placements = Vec::new();
        crate::resource::reserve_headers(&mut placements, value.placements.len())?.retain();
        placements.extend_from_slice(&value.placements);
        output.push(LogicalRetainedValue { placements, ..value.clone_without_placements() });
    }
    Ok(output)
}
impl LogicalRetainedValue {
    fn clone_without_placements(&self) -> Self {
        Self { definition: self.definition.clone(), length_unit_scale: self.length_unit_scale,
            placements: Vec::new(), product_placed: self.product_placed, slot: self.slot,
            source_from_evaluation: self.source_from_evaluation,
            evaluation_from_source: self.evaluation_from_source }
    }
}
