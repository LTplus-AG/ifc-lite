// SPDX-License-Identifier: MPL-2.0
//! Preserve the private typed failure, without exporting the controller taxonomy.
use super::controller::RetainedProgramError;
use super::logical::failure::RetainedFailure;
use crate::resource::ProgramStop;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransactionFailureKind {
    Stopped,
    Unsupported,
    WrongPayload,
    WrongOwner,
    Outstanding,
    StaleRequest,
    AlreadyExecuted,
    NotExecuted,
    Cancelled,
    Source,
    Incomplete,
    OperationUnsupported,
    DeadlineExceeded,
}
#[derive(Debug)]
pub struct TransactionError(RetainedFailure);
impl TransactionError {
    pub(super) fn stopped(stop: ProgramStop) -> Self {
        Self(RetainedFailure::Stopped(stop))
    }
    pub fn original_stop(&self) -> Option<ProgramStop> {
        match &self.0 {
            RetainedFailure::Stopped(stop)
            | RetainedFailure::Protocol(RetainedProgramError::Stopped(stop)) => Some(*stop),
            _ => None,
        }
    }
    /// Allocation-free view of the original typed source failure.
    pub fn origin_view(&self) -> Option<(&'static str, Option<u32>, &'static str)> {
        use super::logical::failure::{FailureSite, OriginCause};
        let RetainedFailure::Origin(handle) = &self.0 else {
            return None;
        };
        let origin = handle.origin()?;
        let site = match origin.site {
            FailureSite::ProductRoot => "product_root",
            FailureSite::ProductShape => "product_shape",
            FailureSite::RepresentationItems => "representation_items",
            FailureSite::Constructor => "constructor",
            FailureSite::ProductCompletion => "product_completion",
            FailureSite::TypeMapCompletion => "type_map_completion",
            FailureSite::TypeBinding => "type_binding",
            FailureSite::MappingSource => "mapping_source",
            FailureSite::MappingTarget => "mapping_target",
            FailureSite::MappingOrigin => "mapping_origin",
            FailureSite::MappedRepresentation => "mapped_representation",
            FailureSite::MappingItems => "mapping_items",
            FailureSite::MappingScale => "mapping_scale",
            FailureSite::MappingDirection => "mapping_direction",
            FailureSite::BooleanSource => "boolean_source",
            FailureSite::BooleanOperator => "boolean_operator",
            FailureSite::BooleanFirstOperand => "boolean_first_operand",
            FailureSite::BooleanSecondOperand => "boolean_second_operand",
            FailureSite::ProductPlacement => "product_placement",
            FailureSite::MappingPlacement => "mapping_placement",
            FailureSite::TypeMapPlacement => "type_map_placement",
            FailureSite::MappingAffine => "mapping_affine",
            FailureSite::TypeMapAffine => "type_map_affine",
        };
        let cause = match &origin.cause {
            OriginCause::Recipe(_) => "recipe",
            OriginCause::Shape(_) => "shape",
            OriginCause::Core(_) => "core",
            OriginCause::Structure(_) => "structure",
            OriginCause::Mapping(_) => "mapping",
            OriginCause::Boolean(_) => "boolean",
            OriginCause::Value(_) => "value",
            OriginCause::Processor(_) => "processor",
            OriginCause::Opaque(_) => "opaque",
        };
        Some((site, origin.entity, cause))
    }
    pub fn kind(&self) -> TransactionFailureKind {
        use TransactionFailureKind as Kind;
        match &self.0 {
            RetainedFailure::Stopped(_) => Kind::Stopped,
            RetainedFailure::DeadlineExceeded => Kind::DeadlineExceeded,
            RetainedFailure::Origin(handle) => {
                use super::logical::failure::{OriginCause, StructuralReason};
                let origin = handle.origin();
                match origin.as_deref().map(|origin| &origin.cause) {
                    Some(
                        OriginCause::Recipe(crate::document::RetainedRefusal::UnsupportedSource(_))
                        | OriginCause::Structure(StructuralReason::UnsupportedProduct)
                        | OriginCause::Processor(_),
                    ) => Kind::OperationUnsupported,
                    _ => Kind::Source,
                }
            }
            RetainedFailure::Completion(_) => Kind::Incomplete,
            RetainedFailure::Protocol(error) => match error {
                RetainedProgramError::Stopped(_) => Kind::Stopped,
                RetainedProgramError::Unsupported => Kind::Unsupported,
                RetainedProgramError::WrongPayload => Kind::WrongPayload,
                RetainedProgramError::WrongOwner => Kind::WrongOwner,
                RetainedProgramError::Outstanding => Kind::Outstanding,
                RetainedProgramError::StaleRequest => Kind::StaleRequest,
                RetainedProgramError::AlreadyExecuted => Kind::AlreadyExecuted,
                RetainedProgramError::NotExecuted => Kind::NotExecuted,
                RetainedProgramError::Cancelled => Kind::Cancelled,
            },
        }
    }
}
impl From<RetainedFailure> for TransactionError {
    fn from(value: RetainedFailure) -> Self {
        Self(value)
    }
}
impl From<RetainedProgramError> for TransactionError {
    fn from(value: RetainedProgramError) -> Self {
        Self(value.into())
    }
}
