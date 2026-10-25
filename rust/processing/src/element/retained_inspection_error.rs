// SPDX-License-Identifier: MPL-2.0
//! Preserve actual source/owner/stop origins; schema codes are coarse diagnostics.
use super::*;
use super::model_context::retained::RetainedContextError;
use super::session_protocol::WorkError;

#[derive(Debug)]
enum Cause { Source(RetainedContextError), Owner(WorkError), Stop(ProgramStop), Code(wire::Code) }
/// Entry refusal before a diagnostic report exists. Never final product authority.
#[derive(Debug)]
pub struct RetainedInspectionError { cause: Cause }
impl RetainedInspectionError {
    pub(super) fn source(error: RetainedContextError) -> Self { Self { cause: Cause::Source(error) } }
    pub(super) fn owner(error: WorkError) -> Self { Self { cause: Cause::Owner(error) } }
    pub(super) fn stopped(stop: ProgramStop) -> Self { Self { cause: Cause::Stop(stop) } }
    fn code(code: wire::Code) -> Self { Self { cause: Cause::Code(code) } }
    pub(super) fn invalid_options() -> Self { Self::code(wire::Code::InvalidOptions) }
    pub(super) fn invalid_source() -> Self { Self::code(wire::Code::SourceInvalid) }
    pub(super) fn mismatched_source() -> Self { Self::source(RetainedContextError::Mismatched) }
    pub(super) fn invalid_report() -> Self { Self::code(wire::Code::RuntimeFailed) }
    pub(super) fn geometry(error: SourceInspectionError) -> Self {
        match error {
            SourceInspectionError::Stopped(stop) => Self::stopped(stop),
            SourceInspectionError::InvalidReport => Self::invalid_report(),
            SourceInspectionError::DeadlineExceeded => Self::code(wire::Code::DeadlineExceeded),
        }
    }
    /// Original typed stop, including dimension/requested/remaining/reason.
    pub fn original_stop(&self) -> Option<ProgramStop> {
        match self.cause { Cause::Stop(stop) => Some(stop), _ => None }
    }
    /// Serialize the generated staged code. Consumers must not classify prose.
    pub fn diagnostic_code_json(&self) -> String {
        use wire::Code;
        let code = match &self.cause {
            Cause::Source(RetainedContextError::Stale) => Code::SourceStale,
            Cause::Source(RetainedContextError::Missing) => Code::SourceMissing,
            Cause::Source(RetainedContextError::Mismatched) => Code::SourceMismatch,
            Cause::Owner(WorkError::StaleSource) => Code::SourceStale,
            Cause::Owner(WorkError::Aborted | WorkError::Unfinished | WorkError::Outstanding
                | WorkError::StaleTicket | WorkError::AlreadyExecuted | WorkError::NotExecuted
                | WorkError::WrongEmitter | WorkError::WrongPayload | WorkError::WrongOwner
                | WorkError::OwnerBusy | WorkError::WrongContext) => Code::OwnerMismatch,
            Cause::Stop(ProgramStop::Cancelled) => Code::Cancelled,
            Cause::Stop(ProgramStop::ResourceRefused(_)) => Code::ResourceExhausted,
            Cause::Code(code) => code.clone(),
        };
        serde_json::to_string(&code).expect("generated finite code serialization")
    }
}
impl std::fmt::Display for RetainedInspectionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.diagnostic_code_json())
    }
}
impl std::error::Error for RetainedInspectionError {}
