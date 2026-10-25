// SPDX-License-Identifier: MPL-2.0
//! Typed origins retained until the diagnostic boundary; no prose classification.
use super::*;
use super::super::session_protocol::WorkError;
use ifc_lite_geometry_runtime::WorkerError;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ReceiptFailure {
    BooleanInputDefinitionReceiptKindMismatch,
    BooleanOperandFormReceiptKindMismatch,
    CancelledDelivery,
    CancelledRetainedProduct,
    ConflictingRetainedNumericalOutcome,
    DuplicateRetainedOutputSlot,
    DuplicateSlot,
    DiagnosticSerialization,
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
pub(super) enum Unsupported {
    ConstructionRecipe,
    RetainedFinalPublicationRequiresOpeningLayerAppearanceFaceProofs,
    RetainedOpeningStrategy,
    RetainedStrategy,
}
#[derive(Debug)]
pub(super) enum RetainedExecutionError {
    Source(RetainedContextError), Core(ifc_lite_core::Error), Owner(WorkError),
    Common(TransactionError), Receipt(ReceiptFailure),
    Recipe(ifc_lite_geometry::document::RetainedRefusal),
    Geometry(ifc_lite_geometry::Error), Runtime(WorkerError),
    Transition(u8), DomainRetired, Unsupported(Unsupported), Stopped(ProgramStop),
    InvalidTypeSource,
}
impl std::fmt::Display for RetainedExecutionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "{self:?}") }
}
impl std::error::Error for RetainedExecutionError {}
pub(super) fn protocol(error: impl Into<RetainedExecutionError>) -> RetainedExecutionError { error.into() }
pub(super) fn geometry(error: ifc_lite_geometry::Error) -> RetainedExecutionError {
    match error { ifc_lite_geometry::Error::ProgramStopped(stop) => RetainedExecutionError::Stopped(stop),
        other => RetainedExecutionError::Geometry(other) }
}
pub(super) fn common(error: TransactionError) -> RetainedExecutionError {
    match error.original_stop() { Some(stop) => RetainedExecutionError::Stopped(stop),
        None => RetainedExecutionError::Common(error) }
}
impl From<WorkError> for RetainedExecutionError {
    fn from(error: WorkError) -> Self { Self::Owner(error) }
}
impl From<WorkerError> for RetainedExecutionError {
    fn from(error: WorkerError) -> Self { Self::Runtime(error) }
}
impl From<ReceiptFailure> for RetainedExecutionError {
    fn from(error: ReceiptFailure) -> Self { Self::Receipt(error) }
}
impl From<ifc_lite_geometry::document::RetainedRefusal> for RetainedExecutionError {
    fn from(error: ifc_lite_geometry::document::RetainedRefusal) -> Self { Self::Recipe(error) }
}
impl From<u8> for RetainedExecutionError {
    fn from(stage: u8) -> Self { Self::Transition(stage) }
}

impl RetainedExecutionError {
    pub(super) fn terminal(&self) -> bool {
        matches!(self, Self::Stopped(_) | Self::Source(_) | Self::Core(_) | Self::Runtime(_) | Self::DomainRetired
            | Self::Recipe(_) | Self::Geometry(_) | Self::Unsupported(_) | Self::InvalidTypeSource
            | Self::Receipt(ReceiptFailure::ConflictingRetainedNumericalOutcome)
            | Self::Transition(CANCELLED)
            | Self::Owner(WorkError::StaleSource | WorkError::Aborted))
            || matches!(self, Self::Common(error) if matches!(error.kind(),
                ifc_lite_geometry::program::transactions::TransactionFailureKind::Source
                | ifc_lite_geometry::program::transactions::TransactionFailureKind::OperationUnsupported
                | ifc_lite_geometry::program::transactions::TransactionFailureKind::DeadlineExceeded
                | ifc_lite_geometry::program::transactions::TransactionFailureKind::Unsupported
                | ifc_lite_geometry::program::transactions::TransactionFailureKind::Incomplete
                | ifc_lite_geometry::program::transactions::TransactionFailureKind::Stopped))
    }
}

impl RetainedExecutionError {
    pub(super) fn code(&self) -> crate::retained_native_contract::Code {
        use crate::retained_native_contract::Code;
        use ifc_lite_geometry::program::transactions::TransactionFailureKind as Kind;
        match self {
            Self::Stopped(ProgramStop::Cancelled) => Code::Cancelled,
            Self::Stopped(ProgramStop::ResourceRefused(_)) => Code::ResourceExhausted,
            Self::Source(RetainedContextError::Missing) => Code::SourceMissing,
            Self::Source(RetainedContextError::Stale) | Self::Owner(WorkError::StaleSource) => Code::SourceStale,
            Self::Source(RetainedContextError::Mismatched) => Code::SourceMismatch,
            Self::Owner(WorkError::WrongOwner) => Code::OwnerMismatch,
            Self::Owner(WorkError::OwnerBusy) => Code::OwnerBusy,
            Self::Common(error) => match error.kind() {
                Kind::Stopped => match error.original_stop() {
                    Some(ProgramStop::Cancelled) => Code::Cancelled, _ => Code::ResourceExhausted,
                },
                Kind::Cancelled => Code::Cancelled,
                Kind::OperationUnsupported => Code::OperationUnsupported,
                Kind::DeadlineExceeded => Code::DeadlineExceeded,
                Kind::WrongOwner => Code::OwnerMismatch,
                Kind::Source | Kind::Unsupported => Code::SourceInvalid,
                _ => Code::RuntimeFailed,
            },
            Self::InvalidTypeSource => Code::SourceInvalid,
            Self::Core(error) => { let _ = error; Code::SourceInvalid }
            Self::Recipe(error) => match error {
                ifc_lite_geometry::document::RetainedRefusal::UnsupportedSource(_) => Code::OperationUnsupported,
                _ => Code::SourceInvalid,
            },
            Self::Runtime(error) => match error {
                WorkerError::WrongWorker => Code::WorkerRetired,
                WorkerError::ResourceLimit(_) => Code::ResourceExhausted,
                _ => Code::RuntimeFailed,
            },
            Self::Unsupported(reason) => match reason {
                Unsupported::RetainedFinalPublicationRequiresOpeningLayerAppearanceFaceProofs => Code::PublicationFailed,
                _ => Code::OperationUnsupported,
            },
            Self::Receipt(ReceiptFailure::InvalidRetainedNumericalLimits) => Code::InvalidOptions,
            Self::Receipt(ReceiptFailure::ForeignSourceAdmission) => Code::ReceiptInvalid,
            Self::Receipt(reason) => { let _ = reason; Code::ReceiptInvalid }
            Self::Transition(stage) => { let _ = stage; Code::Cancelled }
            Self::DomainRetired => Code::WorkerRetired,
            Self::Geometry(ifc_lite_geometry::Error::InspectionDeadlineExceeded) => Code::DeadlineExceeded,
            Self::Geometry(error) => { let _ = error; Code::RuntimeFailed }
            Self::Owner(_) => Code::RuntimeFailed,
        }
    }
}

// Keep the original source/account stop ahead of the cooperative deadline.
// Every lexical scope is restored before the transport can suspend.
pub(super) fn check_resources(resources: &OwnedResourceContext) -> Result<(), RetainedExecutionError> {
    resources.check().map_err(RetainedExecutionError::Stopped)?;
    resources.with_scope(resource::inspection_checkpoint).map_err(geometry)
}
