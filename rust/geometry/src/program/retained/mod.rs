// SPDX-License-Identifier: MPL-2.0
//! Logical admission in the reached common program. No runtime authority lives here.
use crate::document::RetainedRecipe;
#[cfg(any(not(target_arch = "wasm32"), feature = "wasm_source_capture"))]
mod capture;
mod select;
pub(crate) use select::RetainedSelection;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RetainedContract {
    pub(crate) source_epoch: u64,
    pub(crate) source_revision: u64,
}

/// Process-local occurrence identity, unrelated to STEP ids or SDK slots.
/// Never serialize, sort by, or compare these identities across runs: allocation
/// depends on process history and thread interleaving, not source order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) struct LogicalRetainedSlot {
    program: u64,
    occurrence: u64,
}
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) enum LogicalRetainedDefinition {
    Source {
        slot: LogicalRetainedSlot,
        source_epoch: u64,
        source_revision: u64,
        source_id: u32,
    },
}
/// Ordered immutable source-free operation lineage. Matrices are column-major,
/// object-local metres -> output-local metres; source file units stay separate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RetainedPlacementStage {
    Product { product_id: u32 },
}
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RetainedPlacement {
    pub(crate) input: LogicalRetainedSlot,
    pub(crate) output: LogicalRetainedSlot,
    pub(crate) stage: RetainedPlacementStage,
    pub(crate) matrix: [f64; 16],
}
#[derive(Debug, PartialEq)]
pub(crate) struct LogicalRetainedValue {
    definition: LogicalRetainedDefinition,
    /// Reached product placements, in application order.
    placements: Vec<RetainedPlacement>,
    product_placed: bool,
    slot: LogicalRetainedSlot,
    source_from_evaluation: [f64; 16],
    /// Runtime object local metres -> current logical local metres.
    object_frame: [f64; 16],
    world_from_source: [f64; 16],
    evaluation_from_source: [f64; 16],
}
impl LogicalRetainedValue {
    pub(crate) fn try_copy(&self) -> crate::Result<Self> {
        copy_values(std::slice::from_ref(self))?
            .pop()
            .ok_or_else(|| crate::Error::geometry("missing retained value"))
    }
    pub(crate) fn definition(&self) -> &LogicalRetainedDefinition {
        &self.definition
    }
    pub(crate) fn placements(&self) -> &[RetainedPlacement] {
        &self.placements
    }
    pub(crate) fn is_product_placed(&self) -> bool {
        self.product_placed
    }
    /// Evaluation metres -> file local -> metres -> product world.
    /// This f64 analytic frame does not certify exact display rounding or RTC assembly.
    pub(crate) fn world_from_evaluation(&self) -> nalgebra::Matrix4<f64> {
        nalgebra::Matrix4::from_column_slice(&self.object_frame)
    }
    /// Construction definitions carry their authored source frame.
    pub(crate) fn world_from_source(&self) -> &[f64; 16] {
        &self.world_from_source
    }

    pub(in crate::program) fn place_in_place(
        &mut self,
        transform: &nalgebra::Matrix4<f64>,
        program: u64,
        stage: RetainedPlacementStage,
    ) -> crate::Result<()> {
        validate_affine(transform)?;
        proper_rigid(transform)?;
        let matrix = crate::math::mat4::col_major_array(transform);
        // Finite inputs need not compose to a finite frame. Compute both
        // candidates before changing the occurrence or its placement lineage.
        let world_from_source = compose_frame(&matrix, &self.world_from_source)?;
        let object_frame = compose_frame(&world_from_source, &self.source_from_evaluation)?;
        crate::resource::charge(crate::resource::Cost {
            work: 1,
            occurrences: 1,
            ..Default::default()
        })?
        .retain();
        crate::resource::reserve_headers(&mut self.placements, 1)?.retain();
        let input = self.slot;
        let output = next_slot(program)?;
        self.world_from_source = world_from_source;
        self.object_frame = object_frame;
        self.slot = output;
        self.placements.push(RetainedPlacement {
            input,
            output: self.slot,
            stage,
            matrix,
        });
        self.product_placed |= matches!(stage, RetainedPlacementStage::Product { .. });
        Ok(())
    }

    pub(crate) fn object_frame(&self) -> &[f64; 16] {
        &self.object_frame
    }
    pub(crate) fn slot(&self) -> LogicalRetainedSlot {
        self.slot
    }
    pub(crate) fn source_from_evaluation(&self) -> &[f64; 16] {
        &self.source_from_evaluation
    }
    pub(crate) fn evaluation_from_source(&self) -> &[f64; 16] {
        &self.evaluation_from_source
    }
}
/// Immutable original source, captured before any sampled constructor is lowered.
#[derive(Debug)]
pub(crate) struct RetainedPlanOperation {
    pub(super) value: LogicalRetainedValue,
    pub(super) construction: RetainedRecipe,
}
impl RetainedPlanOperation {
    pub(crate) fn value(&self) -> &LogicalRetainedValue {
        &self.value
    }
    pub(crate) fn construction(&self) -> &RetainedRecipe {
        &self.construction
    }
}
// Transpose the existing row-major primitive to column-major operands. This
// preserves its ordered f64 accumulation and avoids inverse-frame round trips.
fn compose_frame(a: &[f64; 16], b: &[f64; 16]) -> crate::Result<[f64; 16]> {
    let composed = crate::math::mat4::mul(b, a);
    if composed.iter().any(|value| !value.is_finite()) {
        return Err(crate::Error::geometry("retained composed frame is non-finite"));
    }
    Ok(composed)
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
pub(crate) struct RetainedProductPlan {
    pub(crate) values: Vec<LogicalRetainedValue>,
    /// Conservatively unchecked obligations until a consumer proves them
    /// unnecessary or discharges them; traversal alone does neither.
    pub(crate) remaining: Vec<RetainedRequirement>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RetainedRequirement {
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
            placements: Vec::new(),
            product_placed: self.product_placed,
            slot: self.slot,
            source_from_evaluation: self.source_from_evaluation,
            evaluation_from_source: self.evaluation_from_source,
            object_frame: self.object_frame,
            world_from_source: self.world_from_source,
        }
    }
}
