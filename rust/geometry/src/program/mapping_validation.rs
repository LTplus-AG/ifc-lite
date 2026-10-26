// SPDX-License-Identifier: MPL-2.0
//! Mapped-input predicates return owned facts; only rejecting callers record them.
use ifc_lite_core::{slot, AttributeValue, DecodedEntity, EntityDecoder, IfcType};
use crate::program::retained::failure::{FailureSite, MappingReason, OriginCause};
use crate::program::retained::RetainedSelection;

pub(super) type Result<T> = std::result::Result<T, MappingFailure>;

#[derive(Debug)]
pub(super) struct MappingFailure {
    site: FailureSite,
    entity: u32,
    cause: OriginCause,
    diagnostic: &'static str,
}
impl MappingFailure {
    pub(super) fn refused(site: FailureSite, entity: u32, reason: MappingReason,
        diagnostic: &'static str) -> Self {
        Self { site, entity, cause: OriginCause::Mapping(reason), diagnostic }
    }
    pub(super) fn core(site: FailureSite, entity: u32, error: ifc_lite_core::Error) -> Self {
        Self { site, entity, cause: OriginCause::Core(error), diagnostic: "" }
    }
    pub(super) fn diagnostic(&self) -> String {
        match &self.cause {
            OriginCause::Core(error) => format!("Core parser error: {error}"),
            _ => self.diagnostic.to_owned(),
        }
    }
    pub(super) fn into_common(self, selection: &RetainedSelection) -> crate::Error {
        let diagnostic = self.diagnostic();
        // The common reply still owns its diagnostic. The traversal owns the
        // actual Core payload (without cloning/parsing it), or predicate fact.
        selection.failure_handle().record(self.site, Some(self.entity), self.cause);
        crate::Error::geometry(diagnostic)
    }
}

// Admission order is source -> origin -> target -> representation/items, even
// on cache hits. Numerical transforms remain entirely in the canonical router.
pub(super) fn occurrence(item: &DecodedEntity, decoder: &mut EntityDecoder) -> Result<()> {
    let source = item.get(slot::IfcMappedItem::MAPPING_SOURCE.index())
        .and_then(AttributeValue::as_entity_ref)
        .ok_or_else(|| MappingFailure::refused(FailureSite::MappingSource, item.id,
            MappingReason::ReferenceRequired, "retained MappingSource requires a reference"))?;
    let source = decoder.decode_by_id(source)
        .map_err(|error| MappingFailure::core(FailureSite::MappingSource, source, error))?;
    if source.ifc_type != IfcType::IfcRepresentationMap {
        return Err(MappingFailure::refused(FailureSite::MappingSource, source.id,
            MappingReason::Category, "retained MappingSource requires IfcRepresentationMap"));
    }
    validate_origin(&source, decoder)?;
    validate_target(item, decoder)?;
    map(&source, decoder)
}

fn validate_target(item: &DecodedEntity, decoder: &mut EntityDecoder) -> Result<()> {
    let target = item.get(slot::IfcMappedItem::MAPPING_TARGET.index())
        .and_then(AttributeValue::as_entity_ref)
        .ok_or_else(|| MappingFailure::refused(FailureSite::MappingTarget, item.id,
            MappingReason::ReferenceRequired, "retained MappingTarget requires a reference"))?;
    let target = decoder.decode_by_id(target)
        .map_err(|error| MappingFailure::core(FailureSite::MappingTarget, target, error))?;
    if !matches!(target.ifc_type, IfcType::IfcCartesianTransformationOperator2D
        | IfcType::IfcCartesianTransformationOperator2DnonUniform
        | IfcType::IfcCartesianTransformationOperator3D
        | IfcType::IfcCartesianTransformationOperator3DnonUniform) {
        return Err(MappingFailure::refused(FailureSite::MappingTarget, target.id,
            MappingReason::Category, "retained MappingTarget requires a supported transformation operator"));
    }
    super::directions::target(&target, decoder)?;
    scale(&target, slot::IfcCartesianTransformationOperator::SCALE.index())?;
    match target.ifc_type {
        IfcType::IfcCartesianTransformationOperator2DnonUniform => {
            scale(&target, slot::IfcCartesianTransformationOperator2DnonUniform::SCALE2.index())?;
        }
        IfcType::IfcCartesianTransformationOperator3DnonUniform => {
            scale(&target, slot::IfcCartesianTransformationOperator3DnonUniform::SCALE2.index())?;
            scale(&target, slot::IfcCartesianTransformationOperator3DnonUniform::SCALE3.index())?;
        }
        _ => {}
    }
    Ok(())
}

fn scale(target: &DecodedEntity, index: usize) -> Result<()> {
    // Optional omission keeps the canonical default. An authored token must
    // be a finite number; exact-display recovery is not admission.
    match target.get(index) {
        None | Some(AttributeValue::Null | AttributeValue::Integer(_)) => Ok(()),
        Some(AttributeValue::Float(value)) if value.is_finite() => Ok(()),
        _ => Err(MappingFailure::refused(FailureSite::MappingScale, target.id,
            MappingReason::FiniteScale { attribute: index },
            "retained MappingTarget Scale requires a finite number or absence")),
    }
}

fn validate_origin(map: &DecodedEntity, decoder: &mut EntityDecoder) -> Result<()> {
    let origin = map.get(slot::IfcRepresentationMap::MAPPING_ORIGIN.index())
        .and_then(AttributeValue::as_entity_ref)
        .ok_or_else(|| MappingFailure::refused(FailureSite::MappingOrigin, map.id,
            MappingReason::ReferenceRequired, "retained MappingOrigin requires a reference"))?;
    let origin = decoder.decode_by_id(origin)
        .map_err(|error| MappingFailure::core(FailureSite::MappingOrigin, origin, error))?;
    if !matches!(origin.ifc_type, IfcType::IfcAxis2Placement2D | IfcType::IfcAxis2Placement3D) {
        return Err(MappingFailure::refused(FailureSite::MappingOrigin, origin.id,
            MappingReason::Category, "retained MappingOrigin requires a supported placement"));
    }
    // Type roots invoke this semantic admission at their late-origin stage.
    super::directions::origin(&origin, decoder)
}

pub(super) fn late_origin(map: &DecodedEntity, decoder: &mut EntityDecoder) -> Result<()> {
    let attribute = map.get(slot::IfcRepresentationMap::MAPPING_ORIGIN.index())
        .ok_or_else(|| MappingFailure::refused(FailureSite::MappingOrigin, map.id,
            MappingReason::ReferenceRequired, "retained type-map MappingOrigin missing"))?;
    // Keep resolve_ref's existing token semantics and the stricter 3D type-root
    // category. Origin admission stays after source construction at this caller.
    let origin = decoder.resolve_ref(attribute)
        .map_err(|error| MappingFailure::core(FailureSite::MappingOrigin,
            attribute.as_entity_ref().unwrap_or(map.id), error))?
        .ok_or_else(|| MappingFailure::refused(FailureSite::MappingOrigin, map.id,
            MappingReason::ReferenceRequired, "retained type-map requires a readable 3D MappingOrigin"))?;
    if origin.ifc_type != IfcType::IfcAxis2Placement3D {
        return Err(MappingFailure::refused(FailureSite::MappingOrigin, origin.id,
            MappingReason::Category, "retained type-map requires a readable 3D MappingOrigin"));
    }
    super::directions::origin(&origin, decoder)
}

pub(super) fn map(map: &DecodedEntity, decoder: &mut EntityDecoder) -> Result<()> {
    if map.ifc_type != IfcType::IfcRepresentationMap {
        return Err(MappingFailure::refused(FailureSite::MappingSource, map.id,
            MappingReason::Category, "retained MappingSource requires IfcRepresentationMap"));
    }
    let representation = map.get(slot::IfcRepresentationMap::MAPPED_REPRESENTATION.index())
        .and_then(AttributeValue::as_entity_ref)
        .ok_or_else(|| MappingFailure::refused(FailureSite::MappedRepresentation, map.id,
            MappingReason::ReferenceRequired, "retained MappedRepresentation requires a reference"))?;
    let representation = decoder.decode_by_id(representation)
        .map_err(|error| MappingFailure::core(FailureSite::MappedRepresentation, representation, error))?;
    if !matches!(representation.ifc_type, IfcType::IfcShapeRepresentation | IfcType::IfcTopologyRepresentation) {
        return Err(MappingFailure::refused(FailureSite::MappedRepresentation, representation.id,
            MappingReason::Category, "retained MappedRepresentation requires a supported representation"));
    }
    items(&representation, decoder)
}

fn items(representation: &DecodedEntity, decoder: &mut EntityDecoder) -> Result<()> {
    let items = representation.get(slot::IfcRepresentation::ITEMS.index())
        .and_then(AttributeValue::as_list)
        .ok_or_else(|| MappingFailure::refused(FailureSite::MappingItems, representation.id,
            MappingReason::ListRequired, "retained representation Items requires a readable list"))?;
    // `Items` is SET [1:?]: an explicit () is malformed here exactly as it is
    // for a representation the product references directly. Validate every
    // member even on source cache hits.
    if items.is_empty() {
        return Err(MappingFailure::refused(FailureSite::MappingItems, representation.id,
            MappingReason::ListRequired, "retained representation Items must be a nonempty list"));
    }
    for item in items {
        let id = item.as_entity_ref()
            .ok_or_else(|| MappingFailure::refused(FailureSite::MappingItems, representation.id,
                MappingReason::NonReferenceMember, "retained representation Items requires references"))?;
        decoder.decode_by_id(id)
            .map_err(|error| MappingFailure::core(FailureSite::MappingItems, id, error))?;
    }
    Ok(())
}
