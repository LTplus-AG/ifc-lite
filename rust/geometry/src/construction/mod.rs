// SPDX-License-Identifier: MPL-2.0
//! Owned construction before product publication. This is an explicitly partial
//! graph of raw representation items and ordered solid boolean/CSG dependencies.
//! This is not a complete product plan or a replacement for canonical assembly.
//!
//! Coordinates are in file length units; constructor Position is applied by
//! evaluation. Product/mapping transforms, RTC publication, appearance and openings
//! remain outside this contract. Source/execution reports are captured separately
//! from product diagnostics. Profiles may already be sampled.
//! Triangle coordinates use the production f32 admission without RTC subtraction;
//! a router's RTC offset is not applied to this raw construction batch. Survey-
//! coordinate detail therefore needs frame-aware lowering before product use.
//! The canonical element path remains responsible for final product geometry.

use crate::{Error, Mesh, Result};

pub use crate::router::ConstructionFamily;
pub use reports::{ConstructionDiagnostic, ConstructionExecutionError, ConstructionReports};

/// Why a requested item cannot be replayed by this construction batch.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ConstructionRequirement {
    /// A caller registration must not silently become a built-in constructor.
    CustomProcessor,
    /// The production family still needs owned lowering in this contract.
    ConstructorNotLowered,
    /// Existing source admission failed; the original diagnostic is retained.
    SourceAdmission(String),
    /// The operation exists, but this graph does not own its full policy yet.
    OperationPolicyNotLowered(String),
    /// A source operation refers back into its active dependency path.
    CyclicDependency(u32),
    /// The graph's explicit node/work bound was reached; no truncated success.
    GraphBudgetExhausted,
    /// The caller's router has explicitly refused the model's length unit.
    LengthUnitRefused,
}

/// One source definition; multiple ordered roots may refer to this definition.
#[derive(Debug, Clone)]
pub struct ConstructionNode {
    source_id: u32,
    family: Option<ConstructionFamily>,
    construction: std::result::Result<usize, ConstructionRequirement>,
}

#[derive(Debug, Clone)]
enum Construction {
    Builtin(crate::program::OwnedConstructor),
    BrepOperand(brep_operand::BrepOperandPlan),
}

impl ConstructionNode {
    pub fn source_id(&self) -> u32 { self.source_id }
    pub fn family(&self) -> Option<ConstructionFamily> { self.family }
    pub fn requirement(&self) -> Option<&ConstructionRequirement> {
        self.construction.as_ref().err()
    }
}

/// Source-scoped owned definitions and ordered occurrences, independent of IFC
/// bytes, decoder and router after compilation. Definition reuse never removes
/// a repeated occurrence. Unsupported roots remain explicit requirements.
#[derive(Debug, Clone)]
pub struct ConstructionBatch {
    pub(super) nodes: Vec<ConstructionNode>,
    pub(super) occurrences: Vec<usize>,
    program: Vec<program::Instruction>,
    program_sources: Vec<u32>,
    reports: ConstructionReports,
}

/// Evaluated unique definitions plus the original ordered occurrence indices.
/// Meshes retain raw file-unit construction coordinates, not world coordinates.
pub struct ConstructionEvaluation {
    pub definitions: Vec<Mesh>,
    pub occurrences: Vec<usize>,
    /// Unattributed diagnostics per unique requested definition, in root order.
    pub diagnostics: Vec<Vec<crate::BoolFailure>>,
    /// Durable source/execution reports, independent of caller thread-local state.
    pub reports: ConstructionReports,
    /// Fresh instruction failures in execution order; reused edges are not repeated.
    pub observed_diagnostics: Vec<ConstructionDiagnostic>,
}

impl ConstructionBatch {
    pub fn nodes(&self) -> &[ConstructionNode] { &self.nodes }
    pub fn occurrences(&self) -> &[usize] { &self.occurrences }
    pub fn reports(&self) -> &ConstructionReports { &self.reports }

    /// Consume owned arrays through the same mesh builders as production.
    /// Refuse the entire batch before evaluation if any root is unresolved;
    /// there is no successful partial result that silently drops geometry.
    pub fn evaluate(self) -> std::result::Result<ConstructionEvaluation, ConstructionExecutionError> {
        if let Some(node) = self.nodes.iter().find(|node| node.requirement().is_some()) {
            return Err(ConstructionExecutionError {
                root_source_id: Some(node.source_id), failed_source_id: Some(node.source_id),
                error: Box::new(Error::geometry(format!("Construction item #{} requires {:?}", node.source_id, node.requirement().unwrap()))),
                diagnostics: Vec::new(), reports: self.reports,
            });
        }
        let (mut result, mut reports) = crate::processors::diagnostic_capture::capture(|| program::evaluate(self));
        match &mut result {
            Ok(evaluated) => {
                reports.merge(std::mem::take(&mut evaluated.reports));
                evaluated.reports = reports;
            }
            Err(error) => {
                reports.merge(std::mem::take(&mut error.reports));
                error.reports = reports;
            }
        }
        result
    }
}

mod lowering;
mod leaf;
mod program;
mod source;
mod reports;
mod brep_operand;

#[cfg(test)]
mod tests;
#[cfg(test)]
mod graph_tests;
#[cfg(test)]
mod family_tests;

impl Construction {
    fn evaluate(self, recorder: &crate::processors::BooleanClippingProcessor) -> Result<(Mesh, bool)> {
        match self {
            Self::Builtin(plan) => plan.evaluate().map(|mesh| (mesh, false)),
            Self::BrepOperand(plan) => plan.evaluate(recorder),
        }
    }
}
