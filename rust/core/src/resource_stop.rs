// SPDX-License-Identifier: MPL-2.0
//! Fixed-size resource terminal record shared only by explicit execution capabilities.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dimension {
    Work,
    CopyBytes,
    OutputBytes,
    Occurrences,
    LiveBytes,
    Representation,
    Coverage,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefusalReason {
    Limit,
    Overflow,
    Allocation,
    UnsupportedCoverage,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResourceFailure {
    pub dimension: Dimension,
    pub requested: u64,
    pub remaining: u64,
    pub reason: RefusalReason,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ProgramStop {
    #[error("resource admission refused: {0:?}")]
    ResourceRefused(ResourceFailure),
    #[error("execution cancelled")]
    Cancelled,
}
