// SPDX-License-Identifier: MPL-2.0
//! Type-map ownership fits in the existing owned-entity slot. Ordinary mapping
//! roots and per-attempt Results gain no field or initialization work.
use ifc_lite_core::DecodedEntity;

pub(super) enum TypeMapRoot<'a> {
    Borrowed(&'a DecodedEntity),
    Owned(DecodedEntity),
    /// Transient cold error storage; restored before a reply leaves execution.
    Refused(Box<PendingRefusal<'a>>),
    Product { map: &'a DecodedEntity, product: &'a DecodedEntity },
}

const _: () = assert!(std::mem::size_of::<TypeMapRoot<'_>>()
    == std::mem::size_of::<super::Reached<'_>>());
const _: () = assert!(std::mem::size_of::<Option<TypeMapRoot<'_>>>()
    == std::mem::size_of::<Option<super::Reached<'_>>>());
const _: () = assert!(std::mem::align_of::<TypeMapRoot<'_>>()
    == std::mem::align_of::<super::Reached<'_>>());

pub(super) struct PendingRefusal<'a> {
    root: Option<TypeMapRoot<'a>>,
    reply: super::MappingReply,
}

impl<'a> super::MappingControl<'a> {
    /// Reuse the existing owned-root slot, rather than widening every control
    /// or Result. Only the refused transaction allocates this envelope.
    #[cold]
    #[inline(never)]
    pub(super) fn defer_refusal(&mut self, item_id: u32,
        refusal: crate::program::mapping_budget::LogicalRefusal,
        budget: crate::program::mapping_budget::LogicalBudget,
    ) -> crate::program::inner::ProgramError {
        let pending = PendingRefusal { root: self.rep_map.take(),
            reply: super::MappingValue::Refused { item_id, refusal, budget } };
        self.rep_map = Some(TypeMapRoot::Refused(Box::new(pending)));
        crate::program::inner::ProgramError::LogicalRefused
    }

    /// Called exclusively from the execution error arm. Source-only programs
    /// pass None; product controllers already hold the affected product.
    #[cold]
    #[inline(never)]
    pub(in crate::program) fn recover_refusal(&mut self,
        error: crate::program::inner::ProgramError, product: Option<&DecodedEntity>,
    ) -> std::result::Result<super::MappingReply, crate::program::inner::ProgramError> {
        if error != crate::program::inner::ProgramError::LogicalRefused { return Err(error); }
        let Some(TypeMapRoot::Refused(pending)) = self.rep_map.take() else {
            return Err(crate::program::inner::ProgramError::StaleRequest);
        };
        let PendingRefusal { root, mut reply } = *pending;
        self.rep_map = root;
        if let (Some(product), super::MappingValue::Refused { refusal, .. }) = (product, &mut reply) {
            refusal.attach_product(product);
        }
        Ok(reply)
    }
}

impl TypeMapRoot<'_> {
    pub(super) fn item(&self) -> &DecodedEntity {
        match self {
            Self::Borrowed(map) | Self::Product { map, .. } => map,
            Self::Owned(map) => map,
            Self::Refused(_) => unreachable!("pending refusal must be recovered before source access"),
        }
    }
    pub(super) fn product(&self) -> Option<&DecodedEntity> {
        match self { Self::Product { product, .. } => Some(product), _ => None }
    }
}

// Main's protocol error is fieldless. Neither it nor the successful mapping
// Result may grow when refusal details or attribution evolve.
const _: () = assert!(std::mem::size_of::<crate::program::inner::ProgramError>() == 1);
const _: () = assert!(std::mem::size_of::<std::result::Result<super::MappingReply,
    crate::program::inner::ProgramError>>() == std::mem::size_of::<super::MappingReply>());
