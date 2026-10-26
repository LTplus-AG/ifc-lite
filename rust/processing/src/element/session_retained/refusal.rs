// SPDX-License-Identifier: MPL-2.0
//! Stable product refusals, independent of any runtime or generated contract.
use super::error::{ReceiptFailure, RetainedExecutionError, Unsupported};
use super::runtime::RuntimeFaultKind;
use super::{ProgramStop, RetainedContextError, CANCELLED};
use crate::element::session_protocol::WorkError;
use ifc_lite_geometry::program::transactions::TransactionFailureKind as Kind;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum RetainedProductRefusal {
    OpeningStrategy,
    MaterialLayerStrategy,
    OperationUnsupported,
    SourceInvalid,
    SourceChanged,
    Incomplete,
    EmptyResult,
    FamilyUnqualified,
    KernelFailure { status: i32 },
    WorkerFault,
    WorkerRetired,
    ResourceExhausted,
    DeadlineExceeded,
    Cancelled,
    ContractBreach,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RefusalOrigin {
    pub site: &'static str,
    pub entity: Option<u32>,
    pub cause: &'static str,
}

impl RetainedProductRefusal {
    pub fn code(&self) -> &'static str {
        match self {
            Self::OpeningStrategy => "opening_strategy",
            Self::MaterialLayerStrategy => "material_layer_strategy",
            Self::OperationUnsupported => "operation_unsupported",
            Self::SourceInvalid => "source_invalid",
            Self::SourceChanged => "source_changed",
            Self::Incomplete => "incomplete",
            Self::EmptyResult => "empty_result",
            Self::FamilyUnqualified => "family_unqualified",
            Self::KernelFailure { .. } => "kernel_failure",
            Self::WorkerFault => "worker_fault",
            Self::WorkerRetired => "worker_retired",
            Self::ResourceExhausted => "resource_exhausted",
            Self::DeadlineExceeded => "deadline_exceeded",
            Self::Cancelled => "cancelled",
            Self::ContractBreach => "contract_breach",
        }
    }
}

impl RetainedExecutionError {
    pub fn refusal(&self) -> (RetainedProductRefusal, Option<RefusalOrigin>) {
        use RetainedProductRefusal as Refusal;
        let mut origin = None;
        let refusal = match self {
            Self::Unsupported(reason) => match reason {
                Unsupported::RetainedOpeningStrategy => Refusal::OpeningStrategy,
                Unsupported::RetainedMaterialLayerStrategy => Refusal::MaterialLayerStrategy,
                Unsupported::ConstructionRecipe | Unsupported::RetainedStrategy => {
                    Refusal::OperationUnsupported
                }
                Unsupported::RetainedFinalPublicationRequiresOpeningLayerAppearanceFaceProofs => {
                    Refusal::Incomplete
                }
            },
            Self::Common(error) => {
                origin = error
                    .origin_view()
                    .map(|(site, entity, cause)| RefusalOrigin {
                        site,
                        entity,
                        cause,
                    });
                common_kind_refusal(error.kind(), error.original_stop())
            }
            Self::Recipe(ifc_lite_geometry::document::RetainedRefusal::UnsupportedSource(_)) => {
                Refusal::OperationUnsupported
            }
            Self::Recipe(_) | Self::Core(_) | Self::InvalidTypeSource => Refusal::SourceInvalid,
            Self::Source(
                RetainedContextError::Missing
                | RetainedContextError::Stale
                | RetainedContextError::Mismatched,
            )
            | Self::Owner(WorkError::StaleSource) => Refusal::SourceChanged,
            Self::Receipt(ReceiptFailure::EmptyConstructionResult) => Refusal::EmptyResult,
            Self::Receipt(_) => Refusal::ContractBreach,
            Self::Runtime(fault) => match fault.kind {
                RuntimeFaultKind::Kernel { status } => Refusal::KernelFailure { status },
                RuntimeFaultKind::Unqualified => Refusal::FamilyUnqualified,
                RuntimeFaultKind::Retired => Refusal::WorkerRetired,
                RuntimeFaultKind::ResourceLimit => Refusal::ResourceExhausted,
                RuntimeFaultKind::Transport => Refusal::WorkerFault,
                RuntimeFaultKind::Contract => Refusal::ContractBreach,
            },
            // The sole Geometry producer is a conflicting logical outcome at acceptance.
            Self::Geometry(_) => Refusal::ContractBreach,
            Self::DomainRetired => Refusal::WorkerRetired,
            Self::Stopped(ProgramStop::ResourceRefused(_)) => Refusal::ResourceExhausted,
            Self::DeadlineExceeded => Refusal::DeadlineExceeded,
            Self::Stopped(ProgramStop::Cancelled) | Self::Transition(CANCELLED) => {
                Refusal::Cancelled
            }
            Self::Owner(_) | Self::Transition(_) => Refusal::ContractBreach,
        };
        (refusal, origin)
    }
}

// Classification is total over the controller taxonomy; origin extraction stays above.
pub(super) fn common_kind_refusal(kind: Kind, stop: Option<ProgramStop>) -> RetainedProductRefusal {
    use RetainedProductRefusal as Refusal;
    match kind {
        Kind::OperationUnsupported => Refusal::OperationUnsupported,
        Kind::Source | Kind::Unsupported => Refusal::SourceInvalid,
        Kind::Incomplete => Refusal::Incomplete,
        Kind::DeadlineExceeded => Refusal::DeadlineExceeded,
        Kind::Cancelled => Refusal::Cancelled,
        Kind::Stopped => match stop {
            Some(ProgramStop::Cancelled) => Refusal::Cancelled,
            _ => Refusal::ResourceExhausted,
        },
        _ => Refusal::ContractBreach,
    }
}
