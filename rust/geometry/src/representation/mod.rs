// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The structural home of a product's representations: the
//! `Representation(6) → IfcProductDefinitionShape.Representations(2) → Items(3)`
//! chain, which representations a caller means ([`Select`]) and a visitor walk
//! over the items and the `IfcMappedItem`s among them ([`RepresentationWalk`]).
//!
//! Decoder-only: this module meshes nothing and owns no cache. The router,
//! RTC-vote probes and the layer slicer are all callers of it.

mod select;
mod walk;

pub use select::{meshed_representations, Select};
pub use walk::{
    Flow, MappedLevel, NestedMaps, RepresentationWalk, WalkCtx, WalkRefusal, WalkVisitor,
};
pub(crate) use select::{
    effective_element_rep_type, effective_rep_type, is_body_representation,
    is_direct_body_representation,
};

use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};

/// Why a product's shape chain could not be read. [`ShapeError`] converts into
/// the geometry [`Error`](crate::Error) with the exact message text the strict
/// element paths have always reported.
#[derive(Debug)]
pub enum ShapeError {
    /// The product has no attribute 6 at all.
    NoRepresentationAttribute { element: u32 },
    /// Attribute 6 is a reference that does not resolve.
    Unresolved,
    /// Attribute 6 resolves to something other than an `IfcProductDefinitionShape`.
    NotAProductDefinitionShape(IfcType),
    /// The `IfcProductDefinitionShape` has no `Representations` attribute.
    MissingRepresentations,
    /// A representation has no `Items` attribute.
    MissingItems,
    /// The decoder failed on a reference.
    Decode(ifc_lite_core::Error),
}

impl From<ifc_lite_core::Error> for ShapeError {
    fn from(error: ifc_lite_core::Error) -> Self {
        ShapeError::Decode(error)
    }
}

impl From<ShapeError> for crate::Error {
    fn from(error: ShapeError) -> Self {
        match error {
            ShapeError::NoRepresentationAttribute { element } => crate::Error::geometry(format!(
                "Element #{element} has no representation attribute"
            )),
            ShapeError::Unresolved => {
                crate::Error::geometry("Failed to resolve representation".to_string())
            }
            ShapeError::NotAProductDefinitionShape(found) => crate::Error::geometry(format!(
                "Expected IfcProductDefinitionShape, got {found}"
            )),
            ShapeError::MissingRepresentations => crate::Error::geometry(
                "IfcProductDefinitionShape missing Representations".to_string(),
            ),
            ShapeError::MissingItems => {
                crate::Error::geometry("IfcShapeRepresentation missing Items".to_string())
            }
            ShapeError::Decode(error) => crate::Error::CoreError(error),
        }
    }
}

/// `IfcProductDefinitionShape.Representations` of a product, decoded once.
pub struct ProductShape {
    /// The `IfcProductDefinitionShape`'s id.
    pub id: u32,
    representations: Vec<DecodedEntity>,
}

/// The shape of `element`: `Ok(None)` iff its `Representation` (attribute 6) is
/// `$`. Every other malformation is an `Err` carrying today's message text; the
/// probes that abstain on malformed input call `.ok().flatten()`, so the
/// leniency stays visible at the call site.
pub fn product_shape(
    element: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Result<Option<ProductShape>, ShapeError> {
    // IfcProduct: GlobalId, OwnerHistory, Name, Description, ObjectType, ObjectPlacement, Representation, Tag
    let attr = element
        .get(6)
        .ok_or(ShapeError::NoRepresentationAttribute { element: element.id })?;
    if attr.is_null() {
        return Ok(None);
    }
    let shape = decoder.resolve_ref(attr)?.ok_or(ShapeError::Unresolved)?;
    if shape.ifc_type != IfcType::IfcProductDefinitionShape {
        return Err(ShapeError::NotAProductDefinitionShape(shape.ifc_type));
    }
    let list = shape.get(2).ok_or(ShapeError::MissingRepresentations)?;
    Ok(Some(ProductShape { id: shape.id, representations: decoder.resolve_ref_list(list)? }))
}

impl ProductShape {
    /// Consume the admitted list without copying entities or revisiting prefixes.
    pub(crate) fn into_selected(self, element: &DecodedEntity, select: Select) -> Vec<DecodedEntity> {
        let direct = select.needs_direct_geometry()
            && select::has_direct_geometry(element, &self.representations);
        self.representations.into_iter().filter(|rep| select.admits(element, rep, direct)).collect()
    }

    /// Every representation, in list order.
    pub fn representations(&self) -> &[DecodedEntity] {
        &self.representations
    }

    /// The representations `select` admits for `element`, in list order.
    pub fn select<'a>(
        &'a self,
        element: &'a DecodedEntity,
        select: Select,
    ) -> impl Iterator<Item = &'a DecodedEntity> + 'a {
        let direct =
            select.needs_direct_geometry() && select::has_direct_geometry(element, &self.representations);
        self.representations.iter().filter(move |rep| select.admits(element, rep, direct))
    }
}

/// `Items` (attribute 3) of an `IfcShapeRepresentation`, an
/// `IfcTopologyRepresentation` or a mapped representation, decoded.
pub fn rep_items(
    rep: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Result<Vec<DecodedEntity>, ShapeError> {
    let items = rep.get(3).ok_or(ShapeError::MissingItems)?;
    Ok(decoder.resolve_ref_list(items)?)
}

#[cfg(test)]
mod walk_tests;
