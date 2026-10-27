// SPDX-License-Identifier: MPL-2.0
//! Bounded private facts, separate from retryable protocol ownership errors.
use super::failure::{FailureHandle, FailureSite, OriginCause};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::program) enum ValueReason {
    SourceProgram, MissingSourceId, SourceEpoch, SourceRevision, OperationProgram,
    UnitDomain, PlacementDomain,
    NonfiniteFrame, NonAffineFrame, NonfiniteDeterminant, SingularFrame,
    NonfiniteRigidFrame, NonAffineRigidFrame, NonrigidGram, ImproperRotation,
    NonfiniteComposition,
}
impl ValueReason {
    fn diagnostic(self) -> crate::Error {
        use ValueReason::*;
        match self {
            SourceProgram | MissingSourceId | SourceEpoch | SourceRevision | OperationProgram
                | UnitDomain => crate::Error::geometry("invalid retained source identity or unit domain"),
            PlacementDomain => crate::Error::geometry("foreign retained placement domain"),
            NonfiniteComposition => crate::Error::geometry("retained composed frame is non-finite"),
            NonfiniteFrame | NonAffineFrame | NonfiniteDeterminant | SingularFrame =>
                crate::Error::geometry(crate::document::RetainedRefusal::UnsupportedSource(
                    "retained placement requires finite nonsingular affine matrix".into()).to_string()),
            NonfiniteRigidFrame | NonAffineRigidFrame | NonrigidGram | ImproperRotation =>
                crate::Error::geometry(crate::document::RetainedRefusal::UnsupportedSource(
                    "retained nonrigid placement requires qualified affine capability".into()).to_string()),
        }
    }
    pub(in crate::program) fn into_common(self, failure: &FailureHandle, site: FailureSite,
        entity: Option<u32>) -> crate::Error {
        let diagnostic = self.diagnostic();
        failure.record(site, entity, OriginCause::Value(self));
        diagnostic
    }
}
impl From<ValueReason> for crate::Error {
    fn from(reason: ValueReason) -> Self { reason.diagnostic() }
}

/// Placement/baking also allocate. Keep those original errors (especially the
/// exact ProgramStop payload) separate from the mathematical facts above.
#[derive(Debug)]
pub(in crate::program) enum ValueError {
    Fact(ValueReason),
    Common(crate::Error),
}
impl From<ValueReason> for ValueError {
    fn from(reason: ValueReason) -> Self { Self::Fact(reason) }
}
impl From<crate::Error> for ValueError {
    fn from(error: crate::Error) -> Self { Self::Common(error) }
}
impl From<crate::resource::ProgramStop> for ValueError {
    fn from(stop: crate::resource::ProgramStop) -> Self { Self::Common(stop.into()) }
}
impl ValueError {
    pub(in crate::program) fn into_common(self, failure: &FailureHandle, site: FailureSite,
        entity: Option<u32>) -> crate::Error {
        match self {
            Self::Fact(reason) => reason.into_common(failure, site, entity),
            Self::Common(error) => error,
        }
    }
}
impl std::fmt::Display for ValueError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Fact(reason) => write!(f, "{}", reason.diagnostic()),
            Self::Common(error) => write!(f, "{error}"),
        }
    }
}
