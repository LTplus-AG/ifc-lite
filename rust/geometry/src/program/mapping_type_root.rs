// SPDX-License-Identifier: MPL-2.0
//! Type-map ownership fits in the existing owned-entity slot. Ordinary mapping
//! roots and per-attempt Results gain no field or initialization work.
use ifc_lite_core::DecodedEntity;

pub(super) enum TypeMapRoot<'a> {
    Borrowed(&'a DecodedEntity),
    Owned(DecodedEntity),
    Product { map: &'a DecodedEntity, product: &'a DecodedEntity },
}

const _: () = assert!(std::mem::size_of::<TypeMapRoot<'_>>()
    == std::mem::size_of::<super::Reached<'_>>());
const _: () = assert!(std::mem::size_of::<Option<TypeMapRoot<'_>>>()
    == std::mem::size_of::<Option<super::Reached<'_>>>());
const _: () = assert!(std::mem::align_of::<TypeMapRoot<'_>>()
    == std::mem::align_of::<super::Reached<'_>>());

impl TypeMapRoot<'_> {
    pub(super) fn item(&self) -> &DecodedEntity {
        match self {
            Self::Borrowed(map) | Self::Product { map, .. } => map,
            Self::Owned(map) => map,
        }
    }
    pub(super) fn product(&self) -> Option<&DecodedEntity> {
        match self { Self::Product { product, .. } => Some(product), _ => None }
    }
}
