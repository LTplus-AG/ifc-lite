// SPDX-License-Identifier: MPL-2.0
use crate::resource_stop::ProgramStop;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum OwnerError {
    Stopped(ProgramStop),
    Allocation,
    Overflow,
    ForeignDomain,
    Invariant,
    Nesting,
}

/// A failed consuming operation returns the original donor, without copying it.
pub(super) struct BuildError<T> {
    pub error: OwnerError,
    pub donor: T,
}
impl<T> BuildError<T> {
    pub fn new(error: OwnerError, donor: T) -> Self { Self { error, donor } }
}
