// SPDX-License-Identifier: MPL-2.0
//! Refusal evidence leaves source execution without an owner. Only the product
//! controller's error arm attaches its already-held product, before acceptance.
use super::{MappingReply, MappingValue, ProgramError};
use crate::program::mapping_budget::{LogicalBudget, LogicalRefusal};
use ifc_lite_core::DecodedEntity;

pub(in crate::program) struct MappingFailure(Box<Failure>);

impl std::fmt::Debug for MappingFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &*self.0 {
            Failure::Protocol(error) => std::fmt::Debug::fmt(error, f),
            Failure::Refused { item_id, refusal, .. } => f.debug_struct("MappingRefusal")
                .field("item_id", item_id).field("refusal", refusal).finish(),
        }
    }
}

enum Failure {
    Protocol(ProgramError),
    Refused { item_id: u32, refusal: LogicalRefusal, budget: LogicalBudget },
}

impl From<ProgramError> for MappingFailure {
    #[cold]
    #[inline(never)]
    fn from(error: ProgramError) -> Self { Self(Box::new(Failure::Protocol(error))) }
}

impl MappingFailure {
    #[cold]
    #[inline(never)]
    pub(super) fn refused(item_id: u32, refusal: LogicalRefusal, budget: LogicalBudget) -> Self {
        Self(Box::new(Failure::Refused { item_id, refusal, budget }))
    }

    /// Source-only programs pass None; ordinary products attach identity here.
    /// Recording remains at acceptance, so discarded replies publish nothing.
    #[cold]
    #[inline(never)]
    pub(in crate::program) fn recover(self, product: Option<&DecodedEntity>)
        -> std::result::Result<MappingReply, ProgramError> {
        match *self.0 {
            Failure::Protocol(error) => Err(error),
            Failure::Refused { item_id, mut refusal, budget } => {
                if let Some(product) = product { refusal.attach_product(product); }
                Ok(MappingValue::Refused { item_id, refusal, budget })
            }
        }
    }
}

// Main's protocol error is fieldless. The boxed failure changes neither the
// controller nor the size of its successful per-attempt Result.
const _: () = assert!(std::mem::size_of::<ProgramError>() == 1);
const _: () = assert!(std::mem::size_of::<MappingFailure>() == std::mem::size_of::<usize>());
const _: () = assert!(std::mem::size_of::<std::result::Result<MappingReply, MappingFailure>>()
    == std::mem::size_of::<std::result::Result<MappingReply, ProgramError>>());
