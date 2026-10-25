// SPDX-License-Identifier: MPL-2.0
//! Preserve the private typed failure, without exporting the controller taxonomy.
use super::controller::RetainedProgramError;
use super::logical::failure::RetainedFailure;
use crate::resource::ProgramStop;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransactionFailureKind {
    Stopped, Unsupported, WrongPayload, WrongOwner, Outstanding,
    StaleRequest, AlreadyExecuted, NotExecuted, Cancelled, Source, Incomplete,
}
#[derive(Debug)]
pub struct TransactionError(RetainedFailure);
impl TransactionError {
    pub fn original_stop(&self) -> Option<ProgramStop> {
        match &self.0 { RetainedFailure::Stopped(stop) => Some(*stop), _ => None }
    }
    pub fn kind(&self) -> TransactionFailureKind {
        use TransactionFailureKind as Kind;
        match &self.0 {
            RetainedFailure::Stopped(_) => Kind::Stopped,
            RetainedFailure::Origin(_) => Kind::Source,
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
    fn from(value: RetainedFailure) -> Self { Self(value) }
}
impl From<RetainedProgramError> for TransactionError {
    fn from(value: RetainedProgramError) -> Self { Self(value.into()) }
}
impl From<ProgramStop> for TransactionError {
    fn from(value: ProgramStop) -> Self { Self(RetainedFailure::Stopped(value)) }
}
