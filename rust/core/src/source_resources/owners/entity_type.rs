// SPDX-License-Identifier: MPL-2.0
//! Known IFC variants are inline; unknown keyword backing follows its allocator.
use super::{build_error::OwnerError, storage::{Domain, Stored}, text::OwnedText};
use crate::IfcType;

pub(super) enum EntityType<A: Domain> {
    Known(IfcType),
    Unknown { id: u32, name: OwnedText<A> },
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct TypeRef<'a> { id: u32, name: &'a str }
impl<'a> TypeRef<'a> {
    pub fn id(self) -> u32 { self.id }
    pub fn as_str(self) -> &'a str { self.name }
}
impl<A: Domain> EntityType<A> {
    pub fn try_new(allocator: &A, value: &IfcType) -> Result<Self, OwnerError> {
        allocator.enter()?;
        match value {
            IfcType::Unknown(keyword) => Ok(Self::Unknown {
                id: keyword.id(), name: OwnedText::try_new(allocator, keyword.as_str())?,
            }),
            // Known variants contain no heap payload. Never Clone Unknown's String.
            known => Ok(Self::Known(known.clone())),
        }
    }
    pub fn view(&self) -> TypeRef<'_> {
        match self {
            Self::Known(value) => TypeRef { id: value.id(), name: value.as_str() },
            Self::Unknown { id, name } => TypeRef { id: *id, name: name.as_str() },
        }
    }
}
impl<A: Domain> Stored<A> for EntityType<A> {
    fn compatible(&self, allocator: &A) -> bool {
        match self {
            Self::Known(IfcType::Unknown(_)) => false,
            Self::Known(_) => true,
            Self::Unknown { name, .. } => name.compatible(allocator),
        }
    }
}
