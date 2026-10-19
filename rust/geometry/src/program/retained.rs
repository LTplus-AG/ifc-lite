// SPDX-License-Identifier: MPL-2.0
//! Logical admission in the reached common program. No runtime authority lives here.
use super::GeometryProgram;
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
pub enum LogicalRetainedDefinition {
    Source { slot: LogicalRetainedSlot, source_epoch: u64, source_revision: u64, source_id: u32 },
    Operation(LogicalRetainedSlot),
}
/// Ordered immutable source-free operation lineage. Matrices are column-major,
/// object-local metres -> output-local metres; source file units stay separate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetainedPlacementStage { TypeMap { representation_map: u32 }, Mapping { source_id: u32 }, Product { product_id: u32 } }
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
    presentation: Vec<super::retained_presentation::RetainedPresentation>,
    pub(super) empty: bool,
    slot: LogicalRetainedSlot,
    source_from_evaluation: [f64; 16],
    /// Runtime object local metres -> current logical local metres.
    object_frame: [f64; 16],
    world_from_source: [f64; 16],
    evaluation_from_source: [f64; 16],
}
impl LogicalRetainedValue {
    pub fn presentation(&self) -> &[super::retained_presentation::RetainedPresentation] { &self.presentation }
    pub(super) fn present(&mut self, binding: super::retained_presentation::RetainedPresentation) -> crate::Result<()> {
        crate::resource::charge(crate::resource::Cost {work:1,copy_bytes:std::mem::size_of_val(&binding) as u64,..Default::default()})?.retain();
        crate::resource::reserve_headers(&mut self.presentation, 1)?.retain();
        self.presentation.push(binding); Ok(())
    }
    pub fn try_copy(&self) -> crate::Result<Self> {
        Ok(copy_values(std::slice::from_ref(self))?.pop().expect("one logical value"))
    }
    pub fn is_empty(&self) -> bool { self.empty }
    pub fn definition(&self) -> &LogicalRetainedDefinition { &self.definition }
    pub fn placements(&self) -> &[RetainedPlacement] { &self.placements }
    pub fn is_product_placed(&self) -> bool { self.product_placed }
    /// Evaluation metres -> file local -> metres -> ordered maps -> product world.
    /// This f64 analytic frame does not certify exact display rounding or RTC assembly.
    pub fn world_from_evaluation(&self) -> nalgebra::Matrix4<f64> {
        nalgebra::Matrix4::from_column_slice(&self.object_frame)
    }
    /// Only a construction definition has an authored source frame. Operation
    /// outputs use their physical object frame and never acquire a fake recipe.
    pub fn world_from_source(&self) -> Option<&[f64;16]> {
        matches!(self.definition,LogicalRetainedDefinition::Source {..}).then_some(&self.world_from_source)
    }

    pub(super) fn placed(mut self, transform: &nalgebra::Matrix4<f64>, program: u64,
        stage: RetainedPlacementStage) -> crate::Result<Self> {
        self.place_in_place(transform,program,stage)?;Ok(self)
    }
    pub(super) fn place_in_place(&mut self,transform:&nalgebra::Matrix4<f64>,program:u64,
        stage:RetainedPlacementStage)->crate::Result<()> {
        validate_affine(transform)?;
        crate::resource::charge(crate::resource::Cost { work: 1, occurrences: 1,
            ..Default::default() })?.retain();
        crate::resource::reserve_headers(&mut self.placements, 1)?.retain();
        let input=self.slot;
        self.slot = next_slot(program)?;
        let matrix=crate::math::mat4::col_major_array(transform);
        if matches!(self.definition,LogicalRetainedDefinition::Source {..}) {
            self.world_from_source=multiply_frames(&matrix,&self.world_from_source);
            self.object_frame=multiply_frames(&self.world_from_source,&self.source_from_evaluation);
        } else {
            self.object_frame=multiply_frames(&matrix,&self.object_frame);
        }
        self.placements.push(RetainedPlacement { input, output:self.slot, stage,
            matrix:crate::math::mat4::col_major_array(transform) });
        self.product_placed |= matches!(stage,RetainedPlacementStage::Product {..});
        Ok(())
    }

    pub fn object_frame(&self) -> &[f64; 16] { &self.object_frame }
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
    pub(super) kind: RetainedOperationKind,
}
impl RetainedPlanOperation {
    pub fn value(&self) -> &LogicalRetainedValue {
        &self.value
    }
    pub fn construction(&self) -> Option<&RetainedConstruction> {
        match &self.kind { RetainedOperationKind::Construction(source) => Some(source), _ => None }
    }
    pub fn kind(&self) -> &RetainedOperationKind { &self.kind }
}
/// Ordered operation inputs are logical occurrences, never STEP ids or raw handles.
#[derive(Debug, Clone)]
pub enum RetainedOperationKind {
    Construction(RetainedConstruction),
    Affine { input: LogicalRetainedValue, matrix: [f64; 16] },
    Boolean { inputs: [LogicalRetainedValue; 2], operation: crate::document::BooleanOperation },
}
impl LogicalRetainedValue {
    /// A physical bake resets object-frame metadata but preserves analytic ancestry.
    pub(super) fn bake(&mut self) -> crate::Result<Option<RetainedPlanOperation>> {
        let matrix = nalgebra::Matrix4::from_column_slice(&self.object_frame);
        if proper_rigid(&matrix).is_ok() && !matches!(self.definition, LogicalRetainedDefinition::Operation(_)) { return Ok(None); }
        if matrix == nalgebra::Matrix4::identity() { return Ok(None); }
        validate_affine(&matrix)?;
        let input = copy_values(std::slice::from_ref(self))?.pop().expect("one value");
        self.slot = next_slot(self.slot.program)?;
        self.definition = LogicalRetainedDefinition::Operation(self.slot);
        self.object_frame = crate::math::mat4::col_major_array(&nalgebra::Matrix4::identity());
        Ok(Some(RetainedPlanOperation { value: copy_values(std::slice::from_ref(self))?
            .pop().expect("one output"), kind: RetainedOperationKind::Affine {
                input, matrix: crate::math::mat4::col_major_array(&matrix) } }))
    }
}
// Transpose the existing row-major primitive to column-major operands. This
// preserves its ordered f64 accumulation and avoids inverse-frame round trips.
fn multiply_frames(a:&[f64;16], b:&[f64;16]) -> [f64;16] {
    crate::math::mat4::mul(b,a)
}
pub(super) fn next_slot(program: u64) -> crate::Result<LogicalRetainedSlot> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let occurrence = NEXT.fetch_update(Ordering::Relaxed, Ordering::Relaxed,
        |value| value.checked_add(1)).map_err(|_| crate::resource::overflow())?;
    Ok(LogicalRetainedSlot {program, occurrence})
}
pub(super) fn boolean_operation(inputs: [LogicalRetainedValue; 2], operation: crate::document::BooleanOperation,
    program: u64) -> crate::Result<RetainedPlanOperation> {
    crate::resource::charge(crate::resource::Cost {work:1,occurrences:1,..Default::default()})?.retain();
    let mut value = copy_values(&inputs[..1])?.pop().expect("left frame");
    value.slot = next_slot(program)?;
    value.definition = LogicalRetainedDefinition::Operation(value.slot);
    value.empty=false;
    Ok(RetainedPlanOperation {value,kind:RetainedOperationKind::Boolean {inputs,operation}})
}
pub(super) fn validate_affine(matrix: &nalgebra::Matrix4<f64>) -> crate::Result<()> {
    if matrix.iter().any(|x| !x.is_finite())
        || matrix.row(3).iter().zip([0.,0.,0.,1.]).any(|(a,b)| *a != b)
        || matrix.fixed_view::<3,3>(0,0).determinant() == 0. {
        return Err(crate::document::RetainedRefusal::UnsupportedSource(
            "retained placement requires finite nonsingular affine matrix".into()).into());
    }
    Ok(())
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

impl RetainedProductPlan {
    /// Assembly of already-completed canonical type-map values, with unresolved
    /// product/presentation obligations retained. No runtime or display claim.
    pub fn from_type_values(values:Vec<LogicalRetainedValue>)->crate::Result<Self> {
        Ok(Self {values,remaining:remaining_requirements()?})
    }
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
                remaining: remaining_requirements()?,
            }),
            Some(Err(error)) => Err(error),
            _ => Err(crate::Error::geometry("retained product incomplete")),
        }
    }
    pub fn retained_submeshes(element: DecodedEntity, contract: RetainedContract) -> Self {
        let mut program=Self::submeshes(element); program.retained=Some(contract);
        program.product.as_mut().expect("product root").select_retained(contract); program
    }
    pub(super) fn retained_styled(item:&DecodedEntity,allow_instancing:bool,contract:RetainedContract,
        router:&crate::GeometryRouter,cache:super::mapping::SharedRetainedCache)->crate::Result<Self> {
        let mut program=Self::mapped_styled(item,allow_instancing,router)?;program.retained=Some(contract);
        program.mapping.as_mut().expect("styled mapping root").select_retained(contract,cache);Ok(program)
    }
    pub fn retained_type_map_id(id:u32,contract:RetainedContract)->Self {
        let mut program=Self::type_map_id(id);program.retained=Some(contract);
        program.type_map.as_mut().expect("type-map root").select_retained(contract);program
    }
    pub fn finish_retained_type_map(mut self,type_product:u32,class:u8,color:[f32;4])->crate::Result<RetainedProductPlan> {
        if self.pending.is_some() {return Err(crate::Error::geometry("retained type-map request outstanding"))}
        match self.take_geometry_output()? {
            super::inner::GeometryOutput::Retained(mut values)=> {
                for value in &mut values {
                    let mut binding=super::retained_presentation::RetainedPresentation::occurrence(type_product,type_product,None,true);
                    binding.type_product=Some((type_product,class));binding.fallback_color=Some(color);value.present(binding)?;
                }
                Ok(RetainedProductPlan {values,remaining:remaining_requirements()?})},
            _=>Err(crate::Error::geometry("retained type-map incomplete")),
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
    let slot=next_slot(program)?;
    Ok(RetainedPlanOperation {
        value: LogicalRetainedValue {
            definition: LogicalRetainedDefinition::Source { slot, source_epoch: contract.source_epoch,
                source_revision: contract.source_revision, source_id: item.id },
            length_unit_scale: scale, placements: Vec::new(), presentation: Vec::new(), product_placed: false, empty:false,
            slot,
            source_from_evaluation: payload.source_from_evaluation,
            evaluation_from_source: payload.evaluation_from_source,
            object_frame: multiply_frames(&crate::math::mat4::col_major_array(&nalgebra::Matrix4::new_nonuniform_scaling(
                &nalgebra::Vector3::repeat(scale))), &payload.source_from_evaluation),
            world_from_source: crate::math::mat4::col_major_array(&nalgebra::Matrix4::new_nonuniform_scaling(
                &nalgebra::Vector3::repeat(scale))),
        },
        kind: RetainedOperationKind::Construction(construction),
    })
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
        let mut presentation = Vec::new();
        crate::resource::reserve_headers(&mut presentation, value.presentation.len())?.retain();
        crate::resource::charge(crate::resource::Cost { copy_bytes: std::mem::size_of_val(value.presentation.as_slice()) as u64, ..Default::default() })?.retain();
        presentation.extend_from_slice(&value.presentation);
        output.push(LogicalRetainedValue { placements, presentation, ..value.clone_without_placements() });
    }
    Ok(output)
}
impl LogicalRetainedValue {
    fn clone_without_placements(&self) -> Self {
        Self { definition: self.definition.clone(), length_unit_scale: self.length_unit_scale,
            placements: Vec::new(), presentation: Vec::new(), product_placed: self.product_placed, empty:self.empty, slot: self.slot,
            source_from_evaluation: self.source_from_evaluation,
            evaluation_from_source: self.evaluation_from_source, object_frame: self.object_frame, world_from_source:self.world_from_source }
    }
}

fn remaining_requirements()->crate::Result<Vec<RetainedRequirement>> {
    let requirements=[RetainedRequirement::OpeningClosure,RetainedRequirement::MaterialLayers,
        RetainedRequirement::IfcAppearance,RetainedRequirement::PersistentFaces];
    let mut remaining=Vec::new();crate::resource::reserve_headers(&mut remaining,requirements.len())?.retain();
    remaining.extend_from_slice(&requirements);Ok(remaining)
}
