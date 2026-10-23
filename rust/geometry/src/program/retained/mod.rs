// SPDX-License-Identifier: MPL-2.0
//! Logical admission in the reached common program. No runtime authority lives here.
use crate::document::RetainedRecipe;
#[cfg(any(not(target_arch = "wasm32"), feature = "wasm_source_capture"))]
mod capture;
mod select;
pub(crate) use select::RetainedSelection;

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
    Source {
        slot: LogicalRetainedSlot,
        source_epoch: u64,
        source_revision: u64,
        source_id: u32,
    },
    Operation(LogicalRetainedSlot),
}
/// Ordered immutable source-free operation lineage. Matrices are column-major,
/// object-local metres -> output-local metres; source file units stay separate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetainedPlacementStage {
    TypeMap { representation_map: u32 },
    Mapping { source_id: u32 },
    Product { product_id: u32 },
}
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
    pub(super) empty: bool,
    slot: LogicalRetainedSlot,
    source_from_evaluation: [f64; 16],
    /// Runtime object local metres -> current logical local metres.
    object_frame: [f64; 16],
    world_from_source: [f64; 16],
    evaluation_from_source: [f64; 16],
}
impl LogicalRetainedValue {
    pub fn try_copy(&self) -> crate::Result<Self> {
        copy_values(std::slice::from_ref(self))?
            .pop()
            .ok_or_else(|| crate::Error::geometry("missing retained value"))
    }
    pub fn is_empty(&self) -> bool {
        self.empty
    }
    pub fn definition(&self) -> &LogicalRetainedDefinition {
        &self.definition
    }
    pub fn placements(&self) -> &[RetainedPlacement] {
        &self.placements
    }
    pub fn is_product_placed(&self) -> bool {
        self.product_placed
    }
    /// Evaluation metres -> file local -> metres -> ordered maps -> product world.
    /// This f64 analytic frame does not certify exact display rounding or RTC assembly.
    pub fn world_from_evaluation(&self) -> nalgebra::Matrix4<f64> {
        nalgebra::Matrix4::from_column_slice(&self.object_frame)
    }
    /// Only a construction definition has an authored source frame. Operation
    /// outputs use their physical object frame and never acquire a fake recipe.
    pub fn world_from_source(&self) -> Option<&[f64; 16]> {
        matches!(self.definition, LogicalRetainedDefinition::Source { .. })
            .then_some(&self.world_from_source)
    }

    pub(in crate::program) fn place_in_place(
        &mut self,
        transform: &nalgebra::Matrix4<f64>,
        program: u64,
        stage: RetainedPlacementStage,
    ) -> crate::Result<()> {
        validate_affine(transform)?;
        proper_rigid(transform)?;
        crate::resource::charge(crate::resource::Cost {
            work: 1,
            occurrences: 1,
            ..Default::default()
        })?
        .retain();
        crate::resource::reserve_headers(&mut self.placements, 1)?.retain();
        let input = self.slot;
        self.slot = next_slot(program)?;
        let matrix = crate::math::mat4::col_major_array(transform);
        if matches!(self.definition, LogicalRetainedDefinition::Source { .. }) {
            self.world_from_source = multiply_frames(&matrix, &self.world_from_source);
            self.object_frame =
                multiply_frames(&self.world_from_source, &self.source_from_evaluation);
        } else {
            self.object_frame = multiply_frames(&matrix, &self.object_frame);
        }
        self.placements.push(RetainedPlacement {
            input,
            output: self.slot,
            stage,
            matrix: crate::math::mat4::col_major_array(transform),
        });
        self.product_placed |= matches!(stage, RetainedPlacementStage::Product { .. });
        Ok(())
    }

    pub fn object_frame(&self) -> &[f64; 16] {
        &self.object_frame
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
    pub(super) kind: RetainedOperationKind,
}
impl RetainedPlanOperation {
    pub fn value(&self) -> &LogicalRetainedValue {
        &self.value
    }
    pub fn construction(&self) -> Option<&RetainedRecipe> {
        match &self.kind {
            RetainedOperationKind::Construction(source) => Some(source),
        }
    }
    pub fn kind(&self) -> &RetainedOperationKind {
        &self.kind
    }
}
/// Ordered operation inputs are logical occurrences, never STEP ids or raw handles.
#[derive(Debug, Clone)]
pub enum RetainedOperationKind {
    Construction(RetainedRecipe),
}
// Transpose the existing row-major primitive to column-major operands. This
// preserves its ordered f64 accumulation and avoids inverse-frame round trips.
fn multiply_frames(a: &[f64; 16], b: &[f64; 16]) -> [f64; 16] {
    crate::math::mat4::mul(b, a)
}
pub(super) fn next_slot(program: u64) -> crate::Result<LogicalRetainedSlot> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let occurrence = NEXT
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
            value.checked_add(1)
        })
        .map_err(|_| crate::resource::overflow())?;
    Ok(LogicalRetainedSlot {
        program,
        occurrence,
    })
}
pub(super) fn validate_affine(matrix: &nalgebra::Matrix4<f64>) -> crate::Result<()> {
    if matrix.iter().any(|x| !x.is_finite())
        || matrix
            .row(3)
            .iter()
            .zip([0., 0., 0., 1.])
            .any(|(a, b)| *a != b)
        || matrix.fixed_view::<3, 3>(0, 0).determinant() == 0.
    {
        return Err(crate::Error::geometry(
            crate::document::RetainedRefusal::UnsupportedSource(
                "retained placement requires finite nonsingular affine matrix".into(),
            )
            .to_string(),
        ));
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
        || matrix
            .row(3)
            .iter()
            .zip([0., 0., 0., 1.])
            .any(|(a, b)| *a != b)
        || (linear.transpose() * linear - nalgebra::Matrix3::identity()).norm() > rounding
        || (linear.determinant() - 1.).abs() > rounding
    {
        return Err(crate::Error::geometry(
            crate::document::RetainedRefusal::UnsupportedSource(
                "retained nonrigid placement requires qualified affine capability".into(),
            )
            .to_string(),
        ));
    }
    Ok(())
}

/// A bounded copy of logical references; no runtime receipt or object is cloned.
pub(super) fn copy_values(
    values: &[LogicalRetainedValue],
) -> crate::Result<Vec<LogicalRetainedValue>> {
    let mut output = Vec::new();
    crate::resource::reserve_headers(&mut output, values.len())?.retain();
    for value in values {
        crate::resource::charge(crate::resource::Cost {
            work: 1,
            copy_bytes: std::mem::size_of_val(value.placements.as_slice()) as u64,
            ..Default::default()
        })?
        .retain();
        let mut placements = Vec::new();
        crate::resource::reserve_headers(&mut placements, value.placements.len())?.retain();
        placements.extend_from_slice(&value.placements);
        output.push(LogicalRetainedValue {
            placements,
            ..value.clone_without_placements()
        });
    }
    Ok(output)
}
impl LogicalRetainedValue {
    fn clone_without_placements(&self) -> Self {
        Self {
            definition: self.definition.clone(),
            length_unit_scale: self.length_unit_scale,
            placements: Vec::new(),
            product_placed: self.product_placed,
            empty: self.empty,
            slot: self.slot,
            source_from_evaluation: self.source_from_evaluation,
            evaluation_from_source: self.evaluation_from_source,
            object_frame: self.object_frame,
            world_from_source: self.world_from_source,
        }
    }
}

#[cfg(all(
    test,
    any(not(target_arch = "wasm32"), feature = "wasm_source_capture")
))]
mod value_tests {
    use super::*;
    #[test]
    fn operation_output_has_no_world_from_source() {
        // #7955: derived values have physical frames, never invented IFC recipes.
        let source = ifc_lite_core::SourceBundle::new(b"#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);#3=IFCDIRECTION((0.,0.,1.));#4=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,2.,4.);#5=IFCEXTRUDEDAREASOLID(#4,#2,#3,3.);".to_vec());
        let mut decoder = source.decoder();
        let item = decoder.decode_by_id(5).unwrap();
        let mut operation = capture::capture(
            &item,
            &mut decoder,
            1.,
            RetainedContract {
                source_epoch: 1,
                source_revision: 1,
            },
            1,
        )
        .unwrap();
        assert!(operation.value.world_from_source().is_some());
        operation.value.definition = LogicalRetainedDefinition::Operation(operation.value.slot());
        assert!(operation.value.world_from_source().is_none());
    }
}
