// SPDX-License-Identifier: MPL-2.0
//! Logical admission in the reached common program. No runtime authority lives here.
use crate::document::RetainedRecipe;
#[cfg(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime"))]
mod capture;
#[cfg(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime"))]
mod walk;
#[cfg(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime"))]
mod cache;
mod presentation;
mod affine;
mod identity;
mod frame;
pub(in crate::program) mod value_error;
#[cfg(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime"))]
use frame::compose_frame;
pub(in crate::program) use frame::{validate_affine, proper_rigid};
mod outcome;
pub(in crate::program) mod boolean;
pub(crate) use presentation::RetainedPresentation;
mod select;
pub(in crate::program) mod failure;
pub(crate) use select::{RetainedSelection, RetainedSlot};
/// Whether retained state can exist in this build. False on the default wasm
/// engine: the hooks the common walks call fold to their default answer, so
/// no retained branch ships in that bundle (#7955).
pub(crate) const ENABLED: bool = cfg!(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime"));

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
    Operation(LogicalRetainedSlot),
}
/// Ordered immutable source-free operation lineage. Matrices are column-major,
/// object-local metres -> output-local metres; source file units stay separate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RetainedPlacementStage {
    TypeMap { representation_map: u32 },
    Mapping { source_id: u32 },
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
    length_unit_scale: f64,
    contract: RetainedContract,
    /// Inner-to-outer metre-domain mappings, followed by reached product placement.
    placements: Vec<RetainedPlacement>,
    presentation: Vec<RetainedPresentation>,
    product_placed: bool,
    outcome: std::sync::Arc<std::sync::OnceLock<bool>>,
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
    pub(crate) fn presentation(&self) -> &[RetainedPresentation] { &self.presentation }
    pub(in crate::program) fn present(&mut self, binding: RetainedPresentation) -> crate::Result<()> {
        crate::resource::reserve_headers(&mut self.presentation, 1)?.retain();
        self.presentation.push(binding);
        Ok(())
    }
    pub(crate) fn is_product_placed(&self) -> bool {
        self.product_placed
    }
    /// Evaluation metres -> file local -> metres -> product world.
    /// This f64 analytic frame does not certify exact display rounding or RTC assembly.
    pub(crate) fn world_from_evaluation(&self) -> nalgebra::Matrix4<f64> {
        nalgebra::Matrix4::from_column_slice(&self.object_frame)
    }
    /// Only constructions have an authored source frame; derived operations
    /// use their physical object frame and never acquire a fake recipe.
    pub(crate) fn world_from_source(&self) -> Option<&[f64; 16]> {
        matches!(self.definition, LogicalRetainedDefinition::Source { .. })
            .then_some(&self.world_from_source)
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
    pub(super) kind: RetainedOperationKind,
}
impl RetainedPlanOperation {
    #[cfg(feature = "retained-runtime")]
    pub(crate) fn into_value(self) -> LogicalRetainedValue { self.value }
    pub(crate) fn value(&self) -> &LogicalRetainedValue {
        &self.value
    }
    pub(crate) fn construction(&self) -> Option<&RetainedRecipe> {
        match &self.kind {
            RetainedOperationKind::Construction(source) => Some(source),
            RetainedOperationKind::Affine { .. } | RetainedOperationKind::Boolean { .. } => None,
        }
    }
    pub(crate) fn kind(&self) -> &RetainedOperationKind {
        &self.kind
    }
}
/// Ordered operation inputs are logical occurrences, never STEP ids or raw handles.
#[derive(Debug)]
pub(crate) enum RetainedOperationKind {
    Construction(RetainedRecipe),
    Boolean { inputs: Box<[LogicalRetainedValue; 2]>, operation: crate::BoolOp },
    Affine { input: LogicalRetainedValue, matrix: [f64; 16] },
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
    ProductPlacement,
    OpeningClosure,
    MaterialLayers,
    IfcAppearance,
    PersistentFaces,
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
            copy_bytes: (std::mem::size_of_val(value.placements.as_slice())
                + std::mem::size_of_val(value.presentation.as_slice())) as u64,
            ..Default::default()
        })?
        .retain();
        let mut placements = Vec::new();
        crate::resource::reserve_headers(&mut placements, value.placements.len())?.retain();
        placements.extend_from_slice(&value.placements);
        let mut presentation = Vec::new();
        crate::resource::reserve_headers(&mut presentation, value.presentation.len())?.retain();
        presentation.extend_from_slice(&value.presentation);
        output.push(LogicalRetainedValue {
            placements,
            presentation,
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
            contract: self.contract,
            placements: Vec::new(),
            presentation: Vec::new(),
            product_placed: self.product_placed,
            outcome: self.outcome.clone(),
            slot: self.slot,
            source_from_evaluation: self.source_from_evaluation,
            evaluation_from_source: self.evaluation_from_source,
            object_frame: self.object_frame,
            world_from_source: self.world_from_source,
        }
    }
}
