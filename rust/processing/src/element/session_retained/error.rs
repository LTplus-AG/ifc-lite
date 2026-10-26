// SPDX-License-Identifier: MPL-2.0
//! Typed origins retained until the diagnostic boundary; no prose classification.
use super::super::session_protocol::WorkError;
use super::runtime::RuntimeFault;
use super::*;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReceiptFailure {
    BooleanInputDefinitionReceiptKindMismatch,
    CancelledDelivery,
    CancelledRetainedProduct,
    ConflictingRetainedNumericalOutcome,
    DuplicateRetainedOutputSlot,
    DuplicateSlot,
    EmptyConstructionResult,
    ForeignAffineInput,
    ForeignAffineInputRuntime,
    ForeignAffineOperationOrOrderedInput,
    ForeignBooleanInput,
    ForeignBooleanInputRuntime,
    ForeignBooleanOperationOrOrderedInputs,
    ForeignConstructionReceipt,
    ForeignConstructionTicketStageOwner,
    ForeignRetainedManifestDefinition,
    ForeignRetainedOutputDefinition,
    ForeignRuntime,
    ForeignSourceAdmission,
    ForeignWorker,
    InvalidRetainedNumericalLimits,
    MissingAdmission,
    MissingOuterRequest,
    MissingProgram,
    NoPendingAdmission,
    NumericalResultKindMismatch,
    OutstandingConstruction,
    RetainedBatchLengthMismatch,
    RetainedFrameMismatch,
    RetainedManifestOutcomeMismatch,
    UndischargedDefinition,
    UndischargedRetainedInput,
    UnfinishedProduct,
    UnsupportedRetainedBooleanOperator,
    WrongRetainedOperationResult,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unsupported {
    ConstructionRecipe,
    RetainedFinalPublicationRequiresOpeningLayerAppearanceFaceProofs,
    RetainedOpeningStrategy,
    RetainedMaterialLayerStrategy,
    RetainedStrategy,
}
#[derive(Debug)]
pub enum RetainedExecutionError {
    Source(RetainedContextError),
    Core(ifc_lite_core::Error),
    Owner(WorkError),
    Common(TransactionError),
    Receipt(ReceiptFailure),
    Recipe(ifc_lite_geometry::document::RetainedRefusal),
    Geometry(ifc_lite_geometry::Error),
    Runtime(RuntimeFault),
    DeadlineExceeded,
    Transition(u8),
    DomainRetired,
    Unsupported(Unsupported),
    Stopped(ProgramStop),
    // Refs #7955: D's model driver validates type-product source before admission.
    #[cfg_attr(not(test), allow(dead_code))]
    InvalidTypeSource,
}
impl std::fmt::Display for RetainedExecutionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for RetainedExecutionError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Core(error) => Some(error),
            Self::Geometry(error) => Some(error),
            Self::Runtime(error) => Some(error),
            _ => None,
        }
    }
}
pub(super) fn runtime_fault(error: impl Into<RuntimeFault>) -> RetainedExecutionError {
    RetainedExecutionError::Runtime(error.into())
}
pub(super) fn protocol(error: impl Into<RetainedExecutionError>) -> RetainedExecutionError {
    error.into()
}
/// Budget checkpoint with the true cause restored. Geometry reports an
/// expired deadline as `ProgramStop::Cancelled`; the cause is read here, at the
/// checkpoint, while the allowance scope is still current.
pub(super) fn budget_checkpoint() -> Result<(), RetainedExecutionError> {
    resource::budget_checkpoint().map_err(|error| match error {
        ifc_lite_geometry::Error::ProgramStopped(ProgramStop::Cancelled)
            if resource::budget_deadline_fired() =>
        {
            RetainedExecutionError::DeadlineExceeded
        }
        other => geometry(other),
    })
}
pub(super) fn geometry(error: ifc_lite_geometry::Error) -> RetainedExecutionError {
    match error {
        ifc_lite_geometry::Error::ProgramStopped(stop) => RetainedExecutionError::Stopped(stop),
        other => RetainedExecutionError::Geometry(other),
    }
}
pub(super) fn common(error: TransactionError) -> RetainedExecutionError {
    match error.original_stop() {
        Some(stop) => RetainedExecutionError::Stopped(stop),
        None => RetainedExecutionError::Common(error),
    }
}
impl From<WorkError> for RetainedExecutionError {
    fn from(error: WorkError) -> Self {
        Self::Owner(error)
    }
}
impl From<ReceiptFailure> for RetainedExecutionError {
    fn from(error: ReceiptFailure) -> Self {
        Self::Receipt(error)
    }
}
impl From<ifc_lite_geometry::document::RetainedRefusal> for RetainedExecutionError {
    fn from(error: ifc_lite_geometry::document::RetainedRefusal) -> Self {
        Self::Recipe(error)
    }
}
impl From<u8> for RetainedExecutionError {
    fn from(stage: u8) -> Self {
        Self::Transition(stage)
    }
}

impl RetainedExecutionError {
    pub(super) fn terminal(&self) -> bool {
        if matches!(self, Self::Runtime(_)) {
            return true;
        }
        matches!(
            self,
            Self::Stopped(_)
                | Self::Source(_)
                | Self::Core(_)
                | Self::DomainRetired
                | Self::Recipe(_)
                | Self::Geometry(_)
                | Self::DeadlineExceeded
                | Self::Unsupported(_)
                | Self::InvalidTypeSource
                | Self::Receipt(ReceiptFailure::ConflictingRetainedNumericalOutcome)
                | Self::Transition(CANCELLED)
                | Self::Owner(WorkError::StaleSource | WorkError::Aborted)
        ) || matches!(self, Self::Common(error) if matches!(error.kind(),
                ifc_lite_geometry::program::transactions::TransactionFailureKind::Source
                | ifc_lite_geometry::program::transactions::TransactionFailureKind::OperationUnsupported
                | ifc_lite_geometry::program::transactions::TransactionFailureKind::DeadlineExceeded
                | ifc_lite_geometry::program::transactions::TransactionFailureKind::Unsupported
                | ifc_lite_geometry::program::transactions::TransactionFailureKind::Incomplete
                | ifc_lite_geometry::program::transactions::TransactionFailureKind::Stopped))
    }
}

// Keep the original source/account stop ahead of the cooperative deadline.
// Every lexical scope is restored before the transport can suspend.
pub(super) fn check_resources(
    resources: &OwnedResourceContext,
) -> Result<(), RetainedExecutionError> {
    resources.check().map_err(RetainedExecutionError::Stopped)?;
    resources.with_scope(budget_checkpoint)
}
