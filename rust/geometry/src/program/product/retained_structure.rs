// SPDX-License-Identifier: MPL-2.0
//! Retained completeness must be checked before lenient decoding or selection.
use crate::representation::{ProductShape, ShapeError};
use crate::Error;
use crate::program::retained::failure::{FailureSite, OriginCause, StructuralReason};
use crate::program::retained::RetainedSelection;
type Result<T> = std::result::Result<T, StructureError>;
use ifc_lite_core::{slot, AttributeValue, DecodedEntity, EntityDecoder, IfcType};

pub(super) fn validated_product_shape(
    element: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Result<Option<ProductShape>> {
    let attr = element
        .get(slot::IfcProduct::REPRESENTATION.index())
        .ok_or_else(|| shape_error(element.id, ShapeError::NoRepresentationAttribute {
            element: element.id,
        }))?;
    // Only an authored absent Representation is an empty product. In
    // particular, `*` is not a derived attribute at this IfcProduct slot.
    if matches!(attr, AttributeValue::Null) {
        return Ok(None);
    }
    let id = attr
        .as_entity_ref()
        .ok_or_else(|| refused(FailureSite::ProductShape, element.id, StructuralReason::RepresentationReference,
            "retained Representation must be a reference or $"))?;
    let shape = decoder.decode_by_id(id).map_err(|error| core_error(FailureSite::ProductShape, id, error))?;
    if shape.ifc_type != IfcType::IfcProductDefinitionShape {
        return Err(shape_error(shape.id, ShapeError::NotAProductDefinitionShape(shape.ifc_type)));
    }
    reference_members(
        &shape,
        slot::IfcProductDefinitionShape::REPRESENTATIONS.index(),
        "Representations",
    )?;
    // This wrapper is not recursive: the distinct shared reader below walks
    // only the authored, finite Representations list, never child references.
    // The shared reader preserves decoding errors and authored order. Its
    // lossy list conversion is safe only after validating the raw members.
    let shape = crate::representation::product_shape(element, decoder)
        .map_err(|error| shape_error(element.id, error))?;
    if let Some(shape) = &shape {
        for rep in shape.representations() {
            crate::resource::check_current()?;
            if !matches!(
                rep.ifc_type,
                IfcType::IfcShapeRepresentation | IfcType::IfcTopologyRepresentation
            ) {
                return Err(refused(FailureSite::ProductShape, rep.id, StructuralReason::RepresentationCategory, format!(
                    "retained Representations contains non-shape representation #{} ({})",
                    rep.id, rep.ifc_type
                )));
            }
            // Resolve and classify even the Items the meshed selector will skip.
            // This is shallow: no mapping targets or geometry children are read.
            let members = reference_members(rep, slot::IfcRepresentation::ITEMS.index(), "Items")?;
            item_targets(members, decoder)?;
        }
    }
    Ok(shape)
}

fn reference_members<'a>(
    entity: &'a DecodedEntity,
    index: usize,
    name: &str,
) -> Result<&'a [AttributeValue]> {
    let members = entity
        .get(index)
        .and_then(AttributeValue::as_list)
        .filter(|members| !members.is_empty())
        .ok_or_else(|| {
            refused(list_site(name), entity.id, StructuralReason::NonemptyReferenceList,
                format!("retained {name} must be a nonempty reference list"))
        })?;
    for member in members {
        crate::resource::check_current()?;
        if member.as_entity_ref().is_none() {
            return Err(refused(list_site(name), entity.id, StructuralReason::NonReferenceMember, format!(
                "retained {name} on #{} contains a non-reference member",
                entity.id
            )));
        }
    }
    Ok(members)
}

fn item_targets(members: &[AttributeValue], decoder: &mut EntityDecoder) -> Result<()> {
    // reference_members has checked every token before this conversion, so
    // none can disappear here. Keep the exact reader's leniency out of S1.
    for id in members.iter().filter_map(AttributeValue::as_entity_ref) {
        crate::resource::check_current()?;
        let item = decoder.decode_by_id(id)
            .map_err(|error| core_error(FailureSite::RepresentationItems, id, error))?;
        // The generated supported-schema hierarchy includes geometric,
        // topological, styled and mapped items, including legacy subclasses.
        // Category membership does not admit a new retained constructor.
        if !item.ifc_type.is_subtype_of(IfcType::IfcRepresentationItem) {
            return Err(refused(FailureSite::RepresentationItems, item.id, StructuralReason::ItemCategory, format!(
                "retained Items contains non-IfcRepresentationItem #{} ({})",
                item.id, item.ifc_type
            )));
        }
    }
    Ok(())
}

// Retained-only errors preserve the reached cause before the common carrier.
pub(super) enum StructureError {
    Stop(crate::resource::ProgramStop),
    Origin { site: FailureSite, entity: u32, cause: OriginCause, diagnostic: String },
}
impl From<crate::resource::ProgramStop> for StructureError {
    fn from(stop: crate::resource::ProgramStop) -> Self { Self::Stop(stop) }
}
impl StructureError {
    pub(super) fn into_common(self, selection: &RetainedSelection) -> Error {
        match self {
            Self::Stop(stop) => Error::ProgramStopped(stop),
            Self::Origin { site, entity, cause, diagnostic } => {
                selection.failure_handle().record(site, Some(entity), cause);
                Error::geometry(diagnostic)
            }
        }
    }
}
fn list_site(name: &str) -> FailureSite {
    if name == "Items" { FailureSite::RepresentationItems } else { FailureSite::ProductShape }
}
fn refused(site: FailureSite, entity: u32, reason: StructuralReason, diagnostic: impl Into<String>) -> StructureError {
    StructureError::Origin { site, entity, cause: OriginCause::Structure(reason), diagnostic: diagnostic.into() }
}
fn core_error(site: FailureSite, entity: u32, error: ifc_lite_core::Error) -> StructureError {
    let diagnostic = format!("Core parser error: {error}");
    StructureError::Origin { site, entity, cause: OriginCause::Core(error), diagnostic }
}
fn shape_error(entity: u32, error: ShapeError) -> StructureError {
    // Format the common diagnostic by reference, then move the actual enum.
    // No owned decoder/type string is cloned to retain its cause.
    let diagnostic = match &error {
        ShapeError::NoRepresentationAttribute { element } => format!("Element #{element} has no representation attribute"),
        ShapeError::Unresolved => "Failed to resolve representation".to_owned(),
        ShapeError::NotAProductDefinitionShape(found) => format!("Expected IfcProductDefinitionShape, got {found}"),
        ShapeError::MissingRepresentations => "IfcProductDefinitionShape missing Representations".to_owned(),
        ShapeError::MissingItems => "IfcShapeRepresentation missing Items".to_owned(),
        ShapeError::Decode(core) => format!("Core parser error: {core}"),
    };
    StructureError::Origin { site: FailureSite::ProductShape, entity, cause: OriginCause::Shape(error), diagnostic }
}

pub(super) fn retained_items(rep: &DecodedEntity, decoder: &mut EntityDecoder,
    selection: &RetainedSelection) -> crate::Result<Vec<DecodedEntity>> {
    crate::representation::rep_items(rep, decoder)
        .map_err(|error| shape_error(rep.id, error).into_common(selection))
}
