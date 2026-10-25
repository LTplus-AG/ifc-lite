// SPDX-License-Identifier: MPL-2.0
//! Project known typed origins conservatively; opaque helper errors stay opaque.
use super::*;
use std::result::Result;
use crate::program::retained::failure::{OriginCause, StructuralReason};

pub(super) fn outcome(failure: RetainedFailure, binding: &wire::Binding)
    -> Result<wire::InspectionOutcome, SourceInspectionError> {
    use wire::{Code, DetailReason, Requirement, Stage};
    let (code, reason, stage, requirement) = match failure {
        RetainedFailure::Stopped(stop) => return Err(stop.into()),
        RetainedFailure::Origin(handle) => {
            let origin = handle.origin().ok_or(SourceInspectionError::InvalidReport)?;
            let unsupported = matches!(&origin.cause,
                OriginCause::Recipe(crate::document::RetainedRefusal::UnsupportedSource(_))
                | OriginCause::Structure(StructuralReason::UnsupportedProduct)
                | OriginCause::Processor(_));
            if unsupported {
                (Code::OperationUnsupported, DetailReason::Unsupported, Stage::Representation, Requirement::Representation)
            } else {
                // Core/shape/structure/mapping causes, and unconverted opaque
                // helpers, establish source failure only. No prose classification.
                (Code::SourceInvalid, DetailReason::Invalid, Stage::Source, Requirement::SourceAuthentication)
            }
        }
        RetainedFailure::Protocol(RetainedProgramError::Stopped(stop)) => return Err(stop.into()),
        RetainedFailure::Protocol(RetainedProgramError::Unsupported) =>
            // Some not-yet-converted adapters erase their common error into
            // Unsupported. This is not proof a platform feature is unavailable.
            (Code::SourceInvalid, DetailReason::Invalid, Stage::Source, Requirement::SourceAuthentication),
        RetainedFailure::Protocol(RetainedProgramError::Cancelled) => return Err(ProgramStop::Cancelled.into()),
        RetainedFailure::Protocol(RetainedProgramError::WrongOwner) =>
            (Code::OwnerMismatch, DetailReason::Mismatch, Stage::Ownership, Requirement::Ownership),
        RetainedFailure::Protocol(_) | RetainedFailure::Completion(_) =>
            (Code::RuntimeFailed, DetailReason::BackendFailure, Stage::Transport, Requirement::Representation),
    };
    Ok(refused(code, reason, stage, requirement, binding))
}

pub(super) fn unavailable(binding: &wire::Binding) -> wire::InspectionOutcome {
    refused(wire::Code::FeatureUnavailable, wire::DetailReason::Unavailable,
        wire::Stage::Representation, wire::Requirement::Representation, binding)
}

fn refused(code: wire::Code, reason: wire::DetailReason, stage: wire::Stage,
    requirement: wire::Requirement, binding: &wire::Binding) -> wire::InspectionOutcome {
    wire::InspectionOutcome::Refused(Box::new(wire::RefusedInspection {
        refusal: wire::Refusal {
            schema_version: 1., family: wire::cause_family(&code), code, stage,
            source: wire::RefusalSource::Known(Box::new(wire::KnownSource { value: binding.identity.source.clone() })),
            target: wire::Target::Product(Box::new(wire::ProductTarget { product: binding.requested[0].clone() })),
            requirement, detail: wire::Detail { reason, measurement: wire::Measurement::NotApplicable(Box::new(wire::NotApplicable {})) },
            exact_retry: "explicit_new_exact_request".into(),
        },
    }))
}
