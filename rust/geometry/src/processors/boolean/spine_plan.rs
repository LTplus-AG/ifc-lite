// SPDX-License-Identifier: MPL-2.0
//! Shared operand role identity; whole-spine snapshots are inspection-only.
use crate::BoolOp;
use std::hash::{Hash, Hasher};
/// Definition sharing must not erase the use's diagnostic/void-shell policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OperandRole { Root, Base, Operation(BoolOp) }
impl OperandRole {
    pub(crate) fn diagnostic_operator(self) -> BoolOp {
        match self { Self::Operation(op) => op, Self::Root | Self::Base => BoolOp::Unknown }
    }
}

impl Hash for OperandRole {
    fn hash<H: Hasher>(&self, state: &mut H) {
        match self {
            Self::Root => 0u8.hash(state),
            Self::Base => 1u8.hash(state),
            Self::Operation(op) => {
                2u8.hash(state);
                match op { BoolOp::Difference => 0u8, BoolOp::Union => 1,
                    BoolOp::Intersection => 2, BoolOp::Unknown => 3 }.hash(state);
            }
        }
    }
}


#[cfg(test)]
#[path = "spine_snapshot.rs"]
mod snapshot;
#[cfg(test)]
pub(crate) use snapshot::*;
